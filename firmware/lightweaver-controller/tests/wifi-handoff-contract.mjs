import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const types = read('src/LightweaverTypes.h');
const storage = read('src/LightweaverStorage.cpp');
const storageHeader = read('src/LightweaverStorage.h');
const runtimeApi = read('src/LightweaverRuntimeApi.h');
const main = read('src/main.cpp');
const web = read('src/LightweaverWeb.cpp');
const orchestrator = read('src/LightweaverConnectivityOrchestrator.h');
const artnet = read('src/LightweaverArtnet.cpp');
const artnetHeader = read('src/LightweaverArtnet.h');
const wled = read('src/LightweaverWledRealtime.cpp');
const wledHeader = read('src/LightweaverWledRealtime.h');
const parserGuard = read('scripts/guard-webserver-control-body.py');
const platformio = read('platformio.ini');

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
assert.match(web, /#include "LightweaverConnectivityOrchestrator\.h"/,
  'firmware maintenance must use the native-tested production orchestrator');
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
for (const field of ['accepted', 'transition', 'handoffGeneration', 'bootId']) {
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
const issueAttempt = functionBody(web, /bool\s+issueStationAttempt\s*\(/);
assert.match(issueAttempt, /WiFi\.setAutoReconnect\(false\)/,
  'the shared hardware attempt adapter must disable SDK auto-reconnect');
assert.match(issueAttempt, /ConnectivityStationAttempt::Reconnect[\s\S]*WiFi\.reconnect/,
  'the hardware adapter must distinguish explicit reconnect actions');
assert.match(issueAttempt, /ConnectivityStationAttempt::Begin[\s\S]*WiFi\.begin/,
  'the hardware adapter must distinguish explicit initial/pre-ack actions');
const initialAttempt = functionBody(web, /void\s+startStationAttempt\s*\(/);
assert.match(initialAttempt, /issueStationAttempt[\s\S]*recordStationAttempt/,
  'initial attempts must use the shared hardware adapter and record a real action receipt');
assert.doesNotMatch(web, /WiFi\.setAutoReconnect\(true\)/,
  'no firmware lifecycle may silently return retry ownership to the SDK');

assert.match(web, /constexpr int LW_BRIDGE_VERSION\s*=\s*2/,
  'bridge v2 must advertise station-origin WiFi handoff acknowledgement support');
const bridgeScript = functionBody(web, /String\s+studioBridgeScript\s*\(/);
assert.match(bridgeScript, /m\.type==='wifi-handoff-ack'/,
  'the card-page bridge must expose the privileged acknowledgement request');
assert.match(bridgeScript, /location\.hash[\s\S]*512/,
  'handoff correlation must be parsed from a bounded fragment');
for (const field of ['wifiHandoff', 'expectedCardId', 'expectedBootId', 'studioOrigin']) {
  assert.match(bridgeScript, new RegExp(field),
    `handoff fragment must require ${field}`);
}
assert.match(bridgeScript, /fetch\('\/api\/status'[\s\S]*cache:'no-store'/,
  'the station page must fetch fresh same-origin status before acknowledgement');
assert.match(bridgeScript, /location\.hostname[\s\S]*stationIp/,
  'the page hostname must exactly match the status station IP');
assert.match(bridgeScript, /transition==='handoff-ready'[\s\S]*transitionPending===true[\s\S]*apActive===true/,
  'the relay must require complete handoff-ready AP keepalive evidence');
assert.match(bridgeScript, /s\.cardId[\s\S]*expectedCardId[\s\S]*s\.bootId[\s\S]*expectedBootId[\s\S]*handoffGeneration/,
  'the relay must correlate exact card, boot, and generation');
assert.match(bridgeScript, /post\('\/api\/wifi\/handoff-ack',[\s\S]*bootId[\s\S]*handoffGeneration/,
  'the verified station page must POST the exact correlation same-origin');
assert.match(bridgeScript, /192\.168\.4\.1/,
  'the setup AP page must be explicitly ineligible to acknowledge');
assert.doesNotMatch(bridgeScript, /postMessage\([^)]*,\s*['"]\*['"]\)/,
  'the card-page bridge must never post a handshake or reply to a wildcard origin');
assert.match(bridgeScript, /ev\.source\s*!==\s*window\.opener/,
  'only the tracked Studio opener may request the handoff acknowledgement');
assert.match(bridgeScript, /lwHandoffAck(?:Flight|InFlight)/,
  'concurrent acknowledgement messages must share one in-flight relay');
assert.match(bridgeScript, /lwHandoffAck(?:Done|Result)/,
  'a successful acknowledgement must latch against duplicate endpoint posts');

// Execute the emitted ready-handshake prefix with browser-like globals. A v1
// Studio launch has only #studioBridge=1; v2 firmware must still announce v2
// to the hard-coded production target without ever using a wildcard.
function decodeCppStrings(source) {
  return [...source.matchAll(/"(?:\\.|[^"\\])*"/g)]
    .map(match => JSON.parse(match[0]))
    .join('');
}
const bridgeStart = bridgeScript.indexOf('script += F(');
const beforeFrames = bridgeScript.slice(bridgeStart, bridgeScript.indexOf('// Frame relay'));
const versionParts = beforeFrames.split('script += bridgeVersion;');
assert.equal(versionParts.length, 3, 'ready prefix should have two version splice points');
const emittedReadyPrefix = versionParts.map(decodeCppStrings).join('2');
const readyPosts = [];
const legacyWindow = {
  opener: { postMessage(message, targetOrigin) { readyPosts.push({ message, targetOrigin }); } },
  addEventListener() {},
};
vm.runInNewContext(emittedReadyPrefix, {
  window: legacyWindow,
  location: { hash: '#studioBridge=1', href: 'http://192.168.4.1/#studioBridge=1', host: '192.168.4.1', hostname: '192.168.4.1' },
  URLSearchParams,
  fetch: async () => ({ ok: false, json: async () => null }),
  post: async () => ({}),
});
assert.equal(readyPosts.length, 1, 'legacy production Studio still receives the v2 ready handshake');
assert.equal(readyPosts[0].targetOrigin, 'https://led.mandalacodes.com');
assert.equal(readyPosts[0].message.version, 2, 'legacy Studio can feature-detect v2 firmware');

const stationOpener = { postMessage() {} };
let statusFetches = 0;
let acknowledgementPosts = 0;
const ackContext = {
  window: { opener: stationOpener, addEventListener() {} },
  location: {
    hash: '#studioBridge=1&wifiHandoff=9&expectedCardId=lw-b0fe81f61b44&expectedBootId=boot-current&studioOrigin=https%3A%2F%2Fled.mandalacodes.com',
    href: 'http://192.168.18.70/', host: '192.168.18.70', hostname: '192.168.18.70',
  },
  URLSearchParams,
  fetch: async () => {
    statusFetches += 1;
    return {
      ok: true,
      json: async () => ({
        app: 'Lightweaver', provisioningContractVersion: 1,
        cardId: 'lw-b0fe81f61b44', firmwareVersion: '1.0.0', buildId: 'build-exact',
        bootId: 'boot-current', knownGoodProject: false, commandReady: false, outputReady: true,
        wifi: {
          transition: 'handoff-ready', transitionPending: true, apActive: true,
          stationIp: '192.168.18.70', handoffGeneration: 9,
        },
      }),
    };
  },
  post: async (path, body) => {
    acknowledgementPosts += 1;
    assert.equal(path, '/api/wifi/handoff-ack');
    assert.equal(JSON.stringify(body), '{"bootId":"boot-current","handoffGeneration":9}');
    await new Promise(resolve => setTimeout(resolve, 0));
    return { ok: true, accepted: true };
  },
};
vm.runInNewContext(`${emittedReadyPrefix};globalThis.relayHandoffAck=lwRelayWifiHandoffAck`, ackContext);
await assert.rejects(
  ackContext.relayHandoffAck({ source: {}, origin: 'https://led.mandalacodes.com' }),
  /invalid handoff correlation/,
  'an allowlisted but non-opener source cannot relay acknowledgement',
);
const ackEvent = { source: stationOpener, origin: 'https://led.mandalacodes.com' };
await Promise.all([
  ackContext.relayHandoffAck(ackEvent),
  ackContext.relayHandoffAck(ackEvent),
]);
await ackContext.relayHandoffAck(ackEvent);
assert.equal(statusFetches, 1, 'concurrent and post-success duplicates share one fresh status read');
assert.equal(acknowledgementPosts, 1, 'concurrent and post-success duplicates relay one endpoint POST');

const ack = functionBody(web, /void\s+handleWifiHandoffAck\s*\(/);
assert.match(ack, /handoffGeneration/,
  'handoff acknowledgement must require a generation');
assert.match(ack, /generation\s*==\s*0|generation\s*!=/,
  'handoff acknowledgement must validate the current nonzero generation');
assert.match(ack, /bootId[\s\S]*\.is<const char\*>\(\)/,
  'handoff acknowledgement must require a string bootId');
assert.match(ack, /requestBootId\s*!=\s*runtimeBootId\(\)[\s\S]*server\.send\(409/,
  'handoff acknowledgement must reject a stale boot before teardown scheduling');
assert.match(ack, /server\.client\(\)\.localIP\(\)\s*==\s*WiFi\.localIP\(\)/,
  'handoff proof must use the local socket address, not Host');
assert.doesNotMatch(ack, /host|Host/,
  'handoff proof must not trust the Host header');
assert.match(ack, /server\.send\(409/,
  'AP-interface handoff acknowledgements must preserve AP reachability with 409');
const sent = ack.indexOf('server.send(200');
const scheduled = ack.indexOf('scheduleApTeardown', sent);
assert.ok(sent !== -1 && scheduled > sent,
  'acknowledgement must be sent before deferred AP teardown is scheduled');
assert.doesNotMatch(ack, /\.flush\s*\(/,
  'WiFiClient::flush clears RX in this ESP32 core and must not be treated as TX proof');
assert.match(ack, /apTeardownScheduled[\s\S]*apTeardownGeneration\s*==\s*generation/,
  'duplicate current acknowledgements in the settle window must be detected');
assert.match(ack, /duplicate/,
  'an idempotent duplicate acknowledgement must return explicit success');
assert.equal((ack.match(/scheduleApTeardown\s*\(/g) || []).length, 1,
  'a duplicate acknowledgement must not reschedule or extend the teardown deadline');

const scheduleTeardown = functionBody(web, /void\s+scheduleApTeardown\s*\([^;]*\)\s*\{/);
assert.match(scheduleTeardown, /LW_HANDOFF_RESPONSE_SETTLE_MS/,
  'acknowledgement teardown must wait for an explicit post-response deadline');
assert.match(scheduleTeardown, /WiFi\.localIP\(\)\.toString\(\)/,
  'deferred teardown must snapshot the acknowledged station IP');
const processTeardown = functionBody(web, /void\s+processScheduledApTeardown\s*\(/);
assert.match(processTeardown, /int32_t\(now\s*-\s*apTeardownDeadlineMs\)\s*<\s*0[\s\S]*return/,
  'teardown processing must remain nonblocking until the response-settle deadline');
for (const proof of [
  'state.phase == lightweaver::ConnectivityPhase::HandoffReady',
  'apTeardownGeneration == state.generation',
  'WiFi.status() == WL_CONNECTED',
  'WiFi.localIP().toString() == apTeardownStationIp',
]) {
  assert.ok(processTeardown.includes(proof), `deferred teardown must revalidate ${proof}`);
}
assert.ok(processTeardown.indexOf('apTeardownDeadlineMs') < processTeardown.indexOf('retireSetupAp'),
  'AP teardown must happen only after the response-settle deadline and proof revalidation');

for (const macro of [
  'LW_WEB_WIFI_MAX_BODY_BYTES',
  'LW_WEB_WIFI_ACK_MAX_BODY_BYTES',
]) {
  assert.match(web, new RegExp(`#ifndef\\s+${macro}\\s*\\n\\s*#error[^\\n]*\\n\\s*#endif`),
    `${macro} must fail firmware compilation when the parser guard flag is missing`);
  assert.doesNotMatch(web, new RegExp(`#define\\s+${macro}\\b`),
    `${macro} must not have a numeric source fallback`);
  const configuredFlags = [
    ...platformio.matchAll(new RegExp(`^\\s*-D${macro}=([0-9]+)\\s*$`, 'gm')),
  ];
  assert.equal(configuredFlags.length, 1,
    `${macro} must have exactly one numeric source of truth in platformio.ini`);
}
assert.match(web, /constexpr size_t LW_MAX_WIFI_REQUEST_BODY_BYTES\s*=\s*LW_WEB_WIFI_MAX_BODY_BYTES/);
assert.match(web, /constexpr size_t LW_MAX_WIFI_ACK_REQUEST_BODY_BYTES\s*=\s*LW_WEB_WIFI_ACK_MAX_BODY_BYTES/);
assert.match(web, /static_assert\s*\(LW_MAX_WIFI_REQUEST_BODY_BYTES\s*>=\s*320/,
  'the C++ buffer must compile-time enforce room for maximum validator-legal escaped credentials');
assert.match(web, /static_assert\s*\(LW_MAX_WIFI_ACK_REQUEST_BODY_BYTES\s*>=\s*128/,
  'the handoff acknowledgement buffer must retain its compile-time lower bound');
assert.match(web, /class BoundedWifiRequestHandler/,
  'WiFi mutations must use a dedicated raw request handler');
assert.match(web, /server\.addHandler\(new BoundedWifiRequestHandler\(\)\)/,
  'bounded WiFi handler must be registered');
assert.doesNotMatch(web, /server\.on\("\/api\/wifi", HTTP_POST|server\.on\("\/api\/wifi\/handoff-ack", HTTP_POST/,
  'WiFi mutations must not use ordinary plain-body route buffering');
const wifiRaw = functionBody(web, /void\s+handleWifiRequestRaw\s*\(/);
assert.match(wifiRaw, /clientContentLength\(\)[\s\S]*LW_MAX_WIFI_ACK_REQUEST_BODY_BYTES[\s\S]*413/,
  'raw WiFi handler must reject declared oversized bodies with 413');
assert.doesNotMatch(wifiPost + ack, /server\.(?:arg|hasArg)\("plain"\)/,
  'WiFi handlers must consume only the fixed raw buffer');
for (const route of ['/api/wifi', '/api/wifi/handoff-ack']) {
  assert.ok(parserGuard.includes(route), `${route} must be guarded before WebServer body allocation`);
}
assert.match(parserGuard, /LW_WEB_WIFI_MAX_BODY_BYTES[\s\S]*LW_WEB_WIFI_ACK_MAX_BODY_BYTES/,
  'framework allocation guard must use explicit WiFi body limits');
assert.match(platformio, /^\s*-DLW_WEB_WIFI_MAX_BODY_BYTES=512\s*$/m);
assert.match(platformio, /^\s*-DLW_WEB_WIFI_ACK_MAX_BODY_BYTES=128\s*$/m);
const maximumEscapedWifiBody = JSON.stringify({
  ssid: '"'.repeat(32),
  password: '\\'.repeat(63),
  hostname: '"'.repeat(32),
});
assert.ok(maximumEscapedWifiBody.length > 256 && maximumEscapedWifiBody.length <= 512,
  'the raised bound must fit fully escaped validator-maximum WiFi fields');

const connectivity = functionBody(web, /void\s+maintainConnectivity\s*\(/);
assert.match(connectivity, /runConnectivityOrchestrator\s*\(/,
  'runtime lifecycle must execute the exact native-tested action runner');
assert.doesNotMatch(connectivity, /advanceConnectivity\s*\(/,
  'runtime maintenance must not duplicate event/action planning around the orchestrator');
assert.match(connectivity,
  /bool\s+stationReady\s*=\s*connected[\s\S]{0,180}0\.0\.0\.0[\s\S]*ConnectivityObservation/,
  'recovery must not retire its AP or restore readiness until station DHCP is usable');
assert.match(connectivity, /processScheduledApTeardown\(cfg, state, now\);\s*if\s*\(apTeardownScheduled\)\s*return;/,
  'an accepted ACK deadline must fence grace-based teardown until response settlement');
assert.match(connectivity, /apRadioStarted\s*&&\s*dnsServerActive/,
  'the orchestrator must observe both AP radio and captive DNS readiness');
const associated = functionBody(web, /void\s+applyStationAssociation\s*\(/);
assert.match(associated, /WiFi\.setAutoReconnect\(false\)/,
  'association and recovery must leave SDK auto-reconnect disabled');
assert.match(associated, /announceMdns/,
  'association hardware effects must refresh mDNS');
assert.match(artnetHeader, /bool\s+artnetRebind\s*\(\s*\)/,
  'Art-Net rebind must report actual bind success');
assert.match(wledHeader, /bool\s+wledRealtimeRebind\s*\(\s*\)/,
  'WLED realtime rebind must report actual bind success');
const artnetRebind = functionBody(artnet, /bool\s+artnetRebind\s*\(\s*\)/);
assert.match(artnetRebind, /gUdp\.stop\s*\(\s*\)[\s\S]*gListening\s*=\s*false[\s\S]*bindArtnetSocket/,
  'Art-Net rebind must discard stale socket truth and reopen UDP 6454');
const artnetBind = functionBody(artnet, /bool\s+bindArtnetSocket\s*\(/);
assert.match(artnetBind, /gUdp\.begin\(LW_ARTNET_PORT\)/,
  'the shared Art-Net bind path must open UDP 6454');
assert.match(artnetRebind, /return\s+gListening/,
  'Art-Net rebind return value must expose socket truth');
const wledRebind = functionBody(wled, /bool\s+wledRealtimeRebind\s*\(\s*\)/);
assert.match(wledRebind, /return\s+g_started/,
  'WLED realtime rebind return value must expose socket truth');
assert.doesNotMatch(artnet, /now\s*>=\s*nextRetry/,
  'Art-Net lazy retry must be rollover-safe');
assert.match(artnet, /elapsed\s*\(/,
  'Art-Net lazy retry must use rollover-safe elapsed arithmetic');
assert.match(wled, /elapsed\s*\(/,
  'WLED realtime must have a rollover-safe lazy retry fallback');
const readiness = functionBody(web, /void\s+syncWifiReadiness\s*\(/);
assert.match(readiness, /connectivityTransitionPending/,
  'production readiness must consume the native-tested binding-pending policy');
const refreshBindings = functionBody(web, /ConnectivityBindingResult\s+refreshNetworkBindings\s*\(/);
assert.match(refreshBindings, /force[\s\S]*wledRealtimeRebind[\s\S]*artnetRebind/,
  'forced association refreshes and lazy listener retries must share one hardware adapter');
assert.doesNotMatch(refreshBindings, /ensureRecoveryAp|softAP/,
  'listener-only failure must not reopen the recovery AP');
const recoveryAp = functionBody(web, /void\s+ensureRecoveryAp\s*\([^;]*\)\s*\{/);
assert.match(recoveryAp, /apActive\s*=\s*apRadioStarted/,
  'recovery AP status must reflect whether the AP radio actually started');
assert.match(recoveryAp,
  /activeIp\s*=\s*apRadioStarted\s*\?\s*WiFi\.softAPIP\(\)\.toString\(\)\s*:\s*String\(\)/,
  'recovery AP status must not publish a dead soft-AP address');
for (const action of [
  'StationLost', 'StationAssociated', 'ConnectivityStationAttempt::Reconnect',
  'ConnectivityStationAttempt::Begin', 'networkBindingsRetryDue',
  'ensureSetupAp', 'ensureRecoveryAp', 'retireRecoveryAp',
]) {
  assert.ok(orchestrator.includes(action),
    `production orchestrator must plan ${action}`);
}
assert.match(orchestrator,
  /refreshNetworkBindings[\s\S]*recordNetworkBindingAttempt[\s\S]*retireSetupAp/,
  'the production runner must apply binding truth before safe AP retirement');
assert.match(orchestrator,
  /setReadinessPending[\s\S]*issueStationAttempt[\s\S]*recordStationAttempt/,
  'the production runner must fail readiness closed before issuing and recording station attempts');
const hardwareAdapter = functionBody(web, /class\s+WebConnectivityHardwareAdapter/);
assert.match(hardwareAdapter,
  /stationLost[\s\S]*stationAssociated[\s\S]*refreshNetworkBindings[\s\S]*ensureSetupAp[\s\S]*ensureRecoveryAp[\s\S]*retireSetupAp[\s\S]*issueStationAttempt[\s\S]*setReadinessPending/,
  'Web.cpp must implement every hardware effect consumed by the tested orchestrator');
assert.match(hardwareAdapter,
  /preAck[\s\S]*activeTransport\s*=\s*WIFI_TRANSPORT_AP[\s\S]*WiFi\.softAPIP\(\)\.toString\(\)/,
  'pre-ack loss hardware effects must immediately restore AP transport truth');

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
  'transition', 'phase', 'transitionPending', 'apActive', 'stationIp',
  'handoffGeneration', 'phaseStartedMs', 'lastAttemptMs',
  'attemptCount', 'lastError', 'networkBindingsPending',
  'wledListenerReady', 'artnetListenerReady', 'lastBindingAttemptMs',
]) {
  assert.match(status, new RegExp(`doc\\["wifi"\\]\\["${field}"\\]\\s*=`),
    `status must expose safe WiFi field ${field}`);
}
assert.doesNotMatch(status, /doc\["wifi"\]\["(?:ssid|password)"\]/,
  'status must never expose WiFi credentials');

console.log('wifi handoff source contract tests passed');
