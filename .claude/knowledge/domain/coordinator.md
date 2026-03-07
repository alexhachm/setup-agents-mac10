# Coordinator Domain Knowledge

## Architecture
- **cli-server.js** (~740 lines): TCP/Unix socket server handling all agent CLI commands. Newline-delimited JSON protocol.
- **web-server.js** (~720 lines): Express HTTP + WebSocket server for the GUI dashboard.
- **db.js**: SQLite (better-sqlite3) with WAL mode, column whitelisting, and parameterized queries.

## Key Patterns
- All CLI commands validated via COMMAND_SCHEMAS before reaching handleCommand switch
- Atomic task assignment uses SQLite transactions to prevent double-assign
- WebSocket broadcasts state every 2s; ping/pong every 30s cleans stale connections
- TCP bridge on port 31000-31999 for cross-environment access (Git Bash <-> WSL)

## Testing
- Tests in `coordinator/tests/` using Node.js built-in test runner (`node --test`)
- Run with `cd coordinator && npm test`
- 70 tests across 21 suites as of 2026-03-07

## Common Issues
- `gh pr create` fails from worktree dirs — must run from main repo dir
- `mac10 distill` CLI has a type coercion issue (passes number instead of string for worker_id)
- `mac10 log-change` is not exposed in the CLI binary despite being a server command
