# Lightweaver — development roadmap

> Open items are now also surfaced in ../TODO.md (consolidated 2026-05-29). This file stays the detailed living roadmap and changelog (Done items are the project history); TODO.md is the scannable open-work view and links back here for detail.

Living source of truth for project work. Update as items move between sections.

Last updated: 2026-05-29

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

### Runtime strategy
- [x] Define the two Lightweaver product versions: **Basic WLED** for entry-level stored looks and **Advanced Art-Net / Custom** for Madrix, live Art-Net, and exact standalone sequence playback — see `docs/superpowers/specs/2026-05-25-two-version-runtime-strategy-design.md`
- [x] Add shared runtime-tier and pattern-target helpers in `lightweaver/src/lib/runtimeTargets.js`
- [x] Add WLED / ADV compatibility chips to the Live pattern grid
- [x] Build WLED Basic export package generation: WLED preset bank, playlist preset, unsupported-pattern warnings, and custom-effect port list
- [x] Audit all 130 Lightweaver patterns and gate them by runtime: WLED stock, WLED custom port, audio source, beat/timeline source, or computer/Pi render — see `docs/pattern-compatibility-audit.md`
- [x] Add controller compatibility audit for the connected WLED unit: firmware, LED count, segments, presets, LED map, Art-Net/E1.31, clock, identity, and audio-source gates — see `docs/controller-compatibility-audit.md`
- [x] Verify bench ESP32-S3 is reachable at `192.168.18.66` running WLED `0.15.4`
- [x] Back up and flash the non-lit USB ESP32-S3 with temporary Lightweaver USB LED test firmware; verify `LWUSB` serial commands on `/dev/cu.usbmodem5B5E0414831` — see `docs/usb-controller-audit.md`

### Cloud relay removal
- [x] Remove Cloudflare KV relay as a Lightweaver transport; the card no longer registers, heartbeats, polls, or shows pairing codes.
- [x] Delete the Cloudflare KV namespace and keep `/api/lw/*` excluded from Pages Functions.
- [x] Reframe Studio v3 as chip-config export/load only: public HTTPS uses copy/download/open-card; direct card push is local HTTP/file only.

## Open — user/hardware actions

These cannot be done by agents. See `docs/hardware-setup.md` for step-by-step.

- [ ] Set final WLED LED count, data GPIO, LED type, color order, and brightness limit for the actual artwork
- [ ] Rename the controller and reserve MAC `ac:a7:04:e2:ec:e0` as `192.168.18.66` or the chosen install IP
- [ ] Back up current `/presets.json` before installing Lightweaver presets
- [ ] Configure & test Madrix Art-Net output → WLED (universes, 510 ch/universe, 30–44 Hz, WiFi sleep disabled)
- [ ] Define WLED segments matching laser-cut zones — fill in zone IDs in `docs/segments.md`
- [ ] Capture per-device record: MAC, post-STA IP, segment JSON dump

## Open — deployment

- [x] Publish the public Lightweaver browser UI at `led.mandalacodes.com` through Mandala Codes/Cloudflare Pages
- [x] Keep actual card control local to the ESP32 page unless a local bridge is intentionally added
- [ ] Pi setup: hostname, autostart `visitor-ui/server` (systemd unit example in `visitor-ui/README.md`)
- [ ] AP mode SSID convention: "Lightweaver — Adrian Rasmussen — Piece 01"
- [ ] Captive portal end-to-end test from a phone on the AP
- [ ] Customize `BRAND` constant in `visitor-ui/src/App.jsx` (artist, piece, accent color)
- [ ] Match `SCENES` array in `visitor-ui/src/App.jsx` to actual saved WLED presets

## Open — software follow-ups

- [ ] Add direct USB controller mode: Web Serial/local bridge transport in the app, using the verified `LWUSB` bench protocol as the first hardware handshake
- [ ] Flash current no-relay firmware to any existing cards that were built with the old relay polling module.
- [ ] **Refactor**: split 4,713-line `led-art-mapper/app/src/main.js` into modules (state, ui, render, export) — *deferred from this round; best done in a focused session because it touches everything*
- [ ] Extend runtime target badges to Pattern, Timeline, and Export screens
- [ ] WLED Basic installer: run controller compatibility audit, back up existing presets, then apply the generated package directly to a connected WLED controller
- [ ] Lightweaver custom WLED effect build: first branded ambient set for Candle Drift, Ember Slow, Warm Pulse, Amber Aurora, and Gallery Idle
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
