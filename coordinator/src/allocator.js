'use strict';

const db = require('./db');
const tmux = require('./tmux');
const path = require('path');

let intervalId = null;

function start(projectDir) {
  const intervalMs = parseInt(db.getConfig('allocator_interval_ms')) || 2000;

  intervalId = setInterval(() => {
    try {
      tick(projectDir);
    } catch (e) {
      db.log('coordinator', 'allocator_error', { error: e.message });
    }
  }, intervalMs);

  db.log('coordinator', 'allocator_started', { interval_ms: intervalMs });
}

function stop() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}

function tick(projectDir) {
  // 1. Promote pending tasks whose dependencies are met
  db.checkAndPromoteTasks();

  // 2. Find ready tasks
  const readyTasks = db.getReadyTasks();
  if (readyTasks.length === 0) return;

  // 3. Find idle workers
  const idleWorkers = db.getIdleWorkers();
  if (idleWorkers.length === 0) return;

  // 4. Match tasks to workers (domain affinity)
  const assignments = matchTasksToWorkers(readyTasks, idleWorkers);

  // 5. Execute assignments
  for (const { task, worker } of assignments) {
    assignTaskToWorker(task, worker, projectDir);
  }
}

function matchTasksToWorkers(tasks, workers) {
  const assignments = [];
  const usedWorkers = new Set();
  const usedTasks = new Set();

  // First pass: domain-matched assignments
  for (const task of tasks) {
    if (!task.domain) continue;
    for (const worker of workers) {
      if (usedWorkers.has(worker.id)) continue;
      if (worker.domain === task.domain) {
        assignments.push({ task, worker });
        usedWorkers.add(worker.id);
        usedTasks.add(task.id);
        break;
      }
    }
  }

  // Second pass: assign remaining tasks to any idle worker
  for (const task of tasks) {
    if (usedTasks.has(task.id)) continue;
    for (const worker of workers) {
      if (usedWorkers.has(worker.id)) continue;
      assignments.push({ task, worker });
      usedWorkers.add(worker.id);
      usedTasks.add(task.id);
      break;
    }
  }

  return assignments;
}

function assignTaskToWorker(task, worker, projectDir) {
  // Atomic assignment: re-check task and worker status inside a transaction
  const assigned = db.getDb().transaction(() => {
    // Re-query to prevent TOCTOU race
    const freshTask = db.getTask(task.id);
    const freshWorker = db.getWorker(worker.id);
    if (!freshTask || freshTask.status !== 'ready' || freshTask.assigned_to) return false;
    if (!freshWorker || freshWorker.status !== 'idle') return false;

    db.updateTask(task.id, { status: 'assigned', assigned_to: worker.id });
    db.updateWorker(worker.id, {
      status: 'assigned',
      current_task_id: task.id,
      domain: task.domain || worker.domain,
      launched_at: new Date().toISOString(),
    });
    return true;
  })();

  if (!assigned) return;

  // Non-transactional side effects: mail and tmux spawn
  db.sendMail(`worker-${worker.id}`, 'task_assigned', {
    task_id: task.id,
    subject: task.subject,
    description: task.description,
    domain: task.domain,
    files: task.files,
    tier: task.tier,
    request_id: task.request_id,
    validation: task.validation,
  });

  db.log('coordinator', 'task_assigned', {
    task_id: task.id,
    worker_id: worker.id,
    domain: task.domain,
  });

  // Spawn worker via tmux if not already running
  spawnWorker(worker, projectDir);
}

function spawnWorker(worker, projectDir) {
  const windowName = `worker-${worker.id}`;

  if (tmux.hasWindow(windowName)) {
    // Worker sentinel is running, just send wake signal via mail (already done above)
    db.log('coordinator', 'worker_signaled', { worker_id: worker.id });
    return;
  }

  // Launch worker sentinel in tmux
  const sentinelPath = path.join(projectDir, '.claude', 'scripts', 'worker-sentinel.sh');
  const worktreePath = worker.worktree_path || path.join(projectDir, '.worktrees', `wt-${worker.id}`);

  tmux.createWindow(windowName, `bash "${sentinelPath}" ${worker.id} "${projectDir}"`, worktreePath);

  db.updateWorker(worker.id, {
    tmux_session: tmux.SESSION,
    tmux_window: windowName,
  });

  db.log('coordinator', 'worker_spawned', { worker_id: worker.id, window: windowName });
}

module.exports = { start, stop, tick, matchTasksToWorkers, spawnWorker };
