#!/usr/bin/env bash
# mac10 setup — Single entry point installer
# Usage: bash setup.sh /path/to/your-project [num_workers]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${1:?Usage: bash setup.sh <project_dir> [num_workers]}"
NUM_WORKERS="${2:-4}"
MAX_WORKERS=8

# Resolve to absolute path
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd || echo "$PROJECT_DIR")"

echo "========================================"
echo " mac10 Multi-Agent Setup"
echo "========================================"
echo "Project:  $PROJECT_DIR"
echo "Workers:  $NUM_WORKERS"
echo ""

# --- WSL shim: expose Windows-side CLIs if running under WSL ---
if grep -qi microsoft /proc/version 2>/dev/null; then
  _wsl_shim() {
    local cmd="$1"
    if ! command -v "$cmd" &>/dev/null; then
      for p in "/mnt/c/Program Files/GitHub CLI" "/mnt/c/Users/$USER/AppData/Local/Programs" "/mnt/c/ProgramData/chocolatey/bin"; do
        if [ -f "$p/${cmd}.exe" ]; then
          mkdir -p "$HOME/bin"
          ln -sf "$p/${cmd}.exe" "$HOME/bin/$cmd"
          export PATH="$HOME/bin:$PATH"
          return
        fi
      done
    fi
  }
  _wsl_shim gh
  _wsl_shim claude
  # Ensure nvm node is on PATH
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" 2>/dev/null
fi

# --- Preflight checks ---

echo "[1/8] Preflight checks..."

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' not found. Please install it first."
    exit 1
  fi
}

check_cmd node
check_cmd git
check_cmd gh
check_cmd tmux
check_cmd claude

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found v$(node -v))"
  exit 1
fi

# Check git repo
if [ ! -d "$PROJECT_DIR/.git" ]; then
  echo "ERROR: $PROJECT_DIR is not a git repository"
  exit 1
fi

# Check gh auth
if ! gh auth status &>/dev/null; then
  echo "ERROR: GitHub CLI not authenticated. Run 'gh auth login' first."
  exit 1
fi

echo "  All checks passed."

# --- Install coordinator ---

echo "[2/8] Installing coordinator..."

cd "$SCRIPT_DIR/coordinator"
npm install --production 2>&1 | tail -1
echo "  Dependencies installed."

# --- Create .claude directory structure ---

echo "[3/8] Setting up project directories..."

CLAUDE_DIR="$PROJECT_DIR/.claude"
mkdir -p "$CLAUDE_DIR/commands"
mkdir -p "$CLAUDE_DIR/state"
mkdir -p "$CLAUDE_DIR/knowledge/domain"
mkdir -p "$CLAUDE_DIR/scripts"

# --- Copy templates ---

echo "[4/8] Copying templates..."

# Commands (slash commands for agents)
cp "$SCRIPT_DIR/templates/commands/"*.md "$CLAUDE_DIR/commands/"

# Agent templates
mkdir -p "$CLAUDE_DIR/agents"
cp "$SCRIPT_DIR/templates/agents/"*.md "$CLAUDE_DIR/agents/"

# Knowledge templates (don't overwrite existing)
for f in "$SCRIPT_DIR/templates/knowledge/"*.md; do
  dest="$CLAUDE_DIR/knowledge/$(basename "$f")"
  [ -f "$dest" ] || cp "$f" "$dest"
done

# Docs
mkdir -p "$CLAUDE_DIR/docs"
cp "$SCRIPT_DIR/templates/docs/"*.md "$CLAUDE_DIR/docs/"

# CLAUDE.md for architect (root)
cp "$SCRIPT_DIR/templates/root-claude.md" "$PROJECT_DIR/CLAUDE.md"

# Worker CLAUDE.md template
cp "$SCRIPT_DIR/templates/worker-claude.md" "$CLAUDE_DIR/worker-claude.md"

# Scripts
cp "$SCRIPT_DIR/scripts/worker-sentinel.sh" "$CLAUDE_DIR/scripts/"
chmod +x "$CLAUDE_DIR/scripts/worker-sentinel.sh"

# Settings
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
  cp "$SCRIPT_DIR/templates/settings.json" "$SETTINGS_FILE"
fi

echo "  Templates copied."

# --- Add mac10 to PATH ---

echo "[5/8] Setting up mac10 CLI..."

MAC10_BIN="$SCRIPT_DIR/coordinator/bin/mac10"
chmod +x "$MAC10_BIN"

# Create a wrapper script in the project
cat > "$CLAUDE_DIR/scripts/mac10" << WRAPPER
#!/usr/bin/env bash
exec node "$MAC10_BIN" "\$@"
WRAPPER
chmod +x "$CLAUDE_DIR/scripts/mac10"

# Add to PATH for this project's agents
export PATH="$CLAUDE_DIR/scripts:$SCRIPT_DIR/coordinator/bin:$PATH"

echo "  mac10 CLI ready."

# --- Create worktrees ---

echo "[6/8] Creating $NUM_WORKERS worktrees..."

WORKTREE_DIR="$PROJECT_DIR/.worktrees"
mkdir -p "$WORKTREE_DIR"

cd "$PROJECT_DIR"
MAIN_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")

for i in $(seq 1 "$NUM_WORKERS"); do
  WT_PATH="$WORKTREE_DIR/wt-$i"
  BRANCH="agent-$i"

  if [ -d "$WT_PATH" ]; then
    echo "  Worktree wt-$i already exists, skipping."
    continue
  fi

  # Create branch if it doesn't exist
  git branch "$BRANCH" "$MAIN_BRANCH" 2>/dev/null || true
  git worktree add "$WT_PATH" "$BRANCH" 2>/dev/null || {
    # Branch might already exist from a previous run
    git worktree add "$WT_PATH" "$BRANCH" --force 2>/dev/null || true
  }

  # Copy CLAUDE.md for worker
  cp "$CLAUDE_DIR/worker-claude.md" "$WT_PATH/CLAUDE.md"

  # Link/copy knowledge and commands to worktree
  mkdir -p "$WT_PATH/.claude/commands"
  mkdir -p "$WT_PATH/.claude/knowledge"
  mkdir -p "$WT_PATH/.claude/scripts"
  cp "$CLAUDE_DIR/commands/"*.md "$WT_PATH/.claude/commands/"
  cp "$CLAUDE_DIR/scripts/mac10" "$WT_PATH/.claude/scripts/"

  # Copy knowledge files (will be updated via main project junction/copy)
  cp -r "$CLAUDE_DIR/knowledge/"* "$WT_PATH/.claude/knowledge/" 2>/dev/null || true

  echo "  Created worktree wt-$i (branch: $BRANCH)"
done

# --- Add trusted directories ---

echo "[7/8] Configuring trusted directories..."

# Detect platform for path format
add_trusted() {
  local p="$1"
  # Add to settings.json trustedDirectories array
  if command -v python3 &>/dev/null; then
    python3 - "$SETTINGS_FILE" "$p" << 'PYEOF'
import json, sys
f, p = sys.argv[1], sys.argv[2]
with open(f) as fp: d = json.load(fp)
dirs = d.setdefault('trustedDirectories', [])
if p not in dirs: dirs.append(p)
with open(f, 'w') as fp: json.dump(d, fp, indent=2)
PYEOF
  fi
}

add_trusted "$PROJECT_DIR"
for i in $(seq 1 "$NUM_WORKERS"); do
  add_trusted "$WORKTREE_DIR/wt-$i"
done

# On Windows/WSL, also add Windows-format paths
if grep -qi microsoft /proc/version 2>/dev/null; then
  WIN_PROJECT=$(echo "$PROJECT_DIR" | sed 's|^/mnt/\(.\)|\U\1:|; s|/|\\\\|g')
  add_trusted "$WIN_PROJECT"
  for i in $(seq 1 "$NUM_WORKERS"); do
    WIN_WT=$(echo "$WORKTREE_DIR/wt-$i" | sed 's|^/mnt/\(.\)|\U\1:|; s|/|\\\\|g')
    add_trusted "$WIN_WT"
  done
fi

echo "  Trusted directories configured."

# --- Initialize coordinator ---

echo "[8/8] Starting coordinator..."

# Check if coordinator is already running (e.g. launched by GUI)
ALREADY_RUNNING=false
if [ -S "$CLAUDE_DIR/state/mac10.sock" ] || lsof -i :${MAC10_PORT:-3100} &>/dev/null 2>&1; then
  ALREADY_RUNNING=true
  echo "  Coordinator already running, skipping start."
fi

if [ "$ALREADY_RUNNING" = false ]; then
  node "$SCRIPT_DIR/coordinator/src/index.js" "$PROJECT_DIR" &
  COORD_PID=$!

  # Wait for socket
  for i in $(seq 1 30); do
    if [ -S "$CLAUDE_DIR/state/mac10.sock" ]; then
      break
    fi
    sleep 0.2
  done

  if [ ! -S "$CLAUDE_DIR/state/mac10.sock" ]; then
    echo "WARNING: Coordinator didn't create socket within 6s"
    echo "  Check logs or run: node $SCRIPT_DIR/coordinator/src/index.js $PROJECT_DIR"
  else
    # Register workers
    for i in $(seq 1 "$NUM_WORKERS"); do
      mac10 ping >/dev/null 2>&1 || true
    done
    echo "  Coordinator running (PID: $COORD_PID)"
  fi
fi

# --- Launch all 3 masters ---

echo "Launching master agents..."

WT_EXE="/mnt/c/Users/$USER/AppData/Local/Microsoft/WindowsApps/wt.exe"
if [ -f "$WT_EXE" ]; then
  WIN_PROJECT=$(echo "$PROJECT_DIR" | sed 's|^/mnt/\(.\)/|\U\1:\\|; s|/|\\|g')

  # Master-1 (Interface) — Sonnet
  "$WT_EXE" -w 0 new-tab --title "Master-1 (Interface)" -- wsl.exe -d "$WSL_DISTRO_NAME" -- bash -c "cd '$PROJECT_DIR' && claude --model sonnet /master-loop; exec bash" &
  echo "  Master-1 (Interface/Sonnet) terminal opened."

  sleep 1

  # Master-2 (Architect) — Opus
  "$WT_EXE" -w 0 new-tab --title "Master-2 (Architect)" -- wsl.exe -d "$WSL_DISTRO_NAME" -- bash -c "cd '$PROJECT_DIR' && claude --model opus /architect-loop; exec bash" &
  echo "  Master-2 (Architect/Opus) terminal opened."

  sleep 1

  # Master-3 (Allocator) — Sonnet
  "$WT_EXE" -w 0 new-tab --title "Master-3 (Allocator)" -- wsl.exe -d "$WSL_DISTRO_NAME" -- bash -c "cd '$PROJECT_DIR' && claude --model sonnet /allocate-loop; exec bash" &
  echo "  Master-3 (Allocator/Sonnet) terminal opened."
else
  echo "  Windows Terminal not found — start manually:"
  echo "    cd $PROJECT_DIR && claude --model sonnet /master-loop"
  echo "    cd $PROJECT_DIR && claude --model opus /architect-loop"
  echo "    cd $PROJECT_DIR && claude --model sonnet /allocate-loop"
fi

echo ""
echo "========================================"
echo " mac10 Setup Complete!"
echo "========================================"
echo ""
echo "3 Masters launched:"
echo "  Master-1 (Interface/Sonnet)  — user's contact point"
echo "  Master-2 (Architect/Opus)    — triage & decomposition"
echo "  Master-3 (Allocator/Sonnet)  — task-worker matching"
echo ""
echo "Dashboard:    http://localhost:3100"
echo "Submit work:  mac10 request \"Add user authentication\""
echo "Check status: mac10 status"
echo "View logs:    mac10 log"
echo ""
echo "Workers will be spawned automatically when tasks are assigned."
echo ""
