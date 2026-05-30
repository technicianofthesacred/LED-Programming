import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');
const start = source.indexOf('void handleControlPost()');
assert.notEqual(start, -1, 'handleControlPost should exist');

const echoStart = source.indexOf('// Echo current state back', start);
assert.notEqual(echoStart, -1, 'handleControlPost should echo current state after applying controls');
const body = source.slice(start, echoStart);

const syncIndex = body.indexOf('runtimeSetSyncZones(controlBool(doc, "syncZones"))');
assert.notEqual(syncIndex, -1, 'handleControlPost should apply syncZones when present');

for (const marker of [
  'runtimeSetBrightnessZ(',
  'runtimeSetSpeedZ(',
  'runtimeSetHueShiftZ(',
  'runtimeSetBlackoutZ(',
  'runtimeSelectPatternByIdZ(',
  'runtimeSetCustomHueZ(',
  'runtimeSetCustomSaturationZ(',
  'runtimeSetCustomBreatheZ(',
  'runtimeSetCustomDriftZ(',
  'runtimeSetDriftRangeZ(',
]) {
  const index = body.indexOf(marker);
  assert.notEqual(index, -1, `${marker} should be present in handleControlPost`);
  assert.ok(
    syncIndex < index,
    `syncZones must be applied before ${marker} so all-section commands broadcast after split previews`,
  );
}

console.log('control-sync-order tests passed');
