'use strict';

const db = require('./db');
const tmux = require('./tmux');
const { execSync } = require('child_process');

let intervalId = null;
let lastMailPurge = 0;

// Escalation thresholds (seconds since last heartbeat)
const THRESHOLDS = {
  warn: 60,
  nudge: 90,
  triage: 120,
  terminate: 180,
};

function start(projectDir) {
  const intervalMs = parseInt(db.getConfig('watchdog_interval_ms')) || 10000;

  intervalId = setInterval(() => {
    try {
      tick(projectDir);
    } catch (e) {
      db.log('coordinator', 'watchdog_error', { error: e.message });
    }
  }, intervalMs);

  db.log('coordinator', 'watchdog_started', { interval_ms: intervalMs });
}

function stop() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}

function tick(projectDir) {
  const workers = db.getAllWorkers();
  const now = Date.now();

  for (const worker of workers) {
    // Skip idle workers
    if (worker.status === 'idle') continue;

    // ZFC death detection: check if tmux pane is actually alive
    const windowName = `worker-${worker.id}`;
    const paneAlive = tmux.isPaneAlive(windowName);

    if (!paneAlive && worker.status !== 'idle' && worker.status !== 'completed_task') {
      // Process died unexpectedly
      handleDeath(worker, 'tmux_pane_dead');
      continue;
    }

    // Skip workers just launched (grace period)
    if (worker.launched_at) {
      const launchedAgo = (now - new Date(worker.launched_at).getTime()) / 1000;
      if (launchedAgo < THRESHOLDS.warn) continue;
    }

    // Heartbeat freshness check
    if (worker.last_heartbeat && (worker.status === 'running' || worker.status === 'busy')) {
      const staleSec = (now - new Date(worker.last_heartbeat).getTime()) / 1000;
      escalate(worker, staleSec, projectDir);
    }

    // Check completed_task workers that haven't been reset
    if (worker.status === 'completed_task') {
      const completedAgo = worker.last_heartbeat
        ? (now - new Date(worker.last_heartbeat).getTime()) / 1000
        : THRESHOLDS.terminate;
      if (completedAgo > 30) {
        // Reset to idle so allocator can reuse
        db.updateWorker(worker.id, { status: 'idle', current_task_id: null });
        db.log('coordinator', 'worker_auto_reset', { worker_id: worker.id });
      }
    }
  }

  // Stale claim cleanup: workers claimed but no task assigned for >2 minutes
  releaseStaleClaimsCheck(now);

  // Orphan task recovery: tasks assigned but worker is idle
  recoverOrphanTasks();

  // Periodic mail purge (once per hour)
  if (now - lastMailPurge > 3600000) {
    lastMailPurge = now;
    const purged = db.purgeOldMail(7);
    if (purged > 0) {
      db.log('coordinator', 'mail_purged', { count: purged });
    }
  }
}

function escalate(worker, staleSec, projectDir) {
  const windowName = `worker-${worker.id}`;

  if (staleSec >= THRESHOLDS.terminate) {
    // Level 4: Terminate and reassign
    db.log('coordinator', 'watchdog_terminate', {
      worker_id: worker.id,
      stale_sec: staleSec,
    });
    tmux.killWindow(windowName);
    handleDeath(worker, 'heartbeat_timeout');

  } else if (staleSec >= THRESHOLDS.triage) {
    // Level 3: Triage — capture output, log for analysis
    const output = tmux.capturePane(windowName, 20);
    db.log('coordinator', 'watchdog_triage', {
      worker_id: worker.id,
      stale_sec: staleSec,
      last_output: output.slice(-500),
    });
    // Send nudge as reminder
    db.sendMail(`worker-${worker.id}`, 'nudge', {
      message: 'Heartbeat stale. Send heartbeat or complete task.',
    });

  } else if (staleSec >= THRESHOLDS.nudge) {
    // Level 2: Nudge — send reminder
    db.sendMail(`worker-${worker.id}`, 'nudge', {
      message: 'Heartbeat check — please report status.',
    });
    db.log('coordinator', 'watchdog_nudge', {
      worker_id: worker.id,
      stale_sec: staleSec,
    });

  } else if (staleSec >= THRESHOLDS.warn) {
    // Level 1: Warn — log only
    db.log('coordinator', 'watchdog_warn', {
      worker_id: worker.id,
      stale_sec: staleSec,
    });
  }
}

function handleDeath(worker, reason) {
  db.log('coordinator', 'worker_death', {
    worker_id: worker.id,
    reason,
    task_id: worker.current_task_id,
  });

  // If worker had a task, conditionally mark it for reassignment
  // Uses a single conditional UPDATE to avoid TOCTOU race with worker's complete-task
  if (worker.current_task_id) {
    const result = db.getDb().prepare(
      "UPDATE tasks SET status='ready', assigned_to=NULL, updated_at=datetime('now') WHERE id=? AND status NOT IN ('completed','failed')"
    ).run(worker.current_task_id);
    if (result.changes > 0) {
      db.log('coordinator', 'task_reassigned', {
        task_id: worker.current_task_id,
        reason: `worker-${worker.id} died (${reason})`,
      });
    }
  }

  // Reset worker
  db.updateWorker(worker.id, {
    status: 'idle',
    current_task_id: null,
    pid: null,
  });
}

function releaseStaleClaimsCheck(now) {
  const claimedWorkers = db.getDb().prepare(
    "SELECT * FROM workers WHERE claimed_by IS NOT NULL AND status = 'idle' AND current_task_id IS NULL"
  ).all();

  for (const worker of claimedWorkers) {
    // Use last_heartbeat or created_at as claim timestamp proxy
    const claimTime = worker.last_heartbeat || worker.created_at;
    if (!claimTime) {
      db.releaseWorker(worker.id);
      db.log('coordinator', 'stale_claim_released', { worker_id: worker.id, reason: 'no_timestamp' });
      continue;
    }
    const staleSec = (now - new Date(claimTime).getTime()) / 1000;
    if (staleSec > 120) {
      db.releaseWorker(worker.id);
      db.log('coordinator', 'stale_claim_released', { worker_id: worker.id, stale_sec: staleSec });
    }
  }
}

function recoverOrphanTasks() {
  // Tasks that are 'assigned' or 'in_progress' but their worker is idle
  const orphans = db.getDb().prepare(`
    SELECT t.* FROM tasks t
    JOIN workers w ON t.assigned_to = w.id
    WHERE t.status IN ('assigned', 'in_progress')
      AND w.status = 'idle'
      AND w.current_task_id IS NULL
  `).all();

  for (const task of orphans) {
    db.updateTask(task.id, { status: 'ready', assigned_to: null });
    db.log('coordinator', 'orphan_task_recovered', { task_id: task.id });
  }
}

module.exports = { start, stop, tick, THRESHOLDS };
