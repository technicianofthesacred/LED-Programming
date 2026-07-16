import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(__dirname, '../../..');
const firmwareDir = path.join(repoDir, 'firmware/lightweaver-controller/src');

const mainSource = fs.readFileSync(path.join(firmwareDir, 'main.cpp'), 'utf8');
const webSource = fs.readFileSync(path.join(firmwareDir, 'LightweaverWeb.cpp'), 'utf8');
const apiHeader = fs.readFileSync(path.join(firmwareDir, 'LightweaverRuntimeApi.h'), 'utf8');
const pipelineHeader = path.join(firmwareDir, 'LightweaverColorPipeline.h');
const pipelineSource = path.join(firmwareDir, 'LightweaverColorPipeline.cpp');

assert.match(
  mainSource,
  /CRGB physicalLeds\[LW_MAX_PIXELS\]/,
  'firmware should keep a separate physical output buffer for live color-order mapping',
);
assert.match(
  mainSource,
  /void copyLogicalToPhysicalLeds\(\)/,
  'firmware should transform logical RGB pixels before FastLED.show()',
);
assert.match(
  mainSource,
  /LightweaverColorPipeline\s+outputColorPipeline;/,
  'firmware should keep one configured output color pipeline',
);
assert.match(
  mainSource,
  /physicalLeds\[i\]\s*=\s*outputColorPipeline\.transform\(leds\[i\],\s*ledColorOrderCode\);/,
  'logical RGB should be transformed into the physical buffer without modifying the logical canvas',
);
assert.doesNotMatch(
  mainSource,
  /leds\[i\]\s*=\s*outputColorPipeline\.transform/,
  'the output transform must never overwrite logical RGB',
);
assert.match(
  mainSource,
  /runtimeSetLedColorOrder\(const String& order\)/,
  'firmware should expose a runtime color-order setter',
);
assert.match(
  apiHeader,
  /void runtimeSetLedColorOrder\(const String& order\);/,
  'runtime API header should expose the color-order setter',
);
assert.match(
  webSource,
  /hasControlField\(doc, "colorOrder"\).*runtimeSetLedColorOrder/s,
  'control endpoint should accept colorOrder without requiring a config save',
);
assert.match(
  mainSource,
  /FastLED\.addLeds<WS2812B, DATA_PIN, RGB>\(start, count\)/,
  'firmware should keep FastLED output RGB and do live order mapping in software',
);
assert.match(
  mainSource,
  /doc\["controls"\]\["encoder"\]\["a"\]\s*=\s*controls\.encoderA/,
  'firmware info should expose the configured encoder A pin for knob diagnostics',
);
assert.match(
  mainSource,
  /doc\["controls"\]\["encoder"\]\["effectiveAlternatePress"\]\s*=\s*effectiveEncoderPressAltPin\(controls\)/,
  'firmware info should expose the effective alternate press fallback pin',
);
assert.match(
  mainSource,
  /doc\["controls"\]\["manualBrightness"\]\s*=\s*manualBrightness/,
  'firmware info should expose the live manual brightness value changed by the knob',
);
assert.match(
  mainSource,
  /doc\["controls"\]\["nextPressed"\]\s*=\s*pinIsPressed\(controls\.next\)/,
  'firmware info should expose the raw next button state for false-trigger diagnostics',
);

assert.equal(fs.existsSync(pipelineHeader), true, 'color pipeline header should exist');
assert.equal(fs.existsSync(pipelineSource), true, 'color pipeline implementation should exist');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-color-pipeline-'));
try {
  fs.writeFileSync(path.join(tempDir, 'Arduino.h'), `
#pragma once
class String {
 public:
  String() = default;
  String(const char*) {}
};
`);
  fs.writeFileSync(path.join(tempDir, 'SD.h'), '#pragma once\n');
  fs.writeFileSync(path.join(tempDir, 'FastLED.h'), `
#pragma once
#include <cmath>
#include <cstdint>

struct CRGB {
  uint8_t r = 0;
  uint8_t g = 0;
  uint8_t b = 0;
  CRGB() = default;
  CRGB(uint8_t red, uint8_t green, uint8_t blue) : r(red), g(green), b(blue) {}
};

inline int gammaApplyCalls = 0;

inline uint8_t applyGamma_video(uint8_t value, float gamma) {
  ++gammaApplyCalls;
  const float normalized = float(value) / 255.0f;
  const float adjusted = std::pow(normalized, gamma) * 255.0f;
  uint8_t result = uint8_t(adjusted);
  if (value > 0 && result == 0) result = 1;
  return result;
}

inline uint8_t scale8_video(uint8_t value, uint8_t scale) {
  return uint8_t(((int(value) * int(scale)) >> 8) + ((value && scale) ? 1 : 0));
}
`);
  fs.writeFileSync(path.join(tempDir, 'pipeline-test.cpp'), `
#include <cassert>
#include "LightweaverColorPipeline.h"

static void assertRgb(const CRGB& color, int red, int green, int blue) {
  assert(color.r == red);
  assert(color.g == green);
  assert(color.b == blue);
}

int main() {
  OutputColorConfig neutral;
  assert(!neutral.gammaEnabled);
  assert(neutral.gammaValue == 2.2f);
  assert(neutral.red == 1.0f && neutral.green == 1.0f && neutral.blue == 1.0f);

  LightweaverColorPipeline pipeline;
  pipeline.configure(neutral);
  assert(!pipeline.gammaEnabled());
  assert(pipeline.gammaValue() == 2.2f);
  assert(gammaApplyCalls == 256);

  const CRGB logical(10, 20, 30);
  assertRgb(pipeline.transform(logical, 0), 10, 20, 30);
  assertRgb(pipeline.transform(logical, 1), 20, 10, 30);
  assertRgb(pipeline.transform(logical, 2), 30, 10, 20);
  assertRgb(pipeline.transform(logical, 3), 30, 20, 10);
  assertRgb(pipeline.transform(logical, 4), 10, 30, 20);
  assertRgb(pipeline.transform(logical, 5), 20, 30, 10);
  assertRgb(logical, 10, 20, 30);
  assert(gammaApplyCalls == 256);

  OutputColorConfig gammaOnly;
  gammaOnly.gammaEnabled = true;
  gammaOnly.gammaValue = 2.0f;
  pipeline.configure(gammaOnly);
  assert(gammaApplyCalls == 512);
  assertRgb(pipeline.transform(CRGB(0, 1, 128), 0), 0, 1, 64);
  assertRgb(pipeline.transform(CRGB(255, 255, 255), 0), 255, 255, 255);
  assert(gammaApplyCalls == 512);

  OutputColorConfig calibrated;
  calibrated.gammaEnabled = true;
  calibrated.gammaValue = 2.0f;
  calibrated.red = 0.5f;
  calibrated.green = 0.25f;
  calibrated.blue = 1.0f;
  pipeline.configure(calibrated);
  assert(pipeline.gammaEnabled());
  assert(pipeline.gammaValue() == 2.0f);
  assert(gammaApplyCalls == 768);

  const CRGB source(100, 80, 60);
  assertRgb(pipeline.transform(source, 1), 1, 10, 14);
  assertRgb(source, 100, 80, 60);
  assert(gammaApplyCalls == 768);
  return 0;
}
`);

  const binary = path.join(tempDir, 'pipeline-test');
  execFileSync('c++', [
    '-std=c++17',
    '-I', tempDir,
    '-I', firmwareDir,
    path.join(tempDir, 'pipeline-test.cpp'),
    pipelineSource,
    '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('runtime-color-order tests passed');
