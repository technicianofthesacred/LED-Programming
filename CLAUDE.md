---
name: lightweaver
status: active
stack: [ESP32-S3, WLED, Raspberry Pi 5, Art-Net/Madrix, React, Vite]
deploy: public Studio at led.mandalacodes.com; local card/WLED/Pi command path
family: installation
last_reviewed: 2026-07-18
---

# Lightweaver — branded LED installation controller

## What this is
Custom LED lighting control platform for laser-cut art installations. **Project name: Lightweaver.** Lighting software: Madrix (Art-Net output). Target: a web interface accessible from phone or browser.

## Current plan — ESP32-only (Pi deferred)
As of 2026-06 the runtime is **ESP32-S3 only**. The card runs the Lightweaver firmware and **serves its own branded scene-selector page (this is the visitor UI)** plus the WLED-compat JSON/WS API at `lightweaver.local` / `192.168.4.1`. The public Studio at `led.mandalacodes.com` is the design/export surface and reaches the card directly on the LAN / via the card-page postMessage bridge. **There is no Raspberry Pi in the runtime path.** A Pi integration is planned for *later* — `lightweaver/server/` (the WLED proxy), `visitor-ui/`, and `docs/pi-hosted-deployment.md` are **kept for that future** but are **not part of the current plan**; don't treat them as the live runtime or invest in them unless the Pi work is explicitly resumed.

## Current contents
- `research.md` — hardware options (ESP32-S3, WLED firmware, Madrix integration), Art-Net/E1.31 protocols, control architecture, color management
- `branded-installation-ui.md` — visitor-facing branded UI design spec (captive portal, scene selector)
- `led-art-mapper/` — Vite app for designing LED strip paths over artwork SVGs; exports `ledmap.json` for WLED
- `lightweaver/` — React Studio/control app, Pi proxy server, controller package export, and runtime contract tests
- `firmware/lightweaver-controller/` — standalone ESP32-S3 Lightweaver card firmware for local playback
- `docs/deployment-checklist.md` — bench-to-gallery checklist, including code/runtime launch gate

## Key decisions from research
- **WLED firmware** recommended for quick start (100+ effects, REST/JSON API, Art-Net support)
- **Architecture options**: standalone ESP32-S3 card for local playback; WLED on ESP32-S3 with Pi-hosted UI; Madrix sends Art-Net for advanced/live installations
- **Public UI split**: `led.mandalacodes.com` is the public Studio/setup/support surface. Actual LED commands stay local through the card page, WLED UI, Pi proxy, or another local bridge.
- **Launch gate**: before deployment, run `npm run launch:check` from `lightweaver/`, then complete the hardware and site smoke tests in `docs/deployment-checklist.md`.

## Project name
**Lightweaver** — use this name in UI copy, WiFi SSIDs, and any public-facing branding.

## Public web / GitHub
- **Parent site**: `mandalacodes.com` is Adrian Rasmussen's site.
- **Canonical public Lightweaver UI URL**: `led.mandalacodes.com`.
- **LED repo GitHub**: `git@github-tech:technicianofthesacred/LED-Programming.git`.
- **Mandala Codes repo GitHub**: `git@github-tech:technicianofthesacred/mandalacodes.git`.
- **Deployment split**: the Lightweaver browser UI lives at `led.mandalacodes.com`. Keep the actual WLED command path local, WLED-served, Pi-proxied, or locally bridged unless a local bridge is present, because public HTTPS pages cannot reliably command local HTTP WLED controllers from every phone/browser.

## Architectural decisions
- `led-art-mapper/` is the **canonical design tool** (vanilla JS Vite app): pattern editor, LED layout over artwork SVGs, `ledmap.json` export. All zone definitions originate here.
- `lightweaver/` (React) provides **reusable building blocks** — WLED WebSocket hook, ESP32 Web Serial flasher. To be repurposed / borrowed-from for the visitor UI rather than shipped as-is.
- `visitor-ui/` is a **future Pi-hosted** branded React UI (captive-portal scene selector per `branded-installation-ui.md`). **Not in the current ESP-only plan** — the firmware card page is today's visitor UI. Retained for a future Pi integration; visitor-facing polish goes into the firmware page for now.
- **Tests** live under `/e2e/` using `@playwright/test`. **Diagnostic scripts** are archived in `/scripts/debug/`.

## Tools already built
- `led-art-mapper/` — design tool: draw LED strip paths over artwork, set pixel counts, write live patterns (JS), export `ledmap.json` / FastLED header / CSV

## Next steps
- [x] Tooling: led-art-mapper design tool, lightweaver React building blocks, visitor-ui scaffold
- [x] Operational docs: `docs/deployment-checklist.md`, `docs/hardware-setup.md`, `docs/segments.md`
- [x] Launch gate: `npm run launch:check` in `lightweaver/` runs core runtime contract tests and production build
- [x] Flash WLED 0.15.4 onto ESP32-S3 N16R8 (`WLED 0.15.4 ESP32-S3 16MB.bin` in repo root) — flashed and verified on bench 2026-05-24 (see docs/roadmap.md)
- [ ] Configure Art-Net output from Madrix; verify WLED reception
- [ ] Define WLED segments matching laser-cut zones; fill in `docs/segments.md`
- [ ] _(deferred — future Pi integration, not current plan)_ Build out `visitor-ui/` against the WLED JSON API and deploy to the Pi

## Where to look for…
- **Launch checklist / deployment source of truth** → `docs/deployment-checklist.md`
- **Project roadmap (living source of truth)** → `docs/roadmap.md`
- **Hardware research** → `research.md`
- **Visitor UI design plan** → `branded-installation-ui.md`
- **LED layout design tool** → `led-art-mapper/`
- **Direction / strategy log** → `THINKING.md` (rejected paths + tensions across chats)
- **Outstanding work** → `TODO.md` (project root)

## TODO format
`TODO.md` items follow the workspace convention: `- [ ] **Bold lead.** _(band: agent-runnable | you-required | routine)_ One descriptive sentence.` with an optional link/detail line underneath pointing to the full plan doc, PR, or referenced files. Group items under `## Soon` / `## Future` / `## Operational notes`. The band hint tells the i64os Temple page which lane to render the item in.

@./THINKING.md
