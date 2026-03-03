'use strict';

const { execFileSync } = require('child_process');
const db = require('./db');

const BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
const PR_URL_RE = /^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+$/;

function validateEntry(entry) {
  if (entry.branch && !BRANCH_RE.test(entry.branch)) {
    throw new Error(`Invalid branch name: ${entry.branch}`);
  }
  if (entry.pr_url && !PR_URL_RE.test(entry.pr_url)) {
    throw new Error(`Invalid PR URL: ${entry.pr_url}`);
  }
}

function safeExec(file, args, cwd) {
  return execFileSync(file, args, { encoding: 'utf8', cwd, timeout: 60000 }).trim();
}

let processing = false;
let mergerIntervalId = null;

function start(projectDir) {
  // Merger is triggered by task completions, but also runs periodic checks
  mergerIntervalId = setInterval(() => {
    try {
      processQueue(projectDir);
    } catch (e) {
      db.log('coordinator', 'merger_error', { error: e.message });
    }
  }, 5000);
  db.log('coordinator', 'merger_started');
}

function onTaskCompleted(taskId) {
  // Check if all tasks for this request are done
  const task = db.getTask(taskId);
  if (!task) return;

  const allTasks = db.listTasks({ request_id: task.request_id });
  const incomplete = allTasks.filter(t => t.status !== 'completed' && t.status !== 'failed');

  if (incomplete.length === 0) {
    // Check if there are any pending merges to process
    const pendingMerges = db.getDb().prepare(
      "SELECT COUNT(*) as cnt FROM merge_queue WHERE request_id = ? AND status IN ('pending', 'merging')"
    ).get(task.request_id);

    if (pendingMerges.cnt > 0) {
      // Has PRs to merge — mark as integrating, merger will handle it
      db.updateRequest(task.request_id, { status: 'integrating' });
      db.log('coordinator', 'request_ready_for_merge', { request_id: task.request_id });
    } else {
      // No PRs to merge — complete immediately (e.g. verification tasks, already-merged)
      const result = `All ${allTasks.length} task(s) completed (no PRs to merge)`;
      db.updateRequest(task.request_id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        result,
      });
      db.sendMail('master-1', 'request_completed', { request_id: task.request_id, result });
      db.log('coordinator', 'request_completed', { request_id: task.request_id });
    }
  }
}

function processQueue(projectDir) {
  if (processing) return;
  processing = true;

  try {
    const entry = db.getNextMerge();
    if (!entry) { processing = false; return; }

    db.updateMerge(entry.id, { status: 'merging' });
    db.log('coordinator', 'merge_start', { merge_id: entry.id, branch: entry.branch, pr: entry.pr_url });

    const result = attemptMerge(entry, projectDir);

    if (result.success) {
      db.updateMerge(entry.id, { status: 'merged', merged_at: new Date().toISOString() });
      db.log('coordinator', 'merge_success', { merge_id: entry.id, branch: entry.branch });

      // Check if entire request is now complete
      checkRequestCompletion(entry.request_id);
    } else {
      db.updateMerge(entry.id, {
        status: result.conflict ? 'conflict' : 'failed',
        error: result.error,
      });
      db.log('coordinator', 'merge_failed', {
        merge_id: entry.id,
        branch: entry.branch,
        error: result.error,
        tier: result.tier,
      });
    }
  } finally {
    processing = false;
  }
}

function attemptMerge(entry, projectDir) {
  validateEntry(entry);

  // Tier 1: Clean merge via gh CLI
  const tier1 = tryCleanMerge(entry, projectDir);
  if (tier1.success) return { success: true, tier: 1 };

  // Tier 2: Auto-resolve (rebase and retry)
  const tier2 = tryAutoResolve(entry, projectDir);
  if (tier2.success) return { success: true, tier: 2 };

  // Tiers 1 & 2 failed — delegate to Master-3 (Allocator) for conflict resolution.
  // Master-3 has domain affinity context and the full task list to decide
  // whether to create a fix task (resolve conflicts) or a redo task.
  const task = db.getTask(entry.task_id);
  db.sendMail('allocator', 'merge_failed', {
    request_id: entry.request_id,
    task_id: entry.task_id,
    merge_id: entry.id,
    branch: entry.branch,
    pr_url: entry.pr_url,
    error: tier2.error || tier1.error,
    original_task: task ? {
      subject: task.subject,
      description: task.description,
      domain: task.domain,
      files: task.files,
      assigned_to: task.assigned_to,
    } : null,
  });
  return { success: false, conflict: true, error: tier2.error || tier1.error, tier: 3 };
}

function tryCleanMerge(entry, projectDir) {
  try {
    // Merge PR via gh CLI
    safeExec('gh', ['pr', 'merge', entry.pr_url, '--merge', '--delete-branch'], projectDir);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function tryAutoResolve(entry, projectDir) {
  try {
    // Fetch latest, rebase the branch, force-push, then merge
    safeExec('git', ['fetch', 'origin'], projectDir);
    safeExec('git', ['checkout', entry.branch], projectDir);
    safeExec('git', ['rebase', 'origin/main'], projectDir);
    safeExec('git', ['push', '--force-with-lease', 'origin', entry.branch], projectDir);
    safeExec('git', ['checkout', 'main'], projectDir);
    // Now try clean merge again
    safeExec('gh', ['pr', 'merge', entry.pr_url, '--merge', '--delete-branch'], projectDir);
    return { success: true };
  } catch (e) {
    // Abort rebase if in progress
    try { safeExec('git', ['rebase', '--abort'], projectDir); } catch {}
    try { safeExec('git', ['checkout', 'main'], projectDir); } catch {}
    return { success: false, error: e.message };
  }
}

function checkRequestCompletion(requestId) {
  const allMerges = db.getDb().prepare(
    "SELECT * FROM merge_queue WHERE request_id = ?"
  ).all(requestId);

  const allMerged = allMerges.every(m => m.status === 'merged');
  if (allMerged && allMerges.length > 0) {
    const result = `All ${allMerges.length} PR(s) merged successfully`;
    db.updateRequest(requestId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result,
    });
    // Notify Master-1 so the user learns the request is done
    db.sendMail('master-1', 'request_completed', {
      request_id: requestId,
      result,
    });
    db.log('coordinator', 'request_completed', { request_id: requestId });
  }
}

function stop() {
  if (mergerIntervalId) { clearInterval(mergerIntervalId); mergerIntervalId = null; }
}

module.exports = { start, stop, onTaskCompleted, processQueue, attemptMerge };
