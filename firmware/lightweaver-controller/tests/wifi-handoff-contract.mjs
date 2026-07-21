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
for (const signature of [
  /void\s+startStationAttempt\s*\(/,
  /void\s+startStationReconnect\s*\(/,
]) {
  const body = functionBody(web, signature);
  assert.match(body, /WiFi\.setAutoReconnect\(false\)/,
    'all policy-owned station attempts must disable SDK auto-reconnect');
  assert.doesNotMatch(body, /WiFi\.setAutoReconnect\(true\)/,
    'the SDK must never own retries alongside the connectivity policy');
  assert.match(body, /recordStationAttempt/,
    'attempt timestamps must be recorded only when production issues a real attempt');
}
assert.doesNotMatch(web, /WiFi\.setAutoReconnect\(true\)/,
  'no firmware lifecycle may silently return retry ownership to the SDK');

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
assert.match(connectivity, /advanceConnectivity\s*\(/,
  'runtime lifecycle must be driven by the tested pure policy');
assert.match(connectivity,
  /bool\s+stationReady\s*=\s*connected[\s\S]{0,180}0\.0\.0\.0[\s\S]*if\s*\(stationReady[\s\S]*recordStationAssociation/,
  'recovery must not retire its AP or restore readiness until station DHCP is usable');
assert.match(connectivity, /processScheduledApTeardown\(cfg, state, now\);\s*if\s*\(apTeardownScheduled\)\s*return;/,
  'an accepted ACK deadline must fence grace-based teardown until response settlement');
assert.match(connectivity, /WL_CONNECTED[\s\S]*HandoffReady|StationAssociated/,
  'association must enter handoff-ready while AP remains available');
assert.match(connectivity, /station association timed out[\s\S]*startApMode|SetupAp[\s\S]*startApMode/,
  'failed initial association must leave or restore a reachable setup AP');
const associated = functionBody(web, /void\s+recordStationAssociation\s*\(/);
assert.match(associated, /WiFi\.setAutoReconnect\(false\)/,
  'association and recovery must leave SDK auto-reconnect disabled');
assert.match(associated, /announceMdns[\s\S]*wledRealtimeRebind/,
  'association must refresh mDNS and existing realtime binding');
assert.match(associated, /wledRealtimeRebind[\s\S]*artnetRebind/,
  'every association and reassociation must refresh both UDP listeners');
assert.ok(associated.indexOf('artnetRebind()') < associated.indexOf('syncWifiReadiness(config)'),
  'command readiness may return only after all runtime UDP bindings are refreshed');
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
assert.match(connectivity, /networkBindingsRetryDue[\s\S]*refreshNetworkBindings/,
  'station-up listener failures must retry without blocking connectivity maintenance');
const refreshBindings = functionBody(web, /void\s+refreshNetworkBindings\s*\(/);
assert.doesNotMatch(refreshBindings, /ensureRecoveryAp|softAP/,
  'listener-only failure must not reopen the recovery AP');
const recoveryAp = functionBody(web, /void\s+ensureRecoveryAp\s*\([^;]*\)\s*\{/);
assert.match(recoveryAp, /apActive\s*=\s*apRadioStarted/,
  'recovery AP status must reflect whether the AP radio actually started');
assert.match(recoveryAp,
  /activeIp\s*=\s*apRadioStarted\s*\?\s*WiFi\.softAPIP\(\)\.toString\(\)\s*:\s*String\(\)/,
  'recovery AP status must not publish a dead soft-AP address');
assert.match(connectivity, /kHandoffGraceMs|advanceConnectivity[\s\S]*Tick/,
  'a still-associated station may retire the AP after the tested grace period');
assert.match(connectivity, /ConnectivityPhase::Station[\s\S]*ConnectivityEvent::StationLost[\s\S]*syncWifiReadiness[\s\S]*(?:WiFi\.reconnect|startStationReconnect)/,
  'completed Station loss must enter policy Reconnecting, fail readiness closed, and retry immediately');
assert.match(connectivity,
  /ConnectivityPhase::Station[\s\S]*currentStationIp\s*!=\s*cfg\.wifiRuntime\.stationIp[\s\S]*recordStationAssociation/,
  'a changed station address must refresh mDNS and both UDP bindings even without an observed disconnect');
assert.match(connectivity, /advanceConnectivity[\s\S]*ConnectivityEvent::Tick[\s\S]*reconnectDue[\s\S]*(?:WiFi\.reconnect|startStationReconnect)/,
  'policy reconnectDue ticks must actively retry the station association');
assert.match(connectivity, /ConnectivityPhase::RecoveryAp[\s\S]*(?:ensureRecoveryAp|startRecoveryAp)/,
  'the 60-second policy transition must enable the recovery AP');
assert.match(connectivity, /ConnectivityPhase::Reconnecting[\s\S]*ConnectivityPhase::RecoveryAp[\s\S]*recordStationAssociation/,
  'both runtime recovery phases must accept reassociation without replaying initial handoff');
assert.match(connectivity, /ConnectivityPhase::HandoffReady[\s\S]*ConnectivityEvent::StationLost[\s\S]*stationIp\s*=\s*""[\s\S]*activeTransport\s*=\s*WIFI_TRANSPORT_AP[\s\S]*activeIp\s*=\s*WiFi\.softAPIP\(\)\.toString\(\)[\s\S]*activeHostname\s*=\s*""/,
  'pre-ack loss must immediately restore legacy AP transport, IP, and hostname truth');

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
