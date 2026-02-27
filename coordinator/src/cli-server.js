'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const db = require('./db');

let server = null;

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
};

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
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(projectDir).digest('hex').slice(0, 12);
    const pipePath = `\\\\.\\pipe\\mac10-${hash}`;
    fs.writeFileSync(path.join(dir, 'mac10.pipe'), pipePath, 'utf8');
    return pipePath;
  }
  // On WSL2, /mnt/c/ (NTFS) doesn't support Unix sockets — use /tmp/ instead
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(projectDir).digest('hex').slice(0, 12);
  const sockPath = `/tmp/mac10-${hash}.sock`;
  // Write the socket path so the CLI can find it
  fs.writeFileSync(path.join(dir, 'mac10.sock.path'), sockPath, 'utf8');
  return sockPath;
}

function start(projectDir, handlers) {
  const socketPath = getSocketPath(projectDir);

  // Clean up stale socket (not needed for Windows named pipes)
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(socketPath); } catch {}
  }

  server = net.createServer((conn) => {
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
    conn.on('error', () => {}); // ignore broken pipe
  });

  server.listen(socketPath, () => {
    // Make socket accessible (not needed on Windows named pipes)
    if (process.platform !== 'win32') {
      try { fs.chmodSync(socketPath, 0o600); } catch {}
    }
  });

  return server;
}

function stop() {
  if (server) { server.close(); server = null; }
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
          return { request_id: id, task_id: taskId };
        })();
        respond(conn, { ok: true, ...fixResult });
        break;
      }
      case 'status': {
        const requests = db.listRequests();
        const workers = db.getAllWorkers();
        const tasks = db.listTasks();
        respond(conn, { ok: true, requests, workers, tasks });
        break;
      }
      case 'clarify': {
        db.sendMail('architect', 'clarification_reply', {
          request_id: args.request_id,
          message: args.message,
        });
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
        respond(conn, { ok: true, task_id: taskId });
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
        // Enqueue merge if PR exists
        const completedTask = db.getTask(task_id);
        if (pr_url) {
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

        // Trigger tmux spawn via handler
        if (handlers.onAssignTask) handlers.onAssignTask(assignedTask, db.getWorker(assignWorkerId));

        respond(conn, { ok: true, task_id: assignTaskId, worker_id: assignWorkerId });
        break;
      }
      case 'claim-worker': {
        const success = db.claimWorker(args.worker_id, args.claimer);
        respond(conn, { ok: true, claimed: success });
        break;
      }
      case 'release-worker': {
        db.releaseWorker(args.worker_id);
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
        db.log('coordinator', 'repair', { reset_workers: stuck.changes, orphaned_tasks: orphaned.changes });
        respond(conn, { ok: true, reset_workers: stuck.changes, orphaned_tasks: orphaned.changes });
        break;
      }
      case 'ping': {
        respond(conn, { ok: true, ts: Date.now() });
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
