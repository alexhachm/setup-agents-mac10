'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('./db');
const instanceRegistry = require('./instance-registry');

const REPO_RE = /^(https?:\/\/github\.com\/)?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(\.git)?$/;
const SAFE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/])[a-zA-Z0-9._\\/: -]+$/;

let server = null;
let wss = null;
let setupProcess = null;
let broadcastIntervalId = null;
let pingIntervalId = null;
let shutdownTimerId = null;
let activeClientCount = 0;
const SHUTDOWN_GRACE_MS = 60000; // 60s after last tab closes

function start(projectDir, port = 3100, scriptDir = null, callbacks = {}) {
  const app = express();
  server = http.createServer(app);
  wss = new WebSocket.Server({ server });
  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Handled by server.on('error') — suppress duplicate
    } else {
      console.error(`WebSocket server error: ${err.message}`);
    }
  });

  // Resolve scriptDir (mac10 repo root containing setup.sh)
  const resolvedScriptDir = scriptDir || path.join(__dirname, '..', '..');

  // Detect WSL — used to route spawns through wsl.exe
  const isWSL = fs.existsSync('/proc/version') &&
    (() => { try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); } catch { return false; } })();

  // CORS -- allow cross-port requests from other mac10 GUI tabs
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Serve static files
  const guiDir = process.env.MAC10_GUI_DIR || path.join(__dirname, '..', '..', 'gui', 'public');
  app.use(express.static(guiDir));
  app.use(express.json());

  // API endpoints
  app.get('/api/status', (req, res) => {
    try {
      const requests = db.listRequests();
      const workers = db.getAllWorkers();
      const tasks = db.listTasks();
      const logs = db.getLog(20);
      res.json({ requests, workers, tasks, logs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/requests', (req, res) => {
    try {
      res.json(db.listRequests(req.query.status));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/requests/:id', (req, res) => {
    try {
      const request = db.getRequest(req.params.id);
      if (!request) return res.status(404).json({ error: 'Not found' });
      const tasks = db.listTasks({ request_id: req.params.id });
      res.json({ ...request, tasks });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/workers', (req, res) => {
    try {
      res.json(db.getAllWorkers());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/tasks', (req, res) => {
    try {
      res.json(db.listTasks(req.query));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/log', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
      res.json(db.getLog(limit, req.query.actor));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/request', (req, res) => {
    try {
      const { description } = req.body;
      if (!description || typeof description !== 'string') {
        return res.status(400).json({ ok: false, error: 'description is required and must be a string' });
      }
      const id = db.createRequest(description);
      res.json({ ok: true, request_id: id });
      broadcast({ type: 'request_created', request_id: id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- Setup endpoints ---

  app.get('/api/config', (req, res) => {
    try {
      const storedDir = db.getConfig('project_dir');
      const storedWorkers = db.getConfig('num_workers');
      const storedRepo = db.getConfig('github_repo');
      const setupDone = db.getConfig('setup_complete');
      res.json({
        projectDir: storedDir || projectDir || '',
        numWorkers: storedWorkers ? parseInt(storedWorkers) : 4,
        githubRepo: storedRepo || '',
        setupComplete: setupDone === '1',
        scriptDir: resolvedScriptDir,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Save config without running full setup
  app.post('/api/config', (req, res) => {
    try {
      const { projectDir: newDir, githubRepo, numWorkers } = req.body;
      if (newDir) {
        if (!SAFE_PATH_RE.test(newDir)) {
          return res.status(400).json({ ok: false, error: 'Invalid project directory path' });
        }
        db.setConfig('project_dir', newDir);
      }
      if (githubRepo !== undefined) {
        if (githubRepo && !REPO_RE.test(githubRepo)) {
          return res.status(400).json({ ok: false, error: 'Invalid GitHub repo format. Expected owner/repo.' });
        }
        db.setConfig('github_repo', githubRepo);
      }
      if (numWorkers !== undefined) {
        db.setConfig('num_workers', String(Math.min(Math.max(parseInt(numWorkers) || 4, 1), 8)));
      }
      // Auto-save as preset when both project dir and repo are set
      const dir = newDir || db.getConfig('project_dir');
      const repo = githubRepo !== undefined ? githubRepo : db.getConfig('github_repo');
      const workers = numWorkers !== undefined ? Math.min(Math.max(parseInt(numWorkers) || 4, 1), 8) : parseInt(db.getConfig('num_workers') || '4');
      if (dir && repo) {
        const presetName = repo || path.basename(dir);
        db.savePreset(presetName, dir, repo, workers);
      }
      db.log('gui', 'config_updated', { projectDir: newDir, githubRepo, numWorkers });
      res.json({ ok: true, message: 'Config saved. Relaunch masters to apply.' });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- Preset endpoints ---

  app.get('/api/presets', (req, res) => {
    try {
      res.json(db.listPresets());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/presets', (req, res) => {
    try {
      const { name, projectDir: dir, githubRepo, numWorkers } = req.body;
      if (!name || !dir) {
        return res.status(400).json({ ok: false, error: 'name and projectDir are required' });
      }
      if (!SAFE_PATH_RE.test(dir)) {
        return res.status(400).json({ ok: false, error: 'Invalid project directory path' });
      }
      if (githubRepo && !REPO_RE.test(githubRepo)) {
        return res.status(400).json({ ok: false, error: 'Invalid GitHub repo format' });
      }
      db.savePreset(name, dir, githubRepo || '', parseInt(numWorkers) || 4);
      db.log('gui', 'preset_saved', { name, projectDir: dir, githubRepo });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.delete('/api/presets/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: 'Invalid preset id' });
      const deleted = db.deletePreset(id);
      if (!deleted) return res.status(404).json({ ok: false, error: 'Preset not found' });
      db.log('gui', 'preset_deleted', { id });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/setup', (req, res) => {
    const { projectDir: reqProjectDir, githubRepo, numWorkers } = req.body;
    if (!reqProjectDir) {
      return res.status(400).json({ ok: false, error: 'projectDir is required' });
    }
    if (!SAFE_PATH_RE.test(reqProjectDir)) {
      return res.status(400).json({ ok: false, error: 'Invalid project directory path' });
    }
    if (githubRepo && !REPO_RE.test(githubRepo)) {
      return res.status(400).json({ ok: false, error: 'Invalid GitHub repo format. Expected owner/repo.' });
    }
    if (setupProcess) {
      return res.status(409).json({ ok: false, error: 'Setup is already running' });
    }

    const workers = Math.min(Math.max(parseInt(numWorkers) || 4, 1), 8);
    const setupScript = path.join(resolvedScriptDir, 'setup.sh');

    // Save config
    try {
      db.setConfig('project_dir', reqProjectDir);
      db.setConfig('num_workers', String(workers));
      db.setConfig('setup_complete', '0');
      if (githubRepo) {
        db.setConfig('github_repo', githubRepo);
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Failed to save config: ' + e.message });
    }

    db.log('gui', 'setup_started', { projectDir: reqProjectDir, numWorkers: workers });
    broadcast({ type: 'setup_log', line: `Starting setup: ${setupScript} ${reqProjectDir} ${workers}` });

    // Spawn setup.sh
    const env = Object.assign({}, process.env, {
      MAC10_GUI_DIR: path.join(resolvedScriptDir, 'gui', 'public'),
    });

    // Always spawn bash directly — we're already inside the correct environment.
    // (wsl.exe is only needed when opening NEW terminal tabs via wt.exe)
    setupProcess = spawn('bash', [setupScript, reqProjectDir, String(workers)], {
      cwd: resolvedScriptDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Stream stdout
    let buffer = '';
    setupProcess.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        broadcast({ type: 'setup_log', line });
      }
    });

    // Stream stderr
    let errBuffer = '';
    setupProcess.stderr.on('data', (chunk) => {
      errBuffer += chunk.toString();
      const lines = errBuffer.split('\n');
      errBuffer = lines.pop();
      for (const line of lines) {
        broadcast({ type: 'setup_log', line: '[stderr] ' + line });
      }
    });

    setupProcess.on('close', (code) => {
      // Flush remaining buffers
      if (buffer) broadcast({ type: 'setup_log', line: buffer });
      if (errBuffer) broadcast({ type: 'setup_log', line: '[stderr] ' + errBuffer });

      if (code === 0) {
        try {
          db.setConfig('setup_complete', '1');
          // Auto-save as preset on successful setup
          const dir = db.getConfig('project_dir');
          const repo = db.getConfig('github_repo');
          const w = parseInt(db.getConfig('num_workers') || '4');
          if (dir && repo) {
            db.savePreset(repo || path.basename(dir), dir, repo, w);
          }
        } catch {}
      }
      db.log('gui', 'setup_finished', { code });
      broadcast({ type: 'setup_complete', code: code || 0 });
      setupProcess = null;
    });

    setupProcess.on('error', (err) => {
      broadcast({ type: 'setup_log', line: '[error] ' + err.message });
      broadcast({ type: 'setup_complete', code: 1 });
      db.log('gui', 'setup_error', { error: err.message });
      setupProcess = null;
    });

    res.json({ ok: true, message: 'Setup started' });
  });

  // --- Agent launch helper ---
  // Uses launch-agent.sh wrapper to avoid semicolons in WT command line
  // (Windows Terminal treats `;` as its own command separator)

  const launchScript = path.join(resolvedScriptDir, 'scripts', 'launch-agent.sh');

  function launchAgent(title, windowName, model, slashCmd, logTag, res) {
    const repoDir = db.getConfig('project_dir') || projectDir;
    if (!repoDir) {
      return res.status(400).json({ ok: false, error: 'No project directory configured' });
    }
    if (!SAFE_PATH_RE.test(repoDir)) {
      return res.status(400).json({ ok: false, error: 'Invalid project directory path' });
    }
    if (!fs.existsSync(repoDir)) {
      return res.status(400).json({ ok: false, error: 'Project directory does not exist' });
    }

    if (isWSL) {
      const user = process.env.USER || process.env.LOGNAME || 'owner';
      const wt = `/mnt/c/Users/${user}/AppData/Local/Microsoft/WindowsApps/wt.exe`;
      const distro = process.env.WSL_DISTRO_NAME || 'Ubuntu';

      const proc = spawn(wt, [
        '-w', '0', 'new-tab', '--title', title, '--',
        'wsl.exe', '-d', distro, '--',
        'bash', launchScript, repoDir, model, slashCmd
      ], {
        stdio: 'ignore',
        detached: true,
      });
      proc.unref();

      db.log('gui', logTag, { projectDir: repoDir });
      return res.json({ ok: true, message: `${title} terminal opened` });
    }

    // macOS / Linux: open in tmux
    const tmux = require('./tmux');
    try {
      tmux.createWindow(windowName, `bash "${launchScript}" "${repoDir}" ${model} ${slashCmd}`, repoDir);
      db.log('gui', logTag, { projectDir: repoDir, method: 'tmux' });
      return res.json({ ok: true, message: `${title} launched in tmux window "${windowName}"` });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // --- Architect (Master-2) launch endpoint ---

  app.post('/api/architect/launch', (req, res) => {
    launchAgent('Master-2 (Architect)', 'architect', 'opus', '/architect-loop', 'architect_launched', res);
  });

  // --- Master-1 (Interface) launch endpoint ---

  app.post('/api/master1/launch', (req, res) => {
    launchAgent('Master-1 (Interface)', 'master-1', 'sonnet', '/master-loop', 'master1_launched', res);
  });

  // --- Master-3 (Allocator) launch endpoint ---

  app.post('/api/master3/launch', (req, res) => {
    launchAgent('Master-3 (Allocator)', 'master-3', 'sonnet', '/allocate-loop', 'master3_launched', res);
  });

  // --- Git push endpoint ---

  app.post('/api/git/push', (req, res) => {
    const repoDir = db.getConfig('project_dir') || projectDir;
    const repo = db.getConfig('github_repo');
    if (!repoDir) {
      return res.status(400).json({ ok: false, error: 'No project directory configured' });
    }
    if (!SAFE_PATH_RE.test(repoDir)) {
      return res.status(400).json({ ok: false, error: 'Invalid project directory path' });
    }
    if (!repo) {
      return res.status(400).json({ ok: false, error: 'No GitHub repo configured. Set it in the Setup panel.' });
    }
    if (!REPO_RE.test(repo)) {
      return res.status(400).json({ ok: false, error: 'Invalid GitHub repo format. Expected owner/repo.' });
    }

    db.log('gui', 'git_push_started', { repo, projectDir: repoDir });

    // Ensure remote is set, then push
    // Uses env vars (MAC10_REPO, MAC10_REPO_DIR) to avoid shell interpolation
    const script = [
      'set -e',
      'CURRENT_REMOTE=$(git remote get-url origin 2>/dev/null || echo "")',
      'TARGET="https://github.com/${MAC10_REPO}.git"',
      'SSH_TARGET="git@github.com:${MAC10_REPO}.git"',
      'if [ "$CURRENT_REMOTE" != "$TARGET" ] && [ "$CURRENT_REMOTE" != "$SSH_TARGET" ]; then',
      '  if [ -z "$CURRENT_REMOTE" ]; then',
      '    git remote add origin "$TARGET"',
      '    echo "Added remote origin: $TARGET"',
      '  else',
      '    git remote set-url origin "$TARGET"',
      '    echo "Updated remote origin: $TARGET"',
      '  fi',
      'fi',
      'echo "Remote: $(git remote get-url origin)"',
      'echo "Branch: $(git branch --show-current)"',
      'echo ""',
      'git push -u origin "$(git branch --show-current)" 2>&1',
    ].join('\n');

    const pushEnv = { ...process.env, MAC10_REPO: repo, MAC10_REPO_DIR: repoDir };
    // Spawn bash directly — already inside the correct environment
    const pushProc = spawn('bash', ['-c', script], {
      cwd: repoDir,
      env: pushEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    pushProc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        broadcast({ type: 'git_push_log', line });
      }
    });

    let errBuf = '';
    pushProc.stderr.on('data', (chunk) => {
      errBuf += chunk.toString();
      const lines = errBuf.split('\n');
      errBuf = lines.pop();
      for (const line of lines) {
        broadcast({ type: 'git_push_log', line });
      }
    });

    pushProc.on('close', (code) => {
      if (buf) broadcast({ type: 'git_push_log', line: buf });
      if (errBuf) broadcast({ type: 'git_push_log', line: errBuf });
      db.log('gui', 'git_push_finished', { code, repo });
      broadcast({ type: 'git_push_complete', code: code || 0 });
    });

    pushProc.on('error', (err) => {
      broadcast({ type: 'git_push_log', line: 'Error: ' + err.message });
      broadcast({ type: 'git_push_complete', code: 1 });
      db.log('gui', 'git_push_error', { error: err.message });
    });

    res.json({ ok: true, message: 'Push started' });
  });

  // --- Instance management endpoints ---

  app.get('/api/instances', (req, res) => {
    try {
      const instances = instanceRegistry.list();
      res.json(instances.map(inst => ({
        ...inst,
        isSelf: inst.port === port,
      })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/instances/launch', async (req, res) => {
    const { projectDir: reqDir, githubRepo, numWorkers } = req.body;
    if (!reqDir) {
      return res.status(400).json({ ok: false, error: 'projectDir is required' });
    }
    if (!SAFE_PATH_RE.test(reqDir)) {
      return res.status(400).json({ ok: false, error: 'Invalid project directory path' });
    }

    // Check for duplicate
    const existing = instanceRegistry.findByProject(reqDir);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'A coordinator is already running for this project', port: existing.port });
    }

    try {
      // Validate project directory exists (do not create arbitrary directories)
      if (!fs.existsSync(reqDir)) {
        return res.status(400).json({ ok: false, error: 'Project directory does not exist' });
      }

      const newPort = await instanceRegistry.acquirePort(3100);
      const env = { ...process.env, MAC10_PORT: String(newPort) };

      const indexPath = path.join(__dirname, 'index.js');
      // Spawn node directly — already inside the correct environment
      const child = spawn('node', [indexPath, reqDir], {
        env,
        stdio: 'ignore',
        detached: true,
      });
      child.unref();

      // Wait for the new coordinator to start and register
      await new Promise(r => setTimeout(r, 2000));

      // Seed config into the new coordinator's API
      const configBody = JSON.stringify({
        projectDir: reqDir,
        githubRepo: githubRepo || '',
        numWorkers: parseInt(numWorkers) || 4,
      });
      try {
        await new Promise((resolve, reject) => {
          const configReq = http.request({
            hostname: '127.0.0.1', port: newPort, path: '/api/config',
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(configBody) },
          }, (configRes) => { configRes.resume(); resolve(); });
          configReq.on('error', reject);
          configReq.write(configBody);
          configReq.end();
        });
      } catch (e) {
        console.error('Failed to seed config into new instance:', e.message);
      }

      const name = path.basename(reqDir);
      db.log('gui', 'instance_launched', { projectDir: reqDir, port: newPort, githubRepo });
      res.json({ ok: true, port: newPort, name });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/instances/stop', (req, res) => {
    const { port: targetPort } = req.body;
    if (!targetPort || targetPort === port) {
      return res.status(400).json({ ok: false, error: 'Cannot stop self or missing port' });
    }
    try {
      const instances = instanceRegistry.list();
      const target = instances.find(i => i.port === targetPort);
      if (!target) {
        return res.status(404).json({ ok: false, error: 'Instance not found' });
      }
      if (!Number.isInteger(target.pid) || target.pid <= 0) {
        return res.status(400).json({ ok: false, error: 'Invalid PID for target instance' });
      }
      try {
        process.kill(target.pid, 'SIGTERM');
      } catch {}
      instanceRegistry.deregister(targetPort);
      db.log('gui', 'instance_stopped', { port: targetPort, pid: target.pid });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- Changes endpoints ---

  app.get('/api/changes', (req, res) => {
    try {
      const filters = {};
      if (req.query.domain) filters.domain = req.query.domain;
      if (req.query.status) filters.status = req.query.status;
      res.json(db.listChanges(filters));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/changes', (req, res) => {
    try {
      const { description, domain, file_path, function_name, tooltip, status } = req.body;
      if (!description) {
        return res.status(400).json({ ok: false, error: 'description is required' });
      }
      const id = db.createChange({ description, domain, file_path, function_name, tooltip, status });
      const change = db.getChange(id);
      db.log('gui', 'change_created', { change_id: id, description });
      broadcast({ type: 'change_created', change });
      res.json({ ok: true, change_id: id, change });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.patch('/api/changes/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: 'Invalid change id' });
      const existing = db.getChange(id);
      if (!existing) return res.status(404).json({ ok: false, error: 'Change not found' });
      const allowed = ['enabled', 'status', 'description', 'tooltip'];
      const fields = {};
      for (const k of allowed) {
        if (req.body[k] !== undefined) fields[k] = req.body[k];
      }
      if (Object.keys(fields).length === 0) {
        return res.status(400).json({ ok: false, error: 'No valid fields to update' });
      }
      db.updateChange(id, fields);
      const updated = db.getChange(id);
      broadcast({ type: 'change_updated', change: updated });
      res.json({ ok: true, change: updated });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --- Shutdown endpoint ---

  app.post('/api/shutdown', (req, res) => {
    res.json({ ok: true, message: 'Coordinator shutting down' });
    db.log('coordinator', 'manual_shutdown', { source: 'gui' });
    setTimeout(() => {
      if (callbacks.onShutdown) callbacks.onShutdown();
    }, 500);
  });

  // --- Loop endpoints ---

  app.get('/api/loops', (req, res) => {
    try {
      res.json(db.listLoops(req.query));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/loop/start', (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ ok: false, error: 'prompt is required and must be a string' });
      }
      const loopId = db.createLoop(prompt);
      const loop = db.getLoop(loopId);

      // Spawn sentinel via tmux
      const sentinelPath = path.join(resolvedScriptDir, 'scripts', 'loop-sentinel.sh');
      const repoDir = db.getConfig('project_dir') || projectDir;
      const tmux = require('./tmux');
      if (tmux.isAvailable()) {
        const windowName = `loop-${loopId}`;
        tmux.createWindow(windowName, `bash "${sentinelPath}" "${loopId}" "${repoDir}"`, repoDir);
      }

      db.log('gui', 'loop_started', { loop_id: loopId, prompt });
      broadcast({ type: 'loop_started', loop_id: loopId });
      res.json({ ok: true, loop_id: loopId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/loop/stop', (req, res) => {
    try {
      const { loop_id } = req.body;
      if (!loop_id || typeof loop_id !== 'string') {
        return res.status(400).json({ ok: false, error: 'loop_id is required' });
      }
      const loop = db.getLoop(loop_id);
      if (!loop) {
        return res.status(404).json({ ok: false, error: `Loop ${loop_id} not found` });
      }
      db.updateLoop(loop_id, { status: 'stopped', stopped_at: new Date().toISOString() });
      db.log('gui', 'loop_stopped', { loop_id });
      broadcast({ type: 'loop_stopped', loop_id });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // WebSocket for live updates + auto-shutdown on zero clients
  wss.on('connection', (ws) => {
    activeClientCount++;
    if (shutdownTimerId) {
      clearTimeout(shutdownTimerId);
      shutdownTimerId = null;
    }

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {}); // prevent unhandled error crashes

    ws.on('close', () => {
      activeClientCount--;
      if (activeClientCount <= 0 && !shutdownTimerId) {
        shutdownTimerId = setTimeout(() => {
          console.log('All GUI clients disconnected — shutting down coordinator.');
          db.log('coordinator', 'auto_shutdown', { reason: 'no_gui_clients', grace_ms: SHUTDOWN_GRACE_MS });
          if (callbacks.onShutdown) callbacks.onShutdown();
        }, SHUTDOWN_GRACE_MS);
      }
    });

    // Send initial state
    try {
      ws.send(JSON.stringify({
        type: 'init',
        data: {
          requests: db.listRequests(),
          workers: db.getAllWorkers(),
          tasks: db.listTasks(),
        },
      }));
    } catch {}
  });

  // Periodic broadcast of state
  broadcastIntervalId = setInterval(() => {
    broadcast({
      type: 'state',
      data: {
        requests: db.listRequests(),
        workers: db.getAllWorkers(),
        tasks: db.listTasks(),
      },
    });
  }, 2000);

  // Ping/pong to detect and terminate stale WebSocket connections
  pingIntervalId = setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    });
  }, 30000);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`WARNING: Port ${port} already in use — web dashboard not started. Coordinator continues without GUI.`);
      db.log('coordinator', 'web_server_port_conflict', { port, error: err.message });
    } else {
      console.error(`Web server error: ${err.message}`);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    db.log('coordinator', 'web_server_started', { port, host: '127.0.0.1' });
  });

  return server;
}

function broadcast(data) {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch {}
    }
  });
}

function stop() {
  if (shutdownTimerId) { clearTimeout(shutdownTimerId); shutdownTimerId = null; }
  if (broadcastIntervalId) { clearInterval(broadcastIntervalId); broadcastIntervalId = null; }
  if (pingIntervalId) { clearInterval(pingIntervalId); pingIntervalId = null; }
  if (setupProcess) {
    try { setupProcess.kill(); } catch {}
    setupProcess = null;
  }
  if (wss) { wss.close(); wss = null; }
  if (server) { server.close(); server = null; }
}

module.exports = { start, stop, broadcast };
