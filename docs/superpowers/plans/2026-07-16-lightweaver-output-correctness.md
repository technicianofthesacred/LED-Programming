# Lightweaver Output Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give local and external Lightweaver frames one tested brightness/color output contract so live sources are no longer dimmed twice and future effects start from predictable physical output.

**Architecture:** Reuse the existing logical `leds[]` canvas, separate `physicalLeds[]` output buffer, frame-source ownership, `showLeds()` funnel, FastLED color helpers, storage parser, and WLED-shaped diagnostics. Add one small pure brightness-policy unit and one color-transform unit; source adapters only decode raw RGB, while `showLeds()` remains the sole physical transformation boundary.

**Tech Stack:** ESP32-S3 Arduino firmware, FastLED 3.10.3, ArduinoJson 7, PlatformIO, Node.js contract tests, Vite/React Studio runtime contract.

---

## Scope boundary

This plan implements Phase 1 only. Effect imports, palette registries, animated thumbnails, binary WebSocket frames, atomic Art-Net assembly, onboard audio, and geometry projection have separate release gates and are not part of this branch.

Output gamma is a new installation-level card setting named `outputGammaEnabled`/`outputGammaValue`. It is deliberately separate from the existing Studio pattern-preview gamma toggle, preventing implicit double correction. Existing configs default to gamma disabled and neutral RGB balance.

## File structure

- Create `firmware/lightweaver-controller/src/LightweaverOutputPolicy.h`: dependency-free brightness composition and source policy.
- Create `firmware/lightweaver-controller/src/LightweaverColorPipeline.h` and `.cpp`: FastLED-backed cached gamma LUT, RGB balance, and color-order transformation.
- Create `firmware/lightweaver-controller/tests/output-policy.cpp`: host assertions for brightness semantics.
- Create `firmware/lightweaver-controller/tests/output-policy.mjs`: compile/run harness plus firmware contract assertions.
- Modify the four live-source adapters so they write unscaled RGB.
- Modify `LightweaverTypes.h` and `LightweaverStorage.cpp` for backward-compatible output-color settings.
- Modify `main.cpp` to use the policy and color pipeline at the existing output funnel.
- Modify `LightweaverRuntimeApi.h`, `LightweaverWledJsonApi.cpp`, and existing web status JSON to expose output diagnostics and capabilities.
- Modify `lightweaver/src/lib/cardRuntimeContract.js` and its tests to preserve installation-level output color settings in controller packages.
- Modify `docs/deployment-checklist.md` with the physical Phase 1 acceptance fixture.

### Task 1: Pure brightness policy

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverOutputPolicy.h`
- Create: `firmware/lightweaver-controller/tests/output-policy.cpp`
- Create: `firmware/lightweaver-controller/tests/output-policy.mjs`
- Modify: `lightweaver/package.json`

- [ ] **Step 1: Write the failing native policy test**

Create a C++ fixture that includes the wished-for policy API and asserts the exact source semantics:

```cpp
#include <cassert>
#include <cstdint>
#include "../src/LightweaverOutputPolicy.h"

int main() {
  OutputBrightnessInputs input{};
  input.brightnessLimit = 0.45f;
  input.lookBrightness = 0.35f;
  input.fadeScale = 1.0f;
  input.knob = 1.0f;
  input.manualBrightness = 1.0f;

  assert(composeOutputBrightness(input, OUTPUT_LOCAL) == 40);
  assert(composeOutputBrightness(input, OUTPUT_EXTERNAL) == 115);

  input.manualBrightness = 0.5f;
  assert(composeOutputBrightness(input, OUTPUT_EXTERNAL) == 57);

  input.lookBrightness = 0.1f;
  input.fadeScale = 0.1f;
  assert(composeOutputBrightness(input, OUTPUT_EXTERNAL) == 57);

  input.blackedOut = true;
  assert(composeOutputBrightness(input, OUTPUT_LOCAL) == 0);
  assert(composeOutputBrightness(input, OUTPUT_EXTERNAL) == 0);
}
```

The Node harness must compile with `c++ -std=c++17`, execute the temporary binary, remove it, and fail on any non-zero result. Add it to `test:core` before the existing firmware contract tests.

- [ ] **Step 2: Run the test and verify RED**

Run: `node firmware/lightweaver-controller/tests/output-policy.mjs`

Expected: FAIL because `LightweaverOutputPolicy.h` does not exist.

- [ ] **Step 3: Implement the dependency-free policy**

Implement this public surface in the header:

```cpp
#pragma once
#include <cmath>
#include <cstdint>

enum OutputSourceClass : uint8_t {
  OUTPUT_LOCAL = 0,
  OUTPUT_EXTERNAL = 1,
};

struct OutputBrightnessInputs {
  float brightnessLimit = 1.0f;
  float lookBrightness = 1.0f;
  float fadeScale = 1.0f;
  float knob = 1.0f;
  float manualBrightness = 1.0f;
  bool blackedOut = false;
};

inline float clampOutputUnit(float value) {
  if (!std::isfinite(value) || value <= 0.0f) return 0.0f;
  return value >= 1.0f ? 1.0f : value;
}

inline uint8_t composeOutputBrightness(
    const OutputBrightnessInputs& input,
    OutputSourceClass source) {
  if (input.blackedOut) return 0;
  float scale = clampOutputUnit(input.brightnessLimit) *
                clampOutputUnit(input.knob) *
                clampOutputUnit(input.manualBrightness);
  if (source == OUTPUT_LOCAL) {
    scale *= clampOutputUnit(input.lookBrightness) *
             clampOutputUnit(input.fadeScale);
  }
  return static_cast<uint8_t>(std::lround(clampOutputUnit(scale) * 255.0f));
}
```

- [ ] **Step 4: Run RED-to-GREEN verification**

Run: `node firmware/lightweaver-controller/tests/output-policy.mjs`

Expected: PASS with all five policy assertions.

- [ ] **Step 5: Commit the policy slice**

```bash
git add firmware/lightweaver-controller/src/LightweaverOutputPolicy.h \
  firmware/lightweaver-controller/tests/output-policy.cpp \
  firmware/lightweaver-controller/tests/output-policy.mjs lightweaver/package.json
git commit -m "test(firmware): define output brightness policy"
```

### Task 2: Raw live-source ingestion

**Files:**
- Modify: `firmware/lightweaver-controller/tests/output-policy.mjs`
- Modify: `firmware/lightweaver-controller/src/LightweaverArtnet.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverArtnet.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverWledRealtime.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWledRealtime.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverWledWebSocket.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWledWebSocket.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverWledJsonApi.cpp`

- [ ] **Step 1: Add failing source-contract assertions**

Extend `output-policy.mjs` to read all four adapters and assert that none declares or applies a per-frame `manualBrightness`, `brightnessScale`, `brightScale`, or `nscale8` operation inside its RGB ingestion block. Assert that each still copies all three raw channels and calls `frameSourceClaim` before writing.

- [ ] **Step 2: Run the contract and verify RED**

Run: `node firmware/lightweaver-controller/tests/output-policy.mjs`

Expected: FAIL for all four current adapters because each scales incoming pixels.

- [ ] **Step 3: Remove only per-source output scaling**

Make each accepted pixel assignment equivalent to:

```cpp
dst[i] = CRGB(sourceR, sourceG, sourceB);
```

Remove now-unused `extern float manualBrightness` declarations and correct header comments. Preserve packet validation, subset semantics, frame ownership, watchdog timestamps, and existing source priority exactly.

- [ ] **Step 4: Run focused GREEN verification**

Run:

```bash
node firmware/lightweaver-controller/tests/output-policy.mjs
node lightweaver/tests/wled-control-contract.mjs
node firmware/lightweaver-controller/tests/bridge-frame-protocol.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit the ingestion slice**

```bash
git add firmware/lightweaver-controller/src/LightweaverArtnet.* \
  firmware/lightweaver-controller/src/LightweaverWledRealtime.* \
  firmware/lightweaver-controller/src/LightweaverWledWebSocket.* \
  firmware/lightweaver-controller/src/LightweaverWledJsonApi.cpp \
  firmware/lightweaver-controller/tests/output-policy.mjs
git commit -m "fix(firmware): preserve raw live RGB frames"
```

### Task 2A: Separate global master and zone brightness

**Files:**
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `firmware/lightweaver-controller/tests/control-sync-order.mjs`
- Modify: `firmware/lightweaver-controller/tests/output-policy.mjs`

- [ ] **Step 1: Add failing setter-semantics assertions**

Require these independent behaviors:

```cpp
void runtimeSetBrightness(float value01) {
  manualBrightness = clampBrightness(value01);
}

void runtimeSetBrightnessZ(const String& targetId, float value01) {
  const float clamped = clampBrightness(value01);
  applyToZones(targetId, [&](ZoneConfig& zone) { zone.brightness = clamped; });
}
```

The contract must prove that top-level WLED `bri` changes the global master only, section/all-section controls change zone brightness only, and the physical rotary continues to change `manualBrightness` only. Preserve the existing sync-zone targeting order.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node firmware/lightweaver-controller/tests/control-sync-order.mjs
node firmware/lightweaver-controller/tests/output-policy.mjs
```

Expected: FAIL because both current setters write `manualBrightness` and zone brightness together.

- [ ] **Step 3: Split the setter responsibilities**

Extract one small clamp helper or preserve the existing bounds in both setters. Remove the zone broadcast from `runtimeSetBrightness()` and remove the empty-target `manualBrightness` assignment from `runtimeSetBrightnessZ()`. Do not change speed, hue, blackout, sync targeting, WLED routing, or rotary handling.

- [ ] **Step 4: Run focused GREEN verification**

Run:

```bash
node firmware/lightweaver-controller/tests/control-sync-order.mjs
node firmware/lightweaver-controller/tests/output-policy.mjs
node lightweaver/tests/wled-control-contract.mjs
```

Expected: all pass.

- [ ] **Step 5: Commit the setter slice**

```bash
git add firmware/lightweaver-controller/src/main.cpp \
  firmware/lightweaver-controller/tests/control-sync-order.mjs \
  firmware/lightweaver-controller/tests/output-policy.mjs
git commit -m "fix(firmware): separate master and zone brightness"
```

### Task 3: Cached output color pipeline and storage contract

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverColorPipeline.h`
- Create: `firmware/lightweaver-controller/src/LightweaverColorPipeline.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverTypes.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/tests/storage-config-clamps.mjs`
- Modify: `firmware/lightweaver-controller/tests/runtime-color-order.mjs`

- [ ] **Step 1: Add failing storage and transformation contracts**

Require this backward-compatible config shape:

```json
{
  "led": {
    "outputGammaEnabled": false,
    "outputGammaValue": 2.2,
    "calibration": { "red": 1, "green": 1, "blue": 1 }
  }
}
```

Tests must assert clamping to gamma `1.0..3.0`, calibration `0.0..1.0`, neutral defaults for missing fields, and this physical transformation order: RGB balance, optional cached gamma lookup, then configured channel order.

- [ ] **Step 2: Run the contracts and verify RED**

Run:

```bash
node firmware/lightweaver-controller/tests/storage-config-clamps.mjs
node firmware/lightweaver-controller/tests/runtime-color-order.mjs
```

Expected: FAIL because the output color fields and pipeline are absent.

- [ ] **Step 3: Add the configuration model and parser**

Add to `RuntimeConfig`:

```cpp
struct OutputColorConfig {
  bool gammaEnabled = false;
  float gammaValue = 2.2f;
  float red = 1.0f;
  float green = 1.0f;
  float blue = 1.0f;
};

OutputColorConfig outputColor;
```

Parse the fields with finite clamps, emit them from runtime configuration JSON, and preserve neutral defaults when loading old packages.

- [ ] **Step 4: Implement the color pipeline using FastLED primitives**

Expose:

```cpp
class LightweaverColorPipeline {
 public:
  void configure(const OutputColorConfig& config);
  CRGB transform(const CRGB& logical, uint8_t colorOrderCode) const;
  bool gammaEnabled() const;
  float gammaValue() const;
 private:
  uint8_t gammaLut_[256];
  uint8_t redScale_ = 255;
  uint8_t greenScale_ = 255;
  uint8_t blueScale_ = 255;
  bool gammaEnabled_ = false;
  float gammaValue_ = 2.2f;
};
```

Build `gammaLut_` once in `configure()` using FastLED's `applyGamma_video`, use `scale8_video` for channel balance, and perform the existing six color-order permutations after calibration/gamma. Do not mutate the logical canvas.

- [ ] **Step 5: Run focused GREEN verification and compile**

Run:

```bash
node firmware/lightweaver-controller/tests/storage-config-clamps.mjs
node firmware/lightweaver-controller/tests/runtime-color-order.mjs
/Users/adrianrasmussen/.local/bin/pio run -d firmware/lightweaver-controller
```

Expected: all tests pass and PlatformIO exits 0.

- [ ] **Step 6: Commit the color pipeline slice**

```bash
git add firmware/lightweaver-controller/src/LightweaverColorPipeline.* \
  firmware/lightweaver-controller/src/LightweaverTypes.h \
  firmware/lightweaver-controller/src/LightweaverStorage.cpp \
  firmware/lightweaver-controller/tests/storage-config-clamps.mjs \
  firmware/lightweaver-controller/tests/runtime-color-order.mjs
git commit -m "feat(firmware): add calibrated output color pipeline"
```

### Task 4: Integrate the shared output funnel and diagnostics

**Files:**
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverWledJsonApi.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/tests/output-policy.mjs`
- Modify: `firmware/lightweaver-controller/tests/wled-compat-smoke.mjs`
- Modify: `firmware/lightweaver-controller/tests/recover-lights-endpoint.mjs`

- [ ] **Step 1: Add failing integration and diagnostics assertions**

Require `computeBrightnessByte()` to call `composeOutputBrightness` with `OUTPUT_EXTERNAL` whenever `frameSourceIsStreaming()` is true. Require `copyLogicalToPhysicalLeds()` to call the shared color pipeline. Require `/json/info` and card status to expose:

```json
{
  "lwOutput": {
    "contract": 1,
    "sourceClass": "local",
    "brightnessByte": 0,
    "gammaEnabled": false,
    "gammaValue": 2.2,
    "calibration": { "red": 1, "green": 1, "blue": 1 },
    "measuredFps": 0,
    "dithering": false
  }
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node firmware/lightweaver-controller/tests/output-policy.mjs
node firmware/lightweaver-controller/tests/wled-compat-smoke.mjs
node firmware/lightweaver-controller/tests/recover-lights-endpoint.mjs
```

Expected: FAIL because the shared policy and diagnostics are not wired into runtime output.

- [ ] **Step 3: Wire the existing output funnel**

Configure one `LightweaverColorPipeline` after runtime config load. Keep `physicalLeds[]` registered with FastLED. Replace the body of `mapLogicalToPhysicalColor()` with the pipeline transform and keep `showLeds()` as the only normal call to `FastLED.show()`.

Build `OutputBrightnessInputs` from the existing limit, active look, fade, knob, manual brightness, and blackout values. Select the external source class only while the frame-source watchdog reports an active external stream.

- [ ] **Step 4: Add measured output state without a second scheduler**

Increment a show counter in `showLeds()`. Once per elapsed second, publish the measured FPS, reset the counter, and set FastLED dithering to `true` only at 50 FPS or above. Cache the last brightness byte and source class for diagnostics.

- [ ] **Step 5: Expose capabilities and diagnostics through existing APIs**

Add read-only runtime getters for the cached output state. Populate `lwOutput` in `/json/info` and the existing local status response. Preserve all existing WLED fields and recovery diagnostics.

- [ ] **Step 6: Run focused GREEN verification and compile**

Run:

```bash
node firmware/lightweaver-controller/tests/output-policy.mjs
node firmware/lightweaver-controller/tests/wled-compat-smoke.mjs
node firmware/lightweaver-controller/tests/recover-lights-endpoint.mjs
/Users/adrianrasmussen/.local/bin/pio run -d firmware/lightweaver-controller
```

Expected: all pass; RAM and flash remain within the existing configured limits.

- [ ] **Step 7: Commit the runtime integration slice**

```bash
git add firmware/lightweaver-controller/src/main.cpp \
  firmware/lightweaver-controller/src/LightweaverRuntimeApi.h \
  firmware/lightweaver-controller/src/LightweaverWledJsonApi.cpp \
  firmware/lightweaver-controller/src/LightweaverWeb.cpp \
  firmware/lightweaver-controller/tests/output-policy.mjs \
  firmware/lightweaver-controller/tests/wled-compat-smoke.mjs \
  firmware/lightweaver-controller/tests/recover-lights-endpoint.mjs
git commit -m "feat(firmware): centralize LED output transforms"
```

### Task 5: Studio controller-package contract

**Files:**
- Modify: `lightweaver/src/lib/cardRuntimeContract.js`
- Modify: `lightweaver/tests/card-runtime-contract.mjs`
- Modify: `lightweaver/src/lib/cardLiveControl.js`
- Modify: `lightweaver/tests/card-live-preview.mjs`

- [ ] **Step 1: Write failing normalization and repair-package tests**

Require the normalized `led` object and repair package to preserve:

```js
{
  outputGammaEnabled: false,
  outputGammaValue: 2.2,
  calibration: { red: 1, green: 1, blue: 1 },
}
```

Require gamma clamp `1..3`, calibration clamp `0..1`, and neutral defaults. Assert that these fields are installation output settings and do not alter the existing browser `gammaEnabled` preview setting.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node lightweaver/tests/card-runtime-contract.mjs
node lightweaver/tests/card-live-preview.mjs
```

Expected: FAIL because controller packages currently drop the fields.

- [ ] **Step 3: Extend existing normalization and repair cloning**

Add the three fields to `DEFAULT_CARD_LED`, normalize finite values, and copy them in `buildRepairRuntimePackage()`. Do not add a second settings UI in this phase and do not reinterpret the pattern-preview gamma fields.

- [ ] **Step 4: Run focused GREEN verification**

Run the same two commands. Expected: PASS.

- [ ] **Step 5: Commit the Studio contract slice**

```bash
git add lightweaver/src/lib/cardRuntimeContract.js \
  lightweaver/tests/card-runtime-contract.mjs \
  lightweaver/src/lib/cardLiveControl.js \
  lightweaver/tests/card-live-preview.mjs
git commit -m "feat(studio): preserve card output color settings"
```

### Task 6: Verification fixture and phase gate

**Files:**
- Modify: `docs/deployment-checklist.md`
- Modify: `docs/superpowers/plans/2026-07-16-lightweaver-output-correctness.md`

- [ ] **Step 1: Add the physical acceptance fixture**

Document the exact bench sequence: first LED blue, final LED red, full white, red/green/blue, gray ramp, low-level gradient, local look at 100%/50%, Studio frame at 100%/50%, Art-Net frame at 100%/50%, source transitions, blackout, Recover lights, and current-limit stress. Record expected monotonic brightness and no local-look leakage into live sources.

- [ ] **Step 2: Run the full software verification**

Run:

```bash
cd lightweaver && npm run test:core
cd ../firmware/lightweaver-controller && /Users/adrianrasmussen/.local/bin/pio run
cd ../../lightweaver && npm run launch:check
```

Expected: every command exits 0. Record RAM/flash figures and any warnings in the plan execution notes.

- [ ] **Step 3: Perform or explicitly defer the physical gate**

If a configured card and LED fixture are available, run the documented fixture and record results. If hardware is unavailable, mark the phase software-complete but hardware-unverified; do not claim visual correctness and do not begin Phase 2.

- [ ] **Step 4: Commit the verification documentation**

```bash
git add docs/deployment-checklist.md \
  docs/superpowers/plans/2026-07-16-lightweaver-output-correctness.md
git commit -m "docs: add output correctness bench gate"
```
