# Handoff — branch `v3.3`

## State
- Branch `v3.3`, open PR #9. Reference that PR going forward — pushing here updates it.
- **Verified working this session (2026-07-04):** `npm install` → `npm run launch:check` passes (all 35 runtime contract tests green + production build). Dev server runs (`vite`, localhost:5173). All 5 screens (Patterns, Playlist, Layout, Flash, Installer) render and navigate in a real browser with no JS/page errors.
- This branch IS the orange/clay **3.3** design — confirmed at runtime: rendered `--accent: oklch(0.553 0.109 56)` (hue 56 = clay). The blue `oklch(74% 0.13 210)` is the older `origin/main` UI ("3"). Screenshots in scratchpad confirm orange palette + real data (132 patterns, 2-circle 44-LED layout, live previews).
- Fixed this session: invalid CSS selector `.tb-btn . kbd` → `.tb-btn .kbd` (`src/v3/v3-styles.css:209`); build no longer emits the css-syntax-error warning.
- Console errors seen at runtime are all expected offline artifacts (fetches to `192.168.4.1/api/status` / external hosts fail with CORS/ERR_TUNNEL — no card on LAN, agent proxy). NOT app bugs.
- Rail renders 7 items: Patterns, Playlist, Layout, **Show**, Flash, Installer, Settings. Both Show AND Settings are present; **Show is an extra vs the v3 mock** (mock rail was Patterns/Playlist/Layout/Settings/Flash/Installer). UNDECIDED whether Show is intended for 3.3.
- Files still internally labeled "v3": browser `<title>Lightweaver v3`, wordmark "Light Weaver", `/* Light Weaver v3 */` headers. Stale naming, not a color issue. UNDECIDED whether to rename.
- node_modules is wiped on container restart — reinstall before running (see Next).

## Next
- cd /home/user/LED-Programming/lightweaver && npm install && npm run dev   # localhost:5173
- git add -A && git commit && git push -u origin v3.3   # updates PR #9; author must be Claude <noreply@anthropic.com>
- DECIDE with Adrian: keep **Show** in the rail or remove it to match the v3 mock (rail array in src/v3/app.jsx).
- DECIDE with Adrian: rename internal "v3" labels to "v3.3" (index.html title + wordmark + lw-*.jsx headers) or leave them.
- Optional: run node "$SCRATCH/verify.js" with NODE_PATH=lightweaver/node_modules to re-screenshot all screens after UI changes.
