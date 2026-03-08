#!/usr/bin/env bash
# mac10 loop sentinel — runs in a tmux window.
# Continuously relaunches claude for a persistent autonomous loop.
# Pre-checks active requests to avoid wasting Claude spawns.
# Adaptive backoff: short runs → exponential backoff, long runs → reset.
set -euo pipefail
export PATH="$HOME/bin:$HOME/.local/bin:$PATH"

LOOP_ID="${1:?Usage: loop-sentinel.sh <loop_id> <project_dir>}"
PROJECT_DIR="${2:?Usage: loop-sentinel.sh <loop_id> <project_dir>}"

cd "$PROJECT_DIR"

# Ensure mac10 CLI is on PATH
export PATH="$PROJECT_DIR/.claude/scripts:$PATH"
export MAC10_LOOP_ID="$LOOP_ID"

BACKOFF=5
PRECHECK_BACKOFF=10

echo "[loop-sentinel-$LOOP_ID] Starting in $PROJECT_DIR"

while true; do
  # Check if loop is still active
  PROMPT_JSON=$(mac10 loop-prompt "$LOOP_ID" 2>/dev/null || echo "")
  if [ -z "$PROMPT_JSON" ]; then
    echo "[loop-sentinel-$LOOP_ID] Could not reach coordinator, retrying in ${BACKOFF}s..."
    sleep "$BACKOFF"
    continue
  fi

  STATUS=$(echo "$PROMPT_JSON" | grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\1/' || echo "")
  if [ "$STATUS" != "active" ]; then
    echo "[loop-sentinel-$LOOP_ID] Loop status is '$STATUS', exiting."
    exit 0
  fi

  # Pre-check: skip Claude spawn if requests are still in-flight
  ACTIVE_COUNT=$(mac10 loop-requests "$LOOP_ID" 2>/dev/null | grep -c '"status"[[:space:]]*:[[:space:]]*"\(pending\|triaging\|executing_tier1\|decomposed\|in_progress\|integrating\)"' || true)
  ACTIVE_COUNT="${ACTIVE_COUNT:-0}"
  if [ "$ACTIVE_COUNT" -gt 0 ]; then
    echo "[loop-sentinel-$LOOP_ID] $ACTIVE_COUNT request(s) still active, skipping spawn (backoff=${PRECHECK_BACKOFF}s)"
    sleep "$PRECHECK_BACKOFF"
    PRECHECK_BACKOFF=$((PRECHECK_BACKOFF * 2))
    [ "$PRECHECK_BACKOFF" -gt 120 ] && PRECHECK_BACKOFF=120
    continue
  fi

  # Requests cleared — reset pre-check backoff for next cycle
  PRECHECK_BACKOFF=10

  # Sync with latest main (only if not on main branch — avoid nuking main worktree)
  CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "main")
  if [ "$CURRENT_BRANCH" != "main" ]; then
    git fetch origin 2>/dev/null || true
    git rebase origin/main 2>/dev/null || {
      git rebase --abort 2>/dev/null || true
      git reset --hard origin/main 2>/dev/null || true
    }
  fi

  # Launch Claude for one iteration
  echo "[loop-sentinel-$LOOP_ID] Launching claude (iteration backoff=${BACKOFF}s)..."
  START_TIME=$(date +%s)
  LOOP_PROMPT=$(echo "$PROMPT_JSON" | jq -r '.prompt // empty' 2>/dev/null || echo "")
  if [ -z "$LOOP_PROMPT" ]; then
    LOOP_PROMPT="/loop-agent"
  fi
  unset CLAUDECODE
  claude --model opus --dangerously-skip-permissions -p "$LOOP_PROMPT" 2>&1 || true
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))

  # Adaptive backoff
  if [ "$DURATION" -lt 30 ]; then
    # Short run — likely crashed or empty iteration, increase backoff
    BACKOFF=$((BACKOFF * 2))
    if [ "$BACKOFF" -gt 60 ]; then
      BACKOFF=60
    fi
    echo "[loop-sentinel-$LOOP_ID] Short run (${DURATION}s), backoff → ${BACKOFF}s"
  else
    # Healthy run — set minimum backoff to let pipeline process submissions
    BACKOFF=30
    echo "[loop-sentinel-$LOOP_ID] Healthy run (${DURATION}s), backoff → ${BACKOFF}s (pipeline processing time)"
  fi

  # Check loop status before sleeping (fast exit if stopped)
  mac10 loop-heartbeat "$LOOP_ID" 2>/dev/null || {
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 2 ]; then
      echo "[loop-sentinel-$LOOP_ID] Loop stopped, exiting."
      exit 0
    fi
  }

  sleep "$BACKOFF"
done
