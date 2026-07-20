import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const types = read('src/LightweaverTypes.h');
const storage = read('src/LightweaverStorage.cpp');
const storageHeader = read('src/LightweaverStorage.h');
const runtimeApi = read('src/LightweaverRuntimeApi.h');
const main = read('src/main.cpp');
const web = read('src/LightweaverWeb.cpp');

function functionBody(source, signature) {
  const match = source.match(signature);
  assert.ok(match, `missing function matching ${signature}`);
  const start = match.index;
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `missing body for ${signature}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

assert.match(web, /#include "LightweaverConnectivityPolicy\.h"/,
  'firmware orchestration must use the native-tested connectivity policy');
assert.match(types, /struct WifiRuntimeState\s*{[\s\S]*ConnectivityState[\s\S]*stationIp[\s\S]*lastError[\s\S]*attemptCount[\s\S]*};/,
  'transient WiFi truth must be separate from saved credentials and include transition/retry metadata');
assert.match(types, /struct RuntimeConfig\s*{[\s\S]*WifiConfig wifi;[\s\S]*WifiRuntimeState wifiRuntime;/,
  'runtime configuration must carry live WiFi truth separately from WifiConfig');

const saveWifi = functionBody(storage, /bool\s+saveWifiConfigJson\s*\(/);
assert.match(storageHeader, /bool\s+saveWifiConfigJson\s*\(const String& json, RuntimeConfig& config, String& message\)/,
  'WiFi persistence interface must report failure before runtime mutation');
assert.match(saveWifi, /doc\.is<JsonObject>\(\)/,
  'WiFi JSON root must be an object');
for (const field of ['ssid', 'password', 'hostname']) {
  assert.match(saveWifi, new RegExp(`doc\\["${field}"\\]\\.is<const char\\*>\\(\\)`),
    `${field} must be type checked`);
}
for (const optionalField of ['password', 'hostname']) {
  assert.match(saveWifi, new RegExp(`${optionalField}Value\\.isUnbound\\(\\)[\\s\\S]{0,100}!${optionalField}Value\\.is<const char\\*>`),
    `explicit null ${optionalField} must not bypass string validation`);
}
assert.match(saveWifi, /ssid\.length\(\)[\s\S]*32/,
  'SSID must be bounds checked');
assert.match(saveWifi, /password\.length\(\)[\s\S]*63/,
  'password must be bounds checked');
assert.match(saveWifi, /hostname\.length\(\)[\s\S]*32/,
  'hostname must be bounds checked');
assert.ok(saveWifi.indexOf('prefs.putString') < saveWifi.indexOf('config.wifi = candidate'),
  'runtime credentials must change only after persistence succeeds');

const wifiPost = functionBody(web, /void\s+handleWifiPost\s*\(/);
assert.match(wifiPost, /beginStationJoin\s*\(/,
  'accepted credentials must immediately begin a nonblocking association');
assert.match(wifiPost, /server\.send\(202/,
  'WiFi save must return HTTP 202 Accepted');
for (const field of ['accepted', 'transition', 'handoffGeneration']) {
  assert.match(wifiPost, new RegExp(`response\\["${field}"\\]\\s*=`),
    `WiFi save acknowledgement must expose ${field}`);
}
assert.doesNotMatch(wifiPost, /runtimeMarkRestartPending|ESP\.restart|delay\s*\(/,
  'WiFi handoff must not misuse permanent restart-pending state or reboot');
assert.doesNotMatch(web, /Saved\. Rebooting[^'\"]*/,
  'the setup page must not claim an accepted nonblocking handoff will reboot');

assert.doesNotMatch(web, /bool\s+tryStationJoin\s*\(/,
  'boot association must not use the old blocking STA-only join');
assert.doesNotMatch(web, /while\s*\(WiFi\.status\(\)[\s\S]{0,300}delay\s*\(/,
  'station association must never freeze rendering while polling');
const setupWeb = functionBody(web, /void\s+setupLightweaverWeb\s*\(/);
assert.match(setupWeb, /startApMode\s*\([\s\S]*beginStationJoin\s*\(/,
  'boot with saved credentials must use the same reachable AP+STA lifecycle');
const beginJoin = functionBody(web, /void\s+beginStationJoin\s*\([^;]*\)\s*\{/);
assert.match(beginJoin, /apTeardownScheduled\s*=\s*false[\s\S]*attemptCount\s*=\s*0[\s\S]*CredentialsAccepted/,
  'new credentials must replace pending teardown and retry metadata before starting a new generation');

const ack = functionBody(web, /void\s+handleWifiHandoffAck\s*\(/);
assert.match(ack, /handoffGeneration/,
  'handoff acknowledgement must require a generation');
assert.match(ack, /generation\s*==\s*0|generation\s*!=/,
  'handoff acknowledgement must validate the current nonzero generation');
assert.match(ack, /server\.client\(\)\.localIP\(\)\s*==\s*WiFi\.localIP\(\)/,
  'handoff proof must use the local socket address, not Host');
assert.doesNotMatch(ack, /host|Host/,
  'handoff proof must not trust the Host header');
assert.match(ack, /server\.send\(409/,
  'AP-interface handoff acknowledgements must preserve AP reachability with 409');
const sent = ack.indexOf('server.send(200');
const flushed = ack.indexOf('server.client().flush()', sent);
const scheduled = ack.indexOf('scheduleApTeardown', flushed);
assert.ok(sent !== -1 && flushed > sent && scheduled > flushed,
  'acknowledgement must be sent and flushed before AP teardown is scheduled');
assert.ok(web.includes('server.on("/api/wifi/handoff-ack", HTTP_POST, handleWifiHandoffAck)'),
  'approved handoff acknowledgement route must be registered');

const connectivity = functionBody(web, /void\s+maintainConnectivity\s*\(/);
assert.match(connectivity, /advanceConnectivity\s*\(/,
  'runtime lifecycle must be driven by the tested pure policy');
assert.match(connectivity, /WL_CONNECTED[\s\S]*HandoffReady|StationAssociated/,
  'association must enter handoff-ready while AP remains available');
assert.match(connectivity, /station association timed out[\s\S]*startApMode|SetupAp[\s\S]*startApMode/,
  'failed initial association must leave or restore a reachable setup AP');
const associated = functionBody(web, /void\s+recordStationAssociation\s*\(/);
assert.match(associated, /announceMdns[\s\S]*wledRealtimeRebind/,
  'association must refresh mDNS and existing realtime binding');
assert.match(connectivity, /kHandoffGraceMs|advanceConnectivity[\s\S]*Tick/,
  'a still-associated station may retire the AP after the tested grace period');

assert.match(runtimeApi, /void\s+runtimeSetWifiTransitionPending\s*\(bool pending\)/,
  'web orchestration must expose a dedicated WiFi readiness interlock');
assert.match(main, /bool\s+wifiTransitionPending\s*=\s*false/,
  'WiFi transition state must not reuse restart-pending state');
const transitionPending = functionBody(main, /bool\s+runtimeTransitionPending\s*\(/);
assert.match(transitionPending, /wifiTransitionPending/,
  'command readiness must fail closed during WiFi transitions');
const wifiSetter = functionBody(main, /void\s+runtimeSetWifiTransitionPending\s*\(/);
assert.doesNotMatch(wifiSetter, /clearPhysicalLeds|FastLED|blackout|restartTransitionPending/,
  'WiFi readiness interlock must not replace or stop known-good lighting');

const status = functionBody(storage, /String\s+runtimeStatusJson\s*\(/);
for (const field of [
  'phase', 'transitionPending', 'apActive', 'stationIp',
  'handoffGeneration', 'phaseStartedMs', 'lastAttemptMs',
  'attemptCount', 'lastError',
]) {
  assert.match(status, new RegExp(`doc\\["wifi"\\]\\["${field}"\\]\\s*=`),
    `status must expose safe WiFi field ${field}`);
}
assert.doesNotMatch(status, /doc\["wifi"\]\["(?:ssid|password)"\]/,
  'status must never expose WiFi credentials');

console.log('wifi handoff source contract tests passed');
