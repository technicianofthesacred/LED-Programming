import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const policy = readFileSync(resolve(root, 'src/LightweaverProvisioningPolicy.h'), 'utf8');
const storage = readFileSync(resolve(root, 'src/LightweaverStorage.cpp'), 'utf8');
const main = readFileSync(resolve(root, 'src/main.cpp'), 'utf8');
const web = readFileSync(resolve(root, 'src/LightweaverWeb.cpp'), 'utf8');

function functionBody(source, signature, nextSignature) {
  let start = source.indexOf(signature);
  while (start >= 0) {
    const brace = source.indexOf('{', start);
    const semicolon = source.indexOf(';', start);
    if (brace >= 0 && (semicolon < 0 || brace < semicolon)) {
      const end = source.indexOf(nextSignature, brace);
      assert.ok(end > brace, `could not isolate ${signature}`);
      return source.slice(start, end);
    }
    start = source.indexOf(signature, semicolon + 1);
  }
  throw new Error(`could not isolate ${signature}`);
}

const defaults = functionBody(storage, 'void applyDefaultRuntimeConfig(', 'void ensureDefaultZone(');
assert.match(defaults, /config\.outputCount\s*=\s*0/,
  'compiled factory defaults must not create a normal project output');
assert.match(defaults, /config\.lookCount\s*=\s*0/,
  'compiled factory defaults must not create a normal project playlist');
assert.match(defaults, /config\.zoneCount\s*=\s*0/,
  'compiled factory defaults must not create a normal project zone');
for (const identity of ['pieceId', 'projectFingerprint', 'productionJobId', 'productionJobDigest', 'wiringDigest']) {
  assert.match(defaults, new RegExp(`config\\.${identity}\\s*=\\s*""`),
    `compiled defaults must blank ${identity}`);
}
assert.match(defaults, /config\.startupLookId\s*=\s*""/);
assert.match(defaults, /config\.ledColorOrder\s*=\s*""/);
assert.doesNotMatch(defaults, /pin\s*=\s*16|pixels\s*=\s*44|"aurora"|"RGB"/,
  'compiled defaults must not masquerade as the historical GPIO16/44/RGB/Aurora project');

assert.match(policy, /LW_APPROVED_OUTPUT_GPIOS\[\]\s*=\s*\{16, 17, 18, 21\}/);
assert.match(policy, /LW_FACTORY_BEACON_PIXEL_LIMIT\s*=\s*8/);
assert.match(policy, /LW_FACTORY_BEACON_BRIGHTNESS_LIMIT\s*=\s*(?:1[0-9]|2[0-4])/);
assert.match(policy, /LW_FACTORY_BEACON_MAX_MILLIAMPS\s*=\s*100/);

const factorySetup = functionBody(main, 'bool setupFactoryBeaconOutputs()', 'bool setupSafeDiscoveryOutputs(');
assert.match(factorySetup, /LW_APPROVED_OUTPUT_GPIO_COUNT/);
assert.match(factorySetup, /addLedsForPin\(LW_APPROVED_OUTPUT_GPIOS\[i\]/);
assert.match(factorySetup, /LW_FACTORY_BEACON_PIXEL_LIMIT/);
assert.doesNotMatch(factorySetup, /38|39|40|48/);

const factoryFrame = functionBody(main, 'void showFactoryBeaconFrame()', 'void showSafeDiscoveryFrame()');
assert.match(factoryFrame, /FactoryBeaconOwnershipInputs/);
assert.match(factoryFrame, /factoryBeaconMayOwnOutput/);
assert.match(factoryFrame, /clearPhysicalLeds\(\)/,
  'every factory beacon step must first submit black to every registered output');
assert.match(factoryFrame, /factoryBeaconPinForStep/);
assert.match(factoryFrame, /LW_FACTORY_BEACON_PIXEL_LIMIT/);
assert.match(factoryFrame, /transmitPhysicalLeds\(LW_FACTORY_BEACON_BRIGHTNESS_LIMIT/);
assert.equal((factoryFrame.match(/fill_solid\(physicalLeds \+ bufferStart/g) || []).length, 1,
  'only one approved output slice may receive non-black data');

const discoverySetup = functionBody(main, 'bool setupSafeDiscoveryOutputs(uint8_t stepIndex)', 'void showFactoryBeaconFrame()');
assert.match(discoverySetup, /factoryBeaconPinForStep\(stepIndex\)/);
assert.equal((discoverySetup.match(/addLedsForPin\(/g) || []).length, 1,
  'discovery must register exactly one controller per rebooted step');
assert.match(discoverySetup, /LW_FACTORY_BEACON_PIXEL_LIMIT/);

for (const [handler, nextHandler] of [
  ['void handleWifiPost()', 'void handleWifiScan()'],
  ['void handleReboot()', 'void handleControlPost();'],
  ['void handleResetWifi()', 'void handleRenamePost()'],
]) {
  const transition = functionBody(web, handler, nextHandler);
  const markAt = transition.indexOf('runtimeMarkRestartPending()');
  assert.ok(markAt >= 0 && markAt < transition.indexOf('server.send(200'),
    `${handler} must black the factory beacon before acknowledging a WiFi/restart transition`);
}
const stopDiscovery = functionBody(main, 'bool runtimeStopSafeDiscovery(', 'String runtimeRecoverLights(');
assert.match(stopDiscovery, /if \(stopped\) runtimeMarkRestartPending\(\)/,
  'stopping discovery must submit black before its reboot delay');
const recover = functionBody(main, 'String runtimeRecoverLights(', 'String runtimeZonesJson(');
assert.match(recover, /if \(factoryBeaconMode\) clearPhysicalLeds\(\)/,
  'factory recovery must black the beacon before recovery owns output');
const setup = functionBody(main, 'void setup()', 'void loop()');
const factoryBranch = setup.slice(setup.indexOf('ProvisioningPhase::Factory'), setup.indexOf('} else {', setup.indexOf('ProvisioningPhase::Factory')));
assert.match(factoryBranch, /runtimeRecoveryAfterRestartPending\(\)/);
assert.match(factoryBranch, /clearRuntimeRecoveryAfterRestart/,
  'a factory boot must complete recovery intent without starting normal project output');

console.log('factory-beacon-safety tests passed');
