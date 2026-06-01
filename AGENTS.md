---
name: lightweaver
status: active
stack: [ESP32-S3, WLED, Raspberry Pi 5, Art-Net/Madrix, React, Vite]
deploy: public Studio at led.mandalacodes.com; local card/WLED/Pi command path
family: installation
last_reviewed: 2026-06-02
---

# Lightweaver — branded LED installation controller

## What this is
Custom LED lighting control platform for laser-cut art installations. **Project name: Lightweaver.** Hardware: ESP32-S3 N16R8 controller + Raspberry Pi 5. Lighting software: Madrix (Art-Net output). Target: a web interface accessible from phone or browser — either served from the Pi on the local network or deployed publicly.

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

## Tools already built
- `led-art-mapper/` — design tool: draw LED strip paths over artwork, set pixel counts, write live patterns (JS), export `ledmap.json` / FastLED header / CSV
- `lightweaver/` — Studio/control app with WLED/Pi proxy paths, controller package export, and launch test script
- `firmware/lightweaver-controller/` — sellable standalone card firmware with local config page, rotary controls, and microSD sequence support

## Next steps
1. Choose the runtime lane for the piece: standalone card, WLED + Pi visitor UI, or Madrix / Art-Net live host.
2. Run `npm run launch:check` from `lightweaver/` after any code or exported config change.
3. Flash/configure the target controller and record firmware version, MAC, IP/hostname, pixel count, GPIO, color order, and brightness cap.
4. Complete `docs/deployment-checklist.md` before handing the piece to a visitor, gallery, or customer.

## Where to look for…
- **Launch checklist** → `docs/deployment-checklist.md`
- **Customer runtime modes** → `docs/lightweaver-customer-runtime.md`
- **Pi-hosted deployment** → `docs/pi-hosted-deployment.md`
- **Public web deployment** → `docs/public-web-deployment.md`
- **Hardware research** → `research.md`
- **Visitor UI design plan** → `branded-installation-ui.md`
- **LED layout design tool** → `led-art-mapper/`
