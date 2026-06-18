# Handoff — branch `v3.3`

## State
- Branch `v3.3` is clean and in sync with `origin/v3.3`; tip `2c06170`, verified author (`Claude <noreply@anthropic.com>`).
- `lightweaver/` builds: `npm run build` succeeds (~3s; only a chunk-size warning on `main.js`, not an error). `node_modules` present.
- This branch IS the orange/clay **3.3** design — confirmed by accent token `--accent: oklch(0.553 0.109 56)` (hue 56 = clay) vs `origin/main`'s blue `oklch(74% 0.13 210)` (hue 210). Design target = `lightweaver/public/v3-mock/ref/` (terracotta/clay PNGs).
- Files are still internally labeled "v3" (`index.html` `<title>Lightweaver v3`, `/* Light Weaver v3 */` headers) — stale naming, not a color mixup. UNDECIDED whether to rename.
- Known 3.3-fidelity drift, NOT yet fixed: left rail renders **Show** where the v3 mock had **Settings** (`src/v3/app.jsx` rail array). UNDECIDED whether intentional.
- Vite dev server (was on port 5180) stopped by container restart — not running now.
- Untested: no runtime/visual verification this session (container just restarted); only `npm run build` confirmed.

## Next
- cd /home/user/LED-Programming/lightweaver && npm run dev   # start dev server, open localhost:5173
- DECIDE with Adrian: rename internal "v3" labels to "v3.3" (index.html title + lw-*.jsx headers) or leave them.
- DECIDE with Adrian: rail item — keep **Show** or restore **Settings** to match the v3 mock (edit rail array in src/v3/app.jsx).
- After any change: cd lightweaver && npm run build  to confirm tree still builds.
- git add -A && git commit && git push -u origin v3.3   # author must be Claude <noreply@anthropic.com>
