import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const types = readFileSync(resolve(root, 'src/LightweaverTypes.h'), 'utf8');
const header = readFileSync(resolve(root, 'src/LightweaverStorage.h'), 'utf8');
const storage = readFileSync(resolve(root, 'src/LightweaverStorage.cpp'), 'utf8');
const main = readFileSync(resolve(root, 'src/main.cpp'), 'utf8');
const web = readFileSync(resolve(root, 'src/LightweaverWeb.cpp'), 'utf8');

function body(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.ok(start >= 0 && end > start, `could not isolate ${signature}`);
  return source.slice(start, end);
}

test('creative save cannot replace known-good during a wiring transaction', () => {
  const saveBody = body(storage, 'bool saveRuntimeConfigJson(', 'bool stageRuntimeConfigJson(');
  const guardAt = saveBody.indexOf('WIRING_CANDIDATE_NONE');
  const knownGoodWriteAt = saveBody.indexOf('putString(NVS_KNOWN_GOOD_CONFIG_KEY');
  assert.ok(guardAt >= 0 && guardAt < knownGoodWriteAt,
    'save must reject an active wiring transaction before writing known-good');
  assert.match(saveBody, /wiring transaction[^"\n]*active/i);
});

test('persisted boot configs are strict and malformed known-good enters setup safe mode', () => {
  assert.match(storage, /loadNvsConfigKeyStrict\(/);
  const loadBody = body(storage, 'RuntimeLoadResult loadRuntimeConfig(', 'bool saveRuntimeConfigJson(');
  assert.match(loadBody, /loadNvsConfigKeyStrict\(\s*NVS_CANDIDATE_CONFIG_KEY/);
  assert.match(loadBody, /loadNvsConfigKeyStrict\(\s*NVS_KNOWN_GOOD_CONFIG_KEY/);
  assert.match(loadBody, /knownGoodState\s*==\s*ProvisioningStorageState::Present[\s\S]*applyDefaultRuntimeConfig[\s\S]*safeMode\s*=\s*true/);
  const malformedBranch = loadBody.slice(loadBody.indexOf('if (knownGoodState == ProvisioningStorageState::Present)'), loadBody.indexOf('if (!provisioningMayFallBackToSd'));
  assert.doesNotMatch(malformedBranch, /overlayNvsWifi/);
  assert.match(header, /bool safeMode = false;/);
});

test('restart recovery intent is durable and card-hosted restore uses it', () => {
  assert.match(storage, /"recoveryPending"/);
  for (const fn of ['armRuntimeRecoveryAfterRestart', 'runtimeRecoveryAfterRestartPending', 'clearRuntimeRecoveryAfterRestart']) {
    assert.match(header, new RegExp(`\\b${fn}\\s*\\(`));
    assert.match(storage, new RegExp(`\\b${fn}\\s*\\(`));
  }
  const recoverHandler = body(web, 'void handleRecoverLights()', 'void handleIdentify()');
  assert.match(recoverHandler, /armRuntimeRecoveryAfterRestart[\s\S]*(runtimeRollbackWiringCandidate|runtimeStopSafeDiscovery)/);
  assert.match(main, /runtimeRecoveryAfterRestartPending\(\)[\s\S]*runtimeRecoverLights\("warm-white"[\s\S]*clearRuntimeRecoveryAfterRestart/);
  const restoreAction = web.slice(web.indexOf('$(\'restore-wiring\')'), web.indexOf('$(\'find-wire\')'));
  assert.doesNotMatch(restoreAction, /\/api\/wiring\/rollback/);
  assert.match(restoreAction, /rebooting[\s\S]*warm white/i);
});

test('confirming an already-promoted activation is retry-safe', () => {
  assert.match(storage, /"confirmedId"/);
  const confirmBody = body(storage, 'bool confirmCandidateRuntimeConfig(', 'bool rollbackCandidateRuntimeConfig(');
  assert.match(confirmBody, /WIRING_CANDIDATE_NONE[\s\S]*NVS_CONFIRMED_ID_KEY[\s\S]*already confirmed/);
  const runtimeConfirm = body(main, 'bool runtimeConfirmWiringCandidate(', 'bool runtimeRollbackWiringCandidate(');
  assert.doesNotMatch(runtimeConfirm, /if \(!wiringProbationActive\)[\s\S]*return false/);
});

test('malformed or rejected discovery returns non-2xx', () => {
  const discoveryHandler = body(web, 'void handleWiringDiscover()', 'void handleWifiPost()');
  assert.match(discoveryHandler, /deserializeJson[\s\S]*server\.send\(400/);
  assert.match(discoveryHandler, /stepValue\s*<\s*0|stepValue\s*>/);
  assert.match(discoveryHandler, /server\.send\(ok\s*\?\s*200\s*:\s*400/);
});

test('discovery is one approved assignment per rebooted step and never persists project wiring', () => {
  const discovery = body(main, 'String runtimeSafeDiscoveryOutput(', 'bool runtimeStopSafeDiscovery(');
  assert.match(discovery, /LW_DISCOVERY_STEP_COUNT/);
  assert.match(discovery, /factoryBeaconPinForStep\(stepIndex\)/);
  assert.match(discovery, /doc\["pin"\]/);
  assert.match(discovery, /doc\["step"\]/);
  assert.match(discovery, /doc\["stepCount"\]/);
  assert.match(discovery, /doc\["brightnessLimit"\]/);
  assert.match(discovery, /doc\["pixelLimit"\]/);
  assert.match(discovery, /doc\["nextStep"\]/);
  assert.doesNotMatch(discovery, /saveRuntimeConfigJson|stageRuntimeConfigJson|NVS_KNOWN_GOOD_CONFIG_KEY/);
  assert.doesNotMatch(discovery, /assignments\.add|for\s*\([^)]*DISCOVERY_OUTPUT/,
    'a discovery response must not expose multiple active assignments');
});

test('factory reset refuses to claim completion when SD config removal fails', () => {
  const runtimeReset = body(main, 'bool runtimeFactoryReset(', 'void runtimeResetWifi(');
  assert.match(runtimeReset, /SD\.begin\(LW_SD_CS\)/,
    'factory reset must mount SD even when normal boot loaded known-good NVS first');
  assert.match(runtimeReset, /SD\.exists\("\/lightweaver\.json"\)/);
  assert.match(runtimeReset, /SD\.remove\("\/lightweaver\.json"\)/);
  assert.match(runtimeReset, /sd[^"\n]*remove|remove[^"\n]*sd/i);
  assert.ok(runtimeReset.indexOf('SD.remove') < runtimeReset.indexOf('prefs.clear'),
    'SD removal must succeed before NVS is erased');
  assert.ok(runtimeReset.indexOf('SD.begin') < runtimeReset.indexOf('SD.exists'),
    'SD must be mounted before reset decides whether a config exists');
  const webReset = body(web, 'void handleFactoryReset()', 'void handleResetWifi()');
  assert.match(webReset, /runtimeFactoryReset\(message\)/);
  assert.match(webReset, /server\.send\(500/);
  assert.match(webReset, /ESP\.restart\(\)/);
});
