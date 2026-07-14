import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const types = readFileSync(resolve(root, 'src/LightweaverTypes.h'), 'utf8');
const header = readFileSync(resolve(root, 'src/LightweaverStorage.h'), 'utf8');
const storage = readFileSync(resolve(root, 'src/LightweaverStorage.cpp'), 'utf8');

assert.match(types, /enum WiringCandidateState\s*:\s*uint8_t\s*{[\s\S]*WIRING_CANDIDATE_NONE[\s\S]*WIRING_CANDIDATE_STAGED[\s\S]*WIRING_CANDIDATE_BOOTING[\s\S]*WIRING_CANDIDATE_AWAITING_CONFIRMATION/);
assert.match(types, /struct WiringSafetyStatus\s*{/);
assert.match(types, /String activationId;/);
assert.match(types, /LW_WIRING_PROBATION_MS\s*=\s*90000/);

for (const key of ['knownGoodConfig', 'candidateConfig', 'candidateState']) {
  assert.match(storage, new RegExp(`constexpr const char\\* [A-Z_]+ = "${key}"`), `storage should reserve the ${key} NVS key`);
}
assert.match(storage, /"candidateId"/);
assert.match(storage, /"discoveryActive"/);
assert.match(storage, /"discoveryBatch"/);

for (const fn of [
  'stageRuntimeConfigJson',
  'activateStagedRuntimeConfig',
  'confirmCandidateRuntimeConfig',
  'rollbackCandidateRuntimeConfig',
  'runtimeWiringSafetyStatusJson',
  'runtimeConfigJsonChangesWiring',
  'setRuntimeWiringDiscoveryBatch',
  'clearRuntimeWiringDiscovery',
]) {
  assert.match(header, new RegExp(`\\b${fn}\\s*\\(`), `storage header should expose ${fn}`);
  assert.match(storage, new RegExp(`\\b${fn}\\s*\\(`), `storage should implement ${fn}`);
}

assert.match(header, /stageRuntimeConfigJson\(const String& json, String& activationId, String& message\)/);
for (const fn of ['activateStagedRuntimeConfig', 'confirmCandidateRuntimeConfig', 'rollbackCandidateRuntimeConfig']) {
  assert.match(header, new RegExp(`${fn}\\(const String& activationId, String& message\\)`));
}
assert.match(storage, /candidateIdMatches\(prefs, activationId\)/, 'candidate mutations must reject stale activation IDs');

for (const [fn, nextFn] of [
  ['activateStagedRuntimeConfig', 'confirmCandidateRuntimeConfig'],
  ['confirmCandidateRuntimeConfig', 'rollbackCandidateRuntimeConfig'],
  ['rollbackCandidateRuntimeConfig', 'getRuntimeWiringSafetyStatus'],
]) {
  const start = storage.indexOf(`bool ${fn}(`);
  const end = storage.indexOf(nextFn, start + 1);
  assert.ok(start > -1 && end > start);
  assert.match(storage.slice(start, end), /candidateIdMatches\(prefs, activationId\)/,
    `${fn} must independently reject a stale activation ID`);
}

for (const validation of [
  'unsupported output pin',
  'duplicate output pin',
  'more than 4 outputs',
  'output pin conflicts with controls',
  'pixel total exceeds',
  'zone range exceeds',
  'unknown startup look',
  'unknown zone reference',
]) {
  assert.match(storage, new RegExp(validation), `strict candidate validation should report ${validation}`);
}

const stageStart = storage.indexOf('bool stageRuntimeConfigJson(');
const stageEnd = storage.indexOf('bool activateStagedRuntimeConfig(', stageStart);
assert.ok(stageStart > -1 && stageEnd > stageStart);
const stageBody = storage.slice(stageStart, stageEnd);
assert.match(stageBody, /validateRuntimeConfigJsonStrict\(json, \*parsed, message\)/, 'staging should fully validate into a temporary config');
assert.doesNotMatch(stageBody, /config\s*=\s*\*parsed/, 'staging must not mutate the active runtime config');

assert.match(storage, /getString\(NVS_LEGACY_CONFIG_KEY/);
assert.match(storage, /putString\(NVS_KNOWN_GOOD_CONFIG_KEY/);
assert.match(storage, /known-good migration failed/);

const loadStart = storage.indexOf('RuntimeLoadResult loadRuntimeConfig(');
const saveStart = storage.indexOf('bool saveRuntimeConfigJson(', loadStart);
const loadBody = storage.slice(loadStart, saveStart);
assert.match(loadBody, /WIRING_CANDIDATE_BOOTING[\s\S]*NVS_CANDIDATE_CONFIG_KEY[\s\S]*WIRING_CANDIDATE_AWAITING_CONFIRMATION/);
assert.match(loadBody, /WIRING_CANDIDATE_AWAITING_CONFIRMATION[\s\S]*rollbackCandidateRuntimeConfig/);

console.log('wiring-candidate-storage tests passed');
