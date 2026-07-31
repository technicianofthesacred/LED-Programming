import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '../src');
const [storage, main, web, runtimeApi, wled, wledWs, wledRealtime, policy, studioPackage] = await Promise.all([
  readFile(join(src, 'LightweaverStorage.cpp'), 'utf8'),
  readFile(join(src, 'main.cpp'), 'utf8'),
  readFile(join(src, 'LightweaverWeb.cpp'), 'utf8'),
  readFile(join(src, 'LightweaverRuntimeApi.h'), 'utf8'),
  readFile(join(src, 'LightweaverWledJsonApi.cpp'), 'utf8'),
  readFile(join(src, 'LightweaverWledWebSocket.cpp'), 'utf8'),
  readFile(join(src, 'LightweaverWledRealtime.cpp'), 'utf8'),
  readFile(join(src, 'LightweaverProvisioningPolicy.h'), 'utf8'),
  readFile(join(here, '../../../lightweaver/package.json'), 'utf8'),
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
assert.match(storage, /effectiveLookRequiresSequenceMetadata\([\s\S]*configMode\s*==\s*"sd-sequence"[\s\S]*hasNativeRecipe/,
  'strict validation must derive sequence requirements after the native-recipe override');
assert.match(main, /bool\s+prepareSequence\s*\(\s*const LookConfig& look,\s*PreparedSequence& prepared\s*\)/,
  'sequence selection must prepare one concrete file handle before mutating playback state');
assert.match(main, /prepared\.file\s*=\s*SD\.open\(look\.file\.c_str\(\), FILE_READ\)[\s\S]*sequenceIntegrityMatches\(prepared\.file,[\s\S]*readSequenceMetadata\(prepared\.file/,
  'the concrete prepared file must be both hashed and parsed before playback');
assert.match(main, /readSequenceMetadata\(prepared\.file[\s\S]*prepared\.file\.read\(preparedSequenceFrameBuffer,[\s\S]*prepared\.ready\s*=\s*true/,
  'the first frame must be read completely from the retained candidate before it becomes prepared');
const instantApplyStart = main.indexOf(
  'bool applyPreparedLookInstant(uint8_t nextIndex, PreparedSequence* prepared) {');
const instantApplyEnd = main.indexOf('bool startLook(', instantApplyStart);
const instantApply = main.slice(instantApplyStart, instantApplyEnd);
assert.match(instantApply, /isPreparedSequenceReady\(/,
  'instant sequence activation must reject an incomplete staged first frame');
assert.ok(
  instantApply.indexOf('isPreparedSequenceReady(') <
      instantApply.indexOf('closeSequence()') &&
      instantApply.indexOf('isPreparedSequenceReady(') <
      instantApply.indexOf('currentLookIndex = nextIndex'),
  'first-frame readiness must be proven before the old sequence or current look is mutated');
assert.match(main, /bool\s+isPreparedSequenceReady\([\s\S]*preparedSequenceActivationReady\(/,
  'production activation readiness must use the behavior-tested generation and byte-count policy');
assert.match(main, /sequenceFile\s*=\s*verified->file/,
  'playback must adopt the exact file handle that was verified');
assert.match(main, /sequenceFile\s*=\s*verified->file[\s\S]*memcpy\(frameBuffer,\s*preparedSequenceFrameBuffer/,
  'activation must adopt the verified handle and its already-staged first frame');
assert.match(main, /esp_task_wdt_reset\(\)[\s\S]*yield\(\)/,
  'long sequence hashes must feed and yield to the task watchdog');
const saveStart = storage.indexOf('bool saveRuntimeConfigJson(');
const saveEnd = storage.indexOf('bool suppressSdProjectAutorunAfterFactoryReset(', saveStart);
const save = storage.slice(saveStart, saveEnd);
assert.match(save, /bool\s+committed\s*=\s*prefs\.putString\(NVS_KNOWN_GOOD_CONFIG_KEY/,
  'the canonical known-good write must be tracked separately from best-effort cleanup');
assert.match(save, /if\s*\(!committed\)[\s\S]*message\s*=\s*"nvs write failed"/,
  'only failure to commit canonical config may return a save failure');
assert.match(save, /cleanup warning/,
  'post-commit cleanup failure must be reported as a truthful warning');
assert.match(wledRealtime, /FrameSource\s+sourceBeforeClaim\s*=\s*frameSourceActive\(\)/,
  'partial realtime frames must detect a new source-ownership epoch before claiming the canvas');
assert.match(wledRealtime, /frameSourceIsStreaming\(\)[\s\S]*frameSourceClaim\(FRAME_WLED_REALTIME\)/,
  'same-source subset continuation must require live ownership before the claim refreshes its epoch');
assert.match(wledRealtime, /applyWledRealtimeDrgb\([\s\S]*wledRealtimeShouldClearTail\([\s\S]*sourceWasStreaming/,
  'the production realtime handler must use the behavior-tested new-epoch tail policy');
assert.doesNotMatch(main, /SequenceIntegrityEvidence/,
  'sequence selection must retain the verified file handle, not trust time-limited metadata evidence');
assert.doesNotMatch(main, /bool\s+canOpenSequence\s*\(/,
  'selection must not preflight a sequence by opening and hashing a separate file handle');
const directPatternSelectStart = main.indexOf('bool runtimeSelectPatternById(');
const directPatternSelectEnd = main.indexOf('// Validate the complete pattern target', directPatternSelectStart);
const directPatternSelect = main.slice(directPatternSelectStart, directPatternSelectEnd);
assert.doesNotMatch(directPatternSelect, /isLoadedLookRenderable/,
  'direct pattern selection must delegate one verified preparation to the final selection path');
assert.match(main, /struct\s+PreparedSequence[\s\S]*File\s+file/,
  'sequence selection must retain the actual opened file through verification and playback');
assert.match(runtimeApi, /runtimePreparePatternByIdZ/,
  'web control must be able to retain a prepared pattern across validation and selection');
assert.match(runtimeApi, /runtimeCommitPreparedPatternSelection/,
  'web control must commit only the already-prepared selection');
assert.match(web, /applyPreparedControlTransaction/,
  'selection failure must short-circuit unrelated mutations and revision advancement');
assert.match(studioPackage, /wled-realtime-policy\.mjs/,
  'the normal core source gate must execute the WLED realtime behavior test');

console.log('runtime hardening contract tests passed');
