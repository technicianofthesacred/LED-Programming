# Lightweaver Standalone Sequence Controller Design

Date: 2026-05-24
Project: Lightweaver
Status: Approved; launch prototype implemented

## Summary

Lightweaver should support a sellable standalone LED controller for laser-cut 3D artworks. The finished piece should not require a Raspberry Pi, laptop, Madrix, or WLED web UI at runtime. The buyer should receive the artwork, controller, power supply, and physical controls.

The controller uses an ESP32-S3 N16R8 with a microSD card. It reads recorded or generated sequence data, handles buttons and knobs, fades to black between selected looks, and drives up to four parallel LED outputs. The Raspberry Pi remains useful in the studio as a development, conversion, testing, and profile-management tool, but it is not part of the sold artwork.

## Goals

- Ship artwork that plays without a Raspberry Pi or laptop.
- Support authored playback exported from Madrix, Art-Net capture, or another computer-side tool.
- Also support non-Art-Net modes, including procedural effects and simple preset/cue looks.
- Support physical controls: sequence selection, play, previous/next, brightness, and blackout.
- Use microSD storage for sequence files and artwork profiles.
- Support up to about 1024 RGB LEDs across one to four outputs.
- Allow each artwork to use only the outputs it needs.
- Use fade-out, switch, fade-in transitions rather than crossfading between recordings.
- Keep WLED useful for development and testing without making it required for finished playback.

## Non-Goals

- Do not rely on WLED as a stored Art-Net recording player.
- Do not require a Raspberry Pi in a sold controller.
- Do not require live Art-Net from Madrix at runtime.
- Do not implement complex crossfades between two full recordings in the first version.
- Do not require every artwork to use recorded Art-Net sequences.
- Do not require all four outputs for simple pieces.

## Runtime Architecture

The sold controller is self-contained:

```text
microSD card
  piece profile + sequence files
        |
ESP32-S3 N16R8
  reads sequence frames
  runs procedural/preset modes
  handles physical controls
  scales brightness
  fades out and in
  sends LED data in parallel
        |
LED artwork zones and branches
```

The studio workflow uses larger tools before deployment:

```text
Madrix / Lightweaver / computer
  authors or records looks
        |
Lightweaver conversion tool
  writes profile and sequence files
        |
microSD card
  inserted into standalone controller
```

The Raspberry Pi workflow remains separate:

```text
Raspberry Pi 5
  development hub
  WLED discovery
  profile testing
  sequence conversion
  bench playback
  optional field diagnostics
```

## Hardware Design

The first hardware target should be conservative and repeatable:

- ESP32-S3 N16R8 controller.
- microSD card module or onboard microSD socket.
- One to four addressable LED data outputs.
- One level-shifter channel per LED output.
- Inline data resistor per output where appropriate.
- Power input sized for the LEDs.
- Fusing or resettable protection suitable for sellable pieces.
- Shared ground between controller and LED power.
- Physical controls connected to GPIO:
  - rotary encoder with push
  - previous button
  - next button
  - blackout button or guarded switch
  - brightness potentiometer
  - status LED
  - optional OLED connector for a later display revision

Four outputs are a controller capability, not a requirement for every piece. A small piece can use one output. Larger pieces can split naturally into artwork zones or branches.

Recommended initial output target:

```text
Output 1 -> zone A
Output 2 -> zone B
Output 3 -> zone C
Output 4 -> zone D
```

For a 1000 LED piece split across four outputs, each output drives about 250 LEDs. That keeps WS281x/WS2815 refresh time low enough for reliable 24-30 fps playback.

## Playback Modes

The controller should support three runtime modes.

### Recorded Sequence Mode

Recorded sequence mode plays frame data from microSD. The source may be Madrix, an Art-Net capture, a Lightweaver export, or another authored toolchain.

This is for polished, intentionally designed looks where the artist wants the finished artwork to play the same way each time.

### Procedural Mode

Procedural mode generates patterns directly on the ESP32-S3. It does not need large files.

This is for ambient generative looks, simple sellable pieces, and cases where exact Madrix-authored playback is unnecessary.

### Preset / Cue Mode

Preset/cue mode triggers named looks, solid colors, gradients, test states, or simple transitions.

This is for utility states and simpler artwork behavior:

- startup look
- gallery idle
- photo mode
- test red, green, blue
- safe warm white
- blackout

## Transition Behavior

The first implementation should use simple, reliable transitions:

```text
current look
  fade brightness to black
  stop current playback
  load selected look
  fade brightness from black to target brightness
next look
```

The controller does not need to blend frame A and frame B. It only needs to scale outgoing RGB values during fade-out and fade-in.

Each profile can define:

- default fade-out duration
- default fade-in duration
- per-look target brightness
- maximum brightness cap

## microSD Data Model

The microSD card should contain one piece profile and a sequence folder:

```text
/lightweaver.json
/sequences/
  001-ember-drift.lwseq
  002-soft-pulse.lwseq
  003-aurora-slow.lwseq
```

The profile describes the physical artwork, outputs, controls, and looks:

```json
{
  "version": 1,
  "piece": {
    "id": "spiral-01",
    "name": "Spiral 01"
  },
  "led": {
    "type": "WS2815",
    "colorOrder": "GRB",
    "brightnessLimit": 0.45
  },
  "outputs": [
    { "id": "outer", "pin": 16, "pixels": 260 },
    { "id": "middle", "pin": 17, "pixels": 220 },
    { "id": "inner", "pin": 18, "pixels": 180 },
    { "id": "halo", "pin": 21, "pixels": 120 }
  ],
  "controls": {
    "encoder": { "a": 4, "b": 5, "press": 6 },
    "previous": 7,
    "next": 8,
    "blackout": 9,
    "brightness": 1,
    "statusLed": 2
  },
  "looks": [
    {
      "id": "ember-drift",
      "label": "Ember Drift",
      "mode": "sequence",
      "file": "/sequences/001-ember-drift.lwseq",
      "fps": 24,
      "loop": true,
      "fadeOutMs": 800,
      "fadeInMs": 1200,
      "brightness": 0.35
    },
    {
      "id": "quiet-warm",
      "label": "Quiet Warm",
      "mode": "preset",
      "preset": "warm-white",
      "fadeOutMs": 500,
      "fadeInMs": 900,
      "brightness": 0.25
    }
  ],
  "startupLook": "ember-drift"
}
```

The profile is the contract between studio tools and firmware. It lets one firmware build support many artworks.

## Sequence File Contract

The first `.lwseq` format should optimize for reliable playback before clever compression.

Required metadata:

- magic header and version
- total pixel count
- output count
- pixels per output
- frame count
- frames per second
- color layout

Frame payload:

- RGB bytes in output order
- frames stored sequentially
- optional simple compression later

The first version can use raw RGB frames if SD throughput tests pass. At 1000 RGB LEDs and 24 fps, raw playback is about 72 KB/s, which is practical for microSD. At 30 fps, it is about 90 KB/s.

## Output Mapping

Recorded sequence files should store frames in controller output order:

```text
frame 0
  output 1 pixels
  output 2 pixels
  output 3 pixels
  output 4 pixels
frame 1
  output 1 pixels
  output 2 pixels
  output 3 pixels
  output 4 pixels
```

This makes firmware playback simple. The conversion tool owns the more complex job of translating Madrix, Art-Net universe order, Lightweaver map coordinates, or patch-board order into controller output order.

This keeps the runtime firmware dependable and pushes mapping complexity into desktop/studio tooling where it is easier to inspect and fix.

## Control Behavior

Minimum physical controls:

- Turn encoder: select next look without changing current playback.
- Press encoder: activate selected look with fade-out and fade-in.
- Next button: activate the next look with fade-out and fade-in.
- Previous button: activate the previous look with fade-out and fade-in.
- Blackout button or switch: fade to black and hold output black.
- Brightness control: scale global output up to the profile brightness limit.

If an OLED is installed, it should show:

```text
LIGHTWEAVER
Piece: Spiral 01
Now: Ember Drift
Next: Soft Pulse
Bri: 35%
```

If no display is installed, the controller should still work through button behavior and optional status LEDs.

## Error Handling

The controller should fail visibly and safely:

- Missing microSD: blink a status code and keep LED outputs black.
- Invalid profile JSON: blink a distinct status code and keep outputs black.
- Missing sequence file: skip that look and keep the previous look running.
- Sequence/output mismatch: refuse to play the file and report the error through status LED or display.
- SD read underrun: hold the last valid frame briefly, then fade to black if playback cannot recover.
- Control input fault: ignore impossible encoder/button events rather than crashing playback.
- Over-bright profile: clamp to firmware maximum brightness.

The safe default is black output, not random LED data.

## Studio Tooling

Lightweaver should grow a studio-side export/conversion path:

1. Select or create artwork profile.
2. Define outputs and pixel counts.
3. Import or reference recorded Art-Net/Madrix data.
4. Convert frames into `.lwseq` output order.
5. Write `/lightweaver.json` and `/sequences/*` to a target folder or microSD card.
6. Validate total pixel counts and file metadata.
7. Optionally preview the sequence in the existing Lightweaver UI.

The Pi can run this tooling in the studio or at a bench, but it is not required in the sold controller.

## Integration With Existing Lightweaver Work

Existing project roles stay intact:

- `lightweaver/` remains the main React operator and mapping application.
- `visitor-ui/` remains the Pi-hosted visitor control surface for installations that need browser access.
- `led-art-mapper/` remains useful for SVG-based physical mapping and WLED ledmap exports.
- The standalone controller adds a new firmware/export target instead of replacing WLED workflows.

The existing patch-board and mapping work should feed this design. The map decides how artwork geometry becomes physical output order. The standalone export writes that order into `lightweaver.json` and `.lwseq` files.

## Testing Strategy

Firmware tests and bench tests should cover:

- profile JSON parse success and failure
- output count and pixel count validation
- sequence metadata validation
- frame read timing from microSD at 24 fps and 30 fps
- one-output and four-output playback
- brightness scaling
- fade-out and fade-in timing
- button debounce and encoder navigation
- blackout behavior
- startup behavior with missing SD, bad profile, and missing file

Hardware smoke tests should include:

- low-brightness red, green, blue test on each output
- 250 pixels per output at 24 fps
- 250 pixels per output at 30 fps
- full-profile startup from cold boot
- repeated sequence switching for at least 30 minutes

## Implementation Phases

### Phase 1: File Contract And Simulator

Define `lightweaver.json` and `.lwseq` on the desktop side. Build a converter/simulator that can write generated sample files and preview them without hardware.

### Phase 2: Firmware Playback Prototype

Build ESP32-S3 firmware that reads one raw `.lwseq` from microSD and plays it on one output with brightness scaling. The prototype firmware should use Arduino framework plus FastLED first because the project only needs four outputs and FastLED's current ESP32-S3 docs describe RMT and I2S parallel-output support. If bench timing fails, the fallback is ESP-IDF RMT.

### Phase 3: Four-Output Playback

Add one to four output support and validate frame timing with realistic LED counts.

### Phase 4: Controls

Add one rotary encoder with push for look selection, three buttons for previous/next/blackout, and one analog brightness potentiometer. Defer OLED until button and playback behavior are stable.

### Phase 5: Studio Export Workflow

Add a Lightweaver export path that writes a complete microSD package from artwork profiles and recorded sequence data.

### Phase 6: Sellable Controller Hardening

Add enclosure-oriented wiring conventions, status codes, recovery behavior, profile backups, and production test steps.

## Implementation Defaults

- Firmware environment: Arduino framework for the first prototype.
- LED library: FastLED first, with ESP-IDF RMT as the fallback if four-output timing is unreliable.
- Storage: SPI microSD.
- First sequence source: Lightweaver-generated raw test files, then Madrix/Art-Net conversion after playback is proven.
- First physical controls: one encoder with push, previous button, next button, blackout button, and brightness potentiometer.
- Display: deferred from the first prototype.
- First frame format: raw RGB frames with metadata header.
- First transition behavior: fade to black, switch look, fade in.

## References

- [WLED Art-Net / E1.31 realtime input docs](https://kno.wled.ge/interfaces/e1.31-dmx/)
- [FastLED ESP32-S3 platform docs](https://fastled.io/docs/index.html)
- [Espressif ESP32-S3 RMT peripheral docs](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/rmt.html)

## Recommendation

Build the controller as a four-output-capable ESP32-S3 product with microSD storage and profile-driven playback. Use one output for simple pieces and up to four outputs for larger zoned artworks. Keep the runtime firmware simple and safe. Put mapping, recording conversion, preview, and profile authoring into Lightweaver studio tooling.
