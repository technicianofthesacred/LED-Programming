# Lightweaver ESP32 Three-Mode Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Lightweaver customer runtime around one ESP32-owned playback system: internal-flash factory patterns, website-loaded internal flash configuration, optional microSD advanced sequence playback, and a stable reserved contract for future live-host streaming.

**Architecture:** The ESP32 always owns playback after setup. The website is an installer/configurator, not the runtime. microSD is an optional expansion layer for recorded frame sequences, while laptop/Pi live streaming remains a reserved protocol lane that does not block the first three modes.

**Tech Stack:** ESP32-S3 Arduino/PlatformIO, FastLED, ArduinoJson, SD/SPI, Preferences/NVS, WiFi/WebServer, React/Vite Lightweaver app, Node test scripts.

---

## Product Runtime Contract

### Mode 1: Factory Card

The customer powers the card and it starts playing from ESP32 internal flash. No website, no SD card, no laptop, no Pi.

Required behavior:
- Boot without SD card present.
- Use built-in pattern bank compiled into firmware.
- Keep Mode 1 inside an 8 MB internal-flash budget; built-in patterns are code and compact parameters, not stored frame recordings.
- Store active pattern index, master brightness, color order, LED count, and rotary direction in NVS.
- Rotary turn adjusts brightness for the current pattern.
- Rotary press cycles through the saved pattern order.
- If NVS is empty or invalid, boot into a safe default bank: `aurora`, `ember`, `rainbow`, `breathe`, `scanner`, `warm-white`.

### Mode 2: Website Loads The Card

The website connects to the ESP32 and saves configuration into internal flash. After disconnecting, the ESP32 continues alone.

Required behavior:
- ESP32 exposes AP mode with a deterministic SSID: `Lightweaver-<last4>`.
- ESP32 exposes JSON API endpoints for status, config read, config write, reboot, and test pattern.
- Lightweaver app can export/apply a small card package containing config and pattern order.
- Reliable installer path is same-origin from the ESP32 AP page at `http://192.168.4.1`; the public Lightweaver website may generate the same JSON package, but direct public-HTTPS-to-private-HTTP posting is treated as a convenience path because browser private-network rules can block it.
- "Saved on card" means the ESP32 has already persisted the config and can be unplugged.

### Mode 3: Memory Card Advanced Sequence

The ESP32 still runs alone, but if valid microSD content exists, it can play larger recorded frame sequences.

Required behavior:
- SD card is optional.
- Boot order is: valid SD package, valid internal flash config, compiled defaults.
- Existing `.lwseq` playback remains supported.
- `/lightweaver.json` declares outputs, controls, looks, color order, and brightness limit.
- Invalid SD content does not brick playback; firmware falls back to internal flash defaults and reports an error status.

### Mode 4: Reserved Live Host

Do not build the live-host runtime in this plan. Reserve the protocol surface so future laptop/Pi/Madrix/sound-reactive streaming can be added without rewriting the first three modes.

Required behavior in this plan:
- Keep the existing USB streaming bench firmware separate from the customer runtime.
- Add a documented future runtime mode id: `live-host`.
- Do not make Mode 1-3 depend on a laptop/Pi process.

---

## Current Repo Anchors

Existing code to reuse:
- `firmware/lightweaver-controller/src/main.cpp` currently plays SD-backed profiles and built-in procedural/preset looks.
- `firmware/lightweaver-usb-led-test/src/main.cpp` currently proves LEDs and rotary hardware over USB.
- `lightweaver/src/lib/standaloneController.js` builds standalone packages and `.lwseq` files.
- `lightweaver/src/components/ExportDialog.jsx` already has Lightweaver Controller export UI.
- `lightweaver/src/lib/wledBasicExport.js` contains useful pattern bank ordering and control-contract ideas.
- `lightweaver/src/lib/usbRotaryInput.js` and `lightweaver/src/lib/rotaryPatternCycle.js` contain the browser-side rotary behavior that must be mirrored on-chip.

Existing assumption to replace:
- `firmware/lightweaver-controller/src/main.cpp` currently fails if microSD is missing. The new customer runtime must boot without SD.

---

## Parallel Agent Lanes

Use these ownership boundaries to run agents in parallel without collisions.

### Agent A: Runtime Schema And Package Contract

Owns:
- `lightweaver/src/lib/cardRuntimeContract.js`
- `lightweaver/tests/card-runtime-contract.mjs`
- Updates to `lightweaver/package.json`

Does not edit:
- Firmware files.
- React components.
- SD unpack script.

Output:
- Normalized runtime mode ids.
- Validated card config schema.
- Builder for internal flash card packages.
- Tests proving Mode 1, Mode 2, Mode 3, and reserved Mode 4 shape.

### Agent B: Firmware Storage And Boot Priority

Owns:
- `firmware/lightweaver-controller/src/LightweaverTypes.h`
- `firmware/lightweaver-controller/src/LightweaverStorage.h`
- `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Boot-related changes in `firmware/lightweaver-controller/src/main.cpp`

Does not edit:
- Web/API firmware module.
- Pattern rendering module.
- React app.

Output:
- SD optional.
- NVS config read/write.
- Boot priority: SD package, NVS package, compiled defaults.
- Serial status lines showing active source.

### Agent C: Firmware Pattern Bank And Controls

Owns:
- `firmware/lightweaver-controller/src/LightweaverPatterns.h`
- `firmware/lightweaver-controller/src/LightweaverPatterns.cpp`
- `firmware/lightweaver-controller/src/LightweaverControls.h`
- `firmware/lightweaver-controller/src/LightweaverControls.cpp`
- Control/pattern call sites in `firmware/lightweaver-controller/src/main.cpp`

Does not edit:
- Storage module internals.
- Web/API module.
- React app.

Output:
- Built-in pattern bank.
- Rotary turn adjusts brightness.
- Rotary press cycles pattern order.
- Previous/next/blackout keep working.

### Agent D: Firmware WiFi Web/API

Owns:
- `firmware/lightweaver-controller/src/LightweaverWeb.h`
- `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Web/API call sites in `firmware/lightweaver-controller/src/main.cpp`
- `firmware/lightweaver-controller/platformio.ini` only if a library dependency is actually required.

Does not edit:
- Pattern bank internals.
- Lightweaver React app.

Output:
- AP mode.
- JSON status/config endpoints.
- Config save uses Agent B storage API.
- Minimal onboard setup page or status page.

### Agent E: Lightweaver Website Installer

Owns:
- `lightweaver/src/lib/cardRuntimeContract.js` after Agent A lands, only additive changes approved by coordinator.
- `lightweaver/src/components/ExportDialog.jsx`
- `lightweaver/src/components/DevicesPanel.jsx`
- `lightweaver/src/components/CardInstallerPanel.jsx` if the Devices panel implementation exceeds 120 added lines.
- `lightweaver/tests/card-installer-package.mjs`

Does not edit:
- Firmware files.
- SD unpack script unless coordinated with Agent F.

Output:
- Clear UI separation:
  - "Factory Card / Internal Flash"
  - "Load Website Settings To Card"
  - "Prepare Memory Card"
- Installer package body that matches firmware API.
- Tests for generated package shape.

### Agent F: SD Advanced Package And Verification

Owns:
- `lightweaver/src/lib/standaloneController.js`
- `lightweaver/scripts/unpack-standalone-package.mjs`
- `lightweaver/tests/standalone-package-unpack.mjs`
- `firmware/lightweaver-controller/README.md`
- New docs: `docs/lightweaver-customer-runtime.md`

Does not edit:
- ESP32 WiFi API module.
- React installer UI.

Output:
- SD package remains compatible.
- Package validation is strict.
- Docs explain customer modes and bench checklist.
- Verification checklist for firmware build, app build, and live card smoke test.

---

## Integration Rules

- The coordinator merges Agent A first because every other lane uses its mode names and schema.
- Agent B and Agent C can run in parallel after Agent A.
- Agent D can run after Agent B exposes `loadRuntimeConfig()`, `saveRuntimeConfig()`, and `runtimeStatusJson()`.
- Agent E can run after Agent A, and may mock the firmware API shape until Agent D lands.
- Agent F can run after Agent A and does not need firmware code complete.
- Only the coordinator edits `firmware/lightweaver-controller/src/main.cpp` if two agents would otherwise conflict in the same function.

---

## Task 1: Runtime Contract Library

**Files:**
- Create: `lightweaver/src/lib/cardRuntimeContract.js`
- Create: `lightweaver/tests/card-runtime-contract.mjs`
- Modify: `lightweaver/package.json`

- [ ] **Step 1: Write the failing runtime contract tests**

Create `lightweaver/tests/card-runtime-contract.mjs`:

```js
import assert from 'node:assert/strict';
import {
  CARD_RUNTIME_MODES,
  DEFAULT_CARD_PATTERN_BANK,
  buildCardRuntimeConfig,
  normalizeCardRuntimeConfig,
  makeCardRuntimePackage,
} from '../src/lib/cardRuntimeContract.js';

assert.deepEqual(CARD_RUNTIME_MODES, ['factory-flash', 'website-flash', 'sd-sequence', 'live-host']);

assert.deepEqual(
  DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id),
  ['aurora', 'ember', 'rainbow', 'breathe', 'scanner', 'warm-white'],
);

const normalized = normalizeCardRuntimeConfig({
  mode: 'website-flash',
  led: { pixels: 44, colorOrder: 'rgb', brightnessLimit: 0.7 },
  controls: {
    encoder: {
      a: 4,
      b: 5,
      press: 0,
      rotateDirection: 'clockwise-brighter',
      brightnessStep: 18,
      patternCycleIds: ['scanner', 'aurora', 'ember'],
    },
  },
});

assert.equal(normalized.mode, 'website-flash');
assert.equal(normalized.led.pixels, 44);
assert.equal(normalized.led.colorOrder, 'RGB');
assert.equal(normalized.led.brightnessLimit, 0.7);
assert.equal(normalized.controls.encoder.press, 0);
assert.deepEqual(normalized.controls.encoder.patternCycleIds, ['scanner', 'aurora', 'ember']);

const fallback = buildCardRuntimeConfig({ projectName: 'Bench Piece' });
assert.equal(fallback.mode, 'factory-flash');
assert.equal(fallback.piece.name, 'Bench Piece');
assert.deepEqual(fallback.patterns.map(pattern => pattern.id), DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id));

const pkg = makeCardRuntimePackage({
  projectName: 'Bench Piece',
  mode: 'website-flash',
  led: { pixels: 44, colorOrder: 'RGB' },
  controls: normalized.controls,
});

assert.equal(pkg.app, 'Lightweaver');
assert.equal(pkg.format, 'lightweaver-card-runtime-package');
assert.equal(pkg.version, 1);
assert.equal(pkg.config.mode, 'website-flash');
assert.equal(pkg.config.piece.name, 'Bench Piece');
assert.equal(pkg.config.led.pixels, 44);
assert.deepEqual(pkg.config.controls.encoder.patternCycleIds, ['scanner', 'aurora', 'ember']);

console.log('card-runtime-contract tests passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd lightweaver
node tests/card-runtime-contract.mjs
```

Expected result:

```text
SyntaxError: The requested module '../src/lib/cardRuntimeContract.js' does not provide an export named ...
```

- [ ] **Step 3: Implement the runtime contract module**

Create `lightweaver/src/lib/cardRuntimeContract.js`:

```js
export const CARD_RUNTIME_MODES = ['factory-flash', 'website-flash', 'sd-sequence', 'live-host'];

export const DEFAULT_CARD_PATTERN_BANK = Object.freeze([
  { id: 'aurora', label: 'Aurora', mode: 'procedural' },
  { id: 'ember', label: 'Ember', mode: 'procedural' },
  { id: 'rainbow', label: 'Rainbow', mode: 'procedural' },
  { id: 'breathe', label: 'Breathe', mode: 'procedural' },
  { id: 'scanner', label: 'Scanner', mode: 'procedural' },
  { id: 'warm-white', label: 'Warm White', mode: 'preset' },
]);

export const DEFAULT_CARD_CONTROLS = Object.freeze({
  encoder: {
    a: 4,
    b: 5,
    press: 0,
    alternatePress: 6,
    rotateDirection: 'clockwise-brighter',
    brightnessStep: 18,
    patternCycleIds: DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id),
  },
  previous: 7,
  next: 8,
  blackout: 9,
  brightness: -1,
  statusLed: 2,
});

export const DEFAULT_CARD_LED = Object.freeze({
  pixels: 44,
  outputs: [{ id: 'out1', name: 'Output 1', pin: 16, pixels: 44 }],
  colorOrder: 'RGB',
  brightnessLimit: 0.65,
});

export function normalizeCardRuntimeConfig(config = {}) {
  const mode = CARD_RUNTIME_MODES.includes(config.mode) ? config.mode : 'factory-flash';
  const patternIds = normalizePatternIds(config.controls?.encoder?.patternCycleIds);
  return {
    version: 1,
    mode,
    piece: {
      id: sanitizeId(config.piece?.id || config.projectName || 'lightweaver-piece'),
      name: String(config.piece?.name || config.projectName || 'Lightweaver Piece'),
    },
    led: normalizeLed(config.led),
    controls: normalizeControls({
      ...config.controls,
      encoder: {
        ...(config.controls?.encoder || {}),
        patternCycleIds: patternIds.length ? patternIds : DEFAULT_CARD_CONTROLS.encoder.patternCycleIds,
      },
    }),
    patterns: normalizePatterns(config.patterns),
    startupPatternId: sanitizeId(config.startupPatternId || patternIds[0] || DEFAULT_CARD_PATTERN_BANK[0].id),
  };
}

export function buildCardRuntimeConfig({
  projectName = 'Lightweaver Piece',
  mode = 'factory-flash',
  led = {},
  controls = {},
  patterns = DEFAULT_CARD_PATTERN_BANK,
  startupPatternId = '',
} = {}) {
  return normalizeCardRuntimeConfig({
    mode,
    projectName,
    led,
    controls,
    patterns,
    startupPatternId,
  });
}

export function makeCardRuntimePackage(options = {}) {
  return {
    app: 'Lightweaver',
    format: 'lightweaver-card-runtime-package',
    version: 1,
    config: buildCardRuntimeConfig(options),
  };
}

function normalizeLed(led = {}) {
  const outputs = Array.isArray(led.outputs) && led.outputs.length
    ? led.outputs
    : DEFAULT_CARD_LED.outputs;
  const normalizedOutputs = outputs
    .slice(0, 4)
    .map((output, index) => ({
      id: sanitizeId(output.id || `out${index + 1}`),
      name: String(output.name || `Output ${index + 1}`),
      pin: clampInt(output.pin, [16, 17, 18, 21][index] || 16, 0, 48),
      pixels: clampInt(output.pixels, DEFAULT_CARD_LED.pixels, 1, 2048),
    }));
  const pixels = clampInt(
    led.pixels,
    normalizedOutputs.reduce((sum, output) => sum + output.pixels, 0),
    1,
    4096,
  );
  return {
    pixels,
    outputs: normalizedOutputs,
    colorOrder: normalizeColorOrder(led.colorOrder),
    brightnessLimit: clampUnit(led.brightnessLimit ?? DEFAULT_CARD_LED.brightnessLimit),
  };
}

function normalizeControls(controls = {}) {
  const encoder = controls.encoder || {};
  return {
    encoder: {
      ...DEFAULT_CARD_CONTROLS.encoder,
      ...encoder,
      a: clampInt(encoder.a, DEFAULT_CARD_CONTROLS.encoder.a, 0, 48),
      b: clampInt(encoder.b, DEFAULT_CARD_CONTROLS.encoder.b, 0, 48),
      press: clampInt(encoder.press, DEFAULT_CARD_CONTROLS.encoder.press, 0, 48),
      alternatePress: clampInt(encoder.alternatePress, DEFAULT_CARD_CONTROLS.encoder.alternatePress, -1, 48),
      rotateDirection: encoder.rotateDirection === 'clockwise-dimmer'
        ? 'clockwise-dimmer'
        : 'clockwise-brighter',
      brightnessStep: clampInt(encoder.brightnessStep, DEFAULT_CARD_CONTROLS.encoder.brightnessStep, 1, 64),
      patternCycleIds: normalizePatternIds(encoder.patternCycleIds).length
        ? normalizePatternIds(encoder.patternCycleIds)
        : DEFAULT_CARD_CONTROLS.encoder.patternCycleIds,
    },
    previous: clampInt(controls.previous, DEFAULT_CARD_CONTROLS.previous, -1, 48),
    next: clampInt(controls.next, DEFAULT_CARD_CONTROLS.next, -1, 48),
    blackout: clampInt(controls.blackout, DEFAULT_CARD_CONTROLS.blackout, -1, 48),
    brightness: clampInt(controls.brightness, DEFAULT_CARD_CONTROLS.brightness, -1, 48),
    statusLed: clampInt(controls.statusLed, DEFAULT_CARD_CONTROLS.statusLed, -1, 48),
  };
}

function normalizePatterns(patterns = DEFAULT_CARD_PATTERN_BANK) {
  const input = Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_CARD_PATTERN_BANK;
  return input.map((pattern, index) => {
    const id = sanitizeId(pattern.id || `pattern-${index + 1}`);
    return {
      id,
      label: String(pattern.label || titleFromId(id)),
      mode: pattern.mode === 'preset' ? 'preset' : 'procedural',
    };
  });
}

function normalizePatternIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map(id => sanitizeId(id))
    .filter(Boolean))];
}

function normalizeColorOrder(value = 'RGB') {
  const upper = String(value || '').trim().toUpperCase();
  return ['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR'].includes(upper) ? upper : 'RGB';
}

function clampUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CARD_LED.brightnessLimit;
  return Math.max(0, Math.min(1, number));
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function sanitizeId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleFromId(id = '') {
  return String(id || '')
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
```

- [ ] **Step 4: Add test command to `package.json`**

Modify `lightweaver/package.json` so `test:core` includes the new test before `standalone-package-unpack` work:

```json
"test:core": "node tests/project-frame-audit.mjs && node tests/wled-control-contract.mjs && node tests/rotary-pattern-cycle.mjs && node tests/usb-rotary-input.mjs && node tests/preview-fallback-strip.mjs && node tests/control-scale.mjs && node tests/pattern-targeting.mjs && node tests/usb-led-frame.mjs && node tests/usb-led-color-order.mjs && node tests/usb-led-status-polling.mjs && node tests/usb-led-controller.mjs && node tests/usb-led-config.mjs && node tests/card-runtime-contract.mjs"
```

- [ ] **Step 5: Verify**

Run:

```bash
cd lightweaver
node tests/card-runtime-contract.mjs
npm run test:core
```

Expected:

```text
card-runtime-contract tests passed
```

and `npm run test:core` exits `0`.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/cardRuntimeContract.js lightweaver/tests/card-runtime-contract.mjs lightweaver/package.json
git commit -m "feat: define Lightweaver card runtime contract"
```

---

## Task 2: Firmware Module Split Without Behavior Change

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverTypes.h`
- Modify: `firmware/lightweaver-controller/src/main.cpp`

- [ ] **Step 1: Create shared firmware types**

Create `firmware/lightweaver-controller/src/LightweaverTypes.h`:

```cpp
#pragma once

#include <Arduino.h>
#include <FastLED.h>
#include <SD.h>

#ifndef LW_MAX_PIXELS
#define LW_MAX_PIXELS 1024
#endif

constexpr uint8_t LW_MAX_OUTPUTS = 4;
constexpr uint8_t LW_MAX_LOOKS = 12;
constexpr uint8_t LW_MAX_PATTERN_IDS = 12;
constexpr uint16_t LWSEQ_HEADER_BYTES = 64;
constexpr uint8_t DEFAULT_STATUS_LED_PIN = 2;
constexpr uint16_t DEFAULT_RENDER_FPS = 30;
constexpr uint16_t BUTTON_DEBOUNCE_MS = 180;

enum ErrorCode : uint8_t {
  ERROR_NONE = 0,
  ERROR_SD = 1,
  ERROR_PROFILE = 2,
  ERROR_PIXELS = 3,
  ERROR_PIN = 4,
  ERROR_SEQUENCE = 5,
  ERROR_CONFIG = 6
};

enum RuntimeSource : uint8_t {
  SOURCE_DEFAULTS = 0,
  SOURCE_NVS = 1,
  SOURCE_SD = 2
};

struct OutputConfig {
  String id;
  String name;
  uint8_t pin = 0;
  uint16_t pixels = 0;
  uint16_t start = 0;
  bool enabled = false;
};

struct ControlsConfig {
  int encoderA = 4;
  int encoderB = 5;
  int encoderPress = 0;
  int encoderPressAlt = 6;
  int previous = 7;
  int next = 8;
  int blackout = 9;
  int brightness = -1;
  int statusLed = DEFAULT_STATUS_LED_PIN;
  String rotateDirection = "clockwise-brighter";
  uint8_t brightnessStep = 18;
};

struct LookConfig {
  String id;
  String label;
  String mode;
  String file;
  String preset;
  uint16_t fps = 24;
  bool loop = true;
  uint16_t fadeOutMs = 320;
  uint16_t fadeInMs = 420;
  float brightness = 0.65f;
};

struct RuntimeConfig {
  String mode = "factory-flash";
  RuntimeSource source = SOURCE_DEFAULTS;
  String pieceName = "Lightweaver";
  String startupLookId = "aurora";
  String ledColorOrder = "RGB";
  float brightnessLimit = 0.65f;
  OutputConfig outputs[LW_MAX_OUTPUTS];
  uint8_t outputCount = 0;
  LookConfig looks[LW_MAX_LOOKS];
  uint8_t lookCount = 0;
  ControlsConfig controls;
};
```

- [ ] **Step 2: Update `main.cpp` to include shared types**

In `firmware/lightweaver-controller/src/main.cpp`, include the new header:

```cpp
#include "LightweaverTypes.h"
```

Remove the duplicate local definitions that now live in `LightweaverTypes.h`:
- `MAX_OUTPUTS`
- `MAX_LOOKS`
- `LWSEQ_HEADER_BYTES`
- `DEFAULT_STATUS_LED_PIN`
- `DEFAULT_RENDER_FPS`
- `BUTTON_DEBOUNCE_MS`
- `ErrorCode`
- `OutputConfig`
- `ControlsConfig`
- `LookConfig`

Replace remaining `MAX_OUTPUTS` references with `LW_MAX_OUTPUTS`.
Replace remaining `MAX_LOOKS` references with `LW_MAX_LOOKS`.

- [ ] **Step 3: Build firmware**

Run:

```bash
cd firmware/lightweaver-controller
pio run
```

Expected:

```text
SUCCESS
```

- [ ] **Step 4: Commit**

```bash
git add firmware/lightweaver-controller/src/LightweaverTypes.h firmware/lightweaver-controller/src/main.cpp
git commit -m "refactor: extract Lightweaver firmware runtime types"
```

---

## Task 3: Firmware Storage And Boot Priority

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverStorage.h`
- Create: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`

- [ ] **Step 1: Create storage API header**

Create `firmware/lightweaver-controller/src/LightweaverStorage.h`:

```cpp
#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <SD.h>
#include "LightweaverTypes.h"

struct RuntimeLoadResult {
  bool ok = false;
  RuntimeSource source = SOURCE_DEFAULTS;
  String message;
};

void applyDefaultRuntimeConfig(RuntimeConfig& config);
RuntimeLoadResult loadRuntimeConfig(RuntimeConfig& config);
bool saveRuntimeConfigJson(const String& json, RuntimeConfig& config, String& message);
String runtimeStatusJson(const RuntimeConfig& config, ErrorCode errorCode, uint16_t totalPixels, uint8_t currentLookIndex);
```

- [ ] **Step 2: Implement default, NVS, and SD loading**

Create `firmware/lightweaver-controller/src/LightweaverStorage.cpp`:

```cpp
#include "LightweaverStorage.h"

namespace {
constexpr const char* NVS_NAMESPACE = "lightweaver";
constexpr const char* NVS_CONFIG_KEY = "config";

uint16_t clampPixels(int value) {
  if (value < 1) return 1;
  if (value > LW_MAX_PIXELS) return LW_MAX_PIXELS;
  return static_cast<uint16_t>(value);
}

float clampUnit(float value) {
  if (value < 0.0f) return 0.0f;
  if (value > 1.0f) return 1.0f;
  return value;
}

void resetConfig(RuntimeConfig& config) {
  config = RuntimeConfig();
}

void applyJsonToConfig(JsonDocument& doc, RuntimeConfig& config, RuntimeSource source) {
  resetConfig(config);
  config.source = source;
  config.mode = String(doc["mode"] | (source == SOURCE_SD ? "sd-sequence" : "website-flash"));
  config.pieceName = String(doc["piece"]["name"] | "Lightweaver");
  config.startupLookId = String(doc["startupPatternId"] | doc["startupLook"] | "aurora");

  JsonObject led = doc["led"].as<JsonObject>();
  config.ledColorOrder = String(led["colorOrder"] | "RGB");
  config.brightnessLimit = clampUnit(led["brightnessLimit"] | 0.65f);

  JsonObject controlsJson = doc["controls"].as<JsonObject>();
  JsonObject encoder = controlsJson["encoder"].as<JsonObject>();
  config.controls.encoderA = encoder["a"] | 4;
  config.controls.encoderB = encoder["b"] | 5;
  config.controls.encoderPress = encoder["press"] | 0;
  config.controls.encoderPressAlt = encoder["alternatePress"] | 6;
  config.controls.rotateDirection = String(encoder["rotateDirection"] | "clockwise-brighter");
  config.controls.brightnessStep = encoder["brightnessStep"] | 18;
  config.controls.previous = controlsJson["previous"] | 7;
  config.controls.next = controlsJson["next"] | 8;
  config.controls.blackout = controlsJson["blackout"] | 9;
  config.controls.brightness = controlsJson["brightness"] | -1;
  config.controls.statusLed = controlsJson["statusLed"] | DEFAULT_STATUS_LED_PIN;

  uint16_t totalPixels = 0;
  JsonArray outputs = doc["led"]["outputs"].as<JsonArray>();
  if (outputs.isNull()) outputs = doc["outputs"].as<JsonArray>();
  for (JsonVariant outputValue : outputs) {
    if (config.outputCount >= LW_MAX_OUTPUTS) break;
    JsonObject output = outputValue.as<JsonObject>();
    int pixels = output["pixels"] | 0;
    if (pixels <= 0) continue;
    OutputConfig& next = config.outputs[config.outputCount];
    next.id = String(output["id"] | "");
    next.name = String(output["name"] | next.id.c_str());
    next.pin = output["pin"] | 16;
    next.pixels = clampPixels(pixels);
    next.start = totalPixels;
    next.enabled = true;
    totalPixels += next.pixels;
    config.outputCount++;
  }

  JsonArray looks = doc["looks"].as<JsonArray>();
  if (looks.isNull()) looks = doc["patterns"].as<JsonArray>();
  for (JsonVariant lookValue : looks) {
    if (config.lookCount >= LW_MAX_LOOKS) break;
    JsonObject lookJson = lookValue.as<JsonObject>();
    LookConfig& look = config.looks[config.lookCount];
    look.id = String(lookJson["id"] | "look");
    look.label = String(lookJson["label"] | look.id.c_str());
    look.mode = String(lookJson["mode"] | (config.mode == "sd-sequence" ? "sequence" : "procedural"));
    look.file = String(lookJson["file"] | "");
    look.preset = String(lookJson["preset"] | look.id.c_str());
    look.fps = lookJson["fps"] | 24;
    look.loop = lookJson["loop"] | true;
    look.fadeOutMs = lookJson["fadeOutMs"] | 320;
    look.fadeInMs = lookJson["fadeInMs"] | 420;
    look.brightness = clampUnit(lookJson["brightness"] | 0.65f);
    config.lookCount++;
  }
}

bool loadJsonString(const String& json, RuntimeConfig& config, RuntimeSource source, String& message) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, json);
  if (error) {
    message = String("json parse failed: ") + error.c_str();
    return false;
  }
  applyJsonToConfig(doc, config, source);
  if (config.outputCount == 0 || config.lookCount == 0) {
    message = "config missing outputs or looks";
    return false;
  }
  message = "config loaded";
  return true;
}

bool loadSdConfig(RuntimeConfig& config, String& message) {
  if (!SD.begin(LW_SD_CS)) {
    message = "sd unavailable";
    return false;
  }
  File profileFile = SD.open("/lightweaver.json", FILE_READ);
  if (!profileFile) {
    message = "sd missing /lightweaver.json";
    return false;
  }
  String json = profileFile.readString();
  profileFile.close();
  return loadJsonString(json, config, SOURCE_SD, message);
}

bool loadNvsConfig(RuntimeConfig& config, String& message) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, true)) {
    message = "nvs unavailable";
    return false;
  }
  String json = prefs.getString(NVS_CONFIG_KEY, "");
  prefs.end();
  if (!json.length()) {
    message = "nvs empty";
    return false;
  }
  return loadJsonString(json, config, SOURCE_NVS, message);
}
}

void applyDefaultRuntimeConfig(RuntimeConfig& config) {
  resetConfig(config);
  config.source = SOURCE_DEFAULTS;
  config.mode = "factory-flash";
  config.pieceName = "Lightweaver";
  config.startupLookId = "aurora";
  config.ledColorOrder = "RGB";
  config.brightnessLimit = 0.65f;
  config.outputCount = 1;
  config.outputs[0].id = "out1";
  config.outputs[0].name = "Output 1";
  config.outputs[0].pin = 16;
  config.outputs[0].pixels = 44;
  config.outputs[0].start = 0;
  config.outputs[0].enabled = true;

  const char* ids[] = {"aurora", "ember", "rainbow", "breathe", "scanner", "warm-white"};
  const char* modes[] = {"procedural", "procedural", "procedural", "procedural", "procedural", "preset"};
  for (uint8_t i = 0; i < 6; i++) {
    config.looks[i].id = ids[i];
    config.looks[i].label = ids[i];
    config.looks[i].mode = modes[i];
    config.looks[i].preset = ids[i];
    config.looks[i].brightness = 0.65f;
  }
  config.lookCount = 6;
}

RuntimeLoadResult loadRuntimeConfig(RuntimeConfig& config) {
  String message;
  if (loadSdConfig(config, message)) {
    return { true, SOURCE_SD, message };
  }
  if (loadNvsConfig(config, message)) {
    return { true, SOURCE_NVS, message };
  }
  applyDefaultRuntimeConfig(config);
  return { true, SOURCE_DEFAULTS, "compiled defaults loaded" };
}

bool saveRuntimeConfigJson(const String& json, RuntimeConfig& config, String& message) {
  RuntimeConfig parsed;
  if (!loadJsonString(json, parsed, SOURCE_NVS, message)) return false;
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    message = "nvs write open failed";
    return false;
  }
  bool ok = prefs.putString(NVS_CONFIG_KEY, json) > 0;
  prefs.end();
  if (!ok) {
    message = "nvs write failed";
    return false;
  }
  config = parsed;
  message = "saved to internal flash";
  return true;
}

String runtimeStatusJson(const RuntimeConfig& config, ErrorCode errorCode, uint16_t totalPixels, uint8_t currentLookIndex) {
  JsonDocument doc;
  doc["ok"] = errorCode == ERROR_NONE;
  doc["errorCode"] = uint8_t(errorCode);
  doc["mode"] = config.mode;
  doc["source"] = config.source == SOURCE_SD ? "sd" : config.source == SOURCE_NVS ? "internal-flash" : "defaults";
  doc["piece"]["name"] = config.pieceName;
  doc["led"]["pixels"] = totalPixels;
  doc["led"]["colorOrder"] = config.ledColorOrder;
  doc["currentLookIndex"] = currentLookIndex;
  doc["currentLookId"] = config.lookCount ? config.looks[currentLookIndex].id : "";
  String output;
  serializeJson(doc, output);
  return output;
}
```

- [ ] **Step 3: Modify `main.cpp` boot flow**

In `firmware/lightweaver-controller/src/main.cpp`:

1. Include storage:

```cpp
#include "LightweaverStorage.h"
```

2. Add a global runtime config:

```cpp
RuntimeConfig runtimeConfig;
```

3. Replace the hard SD boot block:

```cpp
SPI.begin(LW_SPI_SCK, LW_SPI_MISO, LW_SPI_MOSI, LW_SD_CS);
if (!SD.begin(LW_SD_CS, SPI)) {
  fail(ERROR_SD, "microSD mount failed");
  return;
}

if (!loadProfile()) return;
```

with:

```cpp
SPI.begin(LW_SPI_SCK, LW_SPI_MISO, LW_SPI_MOSI, LW_SD_CS);
RuntimeLoadResult loadResult = loadRuntimeConfig(runtimeConfig);
Serial.print("Runtime source: ");
Serial.print(loadResult.source == SOURCE_SD ? "sd" : loadResult.source == SOURCE_NVS ? "internal-flash" : "defaults");
Serial.print(" / ");
Serial.println(loadResult.message);
if (!loadResult.ok) {
  fail(ERROR_CONFIG, loadResult.message.c_str());
  return;
}
applyRuntimeConfig(runtimeConfig);
```

4. Add this helper in `main.cpp` near `loadProfile()` and migrate existing globals from `runtimeConfig`:

```cpp
void applyRuntimeConfig(const RuntimeConfig& config) {
  pieceName = config.pieceName;
  runtimeMode = config.mode;
  startupLookId = config.startupLookId;
  ledColorOrder = config.ledColorOrder;
  brightnessLimit = config.brightnessLimit;
  outputCount = config.outputCount;
  totalPixels = 0;
  for (uint8_t i = 0; i < outputCount; i++) {
    outputs[i] = config.outputs[i];
    totalPixels += outputs[i].pixels;
  }
  controls = config.controls;
  lookCount = config.lookCount;
  for (uint8_t i = 0; i < lookCount; i++) {
    looks[i] = config.looks[i];
  }
}
```

5. Leave the old `loadProfile()` function in place until the build is green, then remove it in the same commit if unused.

- [ ] **Step 4: Build firmware**

Run:

```bash
cd firmware/lightweaver-controller
pio run
```

Expected:

```text
SUCCESS
```

- [ ] **Step 5: Commit**

```bash
git add firmware/lightweaver-controller/src/LightweaverStorage.h firmware/lightweaver-controller/src/LightweaverStorage.cpp firmware/lightweaver-controller/src/main.cpp
git commit -m "feat: boot Lightweaver controller from SD, flash, or defaults"
```

---

## Task 4: Firmware Pattern Bank And Rotary Behavior

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverPatterns.h`
- Create: `firmware/lightweaver-controller/src/LightweaverPatterns.cpp`
- Create: `firmware/lightweaver-controller/src/LightweaverControls.h`
- Create: `firmware/lightweaver-controller/src/LightweaverControls.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`

- [ ] **Step 1: Create pattern renderer module**

Create `firmware/lightweaver-controller/src/LightweaverPatterns.h`:

```cpp
#pragma once

#include <Arduino.h>
#include <FastLED.h>
#include "LightweaverTypes.h"

bool renderProceduralPattern(const String& preset, CRGB* leds, uint16_t totalPixels, uint32_t now);
bool renderPresetPattern(const String& preset, CRGB* leds, uint16_t totalPixels);
```

Create `firmware/lightweaver-controller/src/LightweaverPatterns.cpp`:

```cpp
#include "LightweaverPatterns.h"

bool renderProceduralPattern(const String& preset, CRGB* leds, uint16_t totalPixels, uint32_t now) {
  for (uint16_t i = 0; i < totalPixels; i++) {
    if (preset == "ember") {
      uint8_t flicker = inoise8(i * 18, now / 7);
      CRGB color = CRGB(190, 48, 8);
      color.nscale8(120 + (flicker / 2));
      leds[i] = color;
    } else if (preset == "rainbow") {
      leds[i] = CHSV((i * 4 + now / 22) & 0xff, 190, 220);
    } else if (preset == "breathe") {
      uint8_t level = beatsin8(12, 45, 190);
      leds[i] = CHSV(32, 90, level);
    } else if (preset == "scanner") {
      uint16_t head = (now / 28) % max<uint16_t>(1, totalPixels);
      uint16_t distance = abs(int(i) - int(head));
      uint8_t level = distance > 8 ? 0 : 220 - (distance * 24);
      leds[i] = CRGB(level, level / 3, 12);
    } else {
      uint8_t wave = sin8(i * 6 + now / 18);
      uint8_t hue = 118 + (wave / 5);
      leds[i] = CHSV(hue, 135 + (wave / 5), 120 + (wave / 3));
    }
  }
  return true;
}

bool renderPresetPattern(const String& preset, CRGB* leds, uint16_t totalPixels) {
  CRGB color = CRGB(255, 170, 92);
  if (preset == "blackout" || preset == "off") color = CRGB::Black;
  else if (preset == "test-red" || preset == "red") color = CRGB::Red;
  else if (preset == "test-green" || preset == "green") color = CRGB::Green;
  else if (preset == "test-blue" || preset == "blue") color = CRGB::Blue;
  else if (preset == "cool-white") color = CRGB(190, 210, 255);
  else if (preset == "photo-white") color = CRGB(255, 238, 210);
  fill_solid(leds, totalPixels, color);
  return true;
}
```

- [ ] **Step 2: Create controls module**

Create `firmware/lightweaver-controller/src/LightweaverControls.h`:

```cpp
#pragma once

#include <Arduino.h>
#include "LightweaverTypes.h"

struct ControlState {
  bool prevDown = false;
  bool nextDown = false;
  bool pressDown = false;
  bool pressAltDown = false;
  bool blackoutDown = false;
  uint32_t lastPrevAt = 0;
  uint32_t lastNextAt = 0;
  uint32_t lastPressAt = 0;
  uint32_t lastPressAltAt = 0;
  uint32_t lastBlackoutAt = 0;
  uint8_t encoderLastState = 0;
  int8_t encoderDelta = 0;
};

enum ControlEventType : uint8_t {
  CONTROL_NONE = 0,
  CONTROL_NEXT_LOOK = 1,
  CONTROL_PREVIOUS_LOOK = 2,
  CONTROL_BLACKOUT = 3,
  CONTROL_BRIGHTER = 4,
  CONTROL_DIMMER = 5
};

void setupLightweaverControls(const ControlsConfig& controls, ControlState& state);
ControlEventType pollLightweaverControls(const ControlsConfig& controls, ControlState& state);
float applyRotaryBrightness(float currentBrightness, ControlEventType event, uint8_t step);
```

Create `firmware/lightweaver-controller/src/LightweaverControls.cpp`:

```cpp
#include "LightweaverControls.h"

namespace {
bool validPin(int pin) {
  return pin >= 0;
}

bool buttonPressed(int pin, bool& wasDown, uint32_t& lastAt) {
  if (!validPin(pin)) return false;
  bool isDown = digitalRead(pin) == LOW;
  uint32_t now = millis();
  bool pressed = isDown && !wasDown && now - lastAt > BUTTON_DEBOUNCE_MS;
  wasDown = isDown;
  if (pressed) lastAt = now;
  return pressed;
}

uint8_t readEncoderState(const ControlsConfig& controls) {
  uint8_t a = digitalRead(controls.encoderA) == LOW ? 1 : 0;
  uint8_t b = digitalRead(controls.encoderB) == LOW ? 1 : 0;
  return static_cast<uint8_t>((a << 1) | b);
}

int8_t quadratureDelta(uint8_t previous, uint8_t current) {
  switch ((previous << 2) | current) {
    case 0b0001:
    case 0b0111:
    case 0b1110:
    case 0b1000:
      return 1;
    case 0b0010:
    case 0b1011:
    case 0b1101:
    case 0b0100:
      return -1;
    default:
      return 0;
  }
}
}

void setupLightweaverControls(const ControlsConfig& controls, ControlState& state) {
  if (validPin(controls.statusLed)) pinMode(controls.statusLed, OUTPUT);
  if (validPin(controls.encoderA)) pinMode(controls.encoderA, INPUT_PULLUP);
  if (validPin(controls.encoderB)) pinMode(controls.encoderB, INPUT_PULLUP);
  if (validPin(controls.encoderPress)) pinMode(controls.encoderPress, INPUT_PULLUP);
  if (validPin(controls.encoderPressAlt)) pinMode(controls.encoderPressAlt, INPUT_PULLUP);
  if (validPin(controls.previous)) pinMode(controls.previous, INPUT_PULLUP);
  if (validPin(controls.next)) pinMode(controls.next, INPUT_PULLUP);
  if (validPin(controls.blackout)) pinMode(controls.blackout, INPUT_PULLUP);
  state.encoderLastState = readEncoderState(controls);
}

ControlEventType pollLightweaverControls(const ControlsConfig& controls, ControlState& state) {
  if (buttonPressed(controls.next, state.nextDown, state.lastNextAt) ||
      buttonPressed(controls.encoderPress, state.pressDown, state.lastPressAt) ||
      buttonPressed(controls.encoderPressAlt, state.pressAltDown, state.lastPressAltAt)) {
    return CONTROL_NEXT_LOOK;
  }

  if (buttonPressed(controls.previous, state.prevDown, state.lastPrevAt)) {
    return CONTROL_PREVIOUS_LOOK;
  }

  if (buttonPressed(controls.blackout, state.blackoutDown, state.lastBlackoutAt)) {
    return CONTROL_BLACKOUT;
  }

  uint8_t nextState = readEncoderState(controls);
  if (nextState != state.encoderLastState) {
    int8_t delta = quadratureDelta(state.encoderLastState, nextState);
    state.encoderLastState = nextState;
    if (delta != 0) {
      state.encoderDelta += delta;
      if (state.encoderDelta >= 4) {
        state.encoderDelta = 0;
        return controls.rotateDirection == "clockwise-dimmer" ? CONTROL_DIMMER : CONTROL_BRIGHTER;
      }
      if (state.encoderDelta <= -4) {
        state.encoderDelta = 0;
        return controls.rotateDirection == "clockwise-dimmer" ? CONTROL_BRIGHTER : CONTROL_DIMMER;
      }
    }
  }

  return CONTROL_NONE;
}

float applyRotaryBrightness(float currentBrightness, ControlEventType event, uint8_t step) {
  float amount = float(step) / 255.0f;
  if (event == CONTROL_DIMMER) return max(0.02f, currentBrightness - amount);
  if (event == CONTROL_BRIGHTER) return min(1.0f, currentBrightness + amount);
  return currentBrightness;
}
```

- [ ] **Step 3: Wire modules into `main.cpp`**

In `main.cpp`:

1. Include:

```cpp
#include "LightweaverPatterns.h"
#include "LightweaverControls.h"
```

2. Add global state:

```cpp
ControlState controlState;
float manualBrightness = 1.0f;
```

3. Replace `setupControlPins();` with:

```cpp
setupLightweaverControls(controls, controlState);
```

4. Replace `handleControls();` in `loop()` with:

```cpp
handleControlEvent(pollLightweaverControls(controls, controlState));
```

5. Add:

```cpp
void handleControlEvent(ControlEventType event) {
  if (event == CONTROL_NEXT_LOOK) {
    selectLook(currentLookIndex + 1);
  } else if (event == CONTROL_PREVIOUS_LOOK) {
    selectLook(currentLookIndex == 0 ? lookCount - 1 : currentLookIndex - 1);
  } else if (event == CONTROL_BLACKOUT) {
    if (blackedOut) {
      blackedOut = false;
      fadeTo(1.0f, looks[currentLookIndex].fadeInMs);
    } else {
      fadeTo(0.0f, looks[currentLookIndex].fadeOutMs);
      FastLED.clear(true);
      blackedOut = true;
    }
  } else if (event == CONTROL_BRIGHTER || event == CONTROL_DIMMER) {
    manualBrightness = applyRotaryBrightness(manualBrightness, event, controls.brightnessStep);
  }
}
```

6. Replace the body of old `renderProceduralFrame()` with:

```cpp
return renderProceduralPattern(preset, leds, totalPixels, millis());
```

7. Replace the body of old `renderPresetFrame()` with:

```cpp
return renderPresetPattern(preset, leds, totalPixels);
```

8. In `computeBrightnessByte()`, multiply by `manualBrightness`:

```cpp
float brightness = clampUnit(brightnessLimit) * clampUnit(lookBrightness) * clampUnit(fadeScale) * readBrightnessKnob() * clampUnit(manualBrightness);
```

9. Remove old encoder-A-only rotation logic from `handleControls()` after the new event path is wired.

- [ ] **Step 4: Build firmware**

Run:

```bash
cd firmware/lightweaver-controller
pio run
```

Expected:

```text
SUCCESS
```

- [ ] **Step 5: Commit**

```bash
git add firmware/lightweaver-controller/src/LightweaverPatterns.h firmware/lightweaver-controller/src/LightweaverPatterns.cpp firmware/lightweaver-controller/src/LightweaverControls.h firmware/lightweaver-controller/src/LightweaverControls.cpp firmware/lightweaver-controller/src/main.cpp
git commit -m "feat: run Lightweaver patterns and rotary controls on chip"
```

---

## Task 5: Firmware Web/API Installer

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverWeb.h`
- Create: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`

- [ ] **Step 1: Create web API header**

Create `firmware/lightweaver-controller/src/LightweaverWeb.h`:

```cpp
#pragma once

#include <Arduino.h>
#include <WebServer.h>
#include "LightweaverTypes.h"
#include "LightweaverStorage.h"

void setupLightweaverWeb(RuntimeConfig& config, ErrorCode& errorCode, uint16_t& totalPixels, uint8_t& currentLookIndex);
void handleLightweaverWeb();
```

- [ ] **Step 2: Implement web API**

Create `firmware/lightweaver-controller/src/LightweaverWeb.cpp`:

```cpp
#include "LightweaverWeb.h"
#include <WiFi.h>

namespace {
WebServer server(80);
RuntimeConfig* runtimeConfigPtr = nullptr;
ErrorCode* errorCodePtr = nullptr;
uint16_t* totalPixelsPtr = nullptr;
uint8_t* currentLookIndexPtr = nullptr;

String apSsid() {
  uint64_t mac = ESP.getEfuseMac();
  char suffix[5];
  snprintf(suffix, sizeof(suffix), "%04X", uint16_t(mac & 0xffff));
  return String("Lightweaver-") + suffix;
}

void sendCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

void handleOptions() {
  sendCors();
  server.send(204, "text/plain", "");
}

void handleRoot() {
  sendCors();
  server.send(200, "text/html",
    "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>Lightweaver Card</title>"
    "<body style='font-family:system-ui;margin:24px;background:#090909;color:#f7f3ea'>"
    "<h1>Lightweaver Card</h1>"
    "<p>This card is running on ESP32 internal playback.</p>"
    "<p>Paste a Lightweaver internal flash card config JSON, then save it to this card.</p>"
    "<textarea id='cfg' style='width:100%;min-height:220px;background:#111;color:#f7f3ea;border:1px solid #555'></textarea>"
    "<button id='save' style='display:block;margin-top:12px;padding:12px 16px'>Save to card</button>"
    "<pre id='out'></pre>"
    "<script>"
    "save.onclick=async()=>{out.textContent='Saving...';"
    "const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:cfg.value});"
    "out.textContent=await r.text();};"
    "fetch('/api/status').then(r=>r.text()).then(t=>out.textContent=t);"
    "</script>"
    "</body>");
}

void handleStatus() {
  sendCors();
  server.send(200, "application/json", runtimeStatusJson(
    *runtimeConfigPtr,
    *errorCodePtr,
    *totalPixelsPtr,
    *currentLookIndexPtr
  ));
}

void handleConfigPost() {
  sendCors();
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"ok\":false,\"error\":\"missing json body\"}");
    return;
  }
  String message;
  bool ok = saveRuntimeConfigJson(server.arg("plain"), *runtimeConfigPtr, message);
  if (!ok) {
    server.send(400, "application/json", String("{\"ok\":false,\"error\":\"") + message + "\"}");
    return;
  }
  server.send(200, "application/json", String("{\"ok\":true,\"message\":\"") + message + "\"}");
}

void handleReboot() {
  sendCors();
  server.send(200, "application/json", "{\"ok\":true,\"message\":\"rebooting\"}");
  delay(150);
  ESP.restart();
}
}

void setupLightweaverWeb(RuntimeConfig& config, ErrorCode& errorCode, uint16_t& totalPixels, uint8_t& currentLookIndex) {
  runtimeConfigPtr = &config;
  errorCodePtr = &errorCode;
  totalPixelsPtr = &totalPixels;
  currentLookIndexPtr = &currentLookIndex;

  WiFi.mode(WIFI_AP);
  String ssid = apSsid();
  WiFi.softAP(ssid.c_str());
  Serial.print("Lightweaver AP: ");
  Serial.print(ssid);
  Serial.print(" / ");
  Serial.println(WiFi.softAPIP());

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/config", HTTP_OPTIONS, handleOptions);
  server.on("/api/config", HTTP_POST, handleConfigPost);
  server.on("/api/reboot", HTTP_OPTIONS, handleOptions);
  server.on("/api/reboot", HTTP_POST, handleReboot);
  server.begin();
}

void handleLightweaverWeb() {
  server.handleClient();
}
```

- [ ] **Step 3: Wire web API into `main.cpp`**

In `main.cpp`:

1. Include:

```cpp
#include "LightweaverWeb.h"
```

2. After runtime config is applied and controls are set up, call:

```cpp
setupLightweaverWeb(runtimeConfig, errorCode, totalPixels, currentLookIndex);
```

3. At the start of `loop()`, before control handling, call:

```cpp
handleLightweaverWeb();
```

- [ ] **Step 4: Build firmware**

Run:

```bash
cd firmware/lightweaver-controller
pio run
```

Expected:

```text
SUCCESS
```

- [ ] **Step 5: Bench smoke test**

After uploading to ESP32, open serial monitor:

```bash
cd firmware/lightweaver-controller
pio run --target upload --upload-port /dev/cu.usbmodem5B5E0414831
pio device monitor --port /dev/cu.usbmodem5B5E0414831 --baud 115200
```

Expected serial lines:

```text
Runtime source: defaults / compiled defaults loaded
Lightweaver AP: Lightweaver-....
Ready: Lightweaver / 44 pixels
```

- [ ] **Step 6: Commit**

```bash
git add firmware/lightweaver-controller/src/LightweaverWeb.h firmware/lightweaver-controller/src/LightweaverWeb.cpp firmware/lightweaver-controller/src/main.cpp
git commit -m "feat: host Lightweaver card setup API on ESP32"
```

---

## Task 6: Website Card Installer Package

**Files:**
- Create: `lightweaver/tests/card-installer-package.mjs`
- Modify: `lightweaver/src/components/ExportDialog.jsx`
- Modify: `lightweaver/src/components/DevicesPanel.jsx`
- Modify: `lightweaver/package.json`

- [ ] **Step 1: Write package integration test**

Create `lightweaver/tests/card-installer-package.mjs`:

```js
import assert from 'node:assert/strict';
import { makeCardRuntimePackage } from '../src/lib/cardRuntimeContract.js';

const pkg = makeCardRuntimePackage({
  projectName: 'Customer Piece',
  mode: 'website-flash',
  led: {
    pixels: 44,
    colorOrder: 'GRB',
    brightnessLimit: 0.5,
    outputs: [{ id: 'main', name: 'Main', pin: 16, pixels: 44 }],
  },
  controls: {
    encoder: {
      a: 4,
      b: 5,
      press: 0,
      alternatePress: 6,
      rotateDirection: 'clockwise-brighter',
      brightnessStep: 18,
      patternCycleIds: ['aurora', 'ember', 'scanner'],
    },
  },
});

const body = JSON.stringify(pkg.config);
assert.match(body, /"mode":"website-flash"/);
assert.match(body, /"patternCycleIds":\["aurora","ember","scanner"\]/);
assert.equal(pkg.config.led.outputs[0].pin, 16);
assert.equal(pkg.config.controls.encoder.press, 0);

console.log('card-installer-package tests passed');
```

- [ ] **Step 2: Run test to verify current package path**

Run:

```bash
cd lightweaver
node tests/card-installer-package.mjs
```

Expected after Task 1:

```text
card-installer-package tests passed
```

- [ ] **Step 3: Add `test:core` entry**

Append `node tests/card-installer-package.mjs` to `test:core` after `card-runtime-contract.mjs`.

- [ ] **Step 4: Update export target language**

In `lightweaver/src/components/ExportDialog.jsx`, change the standalone target labels so the UI distinguishes internal flash from SD:

```js
{ id: 'standalone', name: 'Lightweaver Card', sub: 'ESP32 internal flash or memory card package', tag: 'CARD', hw: 'ESP32-S3' },
```

Add a format option for internal flash package:

```js
{ id: 'cardconfig', name: 'Internal flash card config', sub: 'Saved by website to ESP32 flash', ext: '.json' },
```

When `target === 'standalone'`, allow:
- `cardconfig` for Mode 1/2.
- `lwpackage` and `lwseq` for Mode 3 SD.

Use `makeCardRuntimePackage()` for `cardconfig` downloads.

- [ ] **Step 5: Add Devices panel connection copy**

In `lightweaver/src/components/DevicesPanel.jsx`, add a small section near the existing controller installer UI:

```jsx
<Section title="Lightweaver Card">
  <p className="small">
    Connect to the card WiFi, then save this pattern order to ESP32 internal flash. The card keeps running after the website closes.
  </p>
  <button className="btn primary">Load to Card</button>
  <button className="btn">Prepare Memory Card</button>
</Section>
```

Wire `Load to Card` to POST the card config JSON to `http://192.168.4.1/api/config` first. Keep the existing USB preview path separate.

If the browser blocks the direct POST because the Lightweaver app is running from a public HTTPS origin, show the generated JSON and direct the installer to connect to `Lightweaver-XXXX`, open `http://192.168.4.1`, paste the JSON, and press "Save to card". Do not make the public website the only write path.

- [ ] **Step 6: Verify web tests and build**

Run:

```bash
cd lightweaver
npm run test:core
npm run build
```

Expected:

```text
card-installer-package tests passed
✓ built
```

- [ ] **Step 7: Commit**

```bash
git add lightweaver/src/components/ExportDialog.jsx lightweaver/src/components/DevicesPanel.jsx lightweaver/tests/card-installer-package.mjs lightweaver/package.json
git commit -m "feat: add Lightweaver card installer package flow"
```

---

## Task 7: SD Package Validation And Optional Advanced Playback

**Files:**
- Modify: `lightweaver/src/lib/standaloneController.js`
- Modify: `lightweaver/scripts/unpack-standalone-package.mjs`
- Modify: `lightweaver/tests/standalone-package-unpack.mjs`

- [ ] **Step 1: Extend SD package test for mode declaration**

Modify `lightweaver/tests/standalone-package-unpack.mjs` so the profile assertions include:

```js
assert.equal(profile.mode || profile.runtimeMode, 'sd-sequence');
assert.equal(profile.led.colorOrder, 'RGB');
assert.equal(profile.outputs[0].pin, 16);
```

- [ ] **Step 2: Update `makeStandalonePackage()` mode output**

In `lightweaver/src/lib/standaloneController.js`, when `mode === 'sequence'`, write both:

```js
runtimeMode: 'sd-sequence'
```

and keep legacy sequence look mode:

```js
looks: [{
  id: cleanFilename.replace(/\.[^.]+$/, ''),
  label: projectName,
  mode: 'sequence',
  file: filePath,
  fps,
  loop,
}]
```

This keeps the package explicit at the card-runtime level while preserving the firmware sequence renderer.

- [ ] **Step 3: Harden unpack script path validation**

In `lightweaver/scripts/unpack-standalone-package.mjs`, replace:

```js
if (!cleanPath || cleanPath.includes('..')) {
  throw new Error(`Unsafe package path: ${packageFilePath}`);
}
```

with:

```js
if (!cleanPath || cleanPath.includes('..') || cleanPath.startsWith('/') || cleanPath.startsWith('~')) {
  throw new Error(`Unsafe package path: ${packageFilePath}`);
}
```

- [ ] **Step 4: Verify**

Run:

```bash
cd lightweaver
node tests/standalone-package-unpack.mjs
npm run test:core
```

Expected:

```text
standalone-package-unpack passed
```

- [ ] **Step 5: Commit**

```bash
git add lightweaver/src/lib/standaloneController.js lightweaver/scripts/unpack-standalone-package.mjs lightweaver/tests/standalone-package-unpack.mjs
git commit -m "feat: mark memory card packages as SD sequence runtime"
```

---

## Task 8: Runtime Documentation And Customer Checklist

**Files:**
- Create: `docs/lightweaver-customer-runtime.md`
- Modify: `firmware/lightweaver-controller/README.md`

- [ ] **Step 1: Create customer runtime doc**

Create `docs/lightweaver-customer-runtime.md`:

````md
# Lightweaver Customer Runtime

Lightweaver customer pieces are designed so the ESP32 card owns playback. The website edits and loads the card; it is not required for normal playback.

## Mode 1: Factory Card

The ESP32 starts from internal flash with built-in patterns. No website, laptop, Pi, or memory card is required.

Customer behavior:
- Plug in power.
- The piece starts playing.
- Turn the rotary control to dim or brighten.
- Press the rotary control to move through the saved pattern order.

## Mode 2: Website Loads The Card

The customer or installer connects to the Lightweaver card WiFi and saves settings to internal flash.

Stored on the card:
- LED count and output pin mapping.
- Color order.
- Master brightness limit.
- Rotary brightness direction.
- Push-button pattern order.
- Selected built-in pattern bank.

After the website reports "Saved on card", the card can run by itself.

## Mode 3: Memory Card Advanced Sequence

A microSD card adds larger recorded frame sequences. The ESP32 still runs by itself.

Card contents:

```text
/lightweaver.json
/sequences/*.lwseq
```

Boot priority:
1. Valid memory card package.
2. Valid internal flash config.
3. Compiled factory defaults.

## Mode 4: Reserved Live Host

The live-host path is reserved for future laptop/Pi/Madrix/sound-reactive streaming. It is not required for customer playback in Modes 1-3.

## Bench Checklist

1. Flash the standalone Lightweaver controller firmware.
2. Boot with no SD card and confirm default pattern playback.
3. Turn the rotary control and confirm brightness changes.
4. Press the rotary control and confirm pattern cycling.
5. Connect to `Lightweaver-XXXX` WiFi.
6. Open `http://192.168.4.1/api/status` and confirm JSON status.
7. Save a website-flash config and reboot.
8. Confirm saved pattern order survives reboot.
9. Insert a prepared microSD package.
10. Reboot and confirm SD sequence playback.
11. Remove microSD and confirm internal flash fallback.
````

- [ ] **Step 2: Update firmware README**

Modify `firmware/lightweaver-controller/README.md` so the first paragraph says:

```md
Arduino/PlatformIO firmware for the sellable ESP32-S3 Lightweaver card. It does not require WLED, a Raspberry Pi, Madrix, a laptop, or live Art-Net at runtime. It boots from internal flash by default, can be configured from the Lightweaver website, and can optionally read advanced `.lwseq` frame packages from microSD.
```

Add a section:

```md
## Runtime Modes

1. Factory Card: internal flash defaults, no website or microSD.
2. Website Loaded Card: website saves config to ESP32 internal flash.
3. Memory Card Advanced: microSD provides `/lightweaver.json` and `.lwseq` sequences.
4. Live Host Reserved: laptop/Pi/Madrix/sound-reactive control is a future runtime lane.
```

- [ ] **Step 3: Commit**

```bash
git add docs/lightweaver-customer-runtime.md firmware/lightweaver-controller/README.md
git commit -m "docs: define Lightweaver customer runtime modes"
```

---

## Task 9: Full Integration Verification

**Files:**
- No source edits expected.
- If a verification command fails because of code, fix the owning task's files and commit under that task's scope.

- [ ] **Step 1: Run Lightweaver web tests**

```bash
cd lightweaver
npm run test:core
npm run build
```

Expected:

```text
card-runtime-contract tests passed
card-installer-package tests passed
✓ built
```

- [ ] **Step 2: Build standalone firmware**

```bash
cd firmware/lightweaver-controller
pio run
```

Expected:

```text
SUCCESS
```

- [ ] **Step 3: Flash bench card**

Use the currently detected ESP32 upload port:

```bash
cd firmware/lightweaver-controller
pio run --target upload --upload-port /dev/cu.usbmodem5B5E0414831
```

Expected:

```text
SUCCESS
```

- [ ] **Step 4: Monitor boot**

```bash
cd firmware/lightweaver-controller
pio device monitor --port /dev/cu.usbmodem5B5E0414831 --baud 115200
```

Expected lines:

```text
Runtime source: defaults / compiled defaults loaded
Lightweaver AP: Lightweaver-....
Ready: Lightweaver / 44 pixels
```

- [ ] **Step 5: Test HTTP status from card**

Connect the Mac to the ESP32 AP, then run:

```bash
curl -sS --max-time 3 http://192.168.4.1/api/status
```

Expected JSON shape:

```json
{"ok":true,"errorCode":0,"mode":"factory-flash","source":"defaults"}
```

- [ ] **Step 6: Test website-flash save**

Run:

```bash
curl -sS --max-time 5 -X POST -H 'Content-Type: application/json' \
  --data '{"version":1,"mode":"website-flash","piece":{"name":"Bench Piece"},"led":{"pixels":44,"outputs":[{"id":"out1","name":"Output 1","pin":16,"pixels":44}],"colorOrder":"RGB","brightnessLimit":0.65},"controls":{"encoder":{"a":4,"b":5,"press":0,"alternatePress":6,"rotateDirection":"clockwise-brighter","brightnessStep":18,"patternCycleIds":["scanner","aurora","ember"]},"previous":7,"next":8,"blackout":9,"brightness":-1,"statusLed":2},"patterns":[{"id":"scanner","label":"Scanner","mode":"procedural"},{"id":"aurora","label":"Aurora","mode":"procedural"},{"id":"ember","label":"Ember","mode":"procedural"}],"startupPatternId":"scanner"}' \
  http://192.168.4.1/api/config
```

Expected:

```json
{"ok":true,"message":"saved to internal flash"}
```

- [ ] **Step 7: Reboot and confirm flash source**

```bash
curl -sS --max-time 3 -X POST http://192.168.4.1/api/reboot
sleep 8
curl -sS --max-time 3 http://192.168.4.1/api/status
```

Expected JSON includes:

```json
{"source":"internal-flash","mode":"website-flash"}
```

- [ ] **Step 8: Verify SD fallback manually**

Prepare SD using:

```bash
cd lightweaver
npm run standalone:unpack -- ~/Downloads/lightweaver-controller-package.json /Volumes/LIGHTWEAVER
```

Insert SD, reboot, and monitor serial. Expected:

```text
Runtime source: sd / config loaded
```

Remove SD, reboot, and monitor serial. Expected:

```text
Runtime source: internal-flash / config loaded
```

- [ ] **Step 9: Commit verification notes if useful**

If bench verification reveals hardware-specific notes, append them to `docs/lightweaver-customer-runtime.md` and commit:

```bash
git add docs/lightweaver-customer-runtime.md
git commit -m "docs: add Lightweaver card bench verification notes"
```

---

## Handoff Prompts For Parallel Agents

Use these prompts after Task 1 lands.

### Prompt For Agent B

```text
You own firmware storage and boot priority for Lightweaver. Read docs/superpowers/plans/2026-05-28-lightweaver-esp32-three-mode-runtime.md and execute Task 2 and Task 3 only. You are not alone in the codebase: do not revert edits from others. Your write scope is firmware/lightweaver-controller/src/LightweaverTypes.h, LightweaverStorage.h, LightweaverStorage.cpp, and boot-related edits in main.cpp. Run `cd firmware/lightweaver-controller && pio run`. Return status, changed files, and verification output.
```

### Prompt For Agent C

```text
You own firmware patterns and physical controls for Lightweaver. Read docs/superpowers/plans/2026-05-28-lightweaver-esp32-three-mode-runtime.md and execute Task 4 only. You are not alone in the codebase: do not revert edits from others. Your write scope is LightweaverPatterns.*, LightweaverControls.*, and the control/pattern call sites in firmware/lightweaver-controller/src/main.cpp. Run `cd firmware/lightweaver-controller && pio run`. Return status, changed files, and verification output.
```

### Prompt For Agent D

```text
You own ESP32 web/API setup for Lightweaver. Read docs/superpowers/plans/2026-05-28-lightweaver-esp32-three-mode-runtime.md and execute Task 5 only. You are not alone in the codebase: do not revert edits from others. Your write scope is LightweaverWeb.* and its call sites in firmware/lightweaver-controller/src/main.cpp. Run `cd firmware/lightweaver-controller && pio run`. Return status, changed files, and verification output.
```

### Prompt For Agent E

```text
You own the Lightweaver website installer flow. Read docs/superpowers/plans/2026-05-28-lightweaver-esp32-three-mode-runtime.md and execute Task 6 only. You are not alone in the codebase: do not revert edits from others. Your write scope is ExportDialog.jsx, DevicesPanel.jsx, tests/card-installer-package.mjs, and package.json. Run `cd lightweaver && npm run test:core && npm run build`. Return status, changed files, and verification output.
```

### Prompt For Agent F

```text
You own SD advanced package validation and docs. Read docs/superpowers/plans/2026-05-28-lightweaver-esp32-three-mode-runtime.md and execute Task 7 and Task 8 only. You are not alone in the codebase: do not revert edits from others. Your write scope is standaloneController.js, unpack-standalone-package.mjs, standalone-package-unpack.mjs, docs/lightweaver-customer-runtime.md, and firmware/lightweaver-controller/README.md. Run `cd lightweaver && npm run test:core` after code changes. Return status, changed files, and verification output.
```

---

## Final Acceptance Criteria

- ESP32 standalone firmware boots with no SD card.
- Rotary turn changes brightness of the current running pattern.
- Rotary press changes to the next configured pattern.
- ESP32 can expose `Lightweaver-XXXX` AP and `GET /api/status`.
- ESP32 accepts `POST /api/config` and persists config across reboot.
- Website can generate the same config body used by the firmware API.
- microSD sequence playback remains supported and optional.
- Invalid or missing SD never prevents factory/internal-flash playback.
- `cd lightweaver && npm run test:core && npm run build` passes.
- `cd firmware/lightweaver-controller && pio run` passes.
