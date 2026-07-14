import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../src/LightweaverPatterns.cpp'), 'utf8');
const header = readFileSync(resolve(here, '../src/LightweaverPatterns.h'), 'utf8');
const runtime = readFileSync(resolve(here, '../src/main.cpp'), 'utf8');

assert.match(source, /void applyGlobalColorModifiers\(/);
assert.match(source, /rgb2hsv_approximate/);
assert.match(source, /int16_t\(mods\.customHue\) - int16_t\(LW_DEFAULT_CUSTOM_HUE\)/);
assert.match(source, /hsv\.saturation = uint8_t\(sat > 255 \? 255 : sat\)/);
assert.match(source, /applyGlobalColorModifiers\(leds, totalPixels, t, mods\);/);
assert.match(source, /applyGlobalColorModifiers\(leds, totalPixels, millis\(\), mods\);/);
assert.match(source, /preset == "test-white"/, 'firmware preset renderer should support a white strip test');
assert.match(header, /bool\s+isSupportedCompiledPattern\(const String& patternId\)/, 'compiled pattern support must be queryable without rendering');
assert.match(source, /bool\s+isSupportedProceduralPattern\(/, 'procedural support must have an explicit resolver');
assert.match(source, /bool\s+isSupportedPresetPattern\(/, 'preset support must have an explicit resolver');
assert.match(source, /if\s*\(!isSupportedProceduralPattern\(preset\)\)\s*return false;/, 'unknown procedural ids must not silently render Aurora');
assert.match(source, /if\s*\(!isSupportedPresetPattern\(preset\)\)\s*return false;/, 'unknown preset ids must not silently render warm white');

const compiledSupportStart = source.indexOf('bool isSupportedCompiledPattern(');
const compiledSupportEnd = source.indexOf('\n}', compiledSupportStart);
assert.notEqual(compiledSupportStart, -1);
const compiledSupport = source.slice(compiledSupportStart, compiledSupportEnd);
assert.match(compiledSupport, /isSupportedProceduralPattern\(patternId\)/);
assert.match(compiledSupport, /isSupportedPresetPattern\(patternId\)/);

const proceduralSupport = source.slice(
  source.indexOf('bool isSupportedProceduralPattern('),
  source.indexOf('\n}', source.indexOf('bool isSupportedProceduralPattern(')),
);
const presetSupport = source.slice(
  source.indexOf('bool isSupportedPresetPattern('),
  source.indexOf('\n}', source.indexOf('bool isSupportedPresetPattern(')),
);
for (const known of ['aurora', 'ocean', 'custom-color']) {
  assert.ok(proceduralSupport.includes(`"${known}"`), `${known} must remain an accepted procedural built-in`);
}
for (const known of ['warm-white', 'blackout', 'test-white']) {
  assert.ok(presetSupport.includes(`"${known}"`), `${known} must remain an accepted preset built-in`);
}
assert.ok(!proceduralSupport.includes('definitely-not-a-pattern'));
assert.ok(!presetSupport.includes('definitely-not-a-pattern'));

const preflightStart = runtime.indexOf('bool runtimeCanSelectPatternByIdZ(');
const selectStart = runtime.indexOf('bool runtimeSelectPatternByIdZ(', preflightStart);
assert.notEqual(preflightStart, -1);
assert.notEqual(selectStart, -1);
const preflight = runtime.slice(preflightStart, selectStart);
assert.match(preflight, /findLookById\(patternId\)/, 'loaded playlist looks must remain accepted');
assert.match(preflight, /isSupportedCompiledPattern\(patternId\)/, 'known compiled patterns must remain accepted');
const select = runtime.slice(runtime.indexOf('bool runtimeSelectPatternById(const String& id)'), preflightStart);
assert.match(select, /if\s*\(!isSupportedCompiledPattern\(id\)\)\s*return false;/, 'unknown global pattern ids must be rejected before state changes');

console.log('pattern-color-modifiers ok');
