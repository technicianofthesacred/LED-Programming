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
assert.match(storage, /"previousKnown"/);
assert.match(storage, /"promotionArmed"/);
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
assert.match(loadBody, /rollbackCandidateRuntimeConfig[\s\S]*safe defaults loaded/,
  'a failed rollback must boot compiled-safe defaults instead of an uncertain known-good slot');

const confirmStart = storage.indexOf('bool confirmCandidateRuntimeConfig(');
const confirmEnd = storage.indexOf('bool rollbackCandidateRuntimeConfig(', confirmStart);
const confirmBody = storage.slice(confirmStart, confirmEnd);
const previousWrite = confirmBody.indexOf('NVS_PREVIOUS_KNOWN_GOOD_KEY', confirmBody.indexOf('String previous ='));
const armWrite = confirmBody.indexOf('NVS_PROMOTION_ARMED_KEY', previousWrite);
const knownGoodWrite = confirmBody.indexOf('putString(NVS_KNOWN_GOOD_CONFIG_KEY', armWrite);
const stateClear = confirmBody.indexOf('writeCandidateState(prefs, WIRING_CANDIDATE_NONE)', knownGoodWrite);
assert.ok(previousWrite > -1 && armWrite > previousWrite && knownGoodWrite > armWrite && stateClear > knownGoodWrite,
  'confirmation must journal the prior identity before promotion and clear candidate state last');
assert.match(confirmBody, /restorePreviousKnownGood\(prefs\)/,
  'a failed confirmation must restore the prior acknowledged config and identity');

const rollbackStart = storage.indexOf('bool rollbackCandidateRuntimeConfig(');
const rollbackEnd = storage.indexOf('WiringSafetyStatus getRuntimeWiringSafetyStatus(', rollbackStart);
const rollbackBody = storage.slice(rollbackStart, rollbackEnd);
assert.match(rollbackBody, /restorePreviousKnownGood\(prefs\)/,
  'boot or worker rollback must recover an interrupted promotion before clearing the candidate');
assert.match(rollbackBody, /remove\(NVS_CONFIRMED_ID_KEY\)/,
  'rollback must clear an interrupted confirmation marker so it cannot acknowledge a reverted candidate');

console.log('wiring-candidate-storage tests passed');
