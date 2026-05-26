# Lightweaver Controller Compatibility Audit

Date: 2026-05-26

Live controller probed at `192.168.18.66`.

## Current Controller State

- Firmware: WLED `0.15.4`, release `ESP32-S3_16MB_opi`
- Hardware: ESP32-S3, 16 MB flash, PSRAM reported
- USB port during backup: `/dev/cu.usbmodem142101`
- MAC: `ac:a7:04:e2:ec:e0`
- LEDs configured in WLED: `30`
- Output: GPIO `16`, one LED output, one WLED segment from `0` to `30`
- Effects/palettes: `187` effects, `71` palettes
- Current look: preset `4`, `LW Candle`, effect `88` / palette `35`
- Presets: Lightweaver bench presets `1`-`8` are installed
- LED map: no `/ledmap.json` found
- Realtime input: enabled, port `5568`, universe `1`, address `1`, DMX mode `4`
- Clock: WLED reports `1970-1-2`, so wall-clock sync is not valid
- Identity: controller name is still `WLED`
- AudioReactive usermod is present, but audio reactivity is off

## Backups Captured Before Preset Changes

Backup directory:

`backups/controllers/wled-aca704e2ece0-20260526-203738/`

Files:

- `info.json`
- `state.json`
- `cfg.json`
- `presets.json` — pre-change presets, originally empty
- `full-flash-16mb.bin` — raw 16 MB flash image

Raw flash SHA-256:

`78c9e177809dc1e6c5dcf2e410c0204577411bd04e1186b364bcad1899991e26`

Post-change verification files:

- `presets-after-lightweaver-test-bank.json`
- `state-after-lightweaver-test-bank.json`

## Lightweaver Bench Preset Bank

The following WLED-native presets are saved on the controller for immediate physical testing:

| Preset | Name |
| --- | --- |
| `1` | `LW Warm Amber` |
| `2` | `LW Soft Green` |
| `3` | `LW Deep Blue` |
| `4` | `LW Candle` |
| `5` | `LW Fire Flicker` |
| `6` | `LW Rainbow Slow` |
| `7` | `LW Pacifica` |
| `8` | `LW Aurora` |

## Compatibility Problems Found

| Area | Current risk | Shift to compatible state |
| --- | --- | --- |
| LED count | `30` is a bench value unless the final artwork is exactly 30 pixels. | Set WLED LED Preferences to the final Lightweaver pixel count before exporting presets, ledmaps, or Art-Net channel math. |
| Segments | Only one full-strip segment exists. | Export segment bounds from Lightweaver strips or define WLED segments manually for laser-cut zones. |
| Presets | Bench presets exist, but they are not a final artwork package. | Replace with the final WLED Basic package after LED count, segments, palette, and effect choices are commissioned. |
| LED map | `/ledmap.json` is missing. | Upload a Lightweaver `ledmap.json` only when the piece needs WLED 2D/spatial effects. |
| Art-Net / E1.31 | Realtime input is enabled, but Madrix still must match protocol, universe, address, and channel mode. | Gate this as Advanced until Madrix sends a verified test frame to the controller. |
| Clock | WLED time is still 1970. | Enable NTP if schedules/time-based presets are used; otherwise avoid clock-dependent behavior. |
| Identity | Name is generic `WLED`. | Rename to a Lightweaver piece/controller name and reserve the MAC/IP in the router. |
| Audio patterns | WLED audio reactivity is off. | Gate audio patterns to Pi/computer/Art-Net unless an explicit audio-reactive WLED setup is commissioned. |

## Runtime Gate Decision

- **Lightweaver Basic WLED:** not install-ready yet. Firmware is correct, but LED count, segments, presets, ledmap decision, and identity still need commissioning.
- **Advanced Art-Net:** protocol path is plausible because realtime input is enabled, but it remains gated until Madrix is configured and tested against the final LED count.
- **Computer/Pi live render:** usable for preview and commissioning, but not acceptable as the entry-level runtime because the operator should not need a Mac or Pi.

## Implemented Guardrail

The reusable controller audit lives in `lightweaver/src/lib/controllerCompatibility.js`. It classifies live controller state into:

- `ready`
- `needs-config`
- `needs-install`
- `runtime-only`
- `blocked`

Use it before installing a WLED Basic package so Lightweaver can refuse or warn on bench-only state instead of silently writing presets to the wrong controller geometry.
