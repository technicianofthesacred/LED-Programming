// Root cause (discovery findings 2026-08-06, #5b): there was no non-destructive
// way out of a saved bench project — /api/factory-reset also wipes WiFi.
// /api/clear-project erases ONLY project/wiring/discovery/recovery state,
// keeping WiFi credentials and any owner rename, then reboots.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const web = readFileSync(resolve(root, 'src/LightweaverWeb.cpp'), 'utf8');
const storage = readFileSync(resolve(root, 'src/LightweaverStorage.cpp'), 'utf8');
const storageHeader = readFileSync(resolve(root, 'src/LightweaverStorage.h'), 'utf8');
const api = readFileSync(resolve(root, 'src/LightweaverRuntimeApi.h'), 'utf8');
const main = readFileSync(resolve(root, 'src/main.cpp'), 'utf8');

function body(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.ok(start >= 0 && end > start, `could not isolate ${signature}`);
  return source.slice(start, end);
}

for (const method of ['HTTP_OPTIONS', 'HTTP_POST']) {
  assert.ok(web.includes(`server.on("/api/clear-project", ${method},`),
    `/api/clear-project should register ${method}`);
}

const handler = body(web, 'void handleClearProject()', 'void handleFirmwareInfo()');
assert.match(handler, /token != "CLEAR"/,
  'clear-project must demand its confirmation token so a stray click cannot fire it');
assert.match(handler, /runtimeClearProject\(/, 'handler delegates to the runtime clear');
const sendAt = handler.indexOf('server.send(202');
const flushAt = handler.indexOf('server.client().flush()');
const rebootAt = handler.indexOf('ESP.restart()');
assert.ok(sendAt >= 0 && sendAt < flushAt && flushAt < rebootAt,
  'handler must send and flush the acknowledgement before rebooting');
assert.ok(handler.includes('\\"wifiPreserved\\":true'),
  'the acknowledgement must state that WiFi survives');
assert.doesNotMatch(handler, /runtimeFactoryReset|runtimeFinalizeFactoryResetRadio|WiFi\./,
  'clear-project must never touch factory reset or the radio credentials');
assert.equal((handler.match(/sendCors\(\)/g) || []).length, 1,
  'exactly one CORS emission per response (private-network-cors.mjs walks this too)');

assert.match(storageHeader, /bool clearRuntimeProjectStorage\(String& message\);/);
assert.match(api, /bool runtimeClearProject\(String& message\);/);

const clearStorage = body(storage, 'bool clearRuntimeProjectStorage(String& message)', 'bool stageRuntimeConfigJson(');
for (const cleared of ['NVS_KNOWN_GOOD_CONFIG_KEY', 'NVS_CANDIDATE_CONFIG_KEY', 'NVS_CANDIDATE_STATE_KEY',
  'NVS_CANDIDATE_ID_KEY', 'NVS_CONFIRMED_ID_KEY', 'NVS_PREVIOUS_KNOWN_GOOD_KEY', 'NVS_PROMOTION_ARMED_KEY',
  'NVS_DISCOVERY_ACTIVE_KEY', 'NVS_DISCOVERY_BATCH_KEY', 'NVS_RECOVERY_PENDING_KEY', 'NVS_LEGACY_CONFIG_KEY']) {
  assert.ok(clearStorage.includes(cleared), `clear-project must erase ${cleared}`);
}
assert.doesNotMatch(clearStorage, /NVS_WIFI_KEY|NVS_PIECE_NAME_KEY|NVS_SD_AUTORUN_SUPPRESSED_KEY|prefs\.clear\(\)/,
  'clear-project must not name (and so can never erase) WiFi, the rename, or the SD suppression marker');
assert.ok(clearStorage.indexOf('NVS_CANDIDATE_STATE_KEY') < clearStorage.indexOf('NVS_KNOWN_GOOD_CONFIG_KEY'),
  'bootable candidate markers must be cleared before the project bytes');

const runtimeClear = body(main, 'bool runtimeClearProject(String& message)', 'bool runtimeRename(');
assert.match(runtimeClear, /runtimeMarkRestartPending\(\)/,
  'the strip must go dark for the restart transition before storage is touched');
assert.match(runtimeClear, /clearRuntimeProjectStorage\(message\)/);
assert.doesNotMatch(runtimeClear, /WiFi\.|prefs\./);

assert.match(web, /m\.type==='clear-project'/,
  "the card-page bridge must route 'clear-project' for the HTTPS Studio");

// The owner rename survives a cleared project: the project-less boot overlays
// the rename key that runtimeRename() persists.
assert.match(storage, /void overlayNvsPieceName\(RuntimeConfig& config\)/);
const loadBody = body(storage, 'RuntimeLoadResult loadRuntimeConfig(', 'bool saveRuntimeConfigJson(');
const defaultsBranch = loadBody.slice(loadBody.lastIndexOf('applyDefaultRuntimeConfig(config);'));
assert.match(defaultsBranch, /overlayNvsPieceName\(config\);/,
  'the compiled-defaults boot must restore an owner rename');

console.log('clear-project endpoint tests passed');
