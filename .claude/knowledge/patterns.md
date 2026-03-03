# Decomposition Patterns

Learnings from past task decompositions. Updated by the Architect after completing triage cycles.

## Good Patterns
- When requests touch the same component, assign to the same worker to avoid merge conflicts
- The allocator auto-assigns ready tasks to idle workers — for Tier 2, claim+assign immediately to beat allocator race
- Sentinel needs `unset CLAUDECODE` before launching claude in tmux
- For Tier 3 phased work, create phase tasks with clear dependencies. Allocator assigns automatically.
- `fix` requests auto-create tasks — don't create duplicates manually

## Anti-Patterns
- Don't assign multiple workers to the same component simultaneously (merge conflict risk)
- Don't rely on `release-worker` to clear assignments — it only clears claims, not task assignments
- Creating tasks without immediately assigning leads to allocator race conditions
- Failing tasks to reset workers loses task history — use sparingly, prefer watchdog auto-recovery
- NEVER read worker inboxes (`mac10 inbox worker-X`) — consumes mail the sentinel needs
- Merger's `tryAIResolve` marks merge entry as 'merged' prematurely — PRs don't actually merge
- Stale tasks in "ready" state get re-assigned endlessly — clean up completed/stale tasks
