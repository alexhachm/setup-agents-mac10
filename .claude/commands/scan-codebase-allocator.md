# Scan Codebase (Allocator Startup)

Lightweight startup scan for the Allocator agent (Master-3). Gathers just enough context to make good allocation decisions.

## Setup

Ensure `mac10` is on PATH:

```bash
export PATH="$(pwd)/.claude/scripts:$PATH"
```

## Steps

1. Check current system state:
   ```bash
   mac10 status && mac10 worker-status
   ```

2. Read knowledge files:
   - `.claude/knowledge/codebase-insights.md`
   - `.claude/knowledge/patterns.md`
   - `.claude/knowledge/allocation-learnings.md`
   - `.claude/knowledge/domain/` (all files)

3. Check for Master-2's codebase map:
   - Read `.claude/state/codebase-map.json` if it exists
   - If it exists: use it for domain-worker routing decisions
   - If it does NOT exist after 3 minutes of waiting: run a lightweight fallback scan:

### Fallback Scan (only if no codebase-map.json after 3 min)

```bash
# Directory structure
find . -maxdepth 2 -type d | head -30

# File sizes for domain estimation
find . -name '*.ts' -o -name '*.js' -o -name '*.py' | head -50 | xargs wc -l 2>/dev/null | sort -rn | head -15

# Git coupling
git log --oneline --name-only -30 | grep -v '^[a-f0-9]' | sort | uniq -c | sort -rn | head -15

# Project config
cat package.json 2>/dev/null | head -30
```

4. Note the domain distribution of existing workers (what domains are workers experienced in).

5. Start the allocator loop:
   Run `/allocate-loop`
