# Architect Role Reference

## Tier Classification

| Tier | Criteria | Action | Time |
|------|----------|--------|------|
| 1 | 1-2 files, obvious, low risk, <5 min | Execute directly | 2-5 min |
| 2 | Single domain, 2-5 files, clear scope | Create 1 task, claim-before-assign | 5-15 min |
| 3 | Multi-domain, >5 files, or ambiguous | Decompose into N tasks | 20-60 min |

## Tier 1 Examples
- Fix a typo in a UI string
- Add a missing import
- Update a constant value
- Add a CSS property

## Tier 2 Examples
- Add a new API endpoint
- Fix a bug in one module
- Add form validation to a component
- Write tests for an existing function

## Tier 3 Examples
- Add user authentication (frontend + backend + database)
- Refactor state management across the app
- Add a new feature spanning multiple services
- Performance optimization across the stack

## Decomposition Quality Checklist

- [ ] Each task is self-contained (one worker can complete it alone)
- [ ] Each task has a clear domain label
- [ ] Each task lists specific files to modify
- [ ] Coupled files are in the SAME task (not split across workers)
- [ ] depends_on is used only when truly sequential
- [ ] Validation commands are specified (build, test)
- [ ] Descriptions include function names, expected behavior, edge cases
- [ ] Each task tagged with DOMAIN, FILES, VALIDATION, TIER

## Domain Labels

Common domains (use these when possible):
- `frontend` — UI components, pages, styles
- `backend` — API routes, services, middleware
- `database` — models, migrations, queries
- `api` — API client, types, contracts
- `infra` — CI/CD, deployment, configuration
- `tests` — test files, test utilities
- `docs` — documentation, READMEs

## Knowledge Curation Protocol

The Architect curates knowledge every 2nd decomposition cycle:

### Token Budgets

| File | Budget | Owner |
|------|--------|-------|
| `codebase-insights.md` | ~2000 tokens | Architect |
| `patterns.md` | ~1000 tokens | Architect |
| `mistakes.md` | ~1000 tokens | Architect (curate), Workers (append) |
| `user-preferences.md` | ~500 tokens | Master-1 |
| `allocation-learnings.md` | ~500 tokens | Allocator |
| `domain/*.md` | ~800 tokens each | Workers (append), Architect (curate) |

### Curation Steps

1. **Deduplicate** — remove repeated entries across knowledge files
2. **Prune** — remove stale information that no longer applies
3. **Promote** — move recurring patterns from mistakes.md to patterns.md
4. **Enforce budgets** — summarize or trim files exceeding limits
5. **Check systemic patterns** — 3+ similar mistakes → stage instruction patch
6. **Resolve contradictions** — keep most recent when files disagree

## Instruction Patching

When the Architect observes a recurring issue (3+ occurrences):

```markdown
## Patch: [title]
- **Target**: worker | allocator | architect
- **Observed**: [the pattern]
- **Correction**: [what to do instead]
- **Rationale**: [why]
```

Domain knowledge files can be updated directly (no observation threshold).

## Context Reset Triggers

| Trigger | Threshold |
|---------|-----------|
| Tier 1 executions | >= 4 |
| Decompositions | >= 6 (Tier 2 = 0.5, Tier 3 = 1.0) |
| Staleness | 5+ commits since last scan |
| Self-check failure | Can't recall domains/files from memory |

## Validation by Tier

| Tier | Validation Level |
|------|-----------------|
| 1 | Inline build check (architect runs build directly) |
| 2 | build-validator subagent (Haiku) |
| 3 | build-validator (Haiku) + verify-app (Sonnet) |
