# Scan Codebase (Allocator Startup)

Lightweight startup scan for the Allocator agent (Master-3). Gathers just enough context to make good allocation decisions.

## Steps

1. Check current system state:
   ```bash
   mac10 status
   mac10 worker-status
   ```

2. Read knowledge files:
   - `.claude/knowledge/codebase-insights.md`
   - `.claude/knowledge/patterns.md`
   - `.claude/knowledge/domain/` (all files)

3. Note the domain distribution of existing workers (what domains are workers experienced in).

4. Start the allocator loop:
   Run `/allocate-loop`
