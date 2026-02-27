# mac10 — Multi-Agent Orchestration for Claude Code

A deterministic coordination system for multiple Claude Code agents. LLMs do coding work; Node.js does coordination.

## Architecture

```
User ──mac10 CLI──→ Coordinator (Node.js) ──tmux──→ Workers (Opus)
                         |                              |
                    SQLite WAL                    mac10 CLI
                         |                              |
                    Architect (Opus) ←──mac10 CLI──────→|
```

- **Coordinator**: Node.js process. Owns all state (SQLite), worker lifecycle (tmux), task allocation, merge queue, watchdog.
- **Architect**: Single Opus agent. Triages requests into Tier 1/2/3, decomposes complex work into tasks.
- **Workers 1-8**: Opus agents in git worktrees. Receive tasks, code, create PRs.

## Quick Start

```bash
# Prerequisites: node 18+, git, gh, tmux, claude
bash setup.sh /path/to/your-project 4

# Submit a request
mac10 request "Add user authentication"

# Start the architect
cd /path/to/your-project
claude --model opus /architect-loop

# Check status
mac10 status

# View dashboard
open http://localhost:3100
```

## CLI Reference

```
USER:      request, fix, status, clarify, log
ARCHITECT: triage, create-task, tier1-complete, ask-clarification, inbox
WORKER:    my-task, start-task, heartbeat, complete-task, fail-task, distill, inbox
SYSTEM:    start, stop, repair, gui, ping
```

## How It Works

1. User submits a request via `mac10 request`
2. Coordinator stores it in SQLite, mails the Architect
3. Architect triages: Tier 1 (do it), Tier 2 (one worker), Tier 3 (decompose)
4. Coordinator allocates tasks to idle workers (domain affinity, mail-before-boot)
5. Workers code in git worktrees, create PRs, report completion
6. Coordinator merges PRs (4-tier: clean → rebase → AI-resolve → redo)
7. Watchdog monitors health (heartbeats, ZFC death detection, tiered escalation)

## Key Design Decisions

- **SQLite WAL** replaces 7 JSON files + jq — concurrent reads, serialized writes, no race conditions
- **Mail table** replaces 10+ signal files — reliable, ordered, read-once semantics
- **mac10 CLI** is the only interface between agents and coordinator — no file manipulation
- **tmux** replaces platform-specific terminals — works everywhere including WSL
- **Web dashboard** replaces Electron GUI — simpler, no build step
