import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const policy = readFileSync(resolve(root, 'src/LightweaverProvisioningPolicy.h'), 'utf8');
const hardware = readFileSync(resolve(root, 'src/LightweaverHardwareContract.h'), 'utf8');
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

assert.match(policy, /LW_APPROVED_OUTPUT_GPIOS[\s\S]*LW_CARD_HARDWARE_OUTPUT_GPIOS/,
  'provisioning must consume the generated hardware contract');
// The pin menu is contract data, not a firmware literal — pinning the numbers
// here would just be a second place to forget to update. What matters for the
// beacon is that the header's list IS the manifest's list, so a blank card
// pulses exactly the GPIOs Studio offers.
const manifestPins = JSON.parse(
  readFileSync(resolve(root, '../../packages/lightweaver-contract/card-hardware.json'), 'utf8'),
).outputPins;
assert.match(
  hardware,
  new RegExp(`LW_CARD_HARDWARE_OUTPUT_GPIOS\\[\\]\\s*=\\s*\\{${manifestPins.join(', ')}\\}`),
  'the generated header must list exactly the manifest output GPIOs',
);
assert.match(policy, /LW_FACTORY_BEACON_PIXEL_LIMIT\s*=\s*8/);
assert.match(policy, /LW_FACTORY_BEACON_BRIGHTNESS_LIMIT\s*=\s*24/,
  'the beacon must use the brightest approved bench-safe level');
assert.match(policy, /LW_FACTORY_BEACON_MAX_MILLIAMPS\s*=\s*100/);
assert.match(policy, /LW_FACTORY_BEACON_STEP_MS\s*=\s*3000/,
  'each output must stay selected long enough for a clear human observation');
assert.match(policy, /factoryBeaconPulseOn[\s\S]*<\s*LW_FACTORY_BEACON_STEADY_ON_MS[\s\S]*>=\s*LW_FACTORY_BEACON_SECOND_ON_START_MS[\s\S]*<\s*LW_FACTORY_BEACON_SECOND_ON_END_MS/,
  'the visibility pattern must provide a long steady hold and a distinct second pulse');

// The beacon runs with NO config at all, writing one 8-pixel slice per approved
// GPIO into physicalLeds. Now that the buffers are boot-allocated from the
// config's own totalPixels, a blank card would allocate nothing without a floor
// — so the floor has to cover every slice, and the compiler has to enforce it.
assert.match(main, /constexpr uint16_t LW_MIN_ALLOCATED_PIXELS = (\d+);/,
  'the boot allocation must declare a floor for the config-less beacon path');
assert.match(
  main,
  /static_assert\(LW_APPROVED_OUTPUT_GPIO_COUNT \* LW_FACTORY_BEACON_PIXEL_LIMIT <=\s*LW_MIN_ALLOCATED_PIXELS,/,
  'widening the pin menu past the allocation floor must fail the build, not scribble past the buffer',
);
assert.ok(
  manifestPins.length * 8 <= Number(main.match(/constexpr uint16_t LW_MIN_ALLOCATED_PIXELS = (\d+);/)[1]),
  'every approved GPIO beacon slice must fit inside the allocation floor',
);

const factorySetup = functionBody(main, 'bool setupFactoryBeaconOutputs()', 'bool setupSafeDiscoveryOutputs(');
assert.match(factorySetup, /LW_APPROVED_OUTPUT_GPIO_COUNT/);
assert.match(factorySetup, /addLedsForPin\(LW_APPROVED_OUTPUT_GPIOS\[i\]/);
assert.match(factorySetup, /LW_FACTORY_BEACON_PIXEL_LIMIT/);
assert.doesNotMatch(factorySetup, /38|39|40|48/);

const normalSetup = functionBody(main, 'bool setupLedOutputs()', 'bool setupFactoryBeaconOutputs()');
const rejectEmptyAt = normalSetup.indexOf('outputCount == 0');
const readyAt = normalSetup.indexOf('ledOutputsReady = true');
assert.ok(rejectEmptyAt >= 0 && rejectEmptyAt < readyAt,
  'normal output setup must reject an empty output configuration before reporting ready');
assert.match(normalSetup.slice(rejectEmptyAt, readyAt), /return false;/,
  'empty normal output setup must fail instead of registering zero controllers');

const factoryFrame = functionBody(main, 'void showFactoryBeaconFrame()', 'void showSafeDiscoveryFrame()');
assert.match(factoryFrame, /FactoryBeaconOwnershipInputs/);
assert.match(factoryFrame, /factoryBeaconMayOwnOutput/);
assert.match(factoryFrame, /LW_FACTORY_BEACON_SAFETY_POLL_MS/,
  'the factory animation must not read NVS on every 10ms frame');
assert.match(factoryFrame, /clearPhysicalLeds\(\)/,
  'every factory beacon step must first submit black to every registered output');
// The frame used to re-derive its pin with factoryBeaconPinForStep(step), walking
// the whole approved list independently of what setupFactoryBeaconOutputs had
// actually registered. Once the pin menu widened past the four default control
// GPIOs those two lists disagreed: registration skipped 4/5/6/7 as control pins
// while the sweep kept pulsing them, so a blank card sat dark for the first 12
// seconds of every cycle and read as dead — on the exact state the beacon exists
// to make legible. The step list is now built by registration itself, so the
// sweep can only address a slot FastLED was actually given. Re-deriving the pin
// here would reintroduce the second list; that is what this guards.
assert.match(factoryFrame, /factoryBeaconSteps\[/,
  'the beacon frame must address only slots registration recorded, never a re-derived pin list');
assert.doesNotMatch(factoryFrame, /factoryBeaconPinForStep/,
  'the beacon frame must not re-derive its pin independently of what was registered');
assert.match(factoryFrame, /factoryBeaconStepCount/,
  'the sweep length must come from the registered-output count, not the approved-GPIO count');
assert.match(factoryFrame, /LW_FACTORY_BEACON_PIXEL_LIMIT/);
assert.match(factoryFrame, /transmitPhysicalLeds\(LW_FACTORY_BEACON_BRIGHTNESS_LIMIT/);
assert.equal((factoryFrame.match(/fill_solid\(physicalLeds \+ bufferStart/g) || []).length, 1,
  'only one approved output slice may receive non-black data');

const wiringSafety = functionBody(storage, 'WiringSafetyStatus getRuntimeWiringSafetyStatus()', 'String runtimeWiringSafetyStatusJson()');
assert.match(wiringSafety,
  /prefs\.isKey\(NVS_KNOWN_GOOD_CONFIG_KEY\)[\s\S]*prefs\.getString\(NVS_KNOWN_GOOD_CONFIG_KEY/,
  'an erased card must not call getString for a missing known-good key');
assert.match(wiringSafety,
  /prefs\.isKey\(NVS_CANDIDATE_CONFIG_KEY\)[\s\S]*prefs\.getString\(NVS_CANDIDATE_CONFIG_KEY/,
  'an erased card must not call getString for a missing candidate key');

const discoverySetup = functionBody(main, 'bool setupSafeDiscoveryOutputs(uint8_t stepIndex)', 'void showFactoryBeaconFrame()');
assert.match(discoverySetup, /factoryBeaconPinForStep\(stepIndex\)/);
assert.equal((discoverySetup.match(/addLedsForPin\(/g) || []).length, 1,
  'discovery must register exactly one controller per rebooted step');
assert.match(discoverySetup, /LW_FACTORY_BEACON_PIXEL_LIMIT/);

for (const [handler, nextHandler] of [
  ['void handleReboot()', 'void handleControlPost();'],
  ['void handleResetWifi()', 'void handleRenamePost()'],
]) {
  const transition = functionBody(web, handler, nextHandler);
  const markAt = transition.indexOf('runtimeMarkRestartPending()');
  assert.ok(markAt >= 0 && markAt < transition.indexOf('server.send(200'),
    `${handler} must black the factory beacon before acknowledging a WiFi/restart transition`);
}
const wifiPost = functionBody(web, 'void handleWifiPost()', 'void handleWifiScan()');
assert.doesNotMatch(wifiPost, /runtimeMarkRestartPending|clearPhysicalLeds|FastLED/,
  'nonblocking WiFi association must not stop factory or known-good LED playback');
const stopDiscovery = functionBody(main, 'bool runtimeStopSafeDiscovery(', 'String runtimeRecoverLights(');
assert.match(stopDiscovery, /if \(stopped\) runtimeMarkRestartPending\(\)/,
  'stopping discovery must submit black before its reboot delay');
const recover = functionBody(main, 'String runtimeRecoverLights(', 'String runtimeZonesJson(');
assert.match(recover, /if \(factoryBeaconMode\) clearPhysicalLeds\(\)/,
  'factory recovery must black the beacon before recovery owns output');
const setup = functionBody(main, 'void setup()', 'void loop()');
assert.match(setup, /provisioningUsesFactoryBeacon\(runtimeConfig\.runtimePhase, outputCount\)/,
  'factory and zero-output recovery boots must use the visible factory beacon path');
const factoryCondition = setup.indexOf('provisioningUsesFactoryBeacon(runtimeConfig.runtimePhase, outputCount)');
const factoryBranch = setup.slice(factoryCondition, setup.indexOf('} else {', factoryCondition));
assert.match(factoryBranch, /runtimeRecoveryAfterRestartPending\(\)/);
assert.match(factoryBranch, /clearRuntimeRecoveryAfterRestart/,
  'a factory boot must complete recovery intent without starting normal project output');
const identify = functionBody(web, 'void handleIdentify()', 'void handleZones()');
// runtimePlaybackReady still demands phase Ready + configValid + a known-good
// project, so a factory card is refused; it only stops a WiFi transition from
// withholding light output on an already-commissioned card.
assert.match(identify, /provisioningControlAdmitted\(runtimePlaybackReady\(\)\)/,
  'identify must not take output ownership on a factory card');

const loop = functionBody(main, 'void loop()', 'void applyRuntimeConfig(');
assert.doesNotMatch(loop,
  /runtimeConfig\.activeTransport\s*==\s*WIFI_TRANSPORT_AP[\s\S]{0,600}fill_solid/,
  'recovery AP transport alone must never replace a commissioned project with a beacon');
assert.match(factoryBranch, /factoryBeaconMode\s*=\s*true/,
  'the factory-alive beacon remains restricted to the genuinely blank factory branch');

const outputReady = functionBody(main, 'bool runtimeOutputReady()', 'bool runtimeConfigValid()');
assert.match(outputReady, /provisioningOutputReady\(ledOutputsReady, outputCount\)/,
  'public output readiness must require a configured project output');
const wiringStatus = functionBody(main, 'String runtimeWiringSafetyStatus()', 'bool runtimeActivateWiringCandidate(');
assert.match(wiringStatus, /doc\["outputsReady"\]\s*=\s*runtimeOutputReady\(\)/,
  'wiring status must not expose controller-only readiness as project output readiness');

console.log('factory-beacon-safety tests passed');
