# Architect Role Reference

## Tier Classification

| Tier | Criteria | Action |
|------|----------|--------|
| 1 | 1-2 files, obvious, low risk, <5 min | Execute directly |
| 2 | Single domain, 2-5 files, clear scope | Create 1 task |
| 3 | Multi-domain, >5 files, or ambiguous | Decompose into N tasks |

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

## Domain Labels

Common domains (use these when possible):
- `frontend` — UI components, pages, styles
- `backend` — API routes, services, middleware
- `database` — models, migrations, queries
- `api` — API client, types, contracts
- `infra` — CI/CD, deployment, configuration
- `tests` — test files, test utilities
- `docs` — documentation, READMEs
