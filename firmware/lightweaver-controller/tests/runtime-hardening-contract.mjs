import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '../src');
const [storage, main, wled, wledWs, policy] = await Promise.all([
  readFile(join(src, 'LightweaverStorage.cpp'), 'utf8'),
  readFile(join(src, 'main.cpp'), 'utf8'),
  readFile(join(src, 'LightweaverWledJsonApi.cpp'), 'utf8'),
  readFile(join(src, 'LightweaverWledWebSocket.cpp'), 'utf8'),
  readFile(join(src, 'LightweaverProvisioningPolicy.h'), 'utf8'),
]);

assert.match(storage, /bool\s+mountRuntimeSd\s*\(/,
  'boot must mount microSD before choosing a runtime source');
assert.match(storage, /mountRuntimeSd\(message\)[\s\S]*loadSdConfig\(config, message, sdMounted\)[\s\S]*loadNvsConfigKeyStrict/,
  'an exact-card SD project must be considered before known-good NVS');
assert.match(storage, /loadSdConfig\([^)]*bool\s*&\s*mounted/, 'SD config loading must reuse the boot mount');
assert.match(main, /bool\s+sequenceIntegrityMatches\s*\(/,
  'sequence playback must verify the declared SHA-256 before opening');
assert.match(main, /sequenceIntegrityMatches\([^)]*look\.sequenceBytes[^)]*look\.sequenceSha256/, 
  'sequence playback must bind the profile declaration to the file bytes');
assert.match(main, /SD\.open\(look\.file\.c_str\(\), FILE_READ\)/,
  'sequence playback must use the retained SD mount rather than remounting');
assert.match(main, /prefs\.clear\(\)/,
  'factory reset must clear NVS regardless of SD cleanup availability');
assert.match(main, /sd cleanup unavailable|optional sd cleanup/i,
  'factory reset should report SD cleanup separately from NVS erasure');
assert.match(policy, /provisioningFactoryResetMayComplete\(bool\s+nvsCleared/,
  'factory reset completion must depend on NVS erasure, not SD availability');
assert.match(wled, /LW_WLED_STATE_MAX_BODY_BYTES/,
  '/json/state must have a dedicated bounded request limit');
assert.match(wled, /state request too large/,
  'oversized /json/state writes must fail before parse');
assert.match(wled, /String\s+body\s*=\s*serverPtr->arg\("plain"\)[\s\S]*body\.length\(\)\s*>\s*LW_WLED_STATE_MAX_BODY_BYTES[\s\S]*deserializeJson\(doc,\s*body\)/,
  'the HTTP state body must be capped from its actual bytes, not only Content-Length');
assert.match(wled, /serializeJson\(effects/, 
  'combined /json effects must serialize labels instead of concatenating them');
assert.match(wled, /unsupported per-segment on\/fx control/,
  'unsupported segment on/fx writes must reject before any state mutation');
assert.match(wledWs, /LW_WLED_WS_MAX_PAYLOAD_BYTES/,
  'the WLED WebSocket path must set an explicit payload cap');
assert.match(wledWs, /if\s*\(length\s*>\s*LW_WLED_WS_MAX_PAYLOAD_BYTES\)\s*return;[\s\S]*deserializeJson/,
  'WebSocket frames must be rejected by actual payload length before parsing');
assert.match(wledWs, /if\s*\(!s\["on"\]\.isNull\(\)\s*\|\|\s*!s\["fx"\]\.isNull\(\)\)\s*return;[\s\S]*for\s*\(JsonObject s : segs\)/,
  'unsupported segment operations must be rejected atomically before WebSocket state changes');
assert.match(storage, /NVS_SD_AUTORUN_SUPPRESSED_KEY/,
  'a no-SD reset must leave a durable SD-autoboot suppression marker');
assert.match(storage, /sdAutorunSuppressed[\s\S]*if\s*\(!sdAutorunSuppressed\s*&&\s*sdMounted\s*&&\s*loadSdConfig/,
  'the boot selector must honor the SD-autoboot suppression marker');
assert.match(storage, /prefs\.remove\(NVS_SD_AUTORUN_SUPPRESSED_KEY\)/,
  'a successfully installed internal project must clear the suppression marker');
assert.match(main, /prefs\.clear\(\)[\s\S]*suppressSdProjectAutorunAfterFactoryReset/,
  'factory reset without SD must write its suppression marker after erasing NVS');

console.log('runtime hardening contract tests passed');
