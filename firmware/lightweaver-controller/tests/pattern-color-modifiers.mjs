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
assert.match(source, /resolveBreatheScale\(now, mods\.breatheLowerPct, mods\.breatheUpperPct, mods\.breatheCycleSeconds\)/);
assert.match(source, /applyGlobalColorModifiers\(leds, totalPixels, now, mods\);/);
assert.doesNotMatch(source, /applyGlobalColorModifiers\(leds, totalPixels, millis\(\), mods\);/);
assert.doesNotMatch(source, /beatsin8\(5, 38, 150\)/);
assert.match(source, /const uint8_t breatheLevel = preset == "breathe"\s*\? resolveBreatheScale\(t, 85, 100, 9\)/,
  'the built-in Breathe pattern must retain the speed-scaled pattern clock');
assert.match(source, /const uint8_t calmLevel = preset == "calm"\s*\? resolveBreatheScale\(t, 15, 59, 12\)/,
  'Calm should share one speed-scaled frame-global envelope');

const proceduralStart = source.indexOf('bool renderProceduralPattern(');
const proceduralEnd = source.indexOf('\nbool renderPresetPattern(', proceduralStart);
const procedural = source.slice(proceduralStart, proceduralEnd);
const pixelLoopStart = procedural.indexOf('for (uint16_t i = 0; i < totalPixels; i++)');
assert.notEqual(pixelLoopStart, -1);
assert.doesNotMatch(procedural.slice(pixelLoopStart), /resolveBreatheScale\(/,
  'frame-global Breathe and Calm envelopes must not recompute cosine per pixel');

const customColorStart = source.indexOf('if (preset == "custom-color")');
const customColorEnd = source.indexOf('\n  } else {\n    for (uint16_t i = 0;', customColorStart);
assert.notEqual(customColorStart, -1);
assert.notEqual(customColorEnd, -1);
const customColor = source.slice(customColorStart, customColorEnd);
assert.doesNotMatch(customColor, /beatsin8|speedBpm/, 'custom color must not keep the legacy speed-scaled breathe path');
assert.doesNotMatch(customColor, /return true/, 'custom color must not return before the shared canonical modifier post-pass');
assert.match(source.slice(customColorStart, source.indexOf('\n  return true;', customColorEnd)),
  /applyGlobalColorModifiers\(leds, totalPixels, now, mods\);/,
  'custom color must flow through the canonical wall-clock breathe envelope and its configured bounds');
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
  source.indexOf('static bool isSupportedLegacyProceduralPattern('),
  source.indexOf('\n}', source.indexOf('static bool isSupportedLegacyProceduralPattern(')),
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
assert.match(preflight, /findLookByExactId\(patternId\)/, 'exact loaded playlist looks must remain accepted');
assert.match(preflight, /findLookByPresetAlias\(patternId\)/, 'non-compiled global preset aliases must remain accepted');
assert.match(preflight, /isLoadedLookRenderable\(\*look,\s*zoneTargeted\)/, 'loaded looks must prove the requested target is renderable');
assert.match(preflight, /isSupportedCompiledPattern\(patternId\)/, 'known compiled patterns must remain accepted');
const select = runtime.slice(runtime.indexOf('bool runtimeSelectPatternById(const String& id)'), preflightStart);
assert.match(select, /if\s*\(!look\)\s*return false;/,
  'unknown global pattern ids must be rejected before state changes');
assert.match(select, /selectLookInstant\(/,
  'loaded global looks must delegate renderability and concrete-file preparation to selection');

console.log('pattern-color-modifiers ok');
