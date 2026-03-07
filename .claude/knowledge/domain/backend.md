# Backend Domain Knowledge

## Stack
- Node.js (>=18) with Express, WebSocket (ws), better-sqlite3
- No build step — plain CommonJS modules
- Tests: `node --test tests/*.test.js` (Node.js built-in test runner)

## Key Files
- `coordinator/src/index.js` — Main coordinator startup
- `coordinator/src/cli-server.js` — Unix socket CLI server
- `coordinator/src/web-server.js` — Express HTTP + WebSocket
- `coordinator/src/db.js` — SQLite database helpers
- `coordinator/src/schema.sql` — Database schema (13+ tables)
- `coordinator/src/script-parser.js` — DAS-Trader script parser
- `coordinator/src/script-executor.js` — Script execution engine
- `coordinator/src/hotkey-manager.js` — Hotkey CRUD with DB storage

## Scripting System Architecture
- Parser: lexer → expression AST → command objects
- Executor: resolves values against market/account context, produces action objects
- Manager: CRUD with profile support, stored in `hotkey_scripts` SQLite table
- API: 10 endpoints at `/api/hotkeys/*` (CRUD, trigger, validate, dry-run, import/export)

## Patterns
- All modules use `'use strict'` and CommonJS exports
- DB access via `db.getDb()` (better-sqlite3 instance)
- Schema auto-migration on first use (CREATE TABLE IF NOT EXISTS)
- Web server broadcasts state via WebSocket every 2s

## Notes
- better-sqlite3 native binding may need rebuilding if Node.js version changes
- Security hook blocks commands containing `.key` or `token` patterns (false positives for hotkey/tokenizer)
- `gh pr create` must run from main repo dir, not worktree
