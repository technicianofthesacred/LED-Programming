import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (name) => readFileSync(resolve(root, name), 'utf8');
const web = read('src/LightweaverWeb.cpp');
const orchestrator = read('src/LightweaverConnectivityOrchestrator.h');
const main = read('src/main.cpp');

function functionBody(source, signature) {
  const match = source.match(signature);
  assert.ok(match, `missing function matching ${signature}`);
  const open = source.indexOf('{', match.index);
  assert.notEqual(open, -1, `missing body for ${signature}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`unterminated body for ${signature}`);
}

const recoveryFunctions = [
  functionBody(web, /void\s+maintainConnectivity\s*\(/),
  functionBody(web, /void\s+applyStationAssociation\s*\(/),
  functionBody(web, /void\s+(?:ensureRecoveryAp|startRecoveryAp)\s*\([^;]*\)\s*\{/),
  functionBody(web, /bool\s+issueStationAttempt\s*\(/),
  functionBody(web, /void\s+retireSetupAp\s*\(/),
  functionBody(web, /class\s+WebConnectivityHardwareAdapter/),
  orchestrator,
].join('\n');

for (const destructive of [
  /prefs\.clear\s*\(/,
  /prefs\.remove\s*\(/,
  /NVS_(?:KNOWN_GOOD|CANDIDATE)/,
  /SD\.remove\s*\(/,
  /runtimeFactoryReset\s*\(/,
  /runtimeResetWifi\s*\(/,
  /clearPhysicalLeds\s*\(/,
  /FastLED\.clear\s*\(/,
]) {
  assert.doesNotMatch(recoveryFunctions, destructive,
    `WiFi recovery must not mutate projects or physical playback: ${destructive}`);
}

const loop = functionBody(main, /void\s+loop\s*\(/);
assert.doesNotMatch(loop,
  /activeTransport\s*==\s*WIFI_TRANSPORT_AP[\s\S]{0,600}(?:fill_solid|showLeds)/,
  'a commissioned recovery AP must keep rendering its saved scene, not a network warning frame');

const resetWifi = functionBody(main, /void\s+runtimeResetWifi\s*\(/);
assert.match(resetWifi, /prefs\.remove\("wifi"\)/,
  'explicit reset-WiFi may remove the dedicated WiFi NVS key');
assert.doesNotMatch(resetWifi,
  /prefs\.clear|knownGood|candidate|SD\.remove|runtimeFactoryReset/,
  'explicit reset-WiFi must preserve project and candidate state');

console.log('wifi project preservation tests passed');
