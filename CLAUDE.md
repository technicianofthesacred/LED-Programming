---
name: led
status: active
stack: [ESP32-S3, WLED, Raspberry Pi 5, Art-Net/Madrix, React (planned UI)]
deploy: n/a (hardware project, no web deployment yet)
family: installation
last_reviewed: 2026-04-15
---

# LED — branded LED installation controller

## What this is
Research + planning workspace for a custom LED lighting control interface for laser-cut installations. Hardware: ESP32-S3 N16R8 controller + Raspberry Pi 5. Lighting software: Madrix (Art-Net output). No code written yet — folder contains research notes and UI design spec.

## Current contents
- `research.md` — hardware options (ESP32-S3, WLED firmware, Madrix integration), Art-Net/E1.31 protocols, control architecture
- `branded-installation-ui.md` — planned custom UI design spec for the branded control interface
- `led` — empty placeholder file

## Key decisions from research
- **WLED firmware** recommended for quick start (100+ effects, REST/JSON API, Art-Net support)
- **Architecture**: ESP32-S3 runs WLED → Madrix sends Art-Net → Raspberry Pi 5 as bridge/UI host
- **Custom UI** will be a React app hosted on the Pi, communicating with WLED's JSON API

## Next steps (when development begins)
1. Flash WLED onto ESP32-S3 N16R8
2. Configure Art-Net output from Madrix
3. Build React control UI (start a new Vite + React project in this folder or scaffold from `.project-template/`)

## Where to look for…
- **Hardware research** → `research.md`
- **UI design plan** → `branded-installation-ui.md`
