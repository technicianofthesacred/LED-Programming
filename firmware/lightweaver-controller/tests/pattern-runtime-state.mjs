import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(resolve(here, '../src/main.cpp'), 'utf8');
const api = readFileSync(resolve(here, '../src/LightweaverRuntimeApi.h'), 'utf8');
const web = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');
const storage = readFileSync(resolve(here, '../src/LightweaverStorage.cpp'), 'utf8');

assert.match(
  api,
  /String\s+runtimeCurrentPatternId\s*\(\s*\)\s*;/,
  'the web layer needs an applied runtime pattern readback instead of a playlist-index echo',
);

assert.match(
  main,
  /String\s+activePatternId\s*;/,
  'runtime must track the selected global pattern independently of the loaded playlist index',
);

assert.match(
  main,
  /String\s+runtimeCurrentPatternId\s*\(\s*\)\s*\{[\s\S]*return activePatternId;/,
  'runtime must expose the applied selection to API consumers',
);

const commitStart = main.indexOf('bool runtimeCommitPreparedPatternSelection()');
const commitEnd = main.indexOf('void runtimeDiscardPreparedPatternSelection()', commitStart);
assert.ok(commitStart >= 0 && commitEnd > commitStart, 'prepared pattern commit should exist');
const commit = main.slice(commitStart, commitEnd);
assert.match(
  commit,
  /GlobalCompiledPattern[\s\S]*activePatternId\s*=\s*affected\s*==\s*runtimeConfig\.zoneCount[\s\S]*preparedPatternSelection\.patternId/,
  'a successful compiled-pattern selection must update applied readback state',
);
assert.match(
  commit,
  /ZonePattern[\s\S]*activePatternId\s*=\s*String\(""\)/,
  'a section-only change must invalidate the global-scene readback',
);

const patternsStart = web.indexOf('void handlePatterns() {');
const patternsEnd = web.indexOf('void handleCaptiveProbe()', patternsStart);
assert.ok(patternsStart >= 0 && patternsEnd > patternsStart, 'pattern API handler should exist');
const patterns = web.slice(patternsStart, patternsEnd);
assert.match(
  patterns,
  /String\s+currentPatternId\s*=\s*runtimeCurrentPatternId\(\)/,
  '/api/patterns must report the actually applied runtime pattern',
);
assert.match(patterns, /doc\["currentId"\]\s*=\s*currentPatternId/);
assert.doesNotMatch(
  patterns,
  /cfg\.looks\[\*currentLookIndexPtr\]\.id/,
  '/api/patterns must not report a stale playlist id after Studio selects a compiled pattern',
);

const statusStart = storage.indexOf('String runtimeStatusJson(');
assert.ok(statusStart >= 0, 'status serializer should exist');
const status = storage.slice(statusStart);
assert.match(status, /String\s+currentPatternId\s*=\s*runtimeCurrentPatternId\(\)/,
  '/api/status must use the same applied pattern readback');
assert.match(status, /doc\["currentLookId"\]\s*=\s*currentPatternId/,
  '/api/status currentLookId must not keep reporting a superseded playlist item');
assert.match(status, /doc\["currentPatternId"\]\s*=\s*currentPatternId/,
  '/api/status should expose an unambiguous currentPatternId field');

const controlStart = web.indexOf('void handleControlPost()');
const controlEnd = web.indexOf('void handleRecoverLights()', controlStart);
assert.ok(controlStart >= 0 && controlEnd > controlStart, 'control handler should exist');
const control = web.slice(controlStart, controlEnd);
assert.match(
  control,
  /out\["appliedPatternId"\]\s*=\s*runtimeCurrentPatternId\(\)/,
  'control acknowledgement must include card-owned applied pattern readback',
);

const recoverStart = main.indexOf('String runtimeRecoverLights(');
const recoverEnd = main.indexOf('String runtimeZonesJson()', recoverStart);
assert.ok(recoverStart >= 0 && recoverEnd > recoverStart, 'recover-lights runtime should exist');
const recover = main.slice(recoverStart, recoverEnd);
assert.match(
  recover,
  /activePatternId\s*=\s*id/,
  'machine-verifiable recovery state must agree with the recovery pattern written to every zone',
);

console.log('pattern-runtime-state tests passed');
