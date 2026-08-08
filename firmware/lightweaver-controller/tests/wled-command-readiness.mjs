import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The WLED surfaces drive pixels, so they use the playback gate: a WiFi
// transition must not stop a card from rendering. Configuration mutations
// still go through the strict runtimeCommandReady().
const root = resolve(import.meta.dirname, '..');
const read = name => readFileSync(resolve(root, 'src', name), 'utf8');

function maskCommentsAndStrings(source) {
  const masked = [...source];
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') {
        masked[index] = masked[index + 1] = ' ';
        state = 'line-comment';
        index += 1;
      } else if (char === '/' && next === '*') {
        masked[index] = masked[index + 1] = ' ';
        state = 'block-comment';
        index += 1;
      } else if (char === '"' || char === "'") {
        masked[index] = ' ';
        state = char === '"' ? 'string' : 'char';
      }
      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      else masked[index] = ' ';
    } else if (state === 'block-comment') {
      masked[index] = char === '\n' ? '\n' : ' ';
      if (char === '*' && next === '/') {
        masked[index + 1] = ' ';
        state = 'code';
        index += 1;
      }
    } else {
      masked[index] = char === '\n' ? '\n' : ' ';
      if (char === '\\') {
        if (index + 1 < source.length) masked[index + 1] = ' ';
        index += 1;
      } else if ((state === 'string' && char === '"') || (state === 'char' && char === "'")) {
        state = 'code';
      }
    }
  }
  return masked.join('');
}

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
const artnet = functionBody(read('LightweaverArtnet.cpp'), 'void decodePacket(');

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

function assertArtnetReadinessContract(source) {
  const executableSource = maskCommentsAndStrings(source);
  const artnetGate = executableSource.indexOf('runtimePlaybackReady()');
  const artnetPixelValidation = executableSource.indexOf('if (pixelsInPacket == 0) return;');
  const artnetClaim = executableSource.indexOf('frameSourceClaim(');
  const artnetPixelWrite = executableSource.indexOf('dst[i] = CRGB(');
  assert.notEqual(artnetPixelValidation, -1,
    'Art-Net frames must retain packet and pixel range validation');
  assert.notEqual(artnetGate, -1,
    'Art-Net frames must retain the playback readiness gate');
  assert.notEqual(artnetClaim, -1,
    'Art-Net frames must retain their frame ownership claim');
  assert.notEqual(artnetPixelWrite, -1,
    'Art-Net frames must retain their pixel write');
  assert.ok(artnetGate > artnetPixelValidation,
    'Art-Net frames must validate their packet and pixel range before checking playback readiness');
  assert.ok(artnetGate < artnetClaim,
    'Art-Net frames must not claim output ownership while playback is unready');
  assert.ok(artnetGate < artnetPixelWrite,
    'Art-Net frames must not write pixels while playback is unready');
}

assertArtnetReadinessContract(artnet);

const commentedArtnetGate = artnet.replace(
  'if (!runtimePlaybackReady()) return;',
  '// if (!runtimePlaybackReady()) return;',
);
assert.notEqual(commentedArtnetGate, artnet, 'Art-Net gate mutation fixture must change the source');
assert.throws(
  () => assertArtnetReadinessContract(commentedArtnetGate),
  /playback readiness/,
  'a commented-out Art-Net readiness gate must not satisfy the source contract',
);

const missingArtnetPixelValidation = artnet.replace('if (pixelsInPacket == 0) return;', '');
assert.notEqual(missingArtnetPixelValidation, artnet,
  'Art-Net pixel-validation mutation fixture must change the source');
assert.throws(
  () => assertArtnetReadinessContract(missingArtnetPixelValidation),
  /packet and pixel range/,
  'a missing Art-Net pixel-validation marker must not satisfy the source contract',
);

console.log('wled-command-readiness tests passed');
