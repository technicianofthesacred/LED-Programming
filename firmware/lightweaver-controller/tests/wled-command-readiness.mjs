import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The WLED surfaces drive pixels, so they use the playback gate: a WiFi
// transition must not stop a card from rendering. Configuration mutations
// still go through the strict runtimeCommandReady().
const root = resolve(import.meta.dirname, '..');
const read = name => readFileSync(resolve(root, 'src', name), 'utf8');

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `missing body for ${signature}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

const http = functionBody(read('LightweaverWledJsonApi.cpp'), 'void handleStatePost()');
const websocket = functionBody(read('LightweaverWledWebSocket.cpp'), 'void applyState(');
const udp = functionBody(read('LightweaverWledRealtime.cpp'), 'void handleWledRealtime()');

const httpGate = http.indexOf('runtimePlaybackReady()');
assert.ok(httpGate >= 0 && httpGate < http.indexOf('deserializeJson('),
  'WLED HTTP state writes must reject an unready or zero-pixel runtime before parsing intent');
assert.ok(httpGate < http.indexOf('frameSourceClaim('),
  'WLED HTTP state writes must reject before claiming output ownership');
assert.match(http.slice(httpGate, http.indexOf('deserializeJson(')),
  /totalPixels\s*==\s*0[\s\S]*serverPtr->send\((409|423)[\s\S]*\\"success\\":false[\s\S]*return;/,
  'WLED HTTP must explicitly reject a zero-pixel/unready card instead of returning success');

const wsGate = websocket.indexOf('runtimePlaybackReady()');
assert.ok(wsGate >= 0 && wsGate < websocket.indexOf('deserializeJson('),
  'WLED WebSocket state writes must be dropped before parsing when runtime control is unavailable');
assert.ok(wsGate < websocket.indexOf('frameSourceClaim('),
  'WLED WebSocket state writes must not claim output ownership while unready');
assert.match(websocket.slice(0, websocket.indexOf('deserializeJson(')), /totalPixels\s*==\s*0/,
  'WLED WebSocket must explicitly reject a zero-pixel runtime');

const udpGate = udp.indexOf('runtimePlaybackReady()');
assert.ok(udpGate >= 0 && udpGate < udp.indexOf('frameSourceClaim('),
  'WLED UDP frames must not claim output ownership while runtime control is unavailable');
assert.match(udp.slice(0, udp.indexOf('frameSourceClaim(')), /g_totalPixels\s*==\s*0/,
  'WLED UDP must explicitly reject a zero-pixel runtime');
assert.match(udp.slice(udpGate, udp.indexOf('frameSourceClaim(')), /g_udp\.read\(/,
  'unready UDP packets must be drained so stale frames cannot take ownership after readiness changes');

console.log('wled-command-readiness tests passed');
