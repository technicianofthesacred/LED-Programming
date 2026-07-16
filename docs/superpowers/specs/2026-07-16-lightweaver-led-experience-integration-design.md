# Lightweaver LED Experience Integration Design

**Date:** 2026-07-16
**Status:** Approved for implementation planning

## Purpose

Improve the visible quality, reliability, and usability of Lightweaver by integrating selected techniques from FastLED and related open-source LED projects without replacing Lightweaver's existing ESP32-S3 runtime or public/local control architecture.

The work follows quality-first phased releases. Each phase must leave the existing product deployable and physically verifiable before the next phase begins.

## Goals

- Make live Art-Net, WLED-compatible, and Studio preview output reach the LEDs with predictable brightness and color.
- Improve the standalone card's native effects through reusable FastLED techniques and real palette support.
- Make effect behavior and available controls understandable in the Studio and card interface.
- Improve live-stream efficiency, diagnostics, and multi-universe frame integrity.
- Create a safe path toward onboard audio and geometry-aware effects after the core runtime is stable.

## Non-goals

- Do not put a Raspberry Pi back into the current runtime path.
- Do not replace the Lightweaver firmware with WLED, WS2812FX, LEDFx, xLights, or another complete runtime.
- Do not redesign the entire Studio or card interface.
- Do not break existing WLED-compatible JSON, WebSocket, Art-Net, controller-package, or saved-look interfaces.
- Do not import code without a compatible license and recorded provenance.
- Do not ship onboard audio or geometry projection until the dependency and hardware experiments pass their own release gates.

## Architectural principles

### One output contract

Every frame source supplies unscaled RGB pixels to the shared LED canvas. Source adapters may validate, decode, stage, and claim ownership, but they do not apply customer brightness, saved-look brightness, gamma, or output calibration.

The final output path applies transformations once and in this order:

1. Select or render the current frame source.
2. Determine the appropriate master brightness policy for that source.
3. Apply installation RGB balance and white-point calibration.
4. Apply the configured output transfer curve exactly once.
5. Apply power limiting and supported temporal dithering.
6. Transmit the pixels to the physical LED outputs.

Local procedural looks use their saved look brightness. External live sources use a live master brightness and must not inherit the currently selected local look's brightness.

### One effect registry

The card-native effect catalog will have a single authoritative registry. Each entry defines:

- Stable effect ID and display label.
- Renderer identifier.
- Default palette.
- Supported controls and valid ranges.
- Motion, tempo, intensity, and preview metadata.
- Compatibility aliases for existing pattern IDs.
- Minimum firmware capability when the effect needs a newer runtime feature.

Firmware rendering, storage validation, WLED-compatible APIs, Studio controls, previews, and exports consume this registry or generated artifacts derived from it. Unknown IDs produce an explicit compatibility error rather than silently rendering Aurora.

### Capability-gated compatibility

New protocol and rendering behavior must be discoverable through the existing card capability response. The Studio selects the newest mutually supported behavior and automatically falls back for older cards.

This applies to binary RGB frames, output color encoding, enhanced palettes, advanced effect parameters, onboard audio, and geometry projection.

### Release isolation

Each phase is implemented, tested, bench-verified, and released independently. Protocol upgrades keep backward-compatible fallbacks until all supported cards advertise the newer capability.

## Phase 1: Output correctness

### Scope

- Remove per-source multiplication by `manualBrightness` from Art-Net, UDP realtime, WebSocket text frames, and JSON API frame ingestion.
- Split local-look brightness from external-live brightness in the final output calculation.
- Define the RGB encoding expected from the Studio and live protocols.
- Add one final output transfer lookup table on the card where appropriate.
- Add per-installation red, green, and blue balance values with neutral defaults.
- Keep the existing FastLED current limiter as the final safety ceiling.
- Expose active source, final output scale, gamma mode, calibration values, and measured frame rate in diagnostics.
- Enable temporal dithering only when measured output refresh is high enough to avoid visible low-rate shimmer.

### Failure behavior

Invalid calibration or gamma values are rejected without changing the active configuration. A card that lacks the new color capability continues using the legacy Studio frame behavior, preventing double gamma.

### Release gate

- Automated brightness-composition tests cover local looks and every external input source.
- Full-white, primary-color, low-level gradient, and neutral-gray frames are inspected on physical LEDs.
- Manual brightness at 100%, 50%, and near-minimum produces monotonic output without quadratic dimming.
- Switching among local, Studio, WLED-compatible, and Art-Net sources does not leak brightness state.
- Recovery mode and power limiting continue to work.

## Phase 2: Native effects and palettes

### Scope

- Introduce the authoritative effect and palette registries while preserving existing IDs.
- Persist `paletteId` and supported effect parameters in looks and section assignments.
- Use FastLED palette lookup and palette blending in the native renderer.
- Replace the simplest native implementations with adapted MIT-licensed techniques:
  - Deterministic TwinkleFox-style attack, decay, and incandescent cooling.
  - Pacifica-style additive wave layers for cool and warm tide variants.
  - Fire2012-style heat diffusion for fire, candle, ember, and molten variants.
  - FastLED blur, fade, and blend primitives for meteor, scanner, chase, and particle trails.
- Record the upstream source, license, and adaptation notes for every imported algorithm.

### Data compatibility

Existing looks without a palette use the effect's default palette. Existing effect IDs resolve through explicit aliases. Exported controller packages include a schema version and the capability requirements for effects and palettes.

### Release gate

- Registry and storage tests reject unknown IDs and out-of-range parameters.
- Existing saved looks load with visually compatible defaults.
- Effects are inspected at representative low and high pixel counts.
- Effects remain smooth at the card's sustained physical refresh rate.
- Power limiting and brightness changes do not corrupt effect state.

## Phase 3: Interface integration

### Scope

- Preserve motion, tempo, intensity, CSS motion family, palette, and supported-control metadata when adapting pattern data for the live v3 interface.
- Animate thumbnails using a small set of truthful motion families rather than executing full LED programs in every list row.
- Render effect-specific controls from registry metadata.
- Make palette previews reflect the same ordered colors used by firmware.
- Add multi-section selection while preserving the existing single-section path.
- Add clone/remix behavior for customer and AI-edited effects so a working source is not overwritten.
- Define a versioned Lightweaver Look Pack containing effect IDs, parameters, palettes, section bindings, and compatibility metadata.
- Keep the last valid preview visible when browser pattern compilation fails and show actionable error locations.

### Failure behavior

Unsupported effects or controls remain visible but disabled with a clear firmware compatibility explanation. Invalid imports are parsed without mutating the current project and present a list of specific schema or capability errors.

### Release gate

- A user can discover, preview, customize, save, reload, export, and re-import a look.
- Controls shown for each effect match its declared parameters.
- Studio preview and physical output use the same palette ordering.
- Older cards retain their current controls and streaming path.
- The actual mobile and desktop screens pass visual and interaction smoke tests.

## Phase 4: Streaming reliability

### Binary frame protocol

Add a versioned binary WebSocket frame containing a fixed header, flags, start pixel, pixel count, and packed RGB bytes. The Studio and card-page bridge use binary frames only when the card advertises support. JSON `RRGGBB` arrays remain the fallback.

The sender remains latest-frame-wins: when congested, it drops stale frames rather than queueing latency. Stream cancellation and frame-source ownership continue using the existing control contract.

### Atomic Art-Net assembly

Stage incoming universes in a secondary frame buffer. Track received universes by Art-Net sequence and commit the staged frame when one of these conditions occurs:

- A matching ArtSync packet arrives.
- Every expected universe for the sequence has arrived.
- A bounded assembly timeout expires.

Out-of-order and late packets are counted and must not partially overwrite a newer visible frame.

### Diagnostics

Expose active source, received FPS, displayed FPS, last-frame age, dropped frames, sequence errors, Art-Net universe completeness, WebSocket parse time, congestion drops, and output scale.

### Release gate

- Binary and JSON streams render identical pixel fixtures.
- Older cards automatically use JSON without user configuration.
- Sustained Studio streaming shows no unbounded heap loss or increasing latency.
- Multi-universe Madrix tests show no visible frame tearing.
- Source ownership, timeout, cancellation, and recovery behavior pass regression tests.

## Phase 5: Advanced capability experiments

These are separate experimental tracks, not prerequisites for Phases 1 through 4.

### FastLED upgrade

Pin a specific reviewed FastLED source rather than a broad version range. Compile checks are followed by physical tests of output timing, networking, SD playback, power limiting, and long-running stability. The upgrade is accepted only if those tests pass with acceptable flash and RAM headroom.

### Onboard audio

Prototype supported I2S/PDM input using the newer FastLED audio APIs. Expose normalized energy, logarithmic frequency bands, spectral flux, beat, silence, and confidence through a small feature contract. Effects consume features rather than microphone samples.

Browser audio may later adopt additional logarithmic triangular bands and per-band normalization while preserving its current bass, mid, high, centroid, flux, and beat outputs.

### Geometry-aware rendering

Extend mapper export with normalized or quantized sculpture coordinates. Render a bounded low-resolution 2D field and sample it through a screen-map projection onto physical LED indices. Existing linear effects remain available when no geometry map exists.

### External companions

LEDFx and xLights remain external GPL applications that send Art-Net to Lightweaver. Lightweaver may provide connection profiles and documentation but does not embed or redistribute their internal engines.

## Testing and verification strategy

Each implementation slice follows this sequence:

1. Add a failing unit, contract, or fixture test for the behavior.
2. Implement the smallest compatible change.
3. Run focused firmware or Studio tests.
4. Compile the ESP32-S3 firmware and check RAM and flash use.
5. Run the phase-specific physical LED test.
6. Run the relevant full verification, including `npm run launch:check` before deployment.
7. Commit the coherent slice with its tests and provenance notes.

Physical verification is required for claims about brightness, color, refresh quality, tearing, power behavior, or visual effect quality. Compile and browser simulation results alone are insufficient for those claims.

## Delivery sequence

The expected delivery order is:

1. Output correctness and diagnostics foundation.
2. Effect/palette registry and native visual upgrades.
3. Metadata-driven interface integration.
4. Binary streaming and atomic Art-Net.
5. Independently approved audio and geometry experiments.

Phases may be stopped after any release without leaving half-migrated data or requiring the deferred Pi runtime.
