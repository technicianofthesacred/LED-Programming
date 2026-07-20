import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const types = read('src/LightweaverTypes.h');
const storageHeader = read('src/LightweaverStorage.h');
const storage = read('src/LightweaverStorage.cpp');
const runtimeApi = read('src/LightweaverRuntimeApi.h');
const policy = read('src/LightweaverProvisioningPolicy.h');
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
const loadSd = functionBody(storage, /bool\s+loadSdConfig\s*\(/);
const supportedOutputPin = functionBody(storage, /bool\s+supportedOutputPin\s*\(/);
assert.match(supportedOutputPin, /isApprovedProvisioningOutputGpio\s*\(/,
  'runtime config output validation must use the shared approved GPIO policy');
assert.doesNotMatch(supportedOutputPin, /38|39|40|48/,
  'production runtime configs must reject legacy discovery-only GPIOs');
assert.match(load, /loadNvsConfigKeyStrict\(\s*NVS_KNOWN_GOOD_CONFIG_KEY[\s\S]*setRuntimeLoadTruth\(config, result, true, true, false\)/,
  'successfully parsed canonical known-good NVS must become known-good truth');
assert.match(loadSd, /validateRuntimeConfigJsonStrict\s*\(/,
  'SD projects must pass the same strict runtime validation as persisted configs');
assert.match(loadSd, /validateRuntimeConfigJsonStrict\(json, config, message, SOURCE_SD\)/,
  'strict SD parsing must retain SD-specific runtime defaults and behavior');
assert.match(loadSd, /config\.source\s*=\s*SOURCE_SD/,
  'strict SD validation must preserve SD source and project identity for diagnosis');
assert.match(load, /loadSdConfig\([\s\S]*provisioningSdProjectKnownGood\(true, false\)[\s\S]*setRuntimeLoadTruth\(config, result, true, sdKnownGood, false\)/,
  'an unaccepted SD file may be playable but must not claim known-good readiness');
assert.match(policy, /enum class ProvisioningStorageState[\s\S]*Absent[\s\S]*Present[\s\S]*Error/,
  'persisted config access must distinguish absent, present, and storage errors');
assert.match(storage, /ProvisioningStorageState\s+migrateLegacyKnownGood\s*\(/,
  'legacy migration must return tri-state storage truth');
assert.match(storage, /ProvisioningStorageState\s+loadNvsConfigKeyStrict\s*\(/,
  'strict NVS reads must return tri-state storage truth');
assert.match(load, /migrationState[\s\S]*provisioningStorageReadFailed\(migrationState\)[\s\S]*safeMode\s*=\s*true[\s\S]*return result/,
  'migration/open failure must enter safe recovery before any SD fallback');
assert.match(load, /knownGoodState[\s\S]*provisioningStorageReadFailed\(knownGoodState\)[\s\S]*safeMode\s*=\s*true[\s\S]*return result/,
  'known-good read failure must enter safe recovery before any SD fallback');
assert.match(load, /provisioningMayFallBackToSd\(migrationState, knownGoodState\)/,
  'production SD fallback must be linked to the native-tested storage policy');
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
const patternAffectsAllOutputs = functionBody(main, /bool\s+runtimePatternAffectsAllOutputs\s*\(/);
const canStepPattern = functionBody(main, /bool\s+runtimeCanStepPattern\s*\(/);
assert.match(outputAffectedByCommand, /provisioningZoneSelected\s*\(/,
  'affected outputs must follow targeted/current sync-zone application semantics');
assert.match(outputAffectedByCommand, /ProvisioningOutputScope::AllOutputs[\s\S]*return\s+true/,
  'physical-global operations must include every active output');
assert.match(patternAffectsAllOutputs, /targetId\.length\(\)[\s\S]*findLookByExactId[\s\S]*findLookByPresetAlias/,
  'empty-target loaded looks must be recognized as global transitions');
assert.match(runtimeApi, /bool\s+runtimeCanStepPattern\s*\(int8_t direction\)/,
  'the web transaction must be able to preflight loaded-look steps');
assert.match(canStepPattern, /provisioningLookStepChangesSelection\s*\([\s\S]*isLoadedLookRenderable\s*\(/,
  'step preflight must prove both a different selected index and a renderable destination');
for (const source of [affectedOutputCount, affectedOutputId]) {
  assert.match(source, /runtimeOutputAffectedByCommand\s*\(/,
    'affected output evidence must share the exact command-selection helper');
}

const control = functionBody(web, /void\s+handleControlPost\s*\(/);
const commandGate = control.indexOf('provisioningControlAdmitted(runtimeCommandReady())');
const deserialize = control.indexOf('deserializeJson(');
assert.ok(commandGate !== -1 && commandGate < deserialize,
  'control admission must reject an unready card before parsing or applying intent');
for (const field of ['cardId', 'bootId', 'runtimePhase', 'commandReady']) {
  assert.match(control.slice(commandGate, deserialize), new RegExp(`rejected\\["${field}"\\]\\s*=`),
    `unready control rejection must report ${field}`);
}
assert.match(control.slice(commandGate, deserialize), /server\.send\((409|423)[\s\S]*return;/,
  'unready control requests must return a lock/conflict response immediately');
assert.doesNotMatch(control.slice(commandGate, deserialize), /stateRevision|confirmedRevision|runtimeAdvanceStateRevision/,
  'unready control rejection must not echo or advance revisions');
for (const handlerName of [
  'handleConfigPost',
  'handleWiringCandidate',
  'handleWiringActivate',
  'handleWiringConfirm',
  'handleWiringRollback',
  'handleWiringDiscover',
  'handleRecoverLights',
]) {
  const provisioningHandler = functionBody(
      web, new RegExp(`void\\s+${handlerName}\\s*\\(`));
  assert.doesNotMatch(provisioningHandler, /runtimeCommandReady|provisioningControlAdmitted/,
    `${handlerName} must remain available while runtime control is locked`);
}
const identifyHandler = functionBody(web, /void\s+handleIdentify\s*\(/);
assert.match(identifyHandler, /provisioningControlAdmitted\(runtimeCommandReady\(\)\)/,
  'identify must share the command-readiness gate');
assert.ok(identifyHandler.indexOf('provisioningControlAdmitted(runtimeCommandReady())') <
          identifyHandler.indexOf('runtimeTriggerIdentify()'),
  'identify must reject before changing output ownership');
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
assert.match(control, /patternAffectsAllOutputs\s*=\s*patternRequested\s*&&[\s\S]*runtimePatternAffectsAllOutputs/,
  'loaded/global pattern scope must come from runtime pattern behavior');
assert.match(control, /nextCanChange\s*=\s*nextRequested\s*&&\s*runtimeCanStepPattern\(1\)/,
  'next must be preflighted before it contributes output scope');
assert.match(control, /previousCanChange\s*=\s*previousRequested\s*&&\s*runtimeCanStepPattern\(-1\)/,
  'previous must be preflighted before it contributes output scope');
assert.match(control, /cancelStreamEffective\s*=\s*provisioningCancelStreamEffective\(\s*cancelStreamRequested,\s*runtimeIsStreaming\(\)\)/,
  'cancel stream scope must derive from a native-tested live-stream preflight');
assert.match(control, /scopeInputs\.globalOutputs\s*=\s*colorOrderRequested[\s\S]*nextCanChange[\s\S]*previousCanChange[\s\S]*patternAffectsAllOutputs/,
  'only effective loaded-look steps may promote mixed commands to all-output scope');
assert.match(control, /scopeInputs\.globalOutputs\s*=[^;]*cancelStreamEffective/,
  'only an active-stream cancellation may promote mixed commands to all-output scope');
assert.doesNotMatch(control, /scopeInputs\.globalOutputs\s*=[^;]*cancelStreamRequested/,
  'a no-op cancel request must not create all-output scope by presence alone');
assert.doesNotMatch(control, /scopeInputs\.globalOutputs\s*=\s*[^;]*nextRequested/,
  'a no-op next request must not create all-output scope by presence alone');
assert.match(control, /if\s*\(nextCanChange\)\s*runtimeNextPattern\(\)/,
  'a rejected no-op next must not mutate runtime state');
assert.match(control, /if\s*\(previousCanChange\)\s*runtimePreviousPattern\(\)/,
  'a rejected no-op previous must not mutate runtime state');
assert.match(control, /scopeInputs\.selectedZones\s*=/,
  'zone-scoped controls must request selected-zone evidence');
assert.match(control, /scopeInputs\.syncStateChanged\s*=\s*syncStateChanged/,
  'sync-only state changes must have an explicit tested output scope');
assert.match(control, /ProvisioningOutputScope\s+operationScope\s*=\s*provisioningOperationScope\(scopeInputs\)/,
  'mixed command scope must be the policy union of requested operations');
assert.match(control, /runtimeAffectedOutputCount\(zoneTarget, effectiveSyncZones, operationScope\)/,
  'preflight must use operation-specific prospective scope');
assert.match(control, /provisioningControlAdvancesRevision\(\s*true,\s*operationScope,\s*preflightAffectedOutputCount\)/,
  'zero-effect rejection and revision admission must use the native-tested effect policy');
assert.match(control, /if\s*\(cancelStreamEffective\)\s*runtimeCancelStream\(\)/,
  'standalone no-op cancel must not mutate the frame source');
const zeroEffectReject = control.indexOf('command affects zero outputs');
assert.ok(zeroEffectReject !== -1 && zeroEffectReject < control.indexOf('runtimeNextPattern()') &&
    zeroEffectReject < control.indexOf('runtimeAdvanceStateRevision()'),
  'zero-look and one-look step requests must reject before mutation, revision echo, or card revision advance');
assert.match(control, /runtimeAdvanceStateRevision\s*\([\s\S]*affectedOutputCount[\s\S]*affectedOutputs/,
  'successful control acknowledgement must report card-owned affected outputs and state revision');
assert.ok(
  control.indexOf('runtimeAdvanceStateRevision()') < control.indexOf('out["confirmedRevision"]'),
  'caller revision compatibility may be emitted only alongside the prior card-owned applied-state revision',
);

assert.match(setup, /startLook\(currentLookIndex\)[\s\S]*startWiringProbation\(loadResult\.bootedCandidate\)/,
  'candidate physical startup frame must remain independent from the web command-admission gate');

console.log('firmware provisioning status contract tests passed');
