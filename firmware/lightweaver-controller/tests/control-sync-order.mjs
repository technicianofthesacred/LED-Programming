import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');

function extractFunction(sourceText, functionName) {
  const signature = new RegExp(`\\b${functionName}\\s*\\(`);
  const match = signature.exec(sourceText);
  assert.ok(match, `${functionName} should exist`);
  const openBrace = sourceText.indexOf('{', match.index + match[0].length);
  assert.notEqual(openBrace, -1, `${functionName} should have a body`);

  let depth = 0;
  let state = 'code';
  for (let i = openBrace; i < sourceText.length; i += 1) {
    const char = sourceText[i];
    const next = sourceText[i + 1];
    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        i += 1;
      }
      continue;
    }
    if (state === 'string' || state === 'char') {
      if (char === '\\') i += 1;
      else if ((state === 'string' && char === '"') || (state === 'char' && char === "'")) state = 'code';
      continue;
    }
    if (char === '/' && next === '/') {
      state = 'line-comment';
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block-comment';
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      state = char === '"' ? 'string' : 'char';
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return sourceText.slice(openBrace + 1, i);
  }
  assert.fail(`${functionName} should have a complete body`);
}

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

assert.match(
  body,
  /runtimeSetBrightnessZ\s*\(\s*zoneTarget\s*,/,
  'card controls should route brightness to the selected zone or zone broadcast',
);
const controlHandler = extractFunction(source, 'handleControlPost');
assert.match(
  controlHandler,
  /out\s*\[\s*"brightness"\s*\]\s*=\s*runtimeGetBrightnessZ\s*\(\s*zoneTarget\s*\)/,
  'card controls should echo the addressed zone brightness after applying a zone write',
);

const jsonApi = readFileSync(resolve(here, '../src/LightweaverWledJsonApi.cpp'), 'utf8');
const jsonStatePost = extractFunction(jsonApi, 'handleStatePost');
assert.match(
  jsonStatePost,
  /runtimeSetBrightnessZ\s*\(\s*runtimeConfig\.zones\s*\[\s*segId\s*\]\.id\s*,\s*br\s*\)/,
  'WLED segment brightness should route to zone brightness',
);
assert.match(
  jsonStatePost,
  /runtimeSetBrightness\s*\(\s*float\s*\(\s*doc\s*\[\s*"bri"\s*\]\.as<int>\s*\(\s*\)\s*\)\s*\/\s*255\.0f\s*\)/,
  'top-level WLED JSON brightness should route to master brightness',
);

const webSocket = readFileSync(resolve(here, '../src/LightweaverWledWebSocket.cpp'), 'utf8');
const applyState = extractFunction(webSocket, 'applyState');
assert.match(
  applyState,
  /runtimeSetBrightness\s*\(\s*float\s*\(\s*doc\s*\[\s*"bri"\s*\]\.as<int>\s*\(\s*\)\s*\)\s*\/\s*255\.0f\s*\)/,
  'top-level WLED WebSocket brightness should route to master brightness',
);

console.log('control-sync-order tests passed');
