import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../src/LightweaverPatterns.cpp'), 'utf8');
const header = readFileSync(resolve(here, '../src/LightweaverPatterns.h'), 'utf8');
const runtime = readFileSync(resolve(here, '../src/main.cpp'), 'utf8');

assert.match(source, /void applyGlobalColorModifiers\(/);
// The hue/saturation post-pass must use an EXACT RGB<->HSV pair. FastLED's
// rgb2hsv_approximate + hsv2rgb_rainbow is not invertible and lands a ~44/255
// recolor on the first notch either control moves off its default (the post-pass
// is skipped entirely AT the default), which is what made the Studio's Color
// sliders lurch once and then appear dead.
assert.match(source, /LwExactHsv hsv = rgbToExactHsv\(leds\[i\]\);/);
assert.match(source, /leds\[i\] = exactHsvToRgb\(hsv\);/);
assert.doesNotMatch(
  source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''),
  /rgb2hsv_approximate|hsv2rgb_rainbow/,
  'the color post-pass must not reintroduce a lossy HSV round trip',
);

// Speed is a rate: every animation clock comes from patternClock(), which
// prefers the caller's integrated per-zone clock over uptime * speed.
assert.match(source, /static inline uint32_t patternClock\(uint32_t now, const PatternModifiers& mods\)/);
assert.match(source, /if \(mods\.hasPatternClock\) return mods\.patternClockMs;/);
{
  // The one surviving `scaleTime(now, mods.speed)` is patternClock()'s own
  // fallback for callers that render at a single fixed speed. Any other use is a
  // render path that would still teleport when its speed changes.
  const bare = source.replace(/\/\/[^\n]*/g, '');
  const uses = bare.match(/scaleTime\(now, mods\.speed\)/g) || [];
  assert.equal(uses.length, 1, 'render paths must read the clock through patternClock()');
  const clockStart = bare.indexOf('static inline uint32_t patternClock(');
  const clockEnd = bare.indexOf('\n}', clockStart);
  assert.ok(clockStart !== -1 && bare.indexOf('scaleTime(now, mods.speed)') < clockEnd
    && bare.indexOf('scaleTime(now, mods.speed)') > clockStart,
    'the remaining uptime scaling must live inside patternClock() as its fallback');
}
assert.match(runtime, /mods\.patternClockMs = advanceZoneAnimationClock\(zoneIndex, now, zone\.speed\);/,
  'each zone must render on its own integrated animation clock');
assert.match(runtime, /const uint32_t elapsed = now - clock\.lastNow;/,
  'the zone clock must integrate elapsed time so a speed change never teleports the pattern');
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
