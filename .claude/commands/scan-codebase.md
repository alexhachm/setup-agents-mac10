# Scan Codebase

Perform a 2-pass progressive scan of the codebase. Write findings to knowledge files. Then auto-start the architect loop.

## Pass 1: Structure (zero file reads)

1. List all top-level directories and their purpose:
   ```bash
   find . -maxdepth 2 -type d | head -50
   ```
2. Identify the tech stack from config files (`package.json`, `Makefile`, `Cargo.toml`, `pyproject.toml`, etc.)
3. Find entry points (`main`, `index`, `app`, etc.)
4. Identify build/test/lint commands from project config
5. Map domain boundaries (frontend, backend, API, database, etc.)
6. Analyze file sizes to identify large files:
   ```bash
   find . -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.go' -o -name '*.rs' | head -100 | xargs wc -l 2>/dev/null | sort -rn | head -20
   ```
7. Build a git coupling map (files that change together):
   ```bash
   git log --oneline --name-only -50 | grep -v '^[a-f0-9]' | sort | uniq -c | sort -rn | head -20
   ```

## Pass 2: Skeleton Reads (MAX 25 files)

1. Read entry point signatures only (function/class declarations, NOT full implementations)
2. Read route/page definitions
3. Read shared types/interfaces
4. Read test configuration (framework, patterns, locations)
5. Note CI/CD configuration
6. Identify naming conventions and coding patterns

**HARD LIMIT**: Do not read more than 25 files in this pass. Read signatures and structure only, not full implementations.

## Output

### 1. Write `codebase-insights.md`

Write findings to `.claude/knowledge/codebase-insights.md` (~2000 tokens max):

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

## Coupling Hotspots
- [files that frequently change together]

## Large Files (potential split candidates)
- [files over 300 lines]

Last scanned: YYYY-MM-DD
```

### 2. Write `codebase-map.json`

Write a machine-readable map to `.claude/state/codebase-map.json`:

```json
{
  "domains": {
    "frontend": ["src/components/", "src/pages/"],
    "backend": ["src/api/", "src/services/"],
    "database": ["src/models/", "migrations/"]
  },
  "coupling_hotspots": [
    ["file1.ts", "file2.ts"]
  ],
  "large_files": ["src/big-file.ts"],
  "launch_commands": {
    "build": "npm run build",
    "test": "npm test",
    "lint": "npm run lint",
    "dev": "npm run dev"
  },
  "entry_points": ["src/index.ts"],
  "last_scanned": "YYYY-MM-DD"
}
```

## Auto-Start

After scanning, automatically start the architect loop:

Run `/architect-loop`
