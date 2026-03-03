# Known Pitfalls

Mistakes made by workers. Read before starting any task to avoid repeating them.

## Common Mistakes

### Worker nested session crash (2026-02-27)
- **Issue**: Worker sentinels launch `claude` inside tmux, but `CLAUDECODE` env var from parent causes "nested session" rejection
- **Fix**: Added `unset CLAUDECODE` before launching claude in BOTH `scripts/worker-sentinel.sh` AND `.claude/scripts/worker-sentinel.sh`
- **Note**: There are two copies of the sentinel script — the coordinator uses `.claude/scripts/` version

### Coordinator Node version mismatch (2026-02-27)
- **Issue**: better-sqlite3 compiled for Node v22 but system node is v24. Coordinator crashes on startup.
- **Fix**: Must use nvm (`nvm use 22`) before starting coordinator. Run `npm rebuild better-sqlite3` with v22.
- **Note**: Port 3100 can also be left bound after crash — kill old process first

### CLI type mismatch for worker commands (2026-02-27)
- **Issue**: `coordinator/bin/mac10` used `parseInt()` for worker_id in worker commands, but server expects string
- **Fix**: Changed to pass `argv[1]` as string instead of `parseInt(argv[1])`

### Claude Code stays interactive after worker-loop (2026-02-27)
- **Issue**: `claude --dangerously-skip-permissions "/worker-loop"` processes the command but doesn't exit — goes interactive, sentinel never cycles
- **Fix**: Added `-p` (print mode) flag: `claude --model opus --dangerously-skip-permissions -p "/worker-loop"` — exits after processing
- **Note**: Both copies of sentinel script must be updated

### Architect must NEVER read worker inboxes (2026-02-27)
- **Issue**: Running `mac10 inbox worker-X` from architect consumes the mail, preventing the sentinel from seeing it
- **Rule**: Never call `mac10 inbox worker-X` — only read your own inbox (`mac10 inbox architect`)
- **Recovery**: If mail is consumed, fail the task + create a new one + assign to resend mail

### Merger creates infinite merge conflict loop (2026-02-27)
- **Issue**: `tryAIResolve` returns `{ success: true }` → merge entry marked 'merged' → but PR isn't actually merged. Worker completes fix task with same PR → `enqueueMerge` adds new entry → merger processes again → infinite loop
- **Fix 1**: Added dedup check in `enqueueMerge` — skip if any entry exists for same PR URL
- **Fix 2 (TODO)**: `tryAIResolve` should NOT return success — needs a 'pending_fix' status so the merge isn't marked as done until the PR is actually merged
- **Note**: Coordinator restart required after db.js changes

### Charts root cause (2026-02-27)
- **Root cause**: No chart code existed at all. Worker-3 added Chart.js with doughnut charts for worker/task distributions.
- **Fix**: Full chart pipeline added: CDN library, HTML containers, JS rendering with real-time updates, CSS layout
