'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const db = require('./db');

let server = null;

function getSocketPath(projectDir) {
  const dir = path.join(projectDir, '.claude', 'state');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    // Windows: use named pipes (Unix sockets have limited support)
    // Create a deterministic pipe name from project dir
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(projectDir).digest('hex').slice(0, 12);
    // Also write the pipe path to a file so CLI can find it
    const pipePath = `\\\\.\\pipe\\mac10-${hash}`;
    fs.writeFileSync(path.join(dir, 'mac10.pipe'), pipePath, 'utf8');
    return pipePath;
  }
  return path.join(dir, 'mac10.sock');
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
      // Protocol: newline-delimited JSON
      const lines = data.split('\n');
      data = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const cmd = JSON.parse(line);
          handleCommand(cmd, conn, handlers);
        } catch (e) {
          respond(conn, { error: `Invalid JSON: ${e.message}` });
        }
      }
    });
    conn.on('error', () => {}); // ignore broken pipe
  });

  server.listen(socketPath, () => {
    // Make socket accessible (not needed on Windows named pipes)
    if (process.platform !== 'win32') {
      try { fs.chmodSync(socketPath, 0o666); } catch {}
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
        respond(conn, { ok: true, request_id: id, task_id: taskId });
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
        db.log('architect', 'tier1_complete', { request_id, result });
        respond(conn, { ok: true });
        break;
      }
      case 'ask-clarification': {
        db.sendMail('user', 'clarification_ask', {
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
        db.updateWorker(worker_id, {
          status: 'completed_task',
          current_task_id: null,
        });
        // Enqueue merge if PR exists
        if (pr_url) {
          const task = db.getTask(task_id);
          db.enqueueMerge({
            request_id: task.request_id,
            task_id,
            pr_url,
            branch: branch || '',
            priority: task.priority === 'urgent' ? 10 : 0,
          });
        }
        db.sendMail('coordinator', 'task_completed', { worker_id, task_id, pr_url });
        db.log(`worker-${worker_id}`, 'task_completed', { task_id, pr_url, result });
        // Notify handlers for merge check
        if (handlers.onTaskCompleted) handlers.onTaskCompleted(task_id);
        respond(conn, { ok: true });
        break;
      }
      case 'fail-task': {
        const { worker_id: wid, task_id: tid, error } = args;
        db.updateTask(tid, { status: 'failed', result: error, completed_at: new Date().toISOString() });
        db.updateWorker(wid, { status: 'idle', current_task_id: null });
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
        // Blocking inbox check (used by sentinel/architect loops)
        const msgs = db.checkMailBlocking(args.recipient, args.timeout || 300000);
        respond(conn, { ok: true, messages: msgs });
        break;
      }

      // === SYSTEM commands ===
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
