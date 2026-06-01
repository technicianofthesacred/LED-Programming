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
- [x] Launch gate: `npm run launch:check` in `lightweaver/` runs core runtime contract tests and production build
- [ ] Flash WLED 0.15.4 onto ESP32-S3 N16R8 (`WLED 0.15.4 ESP32-S3 16MB.bin` in repo root)
- [ ] Configure Art-Net output from Madrix; verify WLED reception
- [ ] Define WLED segments matching laser-cut zones; fill in `docs/segments.md`
- [ ] Build out `visitor-ui/` against the WLED JSON API and deploy to the Pi

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
