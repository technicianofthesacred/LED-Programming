import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../src/LightweaverPatterns.cpp'), 'utf8');

assert.match(source, /void applyGlobalColorModifiers\(/);
assert.match(source, /rgb2hsv_approximate/);
assert.match(source, /int16_t\(mods\.customHue\) - int16_t\(LW_DEFAULT_CUSTOM_HUE\)/);
assert.match(source, /hsv\.saturation = uint8_t\(sat > 255 \? 255 : sat\)/);
assert.match(source, /applyGlobalColorModifiers\(leds, totalPixels, t, mods\);/);
assert.match(source, /applyGlobalColorModifiers\(leds, totalPixels, millis\(\), mods\);/);
assert.match(source, /preset == "test-white"/, 'firmware preset renderer should support a white strip test');

console.log('pattern-color-modifiers ok');
