# Scan Codebase

Perform a 2-pass scan of the codebase and write findings to `.claude/knowledge/codebase-insights.md`.

## Pass 1: Structure

1. List all top-level directories and their purpose
2. Identify the tech stack (languages, frameworks, build tools)
3. Find entry points (`main`, `index`, `app`, etc.)
4. Identify build commands from `package.json`, `Makefile`, `Cargo.toml`, etc.
5. Map domain boundaries (frontend, backend, API, database, etc.)

## Pass 2: Patterns

1. Identify coding patterns (naming conventions, file organization)
2. Find test patterns (test framework, test file locations, how to run)
3. Identify state management patterns
4. Note any CI/CD configuration
5. Find common utilities and shared modules

## Output

Write findings to `.claude/knowledge/codebase-insights.md` in this format:

```markdown
# Codebase Insights

## Tech Stack
- ...

## Build & Test
- Build: `command`
- Test: `command`
- Lint: `command`

## Directory Structure
- `src/` — ...
- `tests/` — ...

## Domain Map
- frontend: src/components/, src/pages/
- backend: src/api/, src/services/
- database: src/models/, migrations/

## Key Patterns
- ...

## Entry Points
- ...

Last scanned: YYYY-MM-DD
```
