'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const db = require('./db');

let server = null;
let tcpServer = null;

const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

const COMMAND_SCHEMAS = {
  'request':           { required: ['description'], types: { description: 'string' } },
  'fix':               { required: ['description'], types: { description: 'string' } },
  'status':            { required: [], types: {} },
  'clarify':           { required: ['request_id', 'message'], types: { request_id: 'string', message: 'string' } },
  'log':               { required: [], types: { limit: 'number', actor: 'string' } },
  'triage':            { required: ['request_id', 'tier'], types: { request_id: 'string', tier: 'number', reasoning: 'string' } },
  'create-task':       {
    required: ['request_id', 'subject', 'description'],
    types: { request_id: 'string', subject: 'string', description: 'string', domain: 'string', priority: 'string', tier: 'number' },
    allowed: ['request_id', 'subject', 'description', 'domain', 'files', 'priority', 'tier', 'depends_on', 'validation'],
  },
  'tier1-complete':    { required: ['request_id', 'result'], types: { request_id: 'string', result: 'string' } },
  'ask-clarification': { required: ['request_id', 'question'], types: { request_id: 'string', question: 'string' } },
  'my-task':           { required: ['worker_id'], types: { worker_id: 'string' } },
  'start-task':        { required: ['worker_id', 'task_id'], types: { worker_id: 'string' } },
  'heartbeat':         { required: ['worker_id'], types: { worker_id: 'string' } },
  'complete-task':     { required: ['worker_id', 'task_id'], types: { worker_id: 'string' } },
  'fail-task':         { required: ['worker_id', 'task_id', 'error'], types: { worker_id: 'string', error: 'string' } },
  'distill':           { required: ['worker_id'], types: { worker_id: 'string' } },
  'inbox':             { required: ['recipient'], types: { recipient: 'string' } },
  'inbox-block':       { required: ['recipient'], types: { recipient: 'string', timeout: 'number' } },
  'ready-tasks':       { required: [], types: {} },
  'assign-task':       { required: ['task_id', 'worker_id'], types: { task_id: 'number', worker_id: 'number' } },
  'claim-worker':      { required: ['worker_id', 'claimer'], types: { worker_id: 'number', claimer: 'string' } },
  'release-worker':    { required: ['worker_id'], types: { worker_id: 'number' } },
  'worker-status':     { required: [], types: {} },
  'check-completion':  { required: ['request_id'], types: { request_id: 'string' } },
  'register-worker':   { required: ['worker_id'], types: { worker_id: 'string', worktree_path: 'string', branch: 'string' } },
  'repair':            { required: [], types: {} },
  'ping':              { required: [], types: {} },
  'add-worker':        { required: [], types: {} },
  'merge-status':      { required: [], types: { request_id: 'string' } },
  'reset-worker':      { required: ['worker_id'], types: { worker_id: 'string' } },
  'check-overlaps':    { required: ['request_id'], types: { request_id: 'string' } },
  'log-change':        {
    required: ['description'],
    types: { description: 'string', domain: 'string', file_path: 'string', function_name: 'string', tooltip: 'string', status: 'string' },
    allowed: ['description', 'domain', 'file_path', 'function_name', 'tooltip', 'status'],
  },
  'list-changes':      { required: [], types: { domain: 'string', status: 'string' } },
  'update-change':     { required: ['id'], types: { id: 'number' } },
  'integrate':         { required: ['request_id'], types: { request_id: 'string' } },
  'reset-merges':      { required: [], types: { request_id: 'string' } },
  'history':           { required: ['request_id'], types: { request_id: 'string' } },
  'shutdown':          { required: [], types: {} },
  'loop':              { required: ['prompt'], types: { prompt: 'string' } },
  'stop-loop':         { required: ['loop_id'], types: {} },
  'loop-status':       { required: [], types: {} },
  'loop-prompt':       { required: ['loop_id'], types: {} },
  'loop-requests':     { required: ['loop_id'], types: {} },
  'loop-request':      { required: ['loop_id', 'description'], types: { description: 'string' } },
  'loop-heartbeat':    { required: ['loop_id'], types: {} },
  'loop-checkpoint':   { required: ['loop_id', 'checkpoint'], types: { checkpoint: 'string' } },
};

/** Parse a files field into an array. Handles arrays, JSON strings, and comma-separated strings. */
function parseFilesField(files) {
  if (Array.isArray(files)) return files;
  if (typeof files === 'string') {
    try { return JSON.parse(files); } catch { return files.split(',').map(f => f.trim()); }
  }
  return null;
}

function validateCommand(cmd) {
  const { command, args } = cmd;
  if (typeof command !== 'string') {
    throw new Error('Missing or invalid "command" field');
  }
  const schema = COMMAND_SCHEMAS[command];
  if (!schema) return; // unknown commands handled by switch default

  const a = args || {};
  for (const field of schema.required) {
    if (a[field] === undefined || a[field] === null) {
      throw new Error(`Missing required field "${field}" for command "${command}"`);
    }
  }
  for (const [field, expectedType] of Object.entries(schema.types)) {
    if (a[field] !== undefined && a[field] !== null && typeof a[field] !== expectedType) {
      throw new Error(`Field "${field}" must be of type ${expectedType}`);
    }
  }
  // Strip unknown keys for create-task
  if (schema.allowed && args) {
    for (const key of Object.keys(args)) {
      if (!schema.allowed.includes(key)) {
        delete args[key];
      }
    }
  }
}

function getSocketPath(projectDir) {
  const dir = path.join(projectDir, '.claude', 'state');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    // Windows: use named pipes (Unix sockets have limited support)
    const hash = crypto.createHash('md5').update(projectDir).digest('hex').slice(0, 12);
    const pipePath = `\\\\.\\pipe\\mac10-${hash}`;
    fs.writeFileSync(path.join(dir, 'mac10.pipe'), pipePath, 'utf8');
    return pipePath;
  }
  // On WSL2, /mnt/c/ (NTFS) doesn't support Unix sockets — use /tmp/ instead
  const hash = crypto.createHash('md5').update(projectDir).digest('hex').slice(0, 12);
  const sockPath = `/tmp/mac10-${hash}.sock`;
  // Write the socket path so the CLI can find it
  fs.writeFileSync(path.join(dir, 'mac10.sock.path'), sockPath, 'utf8');
  return sockPath;
}

function createConnectionHandler(handlers) {
  return (conn) => {
    let data = '';
    conn.on('data', (chunk) => {
      data += chunk.toString();
      if (data.length > MAX_PAYLOAD_SIZE) {
        respond(conn, { error: 'Payload too large' });
        conn.destroy();
        return;
      }
      // Protocol: newline-delimited JSON
      const lines = data.split('\n');
      data = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const cmd = JSON.parse(line);
          validateCommand(cmd);
          handleCommand(cmd, conn, handlers);
        } catch (e) {
          respond(conn, { error: e.message });
        }
      }
    });
    conn.on('end', () => {
      // Process any remaining complete line in the buffer
      if (data.trim()) {
        try {
          const cmd = JSON.parse(data);
          validateCommand(cmd);
          handleCommand(cmd, conn, handlers);
        } catch {} // connection closing — best effort
      }
    });
    conn.on('error', () => {}); // ignore broken pipe
  };
}

function start(projectDir, handlers) {
  const socketPath = getSocketPath(projectDir);
  const connHandler = createConnectionHandler(handlers);

  // Clean up stale socket (not needed for Windows named pipes)
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(socketPath); } catch {}
  }

  // Primary listener: Unix socket (WSL/macOS) or named pipe (Windows)
  server = net.createServer(connHandler);
  server.listen(socketPath, () => {
    if (process.platform !== 'win32') {
      try { fs.chmodSync(socketPath, 0o600); } catch {}
    }
  });

  // TCP bridge: allows cross-environment access (Git Bash ↔ WSL, remote agents)
  // Derive a stable per-project port from the same hash used for sockets (range 31000-31999)
  const portHash = crypto.createHash('md5').update(projectDir).digest('hex');
  const derivedPort = 31000 + (parseInt(portHash.slice(0, 4), 16) % 1000);
  const tcpPort = parseInt(process.env.MAC10_CLI_PORT) || derivedPort;
  const stateDir = path.join(projectDir, '.claude', 'state');
  tcpServer = net.createServer(connHandler);
  tcpServer.listen(tcpPort, '127.0.0.1', () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'mac10.tcp.port'), String(tcpPort), 'utf8');
    console.log(`CLI TCP bridge listening on localhost:${tcpPort}`);
  });
  tcpServer.on('error', (e) => {
    // Port in use — not fatal, Unix socket still works
    console.warn(`TCP bridge failed (port ${tcpPort}): ${e.message}`);
  });

  return server;
}

function stop() {
  if (server) { server.close(); server = null; }
  if (tcpServer) { tcpServer.close(); tcpServer = null; }
}

function respond(conn, data) {
  try {
    conn.write(JSON.stringify(data) + '\n');
  } catch {}
}

function handleCommand(cmd, conn, handlers) {
  const { command, args } = cmd;

  try {
    switch (command) {
      // === USER commands ===
      case 'request': {
        const id = db.createRequest(args.description);
        respond(conn, { ok: true, request_id: id });
        break;
      }
      case 'fix': {
        const fixResult = db.getDb().transaction(() => {
          const id = db.createRequest(args.description);
          db.updateRequest(id, { tier: 2, status: 'decomposed' });
          const taskId = db.createTask({
            request_id: id,
            subject: `Fix: ${args.description}`,
            description: args.description,
            priority: 'urgent',
            tier: 2,
          });
          db.updateTask(taskId, { status: 'ready' });
          db.log('user', 'urgent_fix_created', { request_id: id, task_id: taskId, description: args.description });
          return { request_id: id, task_id: taskId };
        })();
        respond(conn, { ok: true, ...fixResult });
        break;
      }
      case 'status': {
        const requests = db.listRequests();
        const workers = db.getAllWorkers();
        const tasks = db.listTasks();
        const project_dir = db.getConfig('project_dir') || '';
        const merges = db.getDb().prepare(
          "SELECT * FROM merge_queue WHERE status != 'merged' ORDER BY id DESC"
        ).all();
        respond(conn, { ok: true, requests, workers, tasks, project_dir, merges });
        break;
      }
      case 'clarify': {
        db.sendMail('architect', 'clarification_reply', {
          request_id: args.request_id,
          message: args.message,
        });
        db.log('user', 'clarification_answered', { request_id: args.request_id, message: args.message });
        respond(conn, { ok: true });
        break;
      }
      case 'log': {
        const logs = db.getLog(args.limit || 50, args.actor);
        respond(conn, { ok: true, logs });
        break;
      }

      // === ARCHITECT commands ===
      case 'triage': {
        const { request_id, tier, reasoning } = args;
        db.updateRequest(request_id, { tier, status: tier === 1 ? 'executing_tier1' : 'decomposed' });
        db.log('architect', 'triage', { request_id, tier, reasoning });
        if (tier === 3) {
          db.sendMail('allocator', 'tasks_ready', { request_id });
        }
        respond(conn, { ok: true });
        break;
      }
      case 'create-task': {
        const taskId = db.createTask(args);
        // If no dependencies, mark ready immediately
        if (!args.depends_on || args.depends_on.length === 0) {
          db.updateTask(taskId, { status: 'ready' });
        }
        // Detect file overlaps with other tasks in the same request
        let overlaps = [];
        const taskFiles = parseFilesField(args.files);
        if (taskFiles && taskFiles.length > 0) {
          overlaps = db.findOverlappingTasks(args.request_id, taskFiles);
          if (overlaps.length > 0) {
            // Set overlap_with on the new task
            const overlapIds = overlaps.map(o => o.task_id);
            db.updateTask(taskId, { overlap_with: JSON.stringify(overlapIds) });
            // Update existing overlapping tasks to include the new task
            for (const o of overlaps) {
              const existing = db.getTask(o.task_id);
              let existingOverlaps = [];
              if (existing && existing.overlap_with) {
                try { existingOverlaps = JSON.parse(existing.overlap_with); } catch {}
              }
              if (!existingOverlaps.includes(taskId)) {
                existingOverlaps.push(taskId);
                db.updateTask(o.task_id, { overlap_with: JSON.stringify(existingOverlaps) });
              }
            }
            db.log('coordinator', 'overlap_detected', {
              task_id: taskId,
              request_id: args.request_id,
              overlaps: overlaps.map(o => ({ task_id: o.task_id, shared_files: o.shared_files })),
            });
          }
        }
        respond(conn, { ok: true, task_id: taskId, overlaps });
        break;
      }
      case 'tier1-complete': {
        const { request_id, result } = args;
        db.updateRequest(request_id, { status: 'completed', result, completed_at: new Date().toISOString() });
        db.sendMail('master-1', 'request_completed', { request_id, result });
        db.log('architect', 'tier1_complete', { request_id, result });
        respond(conn, { ok: true });
        break;
      }
      case 'ask-clarification': {
        db.sendMail('master-1', 'clarification_ask', {
          request_id: args.request_id,
          question: args.question,
        });
        db.log('architect', 'clarification_ask', { request_id: args.request_id, question: args.question });
        respond(conn, { ok: true });
        break;
      }

      // === WORKER commands ===
      case 'my-task': {
        const worker = db.getWorker(args.worker_id);
        if (!worker || !worker.current_task_id) {
          respond(conn, { ok: true, task: null });
          break;
        }
        const task = db.getTask(worker.current_task_id);
        respond(conn, { ok: true, task });
        break;
      }
      case 'start-task': {
        const { worker_id, task_id } = args;
        db.updateTask(task_id, { status: 'in_progress', started_at: new Date().toISOString() });
        db.updateWorker(worker_id, { status: 'busy', last_heartbeat: new Date().toISOString() });
        db.log(`worker-${worker_id}`, 'task_started', { task_id });
        respond(conn, { ok: true });
        break;
      }
      case 'heartbeat': {
        db.updateWorker(args.worker_id, { last_heartbeat: new Date().toISOString() });
        respond(conn, { ok: true });
        break;
      }
      case 'complete-task': {
        const { worker_id, task_id, pr_url, result, branch } = args;
        db.updateTask(task_id, {
          status: 'completed',
          pr_url: pr_url || null,
          branch: branch || null,
          result: result || null,
          completed_at: new Date().toISOString(),
        });
        // Increment tasks_completed counter on worker
        const workerRow = db.getWorker(worker_id);
        const tasksCompleted = (workerRow ? workerRow.tasks_completed : 0) + 1;
        db.updateWorker(worker_id, {
          status: 'completed_task',
          current_task_id: null,
          tasks_completed: tasksCompleted,
        });
        // Enqueue merge if PR exists (must be a valid URL, not a status string like "already_merged")
        const completedTask = db.getTask(task_id);
        const isValidPrUrl = pr_url && /^https:\/\//.test(pr_url);
        if (isValidPrUrl) {
          db.enqueueMerge({
            request_id: completedTask.request_id,
            task_id,
            pr_url,
            branch: branch || '',
            priority: completedTask.priority === 'urgent' ? 10 : 0,
          });
        }
        db.sendMail('allocator', 'task_completed', {
          worker_id, task_id,
          request_id: completedTask.request_id,
          pr_url,
          tasks_completed: tasksCompleted,
        });
        // Notify architect so it has visibility into Tier 2 outcomes
        db.sendMail('architect', 'task_completed', {
          worker_id, task_id,
          request_id: completedTask.request_id,
          pr_url,
          result,
        });
        db.log(`worker-${worker_id}`, 'task_completed', { task_id, pr_url, result, tasks_completed: tasksCompleted });
        // Notify handlers for merge check
        if (handlers.onTaskCompleted) handlers.onTaskCompleted(task_id);
        respond(conn, { ok: true });
        break;
      }
      case 'fail-task': {
        const { worker_id: wid, task_id: tid, error } = args;
        const failedTask = db.getTask(tid);
        db.updateTask(tid, { status: 'failed', result: error, completed_at: new Date().toISOString() });
        db.updateWorker(wid, { status: 'idle', current_task_id: null });
        db.sendMail('allocator', 'task_failed', {
          worker_id: wid,
          task_id: tid,
          request_id: failedTask ? failedTask.request_id : null,
          error,
        });
        // Also notify architect so it has visibility into failures
        db.sendMail('architect', 'task_failed', {
          worker_id: wid,
          task_id: tid,
          request_id: failedTask ? failedTask.request_id : null,
          error,
        });
        db.log(`worker-${wid}`, 'task_failed', { task_id: tid, error });
        respond(conn, { ok: true });
        break;
      }
      case 'distill': {
        db.log(`worker-${args.worker_id}`, 'distill', { domain: args.domain, content: args.content });
        respond(conn, { ok: true });
        break;
      }

      // === SHARED commands ===
      case 'inbox': {
        const msgs = db.checkMail(args.recipient, !args.peek);
        respond(conn, { ok: true, messages: msgs });
        break;
      }
      case 'inbox-block': {
        // Async blocking inbox check — polls without freezing the event loop
        const recipient = args.recipient;
        const timeoutMs = args.timeout || 300000;
        const pollMs = 1000;
        const deadline = Date.now() + timeoutMs;
        let cancelled = false;

        conn.on('close', () => { cancelled = true; });
        conn.on('end', () => { cancelled = true; });
        conn.on('error', () => { cancelled = true; });

        const poll = () => {
          if (cancelled) return;
          try {
            const msgs = db.checkMail(recipient);
            if (msgs.length > 0) {
              respond(conn, { ok: true, messages: msgs });
              return;
            }
            if (Date.now() >= deadline) {
              respond(conn, { ok: true, messages: [] });
              return;
            }
            setTimeout(poll, pollMs);
          } catch (e) {
            respond(conn, { error: e.message });
          }
        };
        poll();
        break;
      }

      // === ALLOCATOR commands ===
      case 'ready-tasks': {
        const tasks = db.getReadyTasks();
        respond(conn, { ok: true, tasks });
        break;
      }
      case 'assign-task': {
        const { task_id: assignTaskId, worker_id: assignWorkerId } = args;
        // Atomic assignment: same pattern as allocator.js assignTaskToWorker
        const assignResult = db.getDb().transaction(() => {
          const freshTask = db.getTask(assignTaskId);
          const freshWorker = db.getWorker(assignWorkerId);
          if (!freshTask || freshTask.status !== 'ready' || freshTask.assigned_to) return { ok: false, reason: 'task_not_ready' };
          if (!freshWorker || freshWorker.status !== 'idle') return { ok: false, reason: 'worker_not_idle' };

          db.updateTask(assignTaskId, { status: 'assigned', assigned_to: assignWorkerId });
          db.updateWorker(assignWorkerId, {
            status: 'assigned',
            current_task_id: assignTaskId,
            domain: freshTask.domain || freshWorker.domain,
            claimed_by: null,
            launched_at: new Date().toISOString(),
          });
          return { ok: true, task: freshTask, worker: freshWorker };
        })();

        if (!assignResult.ok) {
          respond(conn, { ok: false, error: assignResult.reason });
          break;
        }

        // Send mail to worker
        const assignedTask = db.getTask(assignTaskId);
        db.sendMail(`worker-${assignWorkerId}`, 'task_assigned', {
          task_id: assignTaskId,
          subject: assignedTask.subject,
          description: assignedTask.description,
          domain: assignedTask.domain,
          files: assignedTask.files,
          tier: assignedTask.tier,
          request_id: assignedTask.request_id,
          validation: assignedTask.validation,
        });
        db.log('allocator', 'task_assigned', { task_id: assignTaskId, worker_id: assignWorkerId, domain: assignedTask.domain });

        // Trigger tmux spawn via handler — revert assignment on failure
        if (handlers.onAssignTask) {
          try {
            handlers.onAssignTask(assignedTask, db.getWorker(assignWorkerId));
          } catch (spawnErr) {
            db.updateTask(assignTaskId, { status: 'ready', assigned_to: null });
            db.updateWorker(assignWorkerId, { status: 'idle', current_task_id: null, launched_at: null });
            db.log('coordinator', 'assign_handler_failed', { task_id: assignTaskId, worker_id: assignWorkerId, error: spawnErr.message });
            respond(conn, { ok: false, error: `Failed to spawn worker: ${spawnErr.message}` });
            break;
          }
        }

        respond(conn, { ok: true, task_id: assignTaskId, worker_id: assignWorkerId });
        break;
      }
      case 'claim-worker': {
        const success = db.claimWorker(args.worker_id, args.claimer);
        if (success) db.log(args.claimer, 'worker_claimed', { worker_id: args.worker_id });
        respond(conn, { ok: true, claimed: success });
        break;
      }
      case 'release-worker': {
        db.releaseWorker(args.worker_id);
        db.log('coordinator', 'worker_released', { worker_id: args.worker_id });
        respond(conn, { ok: true });
        break;
      }
      case 'worker-status': {
        const workers = db.getAllWorkers();
        respond(conn, { ok: true, workers });
        break;
      }
      case 'check-completion': {
        const completion = db.checkRequestCompletion(args.request_id);
        respond(conn, { ok: true, ...completion });
        break;
      }

      case 'check-overlaps': {
        const overlapPairs = db.getOverlapsForRequest(args.request_id);
        respond(conn, { ok: true, request_id: args.request_id, overlaps: overlapPairs });
        break;
      }

      case 'integrate': {
        // Master-3 triggers integration when all tasks for a request complete
        const reqId = args.request_id;
        const completion = db.checkRequestCompletion(reqId);
        if (!completion.all_done) {
          respond(conn, { ok: false, error: 'Not all tasks completed', ...completion });
          break;
        }
        // Queue merges for each completed task's branch/PR
        const tasks = db.listTasks({ request_id: reqId, status: 'completed' });
        let queued = 0;
        for (const task of tasks) {
          if (task.pr_url && task.branch) {
            try {
              db.enqueueMerge({
                request_id: reqId,
                task_id: task.id,
                branch: task.branch,
                pr_url: task.pr_url,
              });
              queued++;
            } catch (e) {
              // Already queued or other error — skip
            }
          }
        }
        db.updateRequest(reqId, { status: 'integrating' });
        db.log('coordinator', 'integration_triggered', { request_id: reqId, merges_queued: queued });
        // Trigger merger immediately
        if (handlers.onIntegrate) handlers.onIntegrate(reqId);
        respond(conn, { ok: true, request_id: reqId, merges_queued: queued });
        break;
      }

      // === SYSTEM commands ===
      case 'register-worker': {
        const { worker_id, worktree_path, branch } = args;
        db.registerWorker(worker_id, worktree_path || '', branch || '');
        db.log('coordinator', 'worker_registered', { worker_id });
        respond(conn, { ok: true, worker_id });
        break;
      }
      case 'repair': {
        // Reset stuck states
        const cutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
        const stuck = db.getDb().prepare("UPDATE workers SET status = 'idle', current_task_id = NULL WHERE status IN ('assigned','running','busy') AND last_heartbeat < ?").run(cutoff);
        const orphaned = db.getDb().prepare("UPDATE tasks SET status = 'ready', assigned_to = NULL WHERE status IN ('assigned','in_progress') AND assigned_to IN (SELECT id FROM workers WHERE status = 'idle')").run();
        // Reset conflict merge entries so merger can retry them
        const conflictMerges = db.getDb().prepare("UPDATE merge_queue SET status = 'pending', error = NULL WHERE status = 'conflict'").run();
        db.log('coordinator', 'repair', { reset_workers: stuck.changes, orphaned_tasks: orphaned.changes, conflict_merges_reset: conflictMerges.changes });
        respond(conn, { ok: true, reset_workers: stuck.changes, orphaned_tasks: orphaned.changes, conflict_merges_reset: conflictMerges.changes });
        break;
      }
      case 'ping': {
        respond(conn, { ok: true, ts: Date.now() });
        break;
      }

      case 'add-worker': {
        const maxWorkers = parseInt(db.getConfig('max_workers')) || 8;
        const allWorkers = db.getAllWorkers();
        if (allWorkers.length >= maxWorkers) {
          respond(conn, { ok: false, error: `Already at max workers (${maxWorkers})` });
          break;
        }
        const nextId = allWorkers.length > 0
          ? Math.max(...allWorkers.map(w => typeof w.id === 'number' ? w.id : parseInt(w.id))) + 1
          : 1;
        if (nextId > maxWorkers) {
          respond(conn, { ok: false, error: `Next worker ID ${nextId} exceeds max_workers (${maxWorkers})` });
          break;
        }
        const projDir = db.getConfig('project_dir');
        if (!projDir) {
          respond(conn, { ok: false, error: 'project_dir not set in config' });
          break;
        }
        const wtDir = path.join(projDir, '.worktrees');
        const wtPath = path.join(wtDir, `wt-${nextId}`);
        const branchName = `agent-${nextId}`;
        try {
          fs.mkdirSync(wtDir, { recursive: true });
          // Create branch from main
          const mainBranch = (() => {
            try {
              return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: projDir, encoding: 'utf8' }).trim();
            } catch { return 'main'; }
          })();
          try {
            execFileSync('git', ['branch', branchName, mainBranch], { cwd: projDir, encoding: 'utf8' });
          } catch {} // branch may already exist
          execFileSync('git', ['worktree', 'add', wtPath, branchName], { cwd: projDir, encoding: 'utf8' });

          // Copy .claude structure to worktree
          const srcClaude = path.join(projDir, '.claude');
          const dstClaude = path.join(wtPath, '.claude');
          const copyDir = (rel) => {
            const src = path.join(srcClaude, rel);
            const dst = path.join(dstClaude, rel);
            if (!fs.existsSync(src)) return;
            fs.mkdirSync(dst, { recursive: true });
            for (const f of fs.readdirSync(src)) {
              const srcF = path.join(src, f);
              if (fs.statSync(srcF).isFile()) fs.copyFileSync(srcF, path.join(dst, f));
            }
          };
          copyDir('commands');
          copyDir('knowledge');
          copyDir('knowledge/domain');
          copyDir('scripts');
          copyDir('agents');
          copyDir('hooks');
          // Copy worker CLAUDE.md
          const workerClaude = path.join(srcClaude, 'worker-claude.md');
          if (fs.existsSync(workerClaude)) {
            fs.copyFileSync(workerClaude, path.join(wtPath, 'CLAUDE.md'));
          }
          // Copy settings.json
          const settingsFile = path.join(srcClaude, 'settings.json');
          if (fs.existsSync(settingsFile)) {
            fs.copyFileSync(settingsFile, path.join(dstClaude, 'settings.json'));
          }
          // Make hook scripts executable
          try {
            const hookDir = path.join(dstClaude, 'hooks');
            if (fs.existsSync(hookDir)) {
              for (const f of fs.readdirSync(hookDir)) {
                if (f.endsWith('.sh')) fs.chmodSync(path.join(hookDir, f), 0o755);
              }
            }
          } catch {}

          db.registerWorker(nextId, wtPath, branchName);
          db.log('coordinator', 'worker_added', { worker_id: nextId, worktree_path: wtPath, branch: branchName });
          respond(conn, { ok: true, worker_id: nextId, worktree_path: wtPath, branch: branchName });
        } catch (e) {
          respond(conn, { ok: false, error: `Failed to create worker: ${e.message}` });
        }
        break;
      }

      case 'reset-worker': {
        // Called by sentinel when Claude exits — resets worker to idle
        const resetWid = args.worker_id;
        const resetWorker = db.getWorker(resetWid);
        if (!resetWorker) {
          respond(conn, { ok: false, error: 'Worker not found' });
          break;
        }
        // Only reset if worker isn't already idle (avoid clobbering a fresh assignment)
        if (resetWorker.status !== 'idle') {
          db.updateWorker(resetWid, {
            status: 'idle',
            current_task_id: null,
            last_heartbeat: new Date().toISOString(),
          });
          db.log(`worker-${resetWid}`, 'sentinel_reset', { previous_status: resetWorker.status });
        }
        respond(conn, { ok: true });
        break;
      }

      case 'merge-status': {
        const reqFilter = args && args.request_id;
        let sql = 'SELECT * FROM merge_queue';
        const params = [];
        if (reqFilter) {
          sql += ' WHERE request_id = ?';
          params.push(reqFilter);
        }
        sql += ' ORDER BY id DESC';
        const merges = db.getDb().prepare(sql).all(...params);
        respond(conn, { ok: true, merges });
        break;
      }

      case 'reset-merges': {
        const filterReqId = args && args.request_id;
        let sql = "UPDATE merge_queue SET status = 'pending', error = NULL WHERE status = 'conflict'";
        const params = [];
        if (filterReqId) {
          sql += ' AND request_id = ?';
          params.push(filterReqId);
        }
        const resetResult = db.getDb().prepare(sql).run(...params);
        db.log('coordinator', 'reset_merges', { request_id: filterReqId || 'all', reset_count: resetResult.changes });
        respond(conn, { ok: true, reset_count: resetResult.changes });
        break;
      }

      // === CHANGES commands ===
      case 'log-change': {
        const changeId = db.createChange(args);
        const change = db.getChange(changeId);
        db.log('coordinator', 'change_logged', { change_id: changeId, description: args.description });
        if (handlers.onChangeCreated) handlers.onChangeCreated(change);
        respond(conn, { ok: true, change_id: changeId });
        break;
      }
      case 'list-changes': {
        const changes = db.listChanges(args || {});
        respond(conn, { ok: true, changes });
        break;
      }
      case 'update-change': {
        const { id: changeId2, ...changeFields } = args;
        // Only allow valid change columns
        const allowed = ['enabled', 'status', 'description', 'tooltip'];
        const filtered = {};
        for (const k of allowed) {
          if (changeFields[k] !== undefined) filtered[k] = changeFields[k];
        }
        db.updateChange(changeId2, filtered);
        const updated = db.getChange(changeId2);
        if (handlers.onChangeUpdated) handlers.onChangeUpdated(updated);
        respond(conn, { ok: true });
        break;
      }

      // === HISTORY command ===
      case 'history': {
        const reqId = args.request_id;
        const history = db.getRequestHistory(reqId);
        if (!history) {
          respond(conn, { ok: false, error: `Request ${reqId} not found` });
          break;
        }
        respond(conn, { ok: true, ...history });
        break;
      }

      case 'shutdown': {
        respond(conn, { ok: true, message: 'Coordinator shutting down' });
        db.log('coordinator', 'manual_shutdown', { source: 'cli' });
        setTimeout(() => {
          if (handlers.onShutdown) handlers.onShutdown();
        }, 500);
        break;
      }

      // === LOOP commands ===
      case 'loop': {
        const loopId = db.createLoop(args.prompt);
        const loop = db.getLoop(loopId);
        if (handlers.onLoopCreated) handlers.onLoopCreated(loop);
        respond(conn, { ok: true, loop_id: loopId });
        break;
      }
      case 'stop-loop': {
        const loop = db.getLoop(args.loop_id);
        if (!loop) {
          respond(conn, { ok: false, error: `Loop ${args.loop_id} not found` });
          break;
        }
        db.updateLoop(args.loop_id, { status: 'stopped', stopped_at: new Date().toISOString() });
        db.log('user', 'loop_stopped', { loop_id: args.loop_id });
        respond(conn, { ok: true });
        break;
      }
      case 'loop-status': {
        const loops = db.listLoops();
        respond(conn, { ok: true, loops });
        break;
      }
      case 'loop-prompt': {
        const loop = db.getLoop(args.loop_id);
        if (!loop) {
          respond(conn, { ok: false, error: `Loop ${args.loop_id} not found` });
          break;
        }
        respond(conn, {
          ok: true,
          status: loop.status,
          prompt: loop.prompt,
          last_checkpoint: loop.last_checkpoint || loop.checkpoint || null,
          iteration_count: loop.iteration_count,
        });
        break;
      }
      case 'loop-requests': {
        const requests = db.getLoopRequests(args.loop_id);
        respond(conn, { ok: true, requests });
        break;
      }
      case 'loop-request': {
        const loop = db.getLoop(args.loop_id);
        if (!loop || loop.status !== 'active') {
          respond(conn, { ok: false, error: `Loop ${args.loop_id} not active` });
          break;
        }
        const reqId = db.createLoopRequest(args.loop_id, args.description);
        respond(conn, { ok: true, request_id: reqId });
        break;
      }
      case 'loop-heartbeat': {
        const loop = db.getLoop(args.loop_id);
        if (!loop) {
          respond(conn, { ok: false, error: `Loop ${args.loop_id} not found`, exit_code: 2 });
          break;
        }
        db.updateLoop(args.loop_id, { last_heartbeat: new Date().toISOString() });
        if (loop.status !== 'active') {
          respond(conn, { ok: false, exit_code: 2 });
        } else {
          respond(conn, { ok: true });
        }
        break;
      }
      case 'loop-checkpoint': {
        const loop = db.getLoop(args.loop_id);
        if (!loop) {
          respond(conn, { ok: false, error: `Loop ${args.loop_id} not found` });
          break;
        }
        db.updateLoop(args.loop_id, {
          last_checkpoint: args.checkpoint,
          iteration_count: loop.iteration_count + 1,
        });
        respond(conn, { ok: true });
        break;
      }

      default:
        respond(conn, { error: `Unknown command: ${command}` });
    }
  } catch (e) {
    respond(conn, { error: e.message });
  }
}

module.exports = { start, stop, getSocketPath };
