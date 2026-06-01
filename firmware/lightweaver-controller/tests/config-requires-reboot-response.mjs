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
