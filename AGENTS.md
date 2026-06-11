---
name: lightweaver
status: active
stack: [ESP32-S3, WLED, Art-Net/Madrix, React, Vite]
deploy: public Studio at led.mandalacodes.com; local card command path (ESP32-only)
family: installation
last_reviewed: 2026-06-11
---

# Lightweaver — branded LED installation controller

## What this is
Custom LED lighting control platform for laser-cut art installations. **Project name: Lightweaver.** Lighting software: Madrix (Art-Net output). Target: a web interface accessible from phone or browser.

## Current plan — ESP32-only (Pi deferred)
As of 2026-06 the runtime is **ESP32-S3 only**. The card runs the Lightweaver firmware and **serves its own branded scene-selector page (the visitor UI)** plus the WLED-compat JSON/WS API at `lightweaver.local` / `192.168.4.1`. The public Studio at `led.mandalacodes.com` is the design/export surface and reaches the card directly on the LAN / via the card-page postMessage bridge. **There is no Raspberry Pi in the runtime path.** A Pi integration is planned for later — `lightweaver/server/` (the WLED proxy), `visitor-ui/`, and `docs/pi-hosted-deployment.md` are kept for that future but are not part of the current plan; do not treat them as the live runtime or invest in them unless the Pi work is explicitly resumed.

## Current contents
- `research.md` — hardware options (ESP32-S3, WLED firmware, Madrix integration), Art-Net/E1.31 protocols, control architecture, color management
- `branded-installation-ui.md` — visitor-facing branded UI design spec (captive portal, scene selector)
- `led-art-mapper/` — Vite app for designing LED strip paths over artwork SVGs; exports `ledmap.json` for WLED
- `lightweaver/` — React Studio/control app, Pi proxy server (deferred), controller package export, and runtime contract tests
- `firmware/lightweaver-controller/` — standalone ESP32-S3 Lightweaver card firmware for local playback
- `docs/deployment-checklist.md` — bench-to-gallery checklist, including code/runtime launch gate

## Key decisions from research
- **WLED firmware** recommended for quick start (100+ effects, REST/JSON API, Art-Net support)
- **Architecture options**: standalone ESP32-S3 card for local playback; WLED on ESP32-S3 with Pi-hosted UI (deferred); Madrix sends Art-Net for advanced/live installations
- **Public UI split**: `led.mandalacodes.com` is the public Studio/setup/support surface. Actual LED commands stay local through the card page, WLED UI, Pi proxy (deferred), or another local bridge.
- **Launch gate**: before deployment, run `npm run launch:check` from `lightweaver/`, then complete the hardware and site smoke tests in `docs/deployment-checklist.md`.

## Project name
**Lightweaver** — use this name in UI copy, WiFi SSIDs (`Lightweaver-XXXX` MAC-suffix format for the card AP), and any public-facing branding.

## Public web / GitHub
- **Parent site**: `mandalacodes.com` is Adrian Rasmussen's site.
- **Canonical public Lightweaver UI URL**: `led.mandalacodes.com`.
- **LED repo GitHub**: `git@github-tech:technicianofthesacred/LED-Programming.git`.
- **Mandala Codes repo GitHub**: `git@github-tech:technicianofthesacred/mandalacodes.git`.
- **Deployment split**: the Lightweaver browser UI lives at `led.mandalacodes.com`. Keep the actual LED command path local (card page, WLED UI, or local bridge) — public HTTPS pages cannot reliably command local HTTP controllers from every phone/browser.

## Agent ownership boundaries
- `led-art-mapper/app/src/` — owned by led-art-mapper agent; do not edit
- `lightweaver/src/` — owned by lightweaver-app agent; do not edit
- `firmware/lightweaver-controller/src/` — owned by firmware agent; do not edit
- `scripts/`, `.github/`, `docs/`, root markdown files, `lightweaver/scripts/`, `lightweaver/vite.config.js`, `lightweaver/package.json` (scripts section only), `.gitignore` — owned by CI/docs agent

## Tools already built
- `led-art-mapper/` — design tool: draw LED strip paths over artwork, set pixel counts, write live patterns (JS), export `ledmap.json` / FastLED header / CSV
- `lightweaver/` — React Studio with WLED WebSocket hook, ESP32 Web Serial flasher, controller package export, and launch test script
- `firmware/lightweaver-controller/` — sellable standalone card firmware with local config page, rotary controls, and microSD sequence support

## Where to look for…
- **Launch checklist / deployment source of truth** → `docs/deployment-checklist.md`
- **Project roadmap (living source of truth)** → `docs/roadmap.md`
- **Hardware research** → `research.md`
- **Visitor UI design plan** → `branded-installation-ui.md`
- **LED layout design tool** → `led-art-mapper/`
- **Direction / strategy log** → `THINKING.md` (rejected paths + tensions across chats)
- **Outstanding work** → `TODO.md` (project root)
- **Customer runtime modes** → `docs/lightweaver-customer-runtime.md`
- **Pi-hosted deployment** (deferred) → `docs/pi-hosted-deployment.md`
