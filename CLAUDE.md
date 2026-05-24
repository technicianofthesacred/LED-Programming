---
name: lightweaver
status: active
stack: [ESP32-S3, WLED, Raspberry Pi 5, Art-Net/Madrix, React, Vite]
deploy: web interface (phone/browser, hosted on Raspberry Pi or publicly)
family: installation
last_reviewed: 2026-05-24
---

# Lightweaver — branded LED installation controller

## What this is
Custom LED lighting control platform for laser-cut art installations. **Project name: Lightweaver.** Hardware: ESP32-S3 N16R8 controller + Raspberry Pi 5. Lighting software: Madrix (Art-Net output). Target: a web interface accessible from phone or browser — either served from the Pi on the local network or deployed publicly.

## Current contents
- `research.md` — hardware options (ESP32-S3, WLED firmware, Madrix integration), Art-Net/E1.31 protocols, control architecture, color management
- `branded-installation-ui.md` — visitor-facing branded UI design spec (captive portal, scene selector)
- `led-art-mapper/` — Vite app for designing LED strip paths over artwork SVGs; exports `ledmap.json` for WLED

## Key decisions from research
- **WLED firmware** recommended for quick start (100+ effects, REST/JSON API, Art-Net support)
- **Architecture**: ESP32-S3 runs WLED → Madrix sends Art-Net → Raspberry Pi 5 as bridge/UI host
- **Custom UI** will be a React web app communicating with WLED's JSON API, accessible from any browser on phone or desktop
- **Deployment target**: web interface — Pi-hosted on local network for gallery/installation use, or publicly accessible URL for remote control

## Project name
**Lightweaver** — use this name in UI copy, WiFi SSIDs, and any public-facing branding.

## Architectural decisions
- `led-art-mapper/` is the **canonical design tool** (vanilla JS Vite app): pattern editor, LED layout over artwork SVGs, `ledmap.json` export. All zone definitions originate here.
- `lightweaver/` (React) provides **reusable building blocks** — WLED WebSocket hook, ESP32 Web Serial flasher. To be repurposed / borrowed-from for the visitor UI rather than shipped as-is.
- `visitor-ui/` is the new **Pi-hosted branded React UI** — a small, separate app implementing the captive-portal scene selector per `branded-installation-ui.md`.
- **Tests** live under `/e2e/` using `@playwright/test`. **Diagnostic scripts** are archived in `/scripts/debug/`.

## Tools already built
- `led-art-mapper/` — design tool: draw LED strip paths over artwork, set pixel counts, write live patterns (JS), export `ledmap.json` / FastLED header / CSV

## Next steps
- [x] Tooling: led-art-mapper design tool, lightweaver React building blocks, visitor-ui scaffold
- [x] Operational docs: `docs/deployment-checklist.md`, `docs/hardware-setup.md`, `docs/segments.md`
- [ ] Flash WLED 0.15.4 onto ESP32-S3 N16R8 (`WLED 0.15.4 ESP32-S3 16MB.bin` in repo root)
- [ ] Configure Art-Net output from Madrix; verify WLED reception
- [ ] Define WLED segments matching laser-cut zones; fill in `docs/segments.md`
- [ ] Build out `visitor-ui/` against the WLED JSON API and deploy to the Pi

## Where to look for…
- **Project roadmap (living source of truth)** → `docs/roadmap.md`
- **Hardware research** → `research.md`
- **Visitor UI design plan** → `branded-installation-ui.md`
- **LED layout design tool** → `led-art-mapper/`
