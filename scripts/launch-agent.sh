#!/usr/bin/env bash
# Launch a Claude agent in the specified project directory.
# Usage: launch-agent.sh <project-dir> <model> <slash-command>
# Avoids semicolons so Windows Terminal doesn't split the command.
set -euo pipefail

if [ $# -lt 3 ]; then
  echo "Usage: launch-agent.sh <project-dir> <model> <slash-command>" >&2
  exit 1
fi

DIR="$1"
MODEL="$2"
CMD="$3"

if [ ! -d "$DIR" ]; then
  echo "ERROR: Directory not found: $DIR" >&2
  exit 1
fi
cd "$DIR"

# Ensure mac10 CLI is on PATH (project wrapper + coordinator bin)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$DIR/.claude/scripts:$SCRIPT_DIR/../coordinator/bin:$PATH"

# Source nvm if available (ensures consistent Node.js version)
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" 2>/dev/null

# Prevent nested session rejection when launched from within another Claude session
unset CLAUDECODE 2>/dev/null || true

export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
claude --dangerously-skip-permissions --model "$MODEL" "$CMD"
exec bash
