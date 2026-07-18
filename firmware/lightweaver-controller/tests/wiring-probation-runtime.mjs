import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const api = readFileSync(resolve(root, 'src/LightweaverRuntimeApi.h'), 'utf8');
const main = readFileSync(resolve(root, 'src/main.cpp'), 'utf8');

assert.match(main, /uint32_t wiringProbationDeadlineMs = 0;/);
assert.match(main, /bool wiringProbationActive = false;/);

const setupStart = main.indexOf('void setup() {');
const loopStart = main.indexOf('void loop() {', setupStart);
const setup = main.slice(setupStart, loopStart);
const outputsReady = setup.indexOf('if (!setupLedOutputs())');
const visibleFrame = setup.indexOf('fadeTo(1.0f');
const probationStart = setup.indexOf('startWiringProbation(', visibleFrame);
assert.ok(outputsReady > -1 && visibleFrame > outputsReady, 'outputs must initialize before the visible startup frame');
assert.ok(probationStart > visibleFrame, 'probation must start only after a visible frame is submitted');
assert.match(setup, /if \(!setupLedOutputs\(\)\)[\s\S]*rollbackCandidateBeforeRestart/);

const loop = main.slice(loopStart, main.indexOf('void applyRuntimeConfig(', loopStart));
assert.match(loop, /wiringProbationActive[\s\S]*int32_t\(millis\(\) - wiringProbationDeadlineMs\) >= 0[\s\S]*rollbackCandidateBeforeRestart/);

for (const fn of [
  'runtimeWiringSafetyStatus',
  'runtimeActivateWiringCandidate',
  'runtimeConfirmWiringCandidate',
  'runtimeRollbackWiringCandidate',
  'runtimeSafeDiscoveryOutput',
]) {
  assert.match(api, new RegExp(`\\b${fn}\\s*\\(`), `runtime API should expose ${fn}`);
  assert.match(main, new RegExp(`\\b${fn}\\s*\\(`), `main runtime should implement ${fn}`);
}

assert.match(main, /bool runtimeConfirmWiringCandidate[\s\S]*confirmCandidateRuntimeConfig/);
assert.match(main, /bool runtimeRollbackWiringCandidate[\s\S]*rollbackCandidateRuntimeConfig/);
assert.match(api, /runtimeActivateWiringCandidate\(const String& activationId, String& message\)/);
assert.match(api, /runtimeConfirmWiringCandidate\(const String& activationId, String& message\)/);
assert.match(api, /runtimeRollbackWiringCandidate\(const String& activationId, String& message\)/);
assert.doesNotMatch(main, /MIRROR_OUTPUT_PINS/, 'normal runtime must register only explicitly configured outputs');
assert.match(main, /LW_DISCOVERY_BATCH_SIZE\s*=\s*4/, 'safe discovery must expose no more than four GPIOs per batch');
assert.match(main, /LW_DISCOVERY_PIXELS_PER_OUTPUT/);
assert.match(main, /bool setupSafeDiscoveryOutputs\(uint8_t batchIndex\)/);
assert.match(main, /setupSafeDiscoveryOutputs\(wiringSafety\.discoveryBatchIndex\)/,
  'boot must register the persisted discovery batch instead of normal outputs');
assert.match(main, /if \(safeDiscoveryMode\)[\s\S]*showSafeDiscoveryFrame\(\)[\s\S]*return;/,
  'discovery mode must continuously hold the physical color assignments');

const discoverySetupStart = main.indexOf('bool setupSafeDiscoveryOutputs(uint8_t batchIndex) {');
const discoverySetupEnd = main.indexOf('void showSafeDiscoveryFrame()', discoverySetupStart);
assert.ok(discoverySetupStart > -1 && discoverySetupEnd > discoverySetupStart);
const discoverySetup = main.slice(discoverySetupStart, discoverySetupEnd);
assert.match(discoverySetup, /start \+ LW_DISCOVERY_BATCH_SIZE/);
assert.match(discoverySetup, /addLedsForPin/);
assert.match(discoverySetup, /discoveryPinAvailable\(DISCOVERY_OUTPUT_PINS\[i\]\)/,
  'discovery must never drive a GPIO currently assigned to a physical control');
// Discovery brightness is now applied through the central transmit path:
// setup renders via showSafeDiscoveryFrame(), whose transmit call pins the
// capped LW_DISCOVERY_BRIGHTNESS (transmitPhysicalLeds -> FastLED.setBrightness).
assert.match(discoverySetup, /showSafeDiscoveryFrame\(\)/);
const discoveryFrameStart = main.indexOf('void showSafeDiscoveryFrame() {');
const discoveryFrameEnd = main.indexOf('\n}', discoveryFrameStart);
assert.ok(discoveryFrameStart > -1 && discoveryFrameEnd > discoveryFrameStart);
const discoveryFrame = main.slice(discoveryFrameStart, discoveryFrameEnd);
assert.match(discoveryFrame, /transmitPhysicalLeds\(LW_DISCOVERY_BRIGHTNESS/,
  'discovery frames must transmit at the capped discovery brightness');
assert.match(main, /void transmitPhysicalLeds\(uint8_t brightnessByte[^]*?FastLED\.setBrightness\(brightnessByte\)/,
  'the central transmit path must apply the requested brightness byte');

const safeDiscoveryStart = main.indexOf('String runtimeSafeDiscoveryOutput(uint8_t batchIndex)');
const safeDiscoveryEnd = main.indexOf('bool runtimeStopSafeDiscovery', safeDiscoveryStart);
assert.ok(safeDiscoveryStart > -1 && safeDiscoveryEnd > safeDiscoveryStart);
assert.match(main.slice(safeDiscoveryStart, safeDiscoveryEnd), /setRuntimeWiringDiscoveryBatch/,
  'requesting discovery must persist the batch for a reboot into discovery-only controllers');

for (const field of ['"state"', '"currentOutputs"', '"remainingProbationMs"', '"nextStep"', '"outputsReady"']) {
  assert.ok(main.includes(field), `canonical wiring status must include ${field}`);
}

console.log('wiring-probation-runtime tests passed');
