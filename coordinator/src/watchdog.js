'use strict';

const db = require('./db');
const tmux = require('./tmux');

let intervalId = null;
let lastMailPurge = 0;
// Track last escalation level per worker to avoid duplicate nudge/triage mails
const lastEscalationLevel = new Map();

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
  lastEscalationLevel.clear();
}

function tick(projectDir) {
  const workers = db.getAllWorkers();
  const now = Date.now();

  for (const worker of workers) {
    // Skip idle workers and clear their escalation tracking
    if (worker.status === 'idle') {
      lastEscalationLevel.delete(worker.id);
      continue;
    }

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

  // Worker context fatigue: workers with 6+ completed tasks should reset
  checkWorkerFatigue();

  // Stale claim cleanup: workers claimed but no task assigned for >2 minutes
  releaseStaleClaimsCheck(now);

  // Orphan task recovery: tasks assigned but worker is idle
  recoverOrphanTasks();

  // Recover stale integrations
  recoverStaleIntegrations(now);

  // Periodic mail + log purge (once per hour)
  if (now - lastMailPurge > 3600000) {
    lastMailPurge = now;
    const purged = db.purgeOldMail(7);
    if (purged > 0) {
      db.log('coordinator', 'mail_purged', { count: purged });
    }
    // Purge old activity log entries (>30 days)
    const logPurged = db.getDb().prepare(
      "DELETE FROM activity_log WHERE created_at < datetime('now', '-30 days')"
    ).run();
    if (logPurged.changes > 0) {
      db.log('coordinator', 'activity_log_purged', { count: logPurged.changes });
    }
  }
}

function escalate(worker, staleSec, projectDir) {
  const windowName = `worker-${worker.id}`;
  const prevLevel = lastEscalationLevel.get(worker.id) || 0;

  if (staleSec >= THRESHOLDS.terminate) {
    // Level 4: Terminate and reassign (always fires — destructive action)
    db.log('coordinator', 'watchdog_terminate', {
      worker_id: worker.id,
      stale_sec: staleSec,
    });
    tmux.killWindow(windowName);
    handleDeath(worker, 'heartbeat_timeout');
    lastEscalationLevel.delete(worker.id);

  } else if (staleSec >= THRESHOLDS.triage && prevLevel < 3) {
    // Level 3: Triage — capture output, log for analysis (once per escalation)
    lastEscalationLevel.set(worker.id, 3);
    const output = tmux.capturePane(windowName, 20);
    db.log('coordinator', 'watchdog_triage', {
      worker_id: worker.id,
      stale_sec: staleSec,
      last_output: output.slice(-500),
    });
    db.sendMail(`worker-${worker.id}`, 'nudge', {
      message: 'Heartbeat stale. Send heartbeat or complete task.',
    });

  } else if (staleSec >= THRESHOLDS.nudge && prevLevel < 2) {
    // Level 2: Nudge — send reminder (once per escalation)
    lastEscalationLevel.set(worker.id, 2);
    db.sendMail(`worker-${worker.id}`, 'nudge', {
      message: 'Heartbeat check — please report status.',
    });
    db.log('coordinator', 'watchdog_nudge', {
      worker_id: worker.id,
      stale_sec: staleSec,
    });

  } else if (staleSec >= THRESHOLDS.warn && prevLevel < 1) {
    // Level 1: Warn — log only (once per escalation)
    lastEscalationLevel.set(worker.id, 1);
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

function checkWorkerFatigue() {
  // Workers with 6+ completed tasks need a context reset
  const fatigued = db.getDb().prepare(
    "SELECT * FROM workers WHERE tasks_completed >= 6 AND status IN ('idle', 'completed_task')"
  ).all();

  for (const worker of fatigued) {
    // Reset their counter and log it
    db.updateWorker(worker.id, { tasks_completed: 0 });
    db.log('coordinator', 'worker_fatigue_reset', {
      worker_id: worker.id,
      tasks_completed: worker.tasks_completed,
    });
  }
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

function recoverStaleIntegrations(now) {
  const integratingRequests = db.getDb().prepare(
    "SELECT * FROM requests WHERE status = 'integrating'"
  ).all();

  for (const req of integratingRequests) {
    const merges = db.getDb().prepare(
      'SELECT * FROM merge_queue WHERE request_id = ?'
    ).all(req.id);

    // Case 1: No merge_queue entries and integrating > 15 minutes → complete (e.g. tier1 tasks)
    if (merges.length === 0) {
      const integratingAge = (now - new Date(req.updated_at).getTime()) / 1000;
      if (integratingAge > 900) { // 15 minutes
        db.updateRequest(req.id, {
          status: 'completed',
          completed_at: new Date().toISOString(),
          result: 'Completed (no PRs to merge)',
        });
        db.sendMail('master-1', 'request_completed', {
          request_id: req.id,
          result: 'Completed (no PRs to merge)',
        });
        db.log('coordinator', 'stale_integration_recovered', {
          request_id: req.id,
          reason: 'no_merge_entries_timeout',
        });
      }
      continue;
    }

    // Check for merges stuck in 'merging' for > 5 minutes → timeout them
    // Use updated_at (when status changed to 'merging'), not created_at (when enqueued)
    for (const m of merges) {
      if (m.status === 'merging' && (m.updated_at || m.created_at)) {
        const mergeAge = (now - new Date(m.updated_at || m.created_at).getTime()) / 1000;
        if (mergeAge > 300) { // 5 minutes
          db.updateMerge(m.id, { status: 'failed', error: 'Merge timed out after 5 minutes' });
          db.log('coordinator', 'merge_timeout', { merge_id: m.id, request_id: req.id });
        }
      }
    }

    // Re-fetch merges after potential timeout updates
    const freshMerges = db.getDb().prepare(
      'SELECT * FROM merge_queue WHERE request_id = ?'
    ).all(req.id);

    const allResolved = freshMerges.every(m => ['merged', 'conflict', 'failed'].includes(m.status));
    if (!allResolved) continue;

    const allMerged = freshMerges.every(m => m.status === 'merged');

    if (allMerged) {
      // Case 2: All merges succeeded → mark request completed
      const result = `All ${freshMerges.length} PR(s) merged successfully`;
      db.updateRequest(req.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        result,
      });
      db.sendMail('master-1', 'request_completed', { request_id: req.id, result });
      db.log('coordinator', 'stale_integration_recovered', {
        request_id: req.id,
        reason: 'all_merged',
      });
    } else {
      // Case 3: All resolved but some failed/conflict → mark request failed
      const failedMerges = freshMerges.filter(m => m.status !== 'merged');
      const details = failedMerges.map(m => `${m.branch}: ${m.status}${m.error ? ' - ' + m.error.slice(0, 100) : ''}`).join('; ');
      db.updateRequest(req.id, {
        status: 'failed',
        result: `Merge failures: ${details}`,
      });
      db.sendMail('master-1', 'request_failed', {
        request_id: req.id,
        error: `Merge failures: ${details}`,
      });
      db.sendMail('allocator', 'merge_failed', {
        request_id: req.id,
        error: details,
      });
      db.log('coordinator', 'stale_integration_recovered', {
        request_id: req.id,
        reason: 'merge_failures',
        details,
      });
    }
  }
}

module.exports = { start, stop, tick, THRESHOLDS };
