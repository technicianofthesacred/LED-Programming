import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(resolve(os.tmpdir(), 'lw-kaleidoscope-'));
try {
  const binary = resolve(temp, 'kaleidoscope-runtime');
  execFileSync('c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror',
    '-I', resolve(root, 'src'),
    resolve(import.meta.dirname, 'kaleidoscope-runtime.cpp'),
    '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const types = readFileSync(resolve(root, 'src/LightweaverTypes.h'), 'utf8');
const storage = readFileSync(resolve(root, 'src/LightweaverStorage.cpp'), 'utf8');
const main = readFileSync(resolve(root, 'src/main.cpp'), 'utf8');
const web = readFileSync(resolve(root, 'src/LightweaverWeb.cpp'), 'utf8');
const runtimeApi = readFileSync(resolve(root, 'src/LightweaverRuntimeApi.h'), 'utf8');
const patternsHeader = readFileSync(resolve(root, 'src/LightweaverPatterns.h'), 'utf8');
const patterns = readFileSync(resolve(root, 'src/LightweaverPatterns.cpp'), 'utf8');
const platformio = readFileSync(resolve(root, 'platformio.ini'), 'utf8');

assert.match(types, /KaleidoscopeMappingConfig\s+kaleidoscopeMappings\[LW_MAX_KALEIDOSCOPE_MAPPINGS\]/);
assert.match(storage, /validateKaleidoscopeMappingsStrict\(/);
assert.match(storage, /deriveKaleidoscopePoints\(/);
assert.match(storage, /validateKaleidoscopeSpans\(/,
  'raw storage validation must share the no-wrap/no-overlap span contract with native tests');
assert.match(storage, /kaleidoscopeSpanWithinRanges\(/,
  'raw storage validation must bind every mapping span to its declared zone ranges');
assert.doesNotMatch(storage, /kaleidoscopeMappings[\s\S]{0,200}\|/, 'present mapping fields must not use ArduinoJson defaults');
assert.match(main, /capabilities"\]\["kaleidoscopeReflectionPoints"\]\s*=\s*LW_KALEIDOSCOPE_REFLECTION_POINTS_VERSION/);
assert.match(main, /serializeKaleidoscopeMappings\(/);
assert.match(platformio, /-DLW_CAPABILITIES_VERSION=2/);
assert.match(patternsHeader, /struct PatternCoordinateContext\s*{[\s\S]*sourcePixelCount[\s\S]*sourceStart[\s\S]*sourceStep[\s\S]*kaleidoscope/);
assert.match(patternsHeader, /renderProceduralPattern\([\s\S]*const PatternCoordinateContext\*\s*\w+\s*=\s*nullptr\)/);
assert.match(patternsHeader, /renderNativeRecipe\([\s\S]*const PatternCoordinateContext\*\s*\w+\s*=\s*nullptr\)/);
assert.match(patterns, /patternSpatialIndex\(/);
assert.match(patterns, /sampleKaleidoscope\(context->kaleidoscope/);
assert.match(main, /KaleidoscopePixelLookup\s+kaleidoscopePixelLookup\[LW_MAX_PIXELS\]/,
  'the runtime must keep a bounded precomputed global-pixel lookup');
assert.match(main, /rebuildKaleidoscopePixelLookup\(config\)/,
  'config application must rebuild the bounded lookup once');
assert.match(runtimeApi, /void\s+runtimeApplySavedConfig\(\)/,
  'the web layer needs a firmware-owned seam for activating an accepted saved config');
const configPostStart = web.indexOf('void handleConfigPost()');
const configPostEnd = web.indexOf('void handleWifiPost()', configPostStart);
assert.ok(configPostStart >= 0 && configPostEnd > configPostStart);
const configPostBody = web.slice(configPostStart, configPostEnd);
const savePosition = configPostBody.indexOf('saveRuntimeConfigJson(');
const applyPosition = configPostBody.indexOf('runtimeApplySavedConfig()');
const restartPosition = configPostBody.indexOf('runtimeMarkRestartPending()');
assert.ok(savePosition >= 0 && applyPosition > savePosition && restartPosition > applyPosition,
  'accepted same-wiring config must rebuild live runtime state before restart is marked');
const loopStart = main.indexOf('void loop()');
const loopEnd = main.indexOf('void applyRuntimeConfig(', loopStart);
assert.ok(loopStart >= 0 && loopEnd > loopStart);
const loopBody = main.slice(loopStart, loopEnd);
const restartGuard = loopBody.indexOf('if (restartTransitionPending)');
assert.ok(restartGuard >= 0 && restartGuard < loopBody.indexOf('handleWledRealtime()'),
  'continued loop ticks must stay dark while an accepted config waits for reboot');
const renderZoneStart = main.indexOf('bool renderZone(');
const renderZoneEnd = main.indexOf('bool renderCurrentLook(', renderZoneStart);
const renderZoneBody = main.slice(renderZoneStart, renderZoneEnd);
assert.doesNotMatch(renderZoneBody, /globalPixelUsesKaleidoscope|kaleidoscopeMappingCount|\.zoneId/,
  'frame rendering must not scan mappings or compare zone strings per pixel');
const sequenceStart = main.indexOf('bool renderSequenceFrame(bool force) {');
const sequenceEnd = main.indexOf('bool renderProceduralFrame(', sequenceStart);
assert.ok(sequenceStart >= 0 && sequenceEnd > sequenceStart);
assert.doesNotMatch(main.slice(sequenceStart, sequenceEnd), /Kaleidoscope|kaleidoscope/,
  'lwseq playback must remain byte-oriented and outside coordinate folding');

const stageStart = storage.indexOf('bool stageRuntimeConfigJson(');
const stageEnd = storage.indexOf('bool activateStagedRuntimeConfig(', stageStart);
const stageBody = storage.slice(stageStart, stageEnd);
assert.ok(stageStart >= 0 && stageEnd > stageStart, 'candidate staging implementation must be present');
assert.ok(stageBody.indexOf('validateRuntimeConfigJsonStrict') >= 0,
  'candidate raw JSON must be strictly validated');
assert.ok(stageBody.indexOf('validateRuntimeConfigJsonStrict') < stageBody.indexOf('prefs.putString(NVS_CANDIDATE_CONFIG_KEY'),
  'rejected raw JSON must not replace candidate or known-good storage');
assert.doesNotMatch(stageBody.slice(0, stageBody.indexOf('validateRuntimeConfigJsonStrict')), /NVS_KNOWN_GOOD_CONFIG_KEY|prefs\.remove|prefs\.put/,
  'candidate known-good state must be untouched before raw validation succeeds');

execFileSync(process.execPath, [resolve(import.meta.dirname, 'kaleidoscope-render-golden.mjs')], {
  stdio: 'inherit',
});

console.log('kaleidoscope runtime contract tests passed');
