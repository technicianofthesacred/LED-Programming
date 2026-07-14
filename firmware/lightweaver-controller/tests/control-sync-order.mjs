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
const responseEnd = source.indexOf('\n}', echoStart);
const responseBody = source.slice(echoStart, responseEnd);

const sizeCheckIndex = body.indexOf('LW_MAX_CONTROL_BODY_BYTES');
const deserializeIndex = body.indexOf('deserializeJson(doc, server.arg("plain"))');
assert.notEqual(sizeCheckIndex, -1, 'control requests must have an explicit byte ceiling');
assert.notEqual(deserializeIndex, -1, 'control handler should deserialize JSON');
assert.ok(sizeCheckIndex < deserializeIndex, 'oversized control requests must be rejected before JSON deserialization');
assert.match(body, /LW_MAX_CONTROL_BODY_BYTES\s*=\s*4096/, 'control request ceiling must stay small and explicit');
assert.match(body, /server\.arg\("plain"\)\.length\(\)\s*>\s*LW_MAX_CONTROL_BODY_BYTES/, 'the exact ceiling is accepted and the first byte over is rejected');
assert.match(body, /server\.send\(413,\s*"application\/json"/, 'oversized control requests must return HTTP 413');

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

assert.match(body, /doc\["revision"\]\.is<uint32_t>\(\)/, 'control revisions must be parsed as bounded uint32 values');
assert.match(body, /revision out of range/, 'invalid or oversized revisions must fail before applying a preview');
assert.ok(
  body.indexOf('revision out of range') < syncIndex,
  'revision validation must happen before any physical control mutation',
);
assert.match(body, /patternApplied\s*=\s*runtimeSelectPatternByIdZ/, 'pattern acknowledgement must derive from the real apply result');
const preflightIndex = body.indexOf('runtimeCanSelectPatternByIdZ(zoneTarget, confirmedPatternId)');
assert.notEqual(preflightIndex, -1, 'pattern and zone targets must be checked without mutation');
for (const setter of [
  'runtimeSetSyncZones(',
  'runtimeSetLedColorOrder(',
  'runtimeSetBrightnessZ(',
  'runtimeSetSpeedZ(',
  'runtimeSetHueShiftZ(',
  'runtimeSetBlackoutZ(',
  'runtimeNextPattern(',
  'runtimePreviousPattern(',
  'runtimeSetCustomHueZ(',
  'runtimeSetCustomSaturationZ(',
  'runtimeSetCustomBreatheZ(',
  'runtimeSetCustomDriftZ(',
  'runtimeSetDriftRangeZ(',
  'runtimeCancelStream(',
]) {
  const setterIndex = body.indexOf(setter);
  assert.notEqual(setterIndex, -1, `control handler should contain ${setter}`);
  assert.ok(preflightIndex < setterIndex, `target preflight must happen before ${setter}`);
}
assert.match(
  body,
  /if\s*\(patternRequested\s*&&\s*!runtimeCanSelectPatternByIdZ\(zoneTarget, confirmedPatternId\)\)[\s\S]*?server\.send\(422[\s\S]*?return;/,
  'a missing pattern target must return 422 before any physical control mutation',
);

for (const proof of [
  'out["cardId"] = runtimeCardId()',
  'out["revision"] = confirmedRevision',
  'out["confirmedRevision"] = confirmedRevision',
  'out["patternId"] = confirmedPatternId',
  'confirmedLook["patternId"] = confirmedPatternId',
  'confirmedLook["zone"] = zoneTarget',
  'confirmedLook["syncZones"] = runtimeGetSyncZones()',
]) {
  assert.ok(responseBody.includes(proof), `control response must include applied-intent proof: ${proof}`);
}
assert.match(responseBody, /out\["ok"\]\s*=\s*!patternRequested\s*\|\|\s*patternApplied/, 'failed pattern application must not return ok:true');
assert.match(responseBody, /server\.send\([^;]*patternApplied[^;]*\?\s*200\s*:\s*422/, 'unapplied pattern intent must return a failing HTTP status');

console.log('control-sync-order tests passed');
