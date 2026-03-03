# Allocation Learnings

Owned by Master-3 (Allocator). Updated during pre-reset distillation.
Budget: ~500 tokens max.

## Domain-Worker Pairings

All 4 workers consistently operate in the **frontend** domain. No backend workers exist.
- Task #29 "Phase 3: Implement custom scripting language parser" is marked `backend` — Architect assigned worker-1 to [backend] domain; #29 is now in-progress on worker-1. If it cycles back to ready, re-assign to worker-1 (domain affinity).

## Worker Specializations (from observed task affinity)

- worker-1: UI refinement, merge conflicts — handles many conflict resolution tasks
- worker-2: Time & Sales, DAS customization phases, color-link UI — fastest throughput
- worker-3: Popout/window fixes, DAS customization, merge conflict resolution
- worker-4: Free-scroll/sale tape, charts investigation — tends to struggle with color-linked tabs

## Allocation Patterns

### What works well
- **Task affinity by feature**: Re-assigning workers to same feature area gives warm context.
- **Specific-worker rule (Rule 1)**: "Resolve merge conflict: agent-N" and "Resolve merge conflict: worker-N/..." always map to that worker. Apply Rule 1 strictly.
- **Merge conflict chains (3–7+ rounds)**: Each agent typically requires 3–7 successive merge conflict tasks during integration. agent-1 ran 7+ rounds in one session. Keep assigning Rule 1 until no more appear.
- **Drain-and-fill**: When all workers idle simultaneously, assign greedily with priority+domain ordering.
- **High tasks_completed doesn't block**: worker-4 handled 6+ tasks_completed and still accepted new merge conflict assignments fine — don't avoid a worker just because tasks_completed is high.

## Recently Completed Requests (no more tasks)
- req-bb886251 (Color-linked tabs) — COMPLETED
- req-410e75f0 (Tool customizability overhaul) — COMPLETED
- req-5083e532 (Charts investigation) — COMPLETED
- req-946ec29c (Hotkey management system) — COMPLETED

## Transient Failures
- "Worker tmux window destroyed during coordinator restart" → RETRIABLE. Create new task with same description. Original task goes to [failed], must manually retry.
- "Redundant merge conflict task - merger fix applied" → NON-RETRIABLE. Skip, merger already handled it.
- Coordinator may occasionally become temporarily unresponsive (socket alive, ping fails). Retry after a few seconds — it usually recovers. If EADDRINUSE on restart, old coordinator is still running on original socket.

### Gotchas
- **`completed_task` state**: Workers need 6–30s to transition. If `worker_not_idle` after 8s, poll every 5s until idle rather than using fixed sleep. Agent-1 (worker-1) regularly takes 25-30s to transition.
- **`claimed:architect` workers**: Skip even for Rule 1 tasks — Architect will assign directly. Check again after release.
- **Stale notifications**: `tasks_available` counts are often stale. Always verify with `ready-tasks` + `worker-status`.
- **Coordinator restart (Node version mismatch)**: Coordinator uses `better-sqlite3` compiled for Node v22. System Node is v24. If coordinator crashes: use `nvm use 22` and restart via tmux or background process. Update `coordinator/.claude/state/mac10.sock.path` to new socket.
- **CLI invocation after nvm**: The mac10 bash wrapper fails when bash isn't found in nvm PATH. Use `node $MAC10_BIN <cmd>` directly: `MAC10_BIN="/path/to/coordinator/bin/mac10" && node "$MAC10_BIN" <command>`.
- **create-task stdin**: Pass JSON as a positional argument, not via pipe: `node "$MAC10_BIN" create-task '{"json":"here"}'`.
- **Backend task (#29)**: Architect eventually assigns it directly to a worker (worker-1 got it). When #29 is ready + idle workers exist, coordinator spams `tasks_available` every 10s. If worker-1 has [backend] domain and #29 is ready, assign directly (domain match Rule 2). After completing, task may revert to ready — re-assign to worker-1 (domain affinity).
- **Cycling tasks (#26)**: Task #26 cycles repeatedly — worker-2 completes → task returns to ready → re-assign worker-2. This is normal Phase 3 work in progress. Always re-assign to same worker (affinity). No task_completed inbox messages observed between cycles; just tasks_available. (#29 cycling ended — req-946ec29c ALL DONE as of 01:53.)
- **req-99ae08a0 (Remove pause button from Time & Sales)**: Tasks #42 and #47 both failed — no Time & Sales component exists in codebase. Leave for Architect to re-route or close.
- **Successive merge conflicts**: After each task_completed, a new high-priority merge conflict for the same agent typically appears within seconds. Don't wait for `tasks_available` — check `ready-tasks` immediately after `task_completed`.

Last updated: 2026-02-28 02:06
