'use strict';

const { execSync } = require('child_process');
const db = require('./db');

let processing = false;

function start(projectDir) {
  // Merger is triggered by task completions, but also runs periodic checks
  setInterval(() => {
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
    // All tasks done — mark request for integration
    db.updateRequest(task.request_id, { status: 'integrating' });
    db.log('coordinator', 'request_ready_for_merge', { request_id: task.request_id });
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
  // 4-tier merge resolution
  // Tier 1: Clean merge via gh CLI
  const tier1 = tryCleanMerge(entry, projectDir);
  if (tier1.success) return { success: true, tier: 1 };

  // Tier 2: Auto-resolve (rebase and retry)
  const tier2 = tryAutoResolve(entry, projectDir);
  if (tier2.success) return { success: true, tier: 2 };

  // Tier 3: Conflict detected — create fix task for AI resolution
  const tier3 = tryAIResolve(entry, projectDir);
  if (tier3.success) return { success: true, tier: 3 };

  // Tier 4: Reimagine — create new task to redo the work on latest main
  createRedoTask(entry);
  return { success: false, conflict: true, error: 'Needs reimplementation on latest main', tier: 4 };
}

function tryCleanMerge(entry, projectDir) {
  try {
    // Merge PR via gh CLI
    exec(`gh pr merge "${entry.pr_url}" --merge --delete-branch`, projectDir);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function tryAutoResolve(entry, projectDir) {
  try {
    // Fetch latest, rebase the branch, force-push, then merge
    exec(`git fetch origin`, projectDir);
    exec(`git checkout ${entry.branch}`, projectDir);
    exec(`git rebase origin/main`, projectDir);
    exec(`git push --force-with-lease origin ${entry.branch}`, projectDir);
    exec(`git checkout main`, projectDir);
    // Now try clean merge again
    exec(`gh pr merge "${entry.pr_url}" --merge --delete-branch`, projectDir);
    return { success: true };
  } catch (e) {
    // Abort rebase if in progress
    try { exec(`git rebase --abort`, projectDir); } catch {}
    try { exec(`git checkout main`, projectDir); } catch {}
    return { success: false, error: e.message };
  }
}

function tryAIResolve(entry, projectDir) {
  // Create a fix task for an AI worker to resolve conflicts
  try {
    const task = db.getTask(entry.task_id);
    if (!task) return { success: false, error: 'Original task not found' };

    const fixTaskId = db.createTask({
      request_id: entry.request_id,
      subject: `Resolve merge conflict: ${entry.branch}`,
      description: `The branch "${entry.branch}" has merge conflicts with main. Resolve all conflicts and push.\n\nOriginal task: ${task.subject}\nPR: ${entry.pr_url}`,
      domain: task.domain,
      priority: 'high',
      tier: 2,
    });
    db.updateTask(fixTaskId, { status: 'ready' });
    return { success: true }; // Will be handled by allocator
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function createRedoTask(entry) {
  const task = db.getTask(entry.task_id);
  if (!task) return;

  const redoTaskId = db.createTask({
    request_id: entry.request_id,
    subject: `Redo: ${task.subject}`,
    description: `Previous attempt on branch "${entry.branch}" could not be merged. Redo this work on latest main.\n\nOriginal description:\n${task.description}`,
    domain: task.domain,
    files: task.files,
    priority: 'high',
    tier: task.tier,
  });
  db.updateTask(redoTaskId, { status: 'ready' });
}

function checkRequestCompletion(requestId) {
  const allMerges = db.getDb().prepare(
    "SELECT * FROM merge_queue WHERE request_id = ?"
  ).all(requestId);

  const allMerged = allMerges.every(m => m.status === 'merged');
  if (allMerged && allMerges.length > 0) {
    db.updateRequest(requestId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      result: `All ${allMerges.length} PR(s) merged successfully`,
    });
    db.log('coordinator', 'request_completed', { request_id: requestId });
  }
}

function exec(cmd, cwd) {
  return execSync(cmd, { encoding: 'utf8', cwd, timeout: 60000 }).trim();
}

module.exports = { start, onTaskCompleted, processQueue, attemptMerge };
