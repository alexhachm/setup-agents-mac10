#!/usr/bin/env bash
# mac10 worker sentinel — simplified from mac9 (137→~35 lines)
# Runs in a tmux window. Waits for tasks via mac10 inbox, syncs, launches claude.
set -euo pipefail
export PATH="$HOME/bin:$HOME/.local/bin:$PATH"

WORKER_ID="${1:?Usage: worker-sentinel.sh <worker_id> <project_dir>}"
PROJECT_DIR="${2:?Usage: worker-sentinel.sh <worker_id> <project_dir>}"
WORKTREE="$PROJECT_DIR/.worktrees/wt-$WORKER_ID"

cd "$WORKTREE" || { echo "Worktree not found: $WORKTREE"; exit 1; }

cleanup() { mac10 heartbeat "$WORKER_ID" 2>/dev/null; }
trap cleanup EXIT

echo "[sentinel-$WORKER_ID] Ready in $WORKTREE"

while true; do
  # Wait for task assignment (blocks up to 5 minutes)
  echo "[sentinel-$WORKER_ID] Waiting for task..."
  MSGS=$(mac10 inbox "worker-$WORKER_ID" --block --timeout=300000 2>/dev/null || echo "")

  # Check if we got a task_assigned message
  if echo "$MSGS" | grep -q "task_assigned"; then
    echo "[sentinel-$WORKER_ID] Task received, syncing..."

    # Sync with latest main
    git fetch origin 2>/dev/null || true
    git rebase origin/main 2>/dev/null || {
      git rebase --abort 2>/dev/null || true
      git reset --hard origin/main 2>/dev/null || true
    }

    # Launch Claude worker
    echo "[sentinel-$WORKER_ID] Launching claude..."
    claude --model opus "/worker-loop" 2>&1 || true

    echo "[sentinel-$WORKER_ID] Claude exited, resetting status..."
    mac10 heartbeat "$WORKER_ID" 2>/dev/null || true
  fi
done
