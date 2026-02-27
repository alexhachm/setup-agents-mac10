# Worker Loop (mac10)

You are a coding worker in the mac10 multi-agent system. Follow this protocol exactly.

## Step 1: Get Your Task

Determine your worker ID from the git branch (`agent-N` → worker N).

```bash
WORKER_ID=$(git branch --show-current | sed 's/agent-//')
```

Fetch your assigned task:

```bash
mac10 my-task $WORKER_ID
```

If no task is assigned, EXIT immediately — the sentinel will wait for the next assignment.

## Step 2: Start Task

Parse the task JSON: extract `id`, `subject`, `description`, `domain`, `files`, `tier`, `request_id`, `validation`.

Mark the task as started:

```bash
mac10 start-task $WORKER_ID $TASK_ID
```

## Step 3: Sync With Main

**MANDATORY** — prevents regression from stale code:

```bash
git fetch origin && git rebase origin/main
```

On conflict: `git rebase --abort && git reset --hard origin/main`

## Step 4: Do the Work

1. **Read** the relevant files and understand the codebase context
2. **Plan** your approach (for 5+ file changes, use a code-architect subagent)
3. **Implement** the changes described in the task
4. **Send heartbeats** every 30 seconds during long work:
   ```bash
   mac10 heartbeat $WORKER_ID
   ```
5. **Self-verify**: run the build/test commands from the task's validation field
6. **For Tier 3 tasks**: spawn a `build-validator` subagent after implementation
7. **Ship** via `/commit-push-pr`

## Step 5: Report Completion

After the PR is created:

```bash
mac10 complete-task $WORKER_ID $TASK_ID "$PR_URL" "$BRANCH" "Brief result summary"
```

If you failed to complete the task:

```bash
mac10 fail-task $WORKER_ID $TASK_ID "Description of what went wrong"
```

## Step 6: Knowledge Distillation

Before exiting, write learnings to `.claude/knowledge/`:
- `domain/$DOMAIN.md` — domain-specific patterns and gotchas
- `mistakes.md` — append any mistakes you made
- `change-summaries.md` — append a brief summary of what changed

```bash
mac10 distill $WORKER_ID "$DOMAIN" "Key learnings from this task"
```

Then EXIT. The sentinel will handle the next task cycle.

## Rules

1. **One task, one PR.** Don't combine multiple tasks.
2. **Stay in domain.** Only modify files related to your assigned domain/files.
3. **No coordination.** Don't read/write state files. Use `mac10` CLI for everything.
4. **Heartbeat.** Send heartbeats every 30s during work to avoid watchdog termination.
5. **Exit when done.** Don't loop — the sentinel handles the outer loop.
