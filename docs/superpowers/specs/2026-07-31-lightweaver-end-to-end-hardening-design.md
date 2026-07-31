# Lightweaver end-to-end hardening design

## Status

Approved on 2026-07-31.

## Scope

This work makes the active ESP32-S3 Lightweaver workflow coherent from artwork
design through offline playback on the card. It includes the standalone mapper,
Studio, the local card-page bridge, firmware, microSD sequences, operator
documentation, and release verification.

Raspberry Pi hosting, WLED as the installed card firmware, and Madrix gallery
commissioning remain deferred. Exposed deferred actions must either produce a
valid external artifact or clearly state that they are not part of the active
Lightweaver card workflow.

## Product outcome

An artist can:

1. Design an LED layout without losing geometry or physical address order.
2. Import or continue that work in Studio without silent replacement.
3. Choose looks, a playlist, startup behavior, wiring, power, and calibration.
4. See whether the project is saved locally and whether that exact revision is
   installed on the paired card.
5. Install through one consistent experience.
6. Physically test only when hardware facts changed.
7. Receive independent read-back proof before Studio says the card is installed.
8. Power-cycle the card and get the same verified offline result.

## Interaction model

### Two persistent states

Studio presents two independent facts:

- **Saved in Studio**
- **Installed on card**

Editing never implies installation. Sending never implies verification.

### One installation home

**Test & Install** is the complete commissioning experience. Contextual actions
in Patterns, Playlist, Layout, and Card use the label **Update card** and open
Test & Install with the relevant changes preselected. They do not implement
separate installation semantics.

### User-facing progression

The normal progression is:

1. **Ready to install**
2. **Sending**
3. **Test lights**, only when physical hardware facts changed
4. **Verifying card**
5. **Installed**

The primary interface does not expose `staged`, activation identifiers,
fingerprints, raw revisions, NVS, bridge mechanics, or package JSON. Those facts
remain available under diagnostics.

### Semantic change classes

Changes to looks, playlist order, startup look, and non-hardware playback
parameters use the short update path.

Changes to output pins, pixel counts, segment boundaries, physical direction,
color order, calibration, or current limit require the safe hardware test path.

### Pre-install review

The inline review contains at most four groups:

- Card
- Wiring
- Power
- Playback

It shows only relevant changes, distinguishes blockers from warnings, and offers
direct safe actions. The normal flow never asks the artist to copy raw JSON.

### Safety and recovery

- **Stop lights** remains visible during any live test.
- Tests begin at a safe brightness.
- Chase, flash, and color tests show a photosensitivity warning before starting.
- Instructions use position and blink rhythm in addition to color.
- The interface continually states that the previous working setup remains
  stored until the new setup is confirmed.
- Test confirmation has no inaccessible short deadline.
- A failed send, activation, reconnect, or read-back never marks the project
  installed.
- Recovery offers state-specific actions: **Try again**, **Restore previous
  setup**, and **Connection help**.

### Success

Success names the verified card and the offline outcome:

> Installed and verified on Lightweaver-AB12  
> Offline playback ready. Starts with Aurora.

The primary next action is **Play first scene**.

### Mobile and accessibility

The editor remains desktop-first. Test & Install is a focused mobile-capable
commissioning surface with a persistent card/status bar, 44-pixel touch targets,
resumable state, 200 percent zoom support, visible focus, keyboard alternatives,
and live announcements for sending, testing, reconnecting, rollback, and
verification.

## Canonical deployment contract

Every installation entry point calls one deployment coordinator. The
coordinator:

- Compiles canonical wiring.
- Builds the runtime package through
  `buildCardRuntimePackageFromProject`.
- Preserves output segments and direction.
- Preserves looks, playlist, startup state, power limit, brightness, gamma,
  calibration, controls, revision, and fingerprint.
- Rejects unverified or internally inconsistent wiring.
- Classifies the semantic change.
- Handles candidate activation and rollback.
- Reads configuration back and compares its semantic fingerprint.
- Marks the project installed only after exact-card verification.

A machine-readable hardware contract is the source for Studio and firmware
output-pin and capacity rules. Generated or parity-checked consumers must fail
the build if they drift.

## Mapper interoperability

Mapper project files use a distinct kind and version, separate from Studio
project schema versions. Studio recognizes and converts them explicitly.
Unrecognized JSON is rejected before the open project changes.

Import shows artwork name, strip count, and LED count, and defaults to **Import
as new project**. Conversion completes before any replacement is committed.

Hidden strips retain physical address ranges during live playback. Hidden
addresses receive black frames, so later strips never shift and stale LEDs do
not remain lit.

Preview, coordinate JSON, and FastLED exports use one aspect-preserving
coordinate transform. Coordinate artifacts are described as external exports,
not as firmware input for the active Lightweaver card.

The Studio WLED download is removed from the active install path. If retained as
an external export, it must use stock WLED's flat logical-cell to
physical-index schema and be labeled as a separate WLED setup.

## Firmware behavior

### microSD

The card mounts microSD before choosing configuration. Boot precedence is
deterministic and documented:

1. A valid, exact-identity SD project may provide the active project and is
   accepted as command-ready.
2. Otherwise the last known-good internal project is used.
3. Otherwise the card enters factory recovery.

Sequence media remains mounted and available after the configuration is chosen.
Declared sequence byte length and SHA-256 are verified during unpacking and
before playback.

### Reset

Factory reset always clears internal configuration. Missing or inaccessible
microSD produces a best-effort cleanup warning and does not prevent reset.

### Hardware and power

Studio and firmware accept the same output pins. The exact configured
`maxMilliamps` reaches the runtime. Studio calculations describe the selected
strip profile, while firmware reports and enforces the deployed limit without
claiming a different strip-voltage model.

Default card hostnames include the card identity suffix.

### Compatibility safety

Firmware JSON escapes all user-provided labels and applies explicit request-size
limits. Unsupported WLED segment operations fail clearly instead of appearing
to control independent zones while applying a global change.

## Browser and card-page transport

Frame results distinguish delivered, dropped, and failed. Dropped frames do not
advance success status.

Bridge errors retain actionable categories. Recovery actions reuse the one
tracked card window. Automatic discovery runs before manual local-address entry
appears. Captive-portal aliases are normalized to a card-approved local host
before Studio or WebSocket authority is granted.

Bridge acquisition tolerates ESP startup, local-network permission prompts, and
mobile tab switching without a fixed 2.5-second false failure.

## Documentation

The primary hardware guide installs the signed Lightweaver factory firmware.
Historical WLED instructions move to a clearly deferred document and cannot be
mistaken for the product setup path.

Customer runtime, firmware, mapper, deployment, and production closeout
documentation must agree on:

- The ESP32-S3-only runtime.
- microSD precedence.
- Supported output and control pins.
- Power defaults.
- Current physical acceptance status.

## Verification

All behavior changes follow test-first development. Required proof includes:

- Exact runtime-package equivalence across all installation entry points.
- Candidate activation, rollback, and independent read-back.
- Mapper project recognition, conversion, rejection, and address preservation.
- Shared hardware-contract parity.
- microSD boot precedence, sequence access, integrity, and reset without SD.
- Delivered, dropped, and failed bridge outcomes.
- Mobile, keyboard, screen-reader announcement, zoom, and safe-light controls.
- Production build, staged Pages artifact, signed firmware freshness, and live
  production freshness.

The automated gate cannot declare the physical product ship-ready. The release
remains blocked until the real card passes AP join, project read-back,
visible-strip boundaries, power-cycle persistence, offline playback, microSD
playback, and Wi-Fi recovery.

