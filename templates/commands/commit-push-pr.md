# Commit, Push, and Create PR

Follow these steps exactly. Do NOT skip the secret check.

## Step 1: Stage Changes

```bash
git add -A
git diff --cached --stat
```

## Step 2: Secret Check

Run `git diff --cached` and scan for:
- API keys, tokens, passwords
- `.env` file contents
- Private keys or certificates

If ANY secrets are found: `git reset HEAD` and ABORT. Report the issue.

## Step 3: Commit

Use conventional commit format:

```bash
git commit -m "type(scope): concise description"
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

## Step 4: Rebase on Latest Main

```bash
git fetch origin main
git rebase origin/main
```

If conflicts occur and are resolvable, resolve them. Otherwise:

```bash
git rebase --abort
```

And report the conflict.

## Step 5: Push

```bash
git push origin HEAD
```

If rejected (branch behind), pull and retry:

```bash
git pull --rebase origin HEAD && git push origin HEAD
```

If still rejected:

```bash
git push --force-with-lease origin HEAD
```

## Step 6: Create PR

```bash
gh pr create --base main --fill
```

If a PR already exists:

```bash
gh pr view --json url -q '.url'
```

Report the PR URL. This is your deliverable.
