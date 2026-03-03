# Codebase Insights

## Tech Stack
- Node.js 18+ (coordinator), SQLite WAL (better-sqlite3 v11), Express v4.21, WebSocket (ws v8.18)
- Bash scripts for worker lifecycle, tmux for process orchestration
- No build step — pure JS runtime

## Build & Test
- Test: `cd coordinator && npm test` (node --test tests/*.test.js)
- Start: `mac10 start [project_dir]`
- Setup: `bash setup.sh /path/to/project [num_workers]`
- Dashboard: http://localhost:3100

## Directory Structure
- `coordinator/src/` — Core server (7 modules, ~1870 LOC total)
- `coordinator/bin/mac10` — CLI entry point (457L)
- `coordinator/tests/` — 6 test files (security, state-machine, cli, allocator, watchdog, merger)
- `gui/public/` — Web dashboard (app.js 443L, styles.css 406L, index.html 117L)
- `scripts/` — worker-sentinel.sh (47L), launch-agent.sh
- `.claude/commands/` — 7 agent loop templates (architect, worker, allocator, master, scan)
- `.claude/agents/` — 3 specialized agents (code-architect, build-validator, verify-app)
- `.claude/knowledge/` — Shared knowledge base (synced to worktrees before tasks)
- `.worktrees/wt-{1..N}/` — Worker git worktrees
- `templates/` — Template files for project setup

## Domain Map
- **coordinator**: cli-server.js (475L), db.js (349L), web-server.js (438L), watchdog.js (224L), merger.js (196L), overlay.js (137L), index.js (112L), tmux.js (104L), allocator.js (51L)
- **gui**: gui/public/ — WebSocket dashboard, static HTML/CSS/JS
- **infra**: scripts/, setup.sh, .claude/scripts/
- **agent-config**: .claude/commands/, .claude/agents/, templates/

## DB Schema (6 tables)
- `requests` — user requests with status workflow (pending→triaging→decomposed→completed)
- `tasks` — decomposed work items with dependencies and assignment tracking
- `workers` — worker state, heartbeat, tmux info, claim tracking
- `mail` — IPC messages (replaces signal files)
- `merge_queue` — PR merge pipeline
- `activity_log` — audit trail
- `config` — coordinator settings

## Key Patterns
- All state via SQLite — no JSON files for state management
- `mac10` CLI is the only interface — no direct file/DB manipulation
- Worker commands expect `worker_id` as string; allocator commands expect number
- Allocator runs every 2s, notifies Master-3 agent when tasks+workers available
- Watchdog runs every 10s, escalates: warn(60s)→nudge(90s)→triage(120s)→terminate(180s)
- Merger triggered on task completion + periodic 5s checks, dedup on PR URL
- Knowledge files synced from project root to worktrees before each task
- Sentinel uses `-p` (print mode) to ensure Claude exits after processing
- Coordinator requires Node v22 via nvm (better-sqlite3 compatibility)

## Entry Points
- `coordinator/src/index.js` — main coordinator (inits db, cli-server, allocator, watchdog, merger, web-server)
- `coordinator/bin/mac10` — CLI client (sends JSON over Unix socket)
- `gui/public/app.js` — dashboard frontend (WebSocket)
- `scripts/worker-sentinel.sh` — worker lifecycle loop in tmux

## Coupling Hotspots
- `architect-loop.md` + `allocate-loop.md` (change together 7x)
- `setup.sh` (changes with template files 7x)
- `gui/public/app.js` + `styles.css` + `index.html` (3-5x)

## Large Files
- coordinator/tests/security.test.js (543L)
- coordinator/src/cli-server.js (475L)
- gui/public/app.js (443L)
- coordinator/src/web-server.js (438L)
- gui/public/styles.css (406L)
- coordinator/src/db.js (349L)

Last scanned: 2026-02-27
