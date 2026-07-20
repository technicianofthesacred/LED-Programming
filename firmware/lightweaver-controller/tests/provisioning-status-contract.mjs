import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const types = read('src/LightweaverTypes.h');
const storageHeader = read('src/LightweaverStorage.h');
const storage = read('src/LightweaverStorage.cpp');
const runtimeApi = read('src/LightweaverRuntimeApi.h');
const main = read('src/main.cpp');
const web = read('src/LightweaverWeb.cpp');

function functionBody(source, signature) {
  let searchFrom = 0;
  let start = -1;
  let open = -1;
  while (searchFrom < source.length) {
    const match = source.slice(searchFrom).match(signature);
    assert.ok(match, `missing function matching ${signature}`);
    start = searchFrom + match.index;
    open = source.indexOf('{', start);
    const semicolon = source.indexOf(';', start);
    if (open !== -1 && (semicolon === -1 || open < semicolon)) break;
    searchFrom = semicolon + 1;
  }
  assert.notEqual(open, -1, `missing body for ${signature}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

for (const field of ['configValid', 'knownGoodProject', 'runtimePhase']) {
  assert.match(storageHeader, new RegExp(`\\b${field}\\b`), `runtime load result must own ${field}`);
  assert.match(types, new RegExp(`\\b${field}\\b`), `runtime config must retain ${field} for status serialization`);
}

const load = functionBody(storage, /RuntimeLoadResult\s+loadRuntimeConfig\s*\(/);
const supportedOutputPin = functionBody(storage, /bool\s+supportedOutputPin\s*\(/);
assert.match(supportedOutputPin, /isApprovedProvisioningOutputGpio\s*\(/,
  'runtime config output validation must use the shared approved GPIO policy');
assert.doesNotMatch(supportedOutputPin, /38|39|40|48/,
  'production runtime configs must reject legacy discovery-only GPIOs');
assert.match(load, /loadNvsConfigKeyStrict\(NVS_KNOWN_GOOD_CONFIG_KEY[\s\S]*setRuntimeLoadTruth\(config, result, true, true, false\)/,
  'successfully parsed canonical known-good NVS must become known-good truth');
assert.match(load, /loadSdConfig\([\s\S]*setRuntimeLoadTruth\(config, result, true, true, false\)/,
  'an explicitly accepted SD project must become known-good truth');
for (const corruptMessage of [
  'candidate metadata corrupt',
  'candidate rollback failed',
  'malformed known-good',
]) {
  const messageIndex = load.indexOf(corruptMessage);
  assert.notEqual(messageIndex, -1, `load path must retain ${corruptMessage}`);
  const branch = load.slice(Math.max(0, messageIndex - 500), messageIndex + 500);
  assert.match(branch, /setRuntimeLoadTruth\(config, result, false, false, true\)/, `${corruptMessage} must fail closed in recovery`);
}
assert.match(load, /setRuntimeLoadTruth\(config, result, false, false, false\)[\s\S]{0,500}compiled defaults loaded|compiled defaults loaded[\s\S]{0,500}setRuntimeLoadTruth\(config, result, false, false, false\)/,
  'compiled defaults must stay explicitly not known-good');

const setup = functionBody(main, /void\s+setup\s*\(/);
assert.match(main, /void\s+initializeBootIdentity\s*\([\s\S]*esp_random\s*\([\s\S]*ESP\.getEfuseMac\s*\(/,
  'boot identity must combine per-boot randomness with the stable card suffix');
assert.equal((setup.match(/initializeBootIdentity\s*\(/g) || []).length, 1,
  'setup must generate bootId exactly once');
assert.doesNotMatch(storage + main, /putString\([^\n]*bootId|getString\([^\n]*bootId/i,
  'bootId must never be persisted');

const status = functionBody(storage, /String\s+runtimeStatusJson\s*\(/);
const firmwareInfo = functionBody(main, /String\s+runtimeFirmwareInfo\s*\(/);
const exactFields = [
  'app',
  'cardId',
  'firmwareVersion',
  'buildId',
  'bootId',
  'uptimeMs',
  'resetReason',
  'provisioningContractVersion',
  'runtimePhase',
  'commandReady',
  'outputReady',
  'configValid',
  'knownGoodProject',
  'projectRevision',
  'projectFingerprint',
  'productionJobId',
  'productionJobDigest',
  'wiringRevision',
  'wiringDigest',
];
for (const [payload, source] of [['/api/status', status], ['/api/firmware-info', firmwareInfo]]) {
  for (const field of exactFields) {
    assert.match(source, new RegExp(`doc\\["${field}"\\]\\s*=`), `${payload} must serialize exact field ${field}`);
  }
  assert.match(source, /doc\["cardId"\]\s*=\s*runtimeCardId\(\)|doc\["cardId"\]\s*=\s*cardId/,
    `${payload} must use stable card identity`);
}
assert.match(status, /doc\["commandReady"\]\s*=\s*runtimeCommandReady\(\)/,
  'status command readiness must come from live runtime truth');
assert.match(firmwareInfo, /doc\["commandReady"\]\s*=\s*runtimeCommandReady\(\)/,
  'firmware-info command readiness must come from live runtime truth');
assert.match(runtimeApi, /bool\s+runtimeCommandReady\s*\(\)/);
assert.match(runtimeApi, /bool\s+runtimeOutputReady\s*\(\)/);
assert.match(main, /ProvisioningReadinessInputs[\s\S]*webRuntimeServing[\s\S]*ledOutputsReady[\s\S]*transitionPending/,
  'commandReady must require web serving, initialized output, and no transition');

const affectedOutputCount = functionBody(main, /uint8_t\s+runtimeAffectedOutputCount\s*\(/);
const affectedOutputId = functionBody(main, /String\s+runtimeAffectedOutputId\s*\(/);
const outputAffectedByCommand = functionBody(main, /bool\s+runtimeOutputAffectedByCommand\s*\(/);
assert.match(outputAffectedByCommand, /provisioningZoneSelected\s*\(/,
  'affected outputs must follow targeted/current sync-zone application semantics');
for (const source of [affectedOutputCount, affectedOutputId]) {
  assert.match(source, /runtimeOutputAffectedByCommand\s*\(/,
    'affected output evidence must share the exact command-selection helper');
}

const control = functionBody(web, /void\s+handleControlPost\s*\(/);
assert.match(control, /colorOrder[\s\S]*400[\s\S]*invalid color order/,
  'invalid live color order must receive a 4xx acknowledgement');
assert.match(control, /runtimeControlTargetExists\s*\([\s\S]*422/,
  'an unknown zone must be rejected before mutation');
const syncSetter = control.indexOf('runtimeSetSyncZones(');
const preflightAffected = control.indexOf('preflightAffectedOutputCount');
const finalAffected = control.lastIndexOf('runtimeAffectedOutputCount(');
assert.ok(preflightAffected !== -1 && preflightAffected < syncSetter,
  'zero-effect preflight must use prospective sync semantics before mutation');
assert.ok(syncSetter !== -1 && finalAffected > syncSetter,
  'reported affected outputs must be recalculated after requested syncZones is applied');
assert.match(control, /effectiveSyncZones[\s\S]*runtimeAffectedOutputCount\(zoneTarget, effectiveSyncZones\)/,
  'preflight must account for a command that changes syncZones');
assert.match(control, /runtimeAdvanceStateRevision\s*\([\s\S]*affectedOutputCount[\s\S]*affectedOutputs/,
  'successful control acknowledgement must report card-owned affected outputs and state revision');
assert.ok(
  control.indexOf('runtimeAdvanceStateRevision()') < control.indexOf('out["confirmedRevision"]'),
  'caller revision compatibility may be emitted only alongside the prior card-owned applied-state revision',
);

console.log('firmware provisioning status contract tests passed');
