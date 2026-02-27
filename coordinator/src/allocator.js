'use strict';

const db = require('./db');

let intervalId = null;
let lastNotifyTs = 0;

const NOTIFY_DEDUP_MS = 10000; // Only notify allocator agent once per 10s

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
  lastNotifyTs = 0;
}

function tick() {
  // 1. Promote pending tasks whose dependencies are met
  db.checkAndPromoteTasks();

  // 2. Check if there are ready tasks AND idle unclaimed workers
  const readyTasks = db.getReadyTasks();
  if (readyTasks.length === 0) return;

  const idleWorkers = db.getIdleWorkers().filter(w => !w.claimed_by);
  if (idleWorkers.length === 0) return;

  // 3. Notify the allocator agent (Master-3) — with dedup
  const now = Date.now();
  if (now - lastNotifyTs < NOTIFY_DEDUP_MS) return;
  lastNotifyTs = now;

  db.sendMail('allocator', 'tasks_available', {
    ready_count: readyTasks.length,
    idle_count: idleWorkers.length,
  });
}

module.exports = { start, stop, tick };
