# Lightweaver Two-Version Runtime Strategy Design

Date: 2026-05-25
Project: Lightweaver
Status: Approved direction; foundation implemented

## Summary

Lightweaver has two product versions.

The entry-level version is **Lightweaver Basic - WLED**. It ships with an ESP32-S3 running WLED. Looks are stored on the controller as WLED presets, WLED playlists, WLED segments, or Lightweaver custom WLED effects. The buyer does not need a Raspberry Pi, Mac, Madrix, or Lightweaver editor at runtime.

The high-end version is **Lightweaver Advanced - Art-Net / Custom**. It supports Madrix, live Art-Net, Raspberry Pi-hosted control, and Lightweaver standalone firmware with `.lwseq` sequence playback when exact offline playback is required.

This avoids rebuilding WLED as a generic controller while preserving a path for advanced authored shows.

## Version 1: Lightweaver Basic - WLED

Basic is the default sellable controller path.

Runtime hardware:

- ESP32-S3 N16R8 running WLED.
- LED power supply and final wiring.
- Optional physical button for preset cycling.
- Optional phone/browser UI for owner control.
- No Pi, Mac, Madrix, or microSD required at runtime.

Stored looks:

- WLED presets for color states, segments, effect parameters, playlists, and cycling.
- Lightweaver custom WLED effects for branded looks that stock WLED cannot reproduce.
- WLED playlists for automatic rotation through multiple looks.

Best use cases:

- Slow color rotations.
- Candle / ember / warm flicker.
- Ambient gallery idle looks.
- Simple segment-based pieces.
- Owner-controlled preset selection from phone or button.

Constraints:

- Browser-side Lightweaver JavaScript does not automatically become a stored WLED look.
- A pattern must be mapped to stock WLED behavior or ported as a WLED custom effect before it truly lives on the chip.
- Exact long-form frame sequences are not the Basic default.

## Version 2: Lightweaver Advanced - Art-Net / Custom

Advanced is for pro installations and exact authored playback.

Runtime options:

- WLED on ESP32-S3 receiving live Art-Net from Madrix or another Art-Net source.
- Raspberry Pi-hosted Lightweaver UI as a gallery controller and bridge.
- Lightweaver standalone firmware with microSD `.lwseq` playback for exact offline sequences.

Stored looks:

- Madrix or Lightweaver project files when a host is present.
- Live Art-Net streams when the installation includes an Art-Net source.
- `.lwseq` sequence packages on microSD when exact playback must run without a host.
- Built-in procedural and preset modes in the standalone firmware for utility looks.

Best use cases:

- High-end commissioned pieces.
- Madrix-authored shows.
- Exact timeline playback.
- Multi-output controllers.
- Large pieces where frame order and output order must be controlled precisely.

Constraints:

- Live Art-Net requires a running Art-Net source.
- Offline exact playback needs Lightweaver standalone firmware and storage.
- Commissioning is more complex than WLED Basic.

## Pattern Target Model

Every Lightweaver pattern needs a clear runtime target answer. The codebase now has explicit target constants in `lightweaver/src/lib/runtimeTargets.js`.

Runtime targets:

- `wled-preset`: can be expressed as a WLED preset or playlist entry.
- `wled-custom-effect`: can live on WLED after being ported as a Lightweaver custom WLED effect.
- `live-frame-stream`: can be rendered by Lightweaver and pushed as frames.
- `artnet-stream`: can be sent through the advanced Art-Net path.
- `standalone-procedural`: can be ported into Lightweaver standalone firmware.
- `standalone-sequence`: can be pre-rendered into `.lwseq` frames.

Current rule:

- Basic-compatible ambient patterns such as Candle, Breathe, Aurora, Fire, Rainbow, Gradient, Twinkle, Sparkle, Meteor, Scanner, Lava, and Ocean are candidates for WLED custom effects.
- Beat/audio-driven or editor-specific patterns default to Advanced until they are intentionally ported.
- Any browser-rendered pattern can still be streamed live or pre-rendered into an advanced sequence, but that does not make it a Basic stored WLED look.

## UX Implications

Lightweaver should label each pattern with its supported runtime targets so the artist does not assume every browser pattern is automatically a WLED preset.

Pattern cards should eventually expose:

- **WLED Basic**: stored on WLED now, or needs WLED custom-effect port.
- **Advanced**: Art-Net stream, live frame stream, or standalone sequence.
- **Not portable yet**: editor-only until implemented.

Export should offer two visible tracks:

- **Export to WLED Basic**: build WLED presets/playlists and custom effect selections.
- **Export to Advanced**: Art-Net setup notes, `.lwseq` package, or standalone firmware profile.

## Development Rules

- Do not rebuild WLED features unless there is a specific Lightweaver reason.
- Use WLED for WiFi, AP mode, OTA, presets, playlists, segments, JSON API, button macros, and Art-Net reception.
- Add Lightweaver custom WLED effects when the entry-level product needs a branded ambient look that stock WLED cannot express.
- Use Lightweaver standalone firmware only when WLED cannot satisfy the runtime requirement, especially exact offline sequence playback.
- Keep the Raspberry Pi optional for Basic and useful for Advanced.

## Implementation Foundation

Implemented in this pass:

- Added `lightweaver/src/lib/runtimeTargets.js`.
- Added runtime tier constants for `wled-basic` and `advanced-artnet`.
- Added pattern target constants and compatibility inference helpers.
- Added core test coverage in `lightweaver/tests/project-frame-audit.mjs`.
- Added WLED / ADV compatibility chips to the Live pattern grid.
- Added WLED Basic package export generation for stock WLED presets, a playlist preset, unsupported-pattern warnings, and custom-effect port checklists.
- Added full-library runtime gates for all 130 current patterns and documented the audit in `docs/pattern-compatibility-audit.md`.

Next implementation steps:

- Show runtime target badges on pattern cards.
- Add a connected-controller installer that backs up current WLED presets and applies a WLED Basic package directly.
- Create the first Lightweaver custom WLED effect set: Candle Drift, Ember Slow, Warm Pulse, Amber Aurora, and Gallery Idle.
- Keep the existing standalone `.lwseq` export for the Advanced path.
