import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const web = fs.readFileSync(path.join(root, 'src/LightweaverWeb.cpp'), 'utf8');

const handleStart = web.indexOf('void handleConfigPost()');
assert.notEqual(handleStart, -1, 'firmware web layer should define handleConfigPost');
const handleEnd = web.indexOf('void handleWifiPost()', handleStart);
assert.notEqual(handleEnd, -1, 'handleConfigPost should appear before handleWifiPost');
const handleConfigPost = web.slice(handleStart, handleEnd);

assert.match(
  handleConfigPost,
  /requiresReboot\\"?\s*:\s*true/,
  '/api/config should tell Studio when a saved config requires reboot before it is fully active',
);

const fallbackCalls = handleConfigPost.match(/runtimeArmConfigRestartFallback\(\)/g) || [];
assert.equal(fallbackCalls.length, 1,
  'successful non-staged config should arm exactly one firmware-owned reboot fallback');

const stagedStart = handleConfigPost.indexOf('if (wiringChanged)');
const stagedEnd = handleConfigPost.indexOf('bool ok = saveRuntimeConfigJson', stagedStart);
assert.ok(stagedStart >= 0 && stagedEnd > stagedStart, 'should isolate staged wiring config path');
assert.doesNotMatch(handleConfigPost.slice(stagedStart, stagedEnd),
  /runtimeArmConfigRestartFallback/,
  'staged wiring config must not arm the config-save reboot fallback');

const failedStart = handleConfigPost.indexOf('if (!ok)');
const applyStart = handleConfigPost.indexOf('runtimeApplySavedConfig()', failedStart);
assert.ok(failedStart >= 0 && applyStart > failedStart, 'should isolate failed config path');
assert.doesNotMatch(handleConfigPost.slice(failedStart, applyStart),
  /runtimeArmConfigRestartFallback/,
  'failed config must not arm the config-save reboot fallback');

const markStart = handleConfigPost.indexOf('runtimeMarkRestartPending()', applyStart);
const armStart = handleConfigPost.indexOf('runtimeArmConfigRestartFallback()', markStart);
const sendStart = handleConfigPost.indexOf('server.send(200', armStart);
assert.ok(applyStart < markStart && markStart < armStart && armStart < sendStart,
  'successful config must apply, mark dark, arm fallback, then send its 200 response');

const bridgeStart = web.indexOf('String studioBridgeScript()');
assert.notEqual(bridgeStart, -1, 'firmware web layer should define studioBridgeScript');
const bridgeEnd = web.indexOf('void handleAdvancedRoot();', bridgeStart);
assert.notEqual(bridgeEnd, -1, 'studioBridgeScript should appear before handleAdvancedRoot');
const studioBridgeScript = web.slice(bridgeStart, bridgeEnd);

assert.match(
  studioBridgeScript,
  /response\.requiresReboot\s*===\s*true/,
  'card bridge should reboot when /api/config reports that the saved package requires reboot',
);

console.log('config-requires-reboot-response tests passed');
