'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
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
let processingStartedAt = 0;
const PROCESSING_TIMEOUT_MS = 300000; // 5 minutes — reset flag if stuck
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
  // Reset processing flag if stuck beyond timeout
  if (processing && processingStartedAt > 0 && (Date.now() - processingStartedAt) > PROCESSING_TIMEOUT_MS) {
    db.log('coordinator', 'merger_processing_timeout', { stuck_ms: Date.now() - processingStartedAt });
    processing = false;
  }
  if (processing) return;
  processing = true;
  processingStartedAt = Date.now();

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
    } else if (result.functional_conflict) {
      db.updateMerge(entry.id, { status: 'failed', error: `functional_conflict: ${result.error}` });
      db.log('coordinator', 'functional_conflict', {
        merge_id: entry.id,
        branch: entry.branch,
        error: result.error,
      });
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

  // Pre-merge: check if overlapping tasks were already merged → run validation
  const preValidation = runOverlapValidation(entry, projectDir);
  if (preValidation && !preValidation.passed) {
    escalateToAllocator(entry, preValidation.error, true);
    return { success: false, functional_conflict: true, error: preValidation.error, tier: 'validation' };
  }

  // Tier 1: Clean merge via gh CLI
  const tier1 = tryCleanMerge(entry, projectDir);
  if (tier1.success) return { success: true, tier: 1 };

  // Tier 2: Auto-resolve (rebase and retry)
  const tier2 = tryRebase(entry, projectDir);
  if (tier2.success) {
    // Post-rebase validation if overlapping tasks exist
    const postValidation = runOverlapValidation(entry, projectDir);
    if (postValidation && !postValidation.passed) {
      escalateToAllocator(entry, postValidation.error, true);
      return { success: false, functional_conflict: true, error: postValidation.error, tier: 'validation' };
    }
    // Rebase succeeded, try clean merge again
    const retry = tryCleanMerge(entry, projectDir);
    if (retry.success) return { success: true, tier: 2 };
  }

  // Tiers 1 & 2 failed — escalate to allocator
  escalateToAllocator(entry, tier2.error || tier1.error, false);
  return { success: false, conflict: true, error: tier2.error || tier1.error, tier: 3 };
}

// Find the worktree path for a merge entry's branch.
// Worktrees already have the branch checked out, so we can rebase/validate
// in-place without `git checkout` (which fails when a worktree holds the branch).
function findWorktreePath(entry, projectDir) {
  // Try DB: merge entry → task → worker → worktree_path
  try {
    const task = db.getTask(entry.task_id);
    if (task && task.assigned_to) {
      const worker = db.getWorker(task.assigned_to);
      if (worker && worker.worktree_path && fs.existsSync(worker.worktree_path)) {
        return worker.worktree_path;
      }
    }
  } catch {}

  // Fallback: derive from branch name (agent-N → .worktrees/wt-N)
  const match = entry.branch && entry.branch.match(/^agent-(\d+)$/);
  if (match) {
    const wtPath = path.join(projectDir, '.worktrees', `wt-${match[1]}`);
    if (fs.existsSync(wtPath)) return wtPath;
  }

  return null;
}

function tryRebase(entry, projectDir) {
  const wtPath = findWorktreePath(entry, projectDir);
  const rebaseDir = wtPath || projectDir;

  try {
    safeExec('git', ['fetch', 'origin'], rebaseDir);

    if (wtPath) {
      // Rebase directly in worktree (branch already checked out)
      safeExec('git', ['rebase', 'origin/main'], wtPath);
      try {
        safeExec('git', ['push', '--force-with-lease', 'origin', entry.branch], wtPath);
      } catch (pushErr) {
        // Rebase succeeded but push failed — log for diagnosis
        db.log('coordinator', 'rebase_push_failed', {
          branch: entry.branch,
          error: pushErr.message,
        });
        throw pushErr;
      }
    } else {
      // Fallback: old behavior (will fail if worktree holds the branch)
      safeExec('git', ['checkout', entry.branch], projectDir);
      safeExec('git', ['rebase', 'origin/main'], projectDir);
      safeExec('git', ['push', '--force-with-lease', 'origin', entry.branch], projectDir);
      safeExec('git', ['checkout', 'main'], projectDir);
    }
    return { success: true };
  } catch (e) {
    try { safeExec('git', ['rebase', '--abort'], rebaseDir); } catch {}
    if (!wtPath) {
      try { safeExec('git', ['checkout', 'main'], projectDir); } catch {}
    }
    return { success: false, error: e.message };
  }
}

function runOverlapValidation(entry, projectDir) {
  // Only validate when merge_validation config is enabled
  const mergeValidation = db.getConfig('merge_validation');
  if (mergeValidation !== 'true') return null;

  // Check if any overlapping tasks were already merged
  const mergedOverlaps = db.hasOverlappingMergedTasks(entry.task_id);
  if (mergedOverlaps.length === 0) return null;

  db.log('coordinator', 'overlap_validation_start', {
    merge_id: entry.id,
    task_id: entry.task_id,
    overlapping_merged: mergedOverlaps.map(m => m.id),
  });

  const wtPath = findWorktreePath(entry, projectDir);
  const validationDir = wtPath || projectDir;

  try {
    safeExec('git', ['fetch', 'origin'], validationDir);

    if (wtPath) {
      // Validate directly in worktree (branch already checked out)
      safeExec('npm', ['run', 'build'], wtPath);
    } else {
      // Fallback: old behavior
      safeExec('git', ['checkout', entry.branch], projectDir);
      safeExec('npm', ['run', 'build'], projectDir);
    }

    // Run task-specific validation if set
    const task = db.getTask(entry.task_id);
    if (task && task.validation) {
      let validation;
      try { validation = JSON.parse(task.validation); } catch { validation = task.validation; }
      if (typeof validation === 'string' && validation.trim()) {
        const parts = validation.trim().split(/\s+/);
        safeExec(parts[0], parts.slice(1), validationDir);
      } else if (typeof validation === 'object' && validation !== null) {
        // Handle structured validation: { test_cmd, build_cmd, lint_cmd }
        for (const key of ['build_cmd', 'test_cmd', 'lint_cmd']) {
          if (validation[key] && typeof validation[key] === 'string') {
            const parts = validation[key].trim().split(/\s+/);
            safeExec(parts[0], parts.slice(1), validationDir);
          }
        }
      }
    }

    if (!wtPath) {
      safeExec('git', ['checkout', 'main'], projectDir);
    }
    db.log('coordinator', 'overlap_validation_passed', { merge_id: entry.id, task_id: entry.task_id });
    return { passed: true };
  } catch (e) {
    if (!wtPath) {
      try { safeExec('git', ['checkout', 'main'], projectDir); } catch {}
    }
    db.log('coordinator', 'overlap_validation_failed', {
      merge_id: entry.id,
      task_id: entry.task_id,
      error: e.message,
    });
    return { passed: false, error: e.message };
  }
}

function escalateToAllocator(entry, error, isFunctional) {
  const task = db.getTask(entry.task_id);
  const mailType = isFunctional ? 'functional_conflict' : 'merge_failed';
  db.sendMail('allocator', mailType, {
    request_id: entry.request_id,
    task_id: entry.task_id,
    merge_id: entry.id,
    branch: entry.branch,
    pr_url: entry.pr_url,
    error,
    original_task: task ? {
      subject: task.subject,
      description: task.description,
      domain: task.domain,
      files: task.files,
      assigned_to: task.assigned_to,
    } : null,
    overlapping_merged: isFunctional ? db.hasOverlappingMergedTasks(entry.task_id) : undefined,
  });
}

function checkPrState(prUrl, projectDir) {
  try {
    const state = safeExec('gh', ['pr', 'view', prUrl, '--json', 'state', '-q', '.state'], projectDir);
    return state;
  } catch {
    return null;
  }
}

function tryCleanMerge(entry, projectDir) {
  try {
    // Merge PR via gh CLI
    safeExec('gh', ['pr', 'merge', entry.pr_url, '--merge', '--delete-branch'], projectDir);
    return { success: true };
  } catch (e) {
    const errMsg = e.message || '';
    const isWorktreeBranchError = /cannot delete branch.*used by worktree/i.test(errMsg);

    if (isWorktreeBranchError) {
      // Branch deletion failed because it's checked out in a worktree.
      // The PR merge itself may have succeeded — verify on GitHub.
      const state = checkPrState(entry.pr_url, projectDir);
      if (state === 'MERGED') {
        db.log('coordinator', 'merge_branch_delete_skipped', {
          branch: entry.branch,
          pr_url: entry.pr_url,
          reason: 'branch checked out in worktree',
        });
        return { success: true };
      }
    }

    // Also handle the case where the PR was merged externally
    // (e.g., by another process or manually) but gh pr merge failed
    const state = checkPrState(entry.pr_url, projectDir);
    if (state === 'MERGED') {
      db.log('coordinator', 'merge_already_merged', {
        branch: entry.branch,
        pr_url: entry.pr_url,
      });
      return { success: true };
    }

    return { success: false, error: errMsg };
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
