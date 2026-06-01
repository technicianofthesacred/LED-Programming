import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(__dirname, '../../..');
const firmwareDir = path.join(repoDir, 'firmware/lightweaver-controller/src');

const mainSource = fs.readFileSync(path.join(firmwareDir, 'main.cpp'), 'utf8');
const webSource = fs.readFileSync(path.join(firmwareDir, 'LightweaverWeb.cpp'), 'utf8');
const apiHeader = fs.readFileSync(path.join(firmwareDir, 'LightweaverRuntimeApi.h'), 'utf8');

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
  apiHeader,
  /void runtimeSetBrightnessAnalogPin\(int pin\);/,
  'runtime API header should expose the analog brightness-pin setter',
);
assert.match(
  webSource,
  /hasControlField\(doc, "brightnessAnalog"\).*runtimeSetBrightnessAnalogPin/s,
  'control endpoint should accept brightnessAnalog without requiring a config save',
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

console.log('runtime-color-order tests passed');
