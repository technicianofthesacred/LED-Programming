# Handoff — branch `claude/new-ui-branch-status-1Qp4Y`

## State
- **PR #9 (v3.3) is MERGED** (squash `ba79250`, merged 2026-06-18). The `v3.3` branch was deleted server-side. The orange/clay **3.3** design now lives in `main`. Do NOT try to push to v3.3 — it's gone; PR #9 cannot be reopened.
- Active branch is `claude/new-ui-branch-status-1Qp4Y`, cut from merged `main` (`2de187b`), + one follow-up commit `009d4b2` (pushed). A NEW PR is needed to land it (none opened yet).
- **Verified working (2026-07-04):** on `main`'s 3.3 content — `npm install` → `npm run launch:check` passes (35 runtime contract tests green + production build). Dev server runs (vite, localhost:5173). All 5 screens (Patterns, Playlist, Layout, Flash, Installer) render and navigate in a real browser with no JS/page errors. Accent renders `oklch(0.553 0.109 56)` (hue 56 = clay) → confirmed the orange 3.3 design, not blue.
- Fixed in `009d4b2`: invalid CSS selector `.tb-btn . kbd` → `.tb-btn .kbd` (`lightweaver/src/v3/v3-styles.css:209`); build no longer emits the css-syntax-error warning. Build is clean except a cosmetic chunk-size note on `main.js`.
- Runtime console errors are all expected offline artifacts (fetches to `192.168.4.1/api/status` / external hosts fail — no card on LAN, agent proxy). NOT app bugs.
- Rail renders 7 items: Patterns, Playlist, Layout, Show, Flash, Installer, Settings. **RESOLVED: Show is intended** — PR #9 shipped `lw-show.jsx` as part of the v3 mockup, so it's a real 3.3 screen, not drift. Keep it.
- Files internally labeled "v3" (`<title>Lightweaver v3`, `/* Light Weaver v3 */` headers). **RESOLVED: leaving as-is** — internal/cosmetic; brand copy is "Lightweaver" regardless. Not renaming.
- node_modules is wiped on container restart — reinstall before running.

## Next
- PR is OPEN for `claude/new-ui-branch-status-1Qp4Y` (CSS fix + handoff) — see link in the PR. Merge it to ship the fix into main.
- cd /home/user/LED-Programming/lightweaver && npm install && npm run dev   # localhost:5173
- Future changes: git add -A && git commit && git push -u origin claude/new-ui-branch-status-1Qp4Y   # author must be Claude <noreply@anthropic.com>; updates the open PR
- Nothing else outstanding — 3.3 is merged in main, verified working; the two prior open questions (Show, "v3" labels) are resolved above.
