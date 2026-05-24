# Standalone Controller Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the standalone controller path bench-launch ready: UI-selected runtime modes, microSD package extraction, and ESP32-S3 firmware that can play generated packages.

**Architecture:** Extend the existing standalone controller package format so a profile can be `sequence`, `procedural`, or `preset`. Add a Node script that turns the exported package JSON into actual microSD files. Add a PlatformIO firmware project that reads `/lightweaver.json`, plays `.lwseq` sequence files from SD, and falls back to procedural/preset looks without requiring WLED, Art-Net, or a Pi.

**Tech Stack:** Vite/React, Node ES modules, PlatformIO Arduino framework, ESP32-S3, FastLED, ArduinoJson, SD/SPI.

---

## Tasks

- [x] Extend `standaloneController.js` with `runtimeMode`, procedural/preset profile support, and package manifests that can omit `.lwseq` for non-sequence modes.
- [x] Add tests in `lightweaver/tests/project-frame-audit.mjs` for default runtime mode, procedural package output, preset package output, and sequence package output.
- [x] Add a Settings UI section for standalone controller runtime mode, LED color order, brightness limit, and four connector rows.
- [x] Add `lightweaver/scripts/unpack-standalone-package.mjs` to write `/lightweaver.json` and `/sequences/*.lwseq` from exported package JSON.
- [x] Add `firmware/lightweaver-controller/` PlatformIO project.
- [x] Firmware reads profile JSON, validates connector counts, supports fixed four output pins, and can play `sequence`, `procedural`, and `preset` looks.
- [x] Add firmware README with wiring, microSD layout, build/upload commands, and launch checklist.
- [x] Verify `npm run test:core`, `npm run build`, package extraction, and firmware build if PlatformIO can be installed locally.
