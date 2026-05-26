# Lightweaver Ship-Today Readiness Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get Lightweaver usable today as a Basic WLED installation workflow: choose a curated pattern bank, configure the connected ESP32-S3 safely, install stored WLED looks, verify playback, and produce an install record.

**Architecture:** Ship today on the safest path: ESP32-S3 running stock WLED, stored presets/playlists for entry-level use, Lightweaver used as commissioning/export tool, Art-Net gated as an advanced optional path. Do not depend on Raspberry Pi, Madrix, custom WLED firmware, or browser live rendering for the entry-level runtime.

**Tech Stack:** ESP32-S3 N16R8, WLED 0.15.4, Lightweaver React/Vite app, WLED JSON API, WLED `/presets.json`, WLED segments, optional WLED `ledmap.json`, optional E1.31/Art-Net.

---

## Current Verified State

Verified on 2026-05-26:

- Controller IP: `192.168.18.66`
- Firmware: WLED `0.15.4`
- Hardware: ESP32-S3, 16 MB flash, PSRAM reported
- MAC: `ac:a7:04:e2:ec:e0`
- WiFi signal: strong, around `96%`
- WLED LED count: `30`
- Output: GPIO `16`, WLED type `22`, one output, one segment `0..30`
- Controller name: `WLED`
- Named presets: none
- `ledmap.json`: missing
- Realtime input: enabled, port `5568`, universe `1`, address `1`, DMX mode `4`
- Clock: invalid, reports `1970`
- AudioReactive usermod: present, off
- Latest local WLED backup: `backups/controllers/wled-aca704e2ece0-20260526-204517/` (ignored by git)

This is a working bench controller, not a production-configured controller.

## Same-Day Product Decision

Ship **Lightweaver Basic WLED** today.

Decision update on 2026-05-26: no microSD hardware is attached for this bench session, so the active path is browser + stock WLED. The standalone microSD firmware remains available for later finished-controller builds, but it is not the same-day path.

Use:

- Stock WLED firmware
- Curated stored WLED presets
- One WLED playlist for cycling looks
- Phone/browser control through WLED UI or Lightweaver UI
- Art-Net only as an advanced verification path, not the entry-level promise

Do not block today on:

- Raspberry Pi boot/storage
- Custom WLED effect firmware
- Audio-reactive patterns
- Exact long-form timeline playback
- Madrix show authoring
- Captive portal polish

## What You Need To Review And Dial In

### 1. Physical LED Details

Decide these before installing presets:

- Final LED count for the artwork
- Strip/chip type: likely `WS2815`, confirm
- Data GPIO: currently `16`
- Color order: currently WLED order `0`; visually confirm RGB/GRB with red, green, blue test
- Direction: first pixel and last pixel must match Lightweaver layout
- Brightness limit: choose safe max brightness for power supply and artwork heat
- Power supply voltage and amps
- Power injection points
- Common ground and level shifter status

Acceptance:

- WLED LED Preferences matches the real piece.
- Red/green/blue tests display correct colors.
- First/last/every-10th pixel tests prove count and direction.

### 2. Artwork Geometry

Decide whether today’s piece uses:

- One whole-piece segment, simplest and safest
- Multiple WLED segments for laser-cut zones
- `ledmap.json` for spatial WLED effects

Same-day recommendation:

- If the real artwork has not been fully mapped, use one full-piece segment today.
- If zones matter visually, define segments only.
- Use `ledmap.json` only if you specifically need spatial/2D WLED effects today.

Acceptance:

- Segment starts/stops match physical zones.
- No segment exceeds the configured LED count.
- Lightweaver export and WLED segment count agree.

### 3. Pattern Bank

Use a curated starter bank, not all 130 patterns.

Today’s Basic WLED bank:

- Candle
- Breathe
- Aurora
- Fire
- Rainbow
- Gradient
- Twinkle
- Sparkle
- Meteor
- Ocean
- Scanner
- Lava

Optional replacements if the piece wants calmer gallery behavior:

- Replace Rainbow with Sunrise
- Replace Sparkle with Drift
- Replace Scanner with Waterfall

Gate for later:

- `PORT` patterns need custom WLED effect work.
- `AUD` patterns need live audio runtime.
- `BPM` patterns need beat/timeline runtime or sequence export.
- `CPU` patterns need computer/Pi live rendering, Art-Net, or sequence export.

Acceptance:

- At least 8 patterns are pleasant at low brightness.
- No fast strobe or harsh flashing in the default playlist.
- The default playlist feels like an artwork, not a demo reel.

### 4. Controller Identity And Network

Set:

- WLED name: `Lightweaver-Piece-01` or a piece-specific name
- DHCP reservation: MAC `ac:a7:04:e2:ec:e0`
- Chosen install IP: either keep `192.168.18.66` or reserve another fixed IP
- WiFi sleep: disable if using Art-Net or live streaming

Acceptance:

- Controller reconnects at the same IP after reboot.
- Phone and computer can reach WLED by IP.
- The name in WLED, Lightweaver, and install report all match.

### 5. Backup And Rollback

Before writing anything:

- Download current `/presets.json`
- Capture `/json/info`
- Capture `/json/state`
- Capture `/cfg.json`

Same-day rollback:

- Restore old `/presets.json` from WLED `/edit`
- Restore known-good amber state
- Keep the original WLED firmware intact

Acceptance:

- Backup files exist before install.
- Install is refused if backup is missing.

### 6. Install WLED Basic Package

Use Lightweaver export:

- Generate `wled-basic.json`
- Inspect `presetsJson`
- Inspect `customEffectPorts`
- Inspect `unsupportedPatterns`
- Upload or apply generated preset bank
- Save playlist preset

Acceptance:

- WLED `/presets.json` contains named Lightweaver presets.
- Playlist preset cycles the bank.
- Preset IDs in Lightweaver match WLED.
- Read-back verification confirms the installed JSON.

### 7. Visitor Control

Same-day minimum:

- Use WLED UI or Lightweaver local UI to cycle presets.
- Keep controls simple: power, brightness, scene/preset selection.

If using the Lightweaver visitor UI:

- Set artist name
- Set piece name
- Match scene labels to installed preset IDs
- Test from phone on the same WiFi

Acceptance:

- Phone can select at least 4 scenes.
- Brightness control works.
- Losing the phone does not stop the artwork because presets live on WLED.

### 8. Art-Net Optional Advanced Gate

Only do this after Basic works.

Check:

- WLED realtime input enabled
- Protocol selected correctly in WLED Sync settings
- Universe start matches Madrix
- 510 RGB channels per universe
- Pixel count/channel count math matches final LED count
- WiFi sleep disabled

Acceptance:

- Madrix or test sender lights pixel 1, middle, and last pixel correctly.
- Art-Net does not break stored WLED preset playback.
- If Art-Net is unstable, it is documented as advanced only.

## Today’s Execution Sequence

### Phase 0: Freeze Scope

- [x] Confirm this is Basic WLED shipping, not custom firmware.
- [ ] Confirm final LED count.
- [ ] Confirm one segment vs zones vs ledmap.
- [ ] Confirm the curated preset bank.
- [ ] Confirm controller display name.

### Phase 1: Controller Safety

- [x] Back up `/presets.json`.
- [x] Back up `/cfg.json`.
- [x] Back up `/json/info`.
- [x] Back up `/json/state`.
- [ ] Save backup timestamp in Lightweaver controller profile.

### Phase 2: WLED Hardware Configuration

- [ ] Set LED count.
- [ ] Set GPIO.
- [ ] Set strip type.
- [ ] Set color order.
- [ ] Set brightness/current limit.
- [ ] Rename controller.
- [ ] Reboot WLED.
- [ ] Reconnect and verify the same IP.

### Phase 3: Physical Validation

- [ ] Send low-brightness red.
- [ ] Send low-brightness green.
- [ ] Send low-brightness blue.
- [ ] Send first-pixel marker.
- [ ] Send last-pixel marker.
- [ ] Send every-10th marker.
- [ ] Fix count/order/direction before continuing.

### Phase 4: Lightweaver Package

- [ ] Generate WLED Basic package.
- [ ] Confirm `presets` is non-empty.
- [ ] Confirm `unsupportedPatterns` excludes default bank looks.
- [ ] Confirm `customEffectPorts` are not promised as stock WLED.
- [ ] Install preset bank.
- [ ] Install playlist preset.

### Phase 5: Read-Back Verification

- [ ] Fetch `/presets.json` after install.
- [ ] Confirm all expected preset names exist.
- [ ] Confirm playlist references valid preset IDs.
- [ ] Load each preset once.
- [ ] Load playlist and let it cycle for at least 2 transitions.

### Phase 6: Operator UX

- [ ] Open from phone.
- [ ] Verify power toggle.
- [ ] Verify brightness.
- [ ] Verify preset selection.
- [ ] Verify controller survives browser close.
- [ ] Verify controller survives reboot and resumes acceptable state.

### Phase 7: Install Record

- [ ] Save controller IP.
- [ ] Save MAC.
- [ ] Save LED count.
- [ ] Save data pin.
- [ ] Save color order.
- [ ] Save brightness/current cap.
- [ ] Save preset ID list.
- [ ] Save playlist ID.
- [ ] Save backup filename.
- [ ] Save known issues and deferred gates.

## Hard Stop Conditions

Do not install presets if:

- Final LED count is unknown.
- Power supply is undersized or unknown.
- Color order is untested.
- First/last pixel direction is untested.
- `/presets.json` is not backed up.
- Controller identity/IP is unstable.
- The package has zero runnable WLED presets.

Do not sell/hand off as entry-level if:

- It needs a Mac running Lightweaver to look good.
- It needs a Pi running live frames.
- It needs Madrix to show the default experience.
- Default looks include harsh strobing.
- Recovery steps are not documented.

## Definition Of Ready To Use Today

Lightweaver is ready to start using today when:

- ESP32-S3 boots directly into a safe stored look.
- At least 8 curated looks live on WLED as presets.
- One playlist cycles those looks.
- A phone/browser can switch presets and adjust brightness.
- The artwork does not require the Mac/Pi/Madrix for default operation.
- Backup and rollback exist.
- Controller IP, MAC, LED settings, and preset IDs are recorded.

## Deferred After Today

- Custom WLED effects for Lightweaver-native `PORT` patterns
- Art-Net/Madrix authoring workflow
- Raspberry Pi captive portal
- Full standalone `.lwseq` microSD export
- Audio-reactive runtime
- PDF install report
- Automated rollback button
