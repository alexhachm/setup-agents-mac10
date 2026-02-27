# Frontend Domain Knowledge

## Stack
- Vanilla HTML/CSS/JS dashboard (no framework, no build step)
- Single CSS file: `gui/public/styles.css`
- GitHub dark theme color palette

## Key Files
- `gui/public/styles.css` — all styling
- `gui/public/index.html` — main dashboard layout
- `gui/public/popout.html` — popout window (has inline style overrides, links to styles.css)
- `gui/public/app.js` — main app logic
- `gui/public/popout.js` — popout window logic

## Styling Patterns
- Border color: `#21262d` (subtle) or `#30363d` (standard) — use `#21262d` for section/card borders
- Section border-radius: 8px, card border-radius: 6px, button border-radius: 4px
- h2 titles: 12px, uppercase, `#8b949e` color
- Background: `#0d1117` (body), `#161b22` (sections)

## Notes
- Popout.html overrides section border to `none` and background to `transparent`
- No CSS preprocessor, no CSS modules — plain CSS
- `gh pr create` must run from main repo dir, not worktree (worktree git dir is not recognized by gh)
