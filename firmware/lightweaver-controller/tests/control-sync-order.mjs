import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');
const platformio = readFileSync(resolve(here, '../platformio.ini'), 'utf8');
const parserGuard = readFileSync(resolve(here, '../scripts/guard-webserver-control-body.py'), 'utf8');

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
const responseEnd = source.indexOf('\n}', echoStart);
const responseBody = source.slice(echoStart, responseEnd);

assert.match(source, /constexpr\s+size_t\s+LW_MAX_CONTROL_BODY_BYTES\s*=\s*4096/, 'control request ceiling must stay small and explicit');
assert.match(source, /controlRequestBody\[LW_MAX_CONTROL_BODY_BYTES\s*\+\s*1\]/, 'allowed control bodies must use fixed bounded storage');
const rawStart = source.indexOf('void handleControlRaw(HTTPRaw& raw)');
assert.notEqual(rawStart, -1, 'control endpoint must use the framework raw-body lifecycle');
const rawEnd = source.indexOf('\n}', rawStart);
const rawBody = source.slice(rawStart, rawEnd);
assert.match(rawBody, /RAW_START/);
assert.match(rawBody, /server\.clientContentLength\(\)\s*>\s*LW_MAX_CONTROL_BODY_BYTES/, 'Content-Length must be rejected before raw body reads');
assert.match(rawBody, /server\.send\(413,\s*"application\/json"/, 'oversized control requests must return HTTP 413');
assert.match(rawBody, /server\.client\(\)\.stop\(\)/, 'oversized raw requests must close before the framework body loop continues');
assert.match(rawBody, /RAW_WRITE/);
assert.match(rawBody, /RAW_END/);
assert.doesNotMatch(body, /server\.arg\("plain"\)/, 'control parsing must never use WebServer plainBuf allocation');
assert.match(body, /deserializeJson\(doc,\s*controlRequestBody,\s*controlRequestBodyLength\)/, 'handler must parse only the bounded raw buffer');
assert.match(source, /class\s+BoundedControlRequestHandler\s+final\s*:\s*public RequestHandler/);
assert.match(source, /bool\s+canRaw\(String uri\)\s+override/);
assert.match(source, /bool\s+canUpload\(String uri\)\s+override\s*\{[\s\S]*?return false;/, 'multipart uploads must not enter the raw callback with no HTTPRaw state');
assert.match(source, /server\.addHandler\(new BoundedControlRequestHandler\(\)\)/, 'the control path must register the bounded raw handler instead of FunctionRequestHandler/plainBuf');
assert.match(platformio, /pre:scripts\/guard-webserver-control-body\.py/, 'the universal pre-parser guard must run before framework compilation');
assert.match(parserGuard, /122de5397729899ac8600d545f7ed4b8a02298351a4f1b0fa5c7fa73f87a14d0/, 'build must pin the inspected Parsing.cpp source hash');
assert.match(parserGuard, /_currentUri\s*==\s*"\/api\/control"/);
assert.match(parserGuard, /_clientContentLength\s*>\s*LW_WEB_CONTROL_MAX_BODY_BYTES/);
assert.match(parserGuard, /client\.stop\(\)/);
assert.match(parserGuard, /return false;/, 'oversized multipart/json/form requests must exit before every framework body branch');
assert.match(parserGuard, /corsOriginAllowed/, 'pre-parser rejection must preserve the project origin allowlist');
assert.match(parserGuard, /Access-Control-Allow-Origin/, 'oversized browser requests must expose the 413 through CORS');
assert.match(parserGuard, /Access-Control-Allow-Private-Network/, 'local-card private-network CORS must survive early rejection');
assert.match(parserGuard, /AddBuildMiddleware/, 'guard must replace only the Parsing.cpp compilation unit without mutating the global package');
assert.match(parserGuard, /hashlib\.sha256/, 'framework drift must fail closed before patch injection');
assert.match(platformio, /-DLW_WEB_CONTROL_MAX_BODY_BYTES=4096/);

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
