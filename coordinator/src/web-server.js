'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('./db');
const hotkeyManager = require('./hotkey-manager');
const { parse, validate } = require('./script-parser');
const { execute } = require('./script-executor');

const REPO_RE = /^(https?:\/\/github\.com\/)?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(\.git)?$/;
const SAFE_PATH_RE = /^\/[a-zA-Z0-9._\/ -]+$/;

let server = null;
let wss = null;
let setupProcess = null;

function start(projectDir, port = 3100, scriptDir = null) {
  const app = express();
  server = http.createServer(app);
  wss = new WebSocket.Server({ server });

  // Resolve scriptDir (mac10 repo root containing setup.sh)
  const resolvedScriptDir = scriptDir || path.join(__dirname, '..', '..');

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
      const limit = parseInt(req.query.limit) || 100;
      res.json(db.getLog(limit, req.query.actor));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/request', (req, res) => {
    try {
      const id = db.createRequest(req.body.description);
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
      db.log('gui', 'config_updated', { projectDir: newDir, githubRepo, numWorkers });
      res.json({ ok: true, message: 'Config saved. Relaunch masters to apply.' });
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
        try { db.setConfig('setup_complete', '1'); } catch {}
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
  const isWSL = fs.existsSync('/proc/version') &&
    (() => { try { return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft'); } catch { return false; } })();

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

    const pushProc = spawn('bash', ['-c', script], {
      cwd: repoDir,
      env: { ...process.env, MAC10_REPO: repo, MAC10_REPO_DIR: repoDir },
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

  // --- Hotkey scripting API ---

  // Ensure hotkey schema exists
  try { hotkeyManager.ensureSchema(db.getDb()); } catch {}

  // List hotkeys for a profile
  app.get('/api/hotkeys', (req, res) => {
    try {
      const profile = req.query.profile || 'default';
      const hotkeys = hotkeyManager.listHotkeys(db.getDb(), profile);
      res.json(hotkeys);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // List all profiles
  app.get('/api/hotkeys/profiles', (req, res) => {
    try {
      res.json(hotkeyManager.listProfiles(db.getDb()));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get a single hotkey
  app.get('/api/hotkeys/:id', (req, res) => {
    try {
      const hotkey = hotkeyManager.getHotkey(db.getDb(), parseInt(req.params.id, 10));
      if (!hotkey) return res.status(404).json({ error: 'Hotkey not found' });
      res.json(hotkey);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Create a new hotkey
  app.post('/api/hotkeys', (req, res) => {
    try {
      const { name, keyCombo, script, profile, description } = req.body;
      if (!name || !keyCombo || !script) {
        return res.status(400).json({ error: 'name, keyCombo, and script are required' });
      }
      const result = hotkeyManager.createHotkey(db.getDb(), { name, keyCombo, script, profile, description });
      if (result.errors.length > 0) {
        return res.status(400).json({ ok: false, errors: result.errors, warnings: result.warnings });
      }
      db.log('gui', 'hotkey_created', { id: result.id, name, keyCombo });
      res.json({ ok: true, id: result.id, warnings: result.warnings });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE constraint')) {
        return res.status(409).json({ error: 'A hotkey with that key combination already exists in this profile' });
      }
      res.status(500).json({ error: e.message });
    }
  });

  // Update a hotkey
  app.put('/api/hotkeys/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const result = hotkeyManager.updateHotkey(db.getDb(), id, req.body);
      if (!result.success) {
        return res.status(400).json({ ok: false, errors: result.errors });
      }
      db.log('gui', 'hotkey_updated', { id });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete a hotkey
  app.delete('/api/hotkeys/:id', (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const deleted = hotkeyManager.deleteHotkey(db.getDb(), id);
      if (!deleted) return res.status(404).json({ error: 'Hotkey not found' });
      db.log('gui', 'hotkey_deleted', { id });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Trigger a hotkey (execute its script)
  app.post('/api/hotkeys/trigger', (req, res) => {
    try {
      const { keyCombo, marketContext, profile } = req.body;
      if (!keyCombo) {
        return res.status(400).json({ error: 'keyCombo is required' });
      }
      const result = hotkeyManager.triggerHotkey(db.getDb(), keyCombo, marketContext || {}, profile || 'default');
      if (!result.found) {
        return res.status(404).json({ error: 'No hotkey bound to that key combination' });
      }
      db.log('gui', 'hotkey_triggered', { keyCombo, hotkeyId: result.hotkey.id, name: result.hotkey.name });
      // Broadcast execution event via WebSocket
      broadcast({
        type: 'hotkey_executed',
        hotkey: result.hotkey,
        result: result.result,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Parse/validate a script without executing (for editor feedback)
  app.post('/api/hotkeys/validate', (req, res) => {
    try {
      const { script } = req.body;
      if (!script) {
        return res.status(400).json({ error: 'script is required' });
      }
      const { commands, errors } = parse(script);
      const warnings = errors.length === 0 ? validate(commands) : [];
      res.json({ valid: errors.length === 0, commands: commands.length, errors, warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dry-run a script (parse + execute with mock context)
  app.post('/api/hotkeys/dry-run', (req, res) => {
    try {
      const { script, marketContext } = req.body;
      if (!script) {
        return res.status(400).json({ error: 'script is required' });
      }
      const result = execute(script, marketContext || {});
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Import hotkeys from JSON
  app.post('/api/hotkeys/import', (req, res) => {
    try {
      const { hotkeys, profile } = req.body;
      if (!Array.isArray(hotkeys)) {
        return res.status(400).json({ error: 'hotkeys must be an array' });
      }
      const results = hotkeyManager.importHotkeys(db.getDb(), hotkeys, profile || 'default');
      db.log('gui', 'hotkeys_imported', { count: hotkeys.length, profile: profile || 'default' });
      res.json({ ok: true, results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Export hotkeys as JSON
  app.get('/api/hotkeys/export/:profile', (req, res) => {
    try {
      const exported = hotkeyManager.exportHotkeys(db.getDb(), req.params.profile);
      res.json(exported);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // WebSocket for live updates
  wss.on('connection', (ws) => {
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
  setInterval(() => {
    broadcast({
      type: 'state',
      data: {
        requests: db.listRequests(),
        workers: db.getAllWorkers(),
        tasks: db.listTasks(),
      },
    });
  }, 2000);

  server.listen(port, () => {
    db.log('coordinator', 'web_server_started', { port });
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
  if (setupProcess) {
    try { setupProcess.kill(); } catch {}
    setupProcess = null;
  }
  if (wss) { wss.close(); wss = null; }
  if (server) { server.close(); server = null; }
}

module.exports = { start, stop, broadcast };
