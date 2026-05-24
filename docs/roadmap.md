# Lightweaver — development roadmap

Living source of truth for project work. Update as items move between sections.

Last updated: 2026-05-06 (commit `839eee5`)

## Done

### Audit + foundation (commit `839eee5`)
- [x] Decide canonical app layout: `led-art-mapper/` is design tool; `lightweaver/` provides reusable React building blocks; `visitor-ui/` is the new branded Pi-hosted UI
- [x] Build visitor-facing branded UI per `branded-installation-ui.md` — `visitor-ui/` (Vite/React + Express)
- [x] Wire WLED JSON API in `lightweaver/src/hooks/useWled.js` (setPreset/setPower/setBrightness/getState/getInfo, 3s timeout)
- [x] Stand up Pi-hosted Express server (`visitor-ui/server/index.js`) with `/api/preset/:id`, `/api/power`, `/api/brightness`, `/api/state`, captive-portal probes
- [x] Replace ad-hoc `pw-*.mjs` diagnostic scripts with real `@playwright/test` specs in `e2e/` (svg-import, layer-selection, nested-wrapper) + SVG fixtures
- [x] Archive useful diagnostic scripts to `scripts/debug/`; delete duplicates
- [x] Cache `PreviewRenderer` per-strip normals (`led-art-mapper/app/src/preview.js`)
- [x] Document deployment checklist, segment template, hardware setup (`docs/`)
- [x] Remove zero-byte `led` file

### led-art-mapper bugs (commit `839eee5`)
- [x] **BUG**: WLED frame buffer reallocates every frame — reusable `Uint8Array`, resize on length mismatch (`main.js:139`)
- [x] **BUG**: strip reversal on scene restore — applied post-sample with WHY comment (`main.js:2050-2058`)
- [x] **BUG**: float-imprecise speed comparison — epsilon `1e-4` (`main.js:1153, 1267, 1282`)

### led-art-mapper features (commit `839eee5`)
- [x] **C1** per-section pattern assignment — strip dropdown, lazy compile, render override
- [x] **C2** live WLED push over network — native WS opcode `0x02`, ~30fps, auto-reconnect with exponential backoff (1s → 15s)
- [x] **C3** section groups/zones — collapsible group panels, member assignment popover, render override
- [x] Pattern-eval error log panel — 5-entry ring, dedup consecutive, dismissable

## Open — user/hardware actions

These cannot be done by agents. See `docs/hardware-setup.md` for step-by-step.

- [ ] Flash WLED 0.15.4 onto the ESP32-S3 N16R8 (binary in repo root)
- [ ] Verify WLED first boot (4.3.2.1, version, free heap, WS2815 config, test pattern)
- [ ] Configure & test Madrix Art-Net output → WLED (universes, 510 ch/universe, 30–44 Hz, WiFi sleep disabled)
- [ ] Define WLED segments matching laser-cut zones — fill in zone IDs in `docs/segments.md`
- [ ] Capture per-device record: MAC, post-STA IP, segment JSON dump

## Open — deployment

- [ ] Pi setup: hostname, autostart `visitor-ui/server` (systemd unit example in `visitor-ui/README.md`)
- [ ] AP mode SSID convention: "Lightweaver — Adrian Rasmussen — Piece 01"
- [ ] Captive portal end-to-end test from a phone on the AP
- [ ] Customize `BRAND` constant in `visitor-ui/src/App.jsx` (artist, piece, accent color)
- [ ] Match `SCENES` array in `visitor-ui/src/App.jsx` to actual saved WLED presets

## Open — software follow-ups

- [ ] **Refactor**: split 4,713-line `led-art-mapper/app/src/main.js` into modules (state, ui, render, export) — *deferred from this round; best done in a focused session because it touches everything*
- [ ] Standalone controller export: generate `lightweaver.json` and `.lwseq` microSD packages for ESP32-S3 playback
- [ ] Add Vitest unit suite for `led-art-mapper` pattern helpers + export functions
- [ ] Tighten Playwright selectors flagged with `// TODO: tighten selector` in `e2e/*.spec.ts`
- [ ] Wire visitor-ui brightness slider to debounce instead of commit-on-release (current behavior is intentional — confirm UX)
- [ ] Add `lightweaver` UI hook-up for the new JSON API methods (currently only the hook exposes them)

## Open — nice-to-have

- [ ] Pattern syntax validator with friendly inline errors (currently runtime-only)
- [ ] Accessibility pass on `led-art-mapper` (ARIA, keyboard nav, shortcut documentation)
- [ ] Visitor-ui idle screensaver / brand animation while no scene is selected
- [ ] Telemetry: log preset selections to a local file for installation analytics

## How to update this doc

- Move items between sections as work progresses; do not delete done items — they are the project changelog.
- Reference the commit SHA when marking something done.
- Add new items under the appropriate section as they are discovered.
- Keep entries one line where possible; link to longer notes in `docs/` if needed.
