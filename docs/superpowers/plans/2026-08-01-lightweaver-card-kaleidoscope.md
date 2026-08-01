# Lightweaver Card Kaleidoscope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile each enabled source-local Kaleidoscope mapping into a bounded card runtime mapping, persist and read it back on ESP32-S3 firmware, and use identical folded progress during standalone procedural playback across reversals, seams, splits, gaps, and outputs.

**Architecture:** Layout owns the editable `{ enabled, pointCount, startLed, offsets }` object and the companion Studio plan supplies `lightweaver/src/lib/kaleidoscope.js`. This plan adds a card-only compiler whose optional `config.kaleidoscopeMappings` entries retain compact source-local phase/offsets and add bounded logical-frame spans `{ start, count, sourceStart, sourceStep }`; logical spans preserve source identity while the existing output segments continue to own electrical reversal. Firmware validates the complete optional array without truncation, derives ordered final points only when configuration changes, and passes a coordinate context to standalone procedural/native-recipe rendering; streamed RGB and `.lwseq` frames remain untouched.

**Tech Stack:** React/Vite Studio libraries, Node `node:test`, JSON Schema 2020-12, ESP32-S3 Arduino/C++17, ArduinoJson 7, FastLED, PlatformIO native and device builds.

---

## Contract and limits

The prerequisite Studio helper is `lightweaver/src/lib/kaleidoscope.js` with `KALEIDOSCOPE_REFLECTION_POINTS_VERSION = 1`, `validateKaleidoscope(mapping, pixelCount)`, and `deriveReflectionPointIndices(mapping, pixelCount)`. Do not redefine or persist derived points in the project.

The optional card field is omitted when no enabled strip mapping exists, preserving byte-for-byte legacy runtime/job behavior:

```js
config.kaleidoscopeMappings = [{
  id: 'outer-frame',
  zoneId: 'outer-frame',
  pixelCount: 400,
  pointCount: 4,
  startLed: 100,
  offsets: [0, -1, 2, 0],
  spans: [
    { start: 0, count: 200, sourceStart: 200, sourceStep: 1 },
    { start: 203, count: 200, sourceStart: 0, sourceStep: 1 },
  ],
}];
```

Use these hard limits in Studio and firmware: 32 mappings, 4 spans per mapping, 1024 aggregate offsets, and 3968 serialized configuration bytes. Reject excess, missing/duplicated source coverage, and out-of-range spans before any write; never slice, clamp, or partially install mappings.

### Task 1: Compile source-local mappings through physical wiring

**Files:**
- Create: `lightweaver/src/lib/cardKaleidoscope.js`
- Create: `lightweaver/src/lib/cardKaleidoscope.test.js`
- Modify: `lightweaver/src/lib/wiringCompiler.js`
- Modify: `lightweaver/src/lib/wiringCompiler.test.js`

- [ ] **Step 1: Write the failing compiler tests**

Add Node tests that compile one 400-pixel strip with `{ enabled: true, pointCount: 4, startLed: 100, offsets: [0, 0, 0, 0] }` and assert all of the following exact cases:

```js
assert.deepEqual(compileCardKaleidoscopeMappings({ strips, pixels, zones }).mappings, [{
  id: 'frame', zoneId: 'frame', pixelCount: 400,
  pointCount: 4, startLed: 100, offsets: [0, 0, 0, 0],
  spans: [{ start: 0, count: 400, sourceStart: 0, sourceStep: 1 }],
}]);

assert.deepEqual(splitAcrossGapAndOutputs.spans, [
  { start: 0, count: 125, sourceStart: 0, sourceStep: 1 },
  { start: 128, count: 150, sourceStart: 125, sourceStep: 1 },
  { start: 278, count: 125, sourceStart: 275, sourceStep: 1 },
]);
assert.deepEqual(seamAt300.spans, [
  { start: 0, count: 100, sourceStart: 300, sourceStep: 1 },
  { start: 100, count: 300, sourceStart: 0, sourceStep: 1 },
]);
```

Also assert that `physicalDirection: 'source-reverse'` changes output segment direction but not the mapping's source LED identity; grouped zones retain separate mapping entries with the same `zoneId`; disabled/missing metadata emits no entry; uncovered or duplicated source LEDs, more than four compressed spans, and more than 32 mappings return structured compiler errors.

- [ ] **Step 2: Run the tests and verify red**

Run: `cd lightweaver && node --test src/lib/cardKaleidoscope.test.js src/lib/wiringCompiler.test.js`

Expected: FAIL because `cardKaleidoscope.js` and `compileCardKaleidoscopeMappings` do not exist.

- [ ] **Step 3: Implement strict span compilation**

Export the following exact surface:

```js
export const CARD_KALEIDOSCOPE_MAX_MAPPINGS = 32;
export const CARD_KALEIDOSCOPE_MAX_SPANS_PER_MAPPING = 4;
export const CARD_KALEIDOSCOPE_MAX_AGGREGATE_OFFSETS = 1024;

export function compileCardKaleidoscopeMappings({ strips = [], pixels = [], zones = [] } = {})
// returns { ok, mappings, errors }

export function runtimeConfigUsesKaleidoscope(config = {})
// true only for a non-empty config.kaleidoscopeMappings array
```

Call `validateKaleidoscope` from `kaleidoscope.js`; invalid enabled source metadata must produce `{ code: 'kaleidoscope-invalid', stripId, message }`. Index `compiled.pixels` by `stripId` and `sourceLed`, prove every source LED `0..pixelCount-1` appears exactly once, order by global `pixel.index`, and compress adjacent entries only when both global index and modulo source index advance by one. Emit separate spans across inactive gaps, output boundaries, and seam wrap. Add `kaleidoscopeMappings` and its errors to `compileWiring()`; do not include mapping edits in `wiringFingerprint()` or wiring invalidation.

- [ ] **Step 4: Run the focused tests and commit**

Run: `cd lightweaver && node --test src/lib/cardKaleidoscope.test.js src/lib/wiringCompiler.test.js`

Expected: PASS, including reversed runs, seams, split runs, inactive gaps, grouped zones, and multiple outputs.

```bash
git add lightweaver/src/lib/cardKaleidoscope.js lightweaver/src/lib/cardKaleidoscope.test.js lightweaver/src/lib/wiringCompiler.js lightweaver/src/lib/wiringCompiler.test.js
git commit -m "feat: compile card kaleidoscope mappings"
```

### Task 2: Add the optional runtime contract and capacity-safe package

**Files:**
- Modify: `lightweaver/src/lib/cardRuntimeContract.js`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`
- Modify: `lightweaver/tests/card-runtime-contract.mjs`
- Modify: `lightweaver/src/lib/cardStoragePayload.js`
- Modify: `lightweaver/src/lib/cardStoragePayload.test.js`

- [ ] **Step 1: Write failing runtime and budget tests**

Assert that `buildCardRuntimePackageFromProject()` copies `compiled.kaleidoscopeMappings` to `config.kaleidoscopeMappings`, that `normalizeCardRuntimeConfig()` rejects fractional offsets, bad span coverage, or limit overflow instead of normalizing them, and that the key is absent for legacy projects. Add 400- and 453-pixel fixtures with 4, 6, and 8 points and assert `prepareCardStoragePayload(package).bytes <= 3968`. Add a worst valid 453-point fixture whose actual serialized size exceeds 3968 and assert `CardConfigCapacityError` occurs before transport work. Update the capacity error to say “Reduce playlist looks, combo zones, or Kaleidoscope reflection points, then try again” so recovery is actionable.

- [ ] **Step 2: Verify the focused tests fail**

Run: `cd lightweaver && node --test tests/card-runtime-contract.mjs src/lib/cardStoragePayload.test.js`

Expected: FAIL because runtime normalization drops the new field and the compact-storage path has no mapping rules.

- [ ] **Step 3: Implement strict optional normalization**

Add the exact exports `CARD_KALEIDOSCOPE_REFLECTION_POINTS_VERSION = 1` and `normalizeCardKaleidoscopeMappings(value, totalPixels)`. The normalizer returns `[]` only for an absent property or an empty array; every present entry is either returned in canonical key order or causes a `RangeError` naming the entry and invalid field.

Validate exact integers, `pointCount === offsets.length`, `2 <= pointCount <= pixelCount`, signed offsets within `±(pixelCount - 1)`, unique IDs, known zone IDs, global span bounds, `sourceStep` equal to `1` or `-1`, exact source coverage, and aggregate limits. `normalizeCardRuntimeConfig()` must only add `kaleidoscopeMappings` when the source property exists and the normalized array is non-empty. In `buildCardRuntimePackageFromProject()`, pass the compiler result into `makeCardRuntimePackage()` and fail on compiler mapping errors. Preserve mappings in `compactCardStorageConfig`; only remove `enabled` (runtime entries are inherently enabled), labels, and other keys not in the wire contract.

- [ ] **Step 4: Run tests and commit**

Run: `cd lightweaver && node --test tests/card-runtime-contract.mjs src/lib/cardStoragePayload.test.js src/lib/wiringCompiler.test.js`

Expected: PASS; legacy JSON remains unchanged and all representative 400–453 pixel packages remain within the shared 3968-byte budget.

```bash
git add lightweaver/src/lib/cardRuntimeContract.js lightweaver/src/lib/cardRuntimeProject.js lightweaver/tests/card-runtime-contract.mjs lightweaver/src/lib/cardStoragePayload.js lightweaver/src/lib/cardStoragePayload.test.js
git commit -m "feat: add kaleidoscope runtime contract"
```

### Task 3: Extend immutable production jobs without invalidating legacy jobs

**Files:**
- Modify: `lightweaver/src/lib/productionJobPackage.js`
- Modify: `lightweaver/src/lib/productionJobPackage.test.js`
- Modify: `release/production-job.schema.json`
- Modify: `scripts/production-job-consistency.test.mjs`

- [ ] **Step 1: Write failing schema and round-trip tests**

Add an enabled strip mapping to a cloned source job, rebuild it, and assert the restore snapshot retains exactly `{ enabled, pointCount, startLed, offsets }`, runtime config contains the compiled mapping, and changing one offset changes the job digest. Validate an existing published job with no mapping unchanged. Add negative fixtures for an extra derived `points` field, malformed offsets, and a runtime mapping not reproducible from the restore snapshot.

- [ ] **Step 2: Verify red**

Run: `cd lightweaver && node --test src/lib/productionJobPackage.test.js && npm run test:production-jobs`

Expected: FAIL with “unsupported fields” for `strip.kaleidoscope` and `config.kaleidoscopeMappings`.

- [ ] **Step 3: Make both additions optional**

Change the exact-key validators to required-plus-optional lists:

```js
const STRIP_OPTIONAL_KEYS = [
  'angle', 'brightness', 'closed', 'color', 'emit', 'generatedLayout',
  'hueShift', 'kaleidoscope', 'layoutRole', 'pathData', 'patternId',
  'pixels', 'reversed', 'sourceLayerId', 'sourcePathId', 'speed',
  'svgLength', 'visible', 'x', 'y',
];
const CONFIG_OPTIONAL_KEYS = ['kaleidoscopeMappings'];
```

Validate editable metadata with `validateKaleidoscope`; validate runtime entries with `normalizeCardKaleidoscopeMappings`; keep `schemaVersion`, package version, and config version at `1` because both properties are optional. Add `$defs.kaleidoscope` and `$defs.runtimeKaleidoscopeMapping` to the JSON schema with `additionalProperties: false`, and optional properties at the strip and runtime-config sites. Do not rebuild or rewrite existing signed production artifacts.

- [ ] **Step 4: Run production verification and commit**

Run: `cd lightweaver && node --test src/lib/productionJobPackage.test.js && npm run test:production-jobs`

Expected: PASS; old artifacts validate byte-for-byte and the new fixture digest includes source and runtime mapping fields.

```bash
git add lightweaver/src/lib/productionJobPackage.js lightweaver/src/lib/productionJobPackage.test.js release/production-job.schema.json scripts/production-job-consistency.test.mjs
git commit -m "feat: carry kaleidoscope mappings in production jobs"
```

### Task 4: Add firmware types, strict storage parsing, and read-back API

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverKaleidoscope.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverTypes.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `firmware/lightweaver-controller/platformio.ini`
- Create: `firmware/lightweaver-controller/tests/kaleidoscope-runtime.cpp`
- Create: `firmware/lightweaver-controller/tests/kaleidoscope-runtime.mjs`
- Modify: `lightweaver/package.json` (scripts section only)

- [ ] **Step 1: Write the failing native contract test**

The C++ test must cover 400/4 → `[0,100,200,300]`, 400/6 → `[0,67,133,200,267,333]`, 400/8 → `[0,50,100,150,200,250,300,350]`, wrapped starts, offsets, collision rejection, seam spans, and exact boundary sampling. The `.mjs` harness compiles it with `c++ -std=c++17 -Wall -Wextra -Werror` and also asserts firmware info/status expose `capabilities.kaleidoscopeReflectionPoints === 1` and exact applied mappings.

- [ ] **Step 2: Run and verify red**

Run: `node firmware/lightweaver-controller/tests/kaleidoscope-runtime.mjs`

Expected: FAIL because `LightweaverKaleidoscope.h` and firmware mapping types do not exist.

- [ ] **Step 3: Implement bounded firmware structures and derivation**

Define plain C++ types usable by the native test:

```cpp
constexpr uint8_t LW_MAX_KALEIDOSCOPE_MAPPINGS = 32;
constexpr uint8_t LW_MAX_KALEIDOSCOPE_SPANS = 4;
constexpr uint16_t LW_MAX_KALEIDOSCOPE_OFFSETS = LW_MAX_PIXELS;
constexpr uint8_t LW_KALEIDOSCOPE_REFLECTION_POINTS_VERSION = 1;

struct KaleidoscopeSpan { uint16_t start, count, sourceStart; int8_t sourceStep; };
struct KaleidoscopeMappingConfig {
  String id, zoneId;
  uint16_t pixelCount, startLed, pointCount, pointPoolStart;
  KaleidoscopeSpan spans[LW_MAX_KALEIDOSCOPE_SPANS];
  uint8_t spanCount;
};

// Members of RuntimeConfig; all mappings share these bounded pools.
int16_t kaleidoscopeOffsets[LW_MAX_KALEIDOSCOPE_OFFSETS];
uint16_t kaleidoscopeOrderedPoints[LW_MAX_KALEIDOSCOPE_OFFSETS];
uint16_t kaleidoscopePointPoolCount;
KaleidoscopeMappingConfig kaleidoscopeMappings[LW_MAX_KALEIDOSCOPE_MAPPINGS];
uint8_t kaleidoscopeMappingCount;
```

Keep the derivation/sampling arithmetic and `KaleidoscopeSpan` in the Arduino-independent header; keep `String`-owning configuration structs in `LightweaverTypes.h` so the host test compiles without Arduino stubs. Implement `deriveKaleidoscopePoints()` once after successful parsing/config activation and `sampleKaleidoscope(mapping, sourceLed)` with binary search over the shared ordered-point pool, never a per-pixel linear point scan. The deterministic rule is: an exact reflection LED belongs to the interval that starts at that point; `reflectionProgress = forwardDistance / intervalLength`; even intervals return that value, odd intervals return `1 - value`; `reflectionDistance = 2 * min(forwardDistance, intervalLength - forwardDistance) / intervalLength`, clamped to `0…1`; exact points have distance `0`, `isReflectionPoint=true`, and their own point index.

- [ ] **Step 4: Parse atomically and expose exact evidence**

In `LightweaverStorage.cpp`, reject the whole configuration on any malformed/overflowing mapping before assigning the candidate `RuntimeConfig`; do not use ArduinoJson `|` defaults for present mapping fields and do not truncate arrays. Missing `kaleidoscopeMappings` produces zero mappings. Include the exact applied mappings in `runtimeFirmwareInfo()` and `runtimeZonesJson()` for independent read-back. Set `-DLW_CAPABILITIES_VERSION=2` and return:

```json
{"capabilitiesVersion":2,"capabilities":{"kaleidoscopeReflectionPoints":1}}
```

Keep config schema version `1`; old configurations load with ordinary progress. Configuration POST/candidate staging must reject oversize JSON before NVS mutation and reject mapping validation before replacing known-good state.

Append `node ../firmware/lightweaver-controller/tests/kaleidoscope-runtime.mjs` to the existing `test:core` script so the contract is always-on in the launch gate.

- [ ] **Step 5: Run native, storage, and firmware build checks**

Run: `node firmware/lightweaver-controller/tests/kaleidoscope-runtime.mjs`

Run: `node firmware/lightweaver-controller/tests/storage-config-clamps.mjs && node firmware/lightweaver-controller/tests/storage-stack-safety.mjs && node firmware/lightweaver-controller/tests/card-identity-capabilities.mjs`

Run: `cd firmware/lightweaver-controller && pio run -e esp32-s3-n16r8`

Expected: all tests PASS and the ESP32-S3 image links without static-RAM overflow.

```bash
git add firmware/lightweaver-controller/src/LightweaverKaleidoscope.h firmware/lightweaver-controller/src/LightweaverTypes.h firmware/lightweaver-controller/src/LightweaverStorage.cpp firmware/lightweaver-controller/src/LightweaverRuntimeApi.h firmware/lightweaver-controller/src/main.cpp firmware/lightweaver-controller/platformio.ini firmware/lightweaver-controller/tests/kaleidoscope-runtime.cpp firmware/lightweaver-controller/tests/kaleidoscope-runtime.mjs lightweaver/package.json
git commit -m "feat: persist card kaleidoscope mappings"
```

### Task 5: Feed folded progress to standalone procedural rendering

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverPatterns.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverPatterns.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `firmware/lightweaver-controller/tests/kaleidoscope-runtime.cpp`
- Modify: `firmware/lightweaver-controller/tests/pattern-runtime-state.mjs`

- [ ] **Step 1: Add failing renderer parity tests**

Create golden assertions for pixels at every 400/4 point, both sides of each boundary, a 400/6 uneven interval, an offset point, a wrapped start, and a seam-split span. Render `aurora`, `rainbow`, `wave`, and one native recipe and assert mirrored source LEDs receive the same coordinate-derived sample. Assert preset solids, external frame streaming, and `.lwseq` playback do not enter the Kaleidoscope coordinate path.

- [ ] **Step 2: Run and verify red**

Run: `node firmware/lightweaver-controller/tests/kaleidoscope-runtime.mjs && node firmware/lightweaver-controller/tests/pattern-runtime-state.mjs`

Expected: FAIL because renderers only derive progress from the contiguous range index.

- [ ] **Step 3: Add an explicit coordinate context**

Use these signatures:

```cpp
struct PatternCoordinateContext {
  uint16_t sourcePixelCount = 0;
  uint16_t sourceStart = 0;
  int8_t sourceStep = 1;
  const KaleidoscopeMappingConfig* kaleidoscope = nullptr;
};

bool renderProceduralPattern(const String&, CRGB*, uint16_t, uint32_t,
  const PatternModifiers&, const PatternCoordinateContext* = nullptr);
bool renderNativeRecipe(const lightweaver::NativeRecipe&, CRGB*, uint16_t,
  uint32_t, const PatternModifiers&, const PatternCoordinateContext* = nullptr);
```

For native recipes and legacy patterns whose position is strip progress, replace range-local `i/count` with the sampled `kaleidoscopeProgress`; keep global time, hue, random frame cadence, and non-progress controls unchanged. In `renderZone()`, render ordinary ranges normally, then render each mapped span with its source context so grouped zones may mix mapped and ordinary strips. Reuse precomputed ordered points. Do not touch `renderSequenceFrame()`, Art-Net, WLED realtime/WebSocket, or card frame-stream ingestion.

- [ ] **Step 4: Run renderer and 28 FPS safety checks**

Run: `node firmware/lightweaver-controller/tests/kaleidoscope-runtime.mjs && node firmware/lightweaver-controller/tests/pattern-runtime-state.mjs && node firmware/lightweaver-controller/tests/recipe-capabilities.mjs`

Run: `cd firmware/lightweaver-controller && pio run -e esp32-s3-n16r8`

Expected: PASS; source inspection proves no point-array scan exists inside a pixel loop and the firmware still builds at the 30 FPS target.

```bash
git add firmware/lightweaver-controller/src/LightweaverPatterns.h firmware/lightweaver-controller/src/LightweaverPatterns.cpp firmware/lightweaver-controller/src/main.cpp firmware/lightweaver-controller/tests/kaleidoscope-runtime.cpp firmware/lightweaver-controller/tests/pattern-runtime-state.mjs
git commit -m "feat: render standalone kaleidoscope progress"
```

### Task 6: Capability-gate installation and verify exact read-back

**Files:**
- Modify: `lightweaver/src/lib/cardPushClient.js`
- Modify: `lightweaver/src/lib/cardPushClient.test.js`
- Modify: `lightweaver/src/lib/cardDeployment.js`
- Modify: `lightweaver/src/lib/cardDeployment.test.js`
- Modify: `lightweaver/src/lib/cardIdentity.js`
- Modify: `lightweaver/src/lib/cardIdentity.test.js`

- [ ] **Step 1: Write failing no-side-effect gate tests**

For a package with mappings, assert missing capability evidence and `kaleidoscopeReflectionPoints: 0` throw `CardPushError` with reason `kaleidoscope-unsupported` before config POST, candidate staging, bridge mutation, or reboot. Assert capability version `1` proceeds. Assert a package without mappings still installs on legacy cards. Extend deployment verification so an exact identity with mismatched/missing applied mapping read-back is `read-back-mismatch`.

- [ ] **Step 2: Verify red**

Run: `cd lightweaver && node --test src/lib/cardPushClient.test.js src/lib/cardDeployment.test.js src/lib/cardIdentity.test.js`

Expected: FAIL because card evidence currently discards feature capabilities and applied mappings.

- [ ] **Step 3: Implement the common gate**

Preserve bounded capability and `kaleidoscopeMappings` evidence in `normalizeCardProjectEvidence()`. Export:

```js
export function assertCardKaleidoscopeSupport(runtimePackage, evidence) {
  if (!runtimeConfigUsesKaleidoscope(runtimePackage.config || runtimePackage)) return true;
  if (Number(evidence?.capabilities?.kaleidoscopeReflectionPoints) < 1) {
    throw new CardPushError('kaleidoscope-unsupported',
      'This card can preview streamed calibration frames, but its firmware cannot install standalone Kaleidoscope reflection points. Update the card firmware, then retry.');
  }
  return true;
}
```

Call it after fresh exact-card read-only evidence and before every direct, bridge, blank-card, or candidate config mutation. For the one-shot blank-card bridge path, require capability evidence in the already verified handoff/options; do not add an unbound read between authority and POST. Compare normalized applied mappings during `verifyCardDeployment()` and `waitForCardDeploymentVerification()`. Delivery or project identity alone is not installation success.

- [ ] **Step 4: Run tests and commit**

Run: `cd lightweaver && node --test src/lib/cardPushClient.test.js src/lib/cardDeployment.test.js src/lib/cardIdentity.test.js`

Expected: PASS; old cards may still use frame streaming but cannot be reported as having installed standalone mappings.

```bash
git add lightweaver/src/lib/cardPushClient.js lightweaver/src/lib/cardPushClient.test.js lightweaver/src/lib/cardDeployment.js lightweaver/src/lib/cardDeployment.test.js lightweaver/src/lib/cardIdentity.js lightweaver/src/lib/cardIdentity.test.js
git commit -m "feat: gate kaleidoscope card installation"
```

### Task 7: Full regression and physical acceptance

**Files:**
- Modify: `docs/deployment-checklist.md`

- [ ] **Step 1: Run the complete relevant automated gate**

Run: `cd lightweaver && npm run test:unit && npm run test:core && npm run test:production-jobs && npm run build`

Run: `cd firmware/lightweaver-controller && pio run -e esp32-s3-n16r8`

Expected: every command exits 0. Confirm stock `ledmap.json`, coordinate-map, CSV, FastLED, Madrix, and xLights export snapshots are unchanged.

- [ ] **Step 2: Measure serialized and runtime budgets**

Record `prepareCardStoragePayload()` byte counts for 400 and 453 pixels at 4, 6, and 8 points in the checklist; each must be at most 3968 bytes. Record firmware static RAM/flash from PlatformIO and verify a representative mapped standalone pattern reports at least 28 FPS through existing output telemetry for five continuous minutes.

- [ ] **Step 3: Perform the physical 400–453 pixel card test**

On a real frame, install 4 points with the first physical corner selected, then repeat 6 and 8 points. Verify a start shift rotates all red calibration points, each fine-tune nudge moves exactly one physical LED, and the same LEDs remain selected with a reversed run, seam rotation, split run, inactive gap, and a second output. Save/install, disconnect Studio, run `aurora`, `rainbow`, `wave`, and a native recipe, and confirm the card mirrors between calibrated points. Reconnect and confirm read-back reports the exact mapping; then attempt the same package against old firmware and confirm the install is blocked while transient RGB calibration streaming still works.

- [ ] **Step 4: Document evidence and commit**

Add date, card ID, firmware build ID, pixel count, mapping byte counts, measured minimum FPS, mapping read-back result, and pass/fail for every physical case to `docs/deployment-checklist.md`.

```bash
git add docs/deployment-checklist.md
git commit -m "docs: record kaleidoscope card acceptance"
```

## Final verification

- [ ] Confirm the editable project still persists only `{ enabled, pointCount, startLed, offsets }`.
- [ ] Confirm missing runtime/card data follows ordinary progress with no warning and all legacy jobs remain valid.
- [ ] Confirm malformed enabled data fails rather than being guessed, clamped, sliced, or partially written.
- [ ] Confirm mapping-only edits neither unlock nor dirty verified wiring.
- [ ] Confirm streamed frames and `.lwseq` bytes are unchanged.
- [ ] Confirm capability version 1 is required only when standalone Kaleidoscope mappings are present.
- [ ] Confirm exact applied mapping read-back, not delivery alone, is required before Studio reports Installed.
- [ ] Confirm representative 400–453 pixel configurations fit 3968 bytes and sustain at least 28 FPS on hardware.
