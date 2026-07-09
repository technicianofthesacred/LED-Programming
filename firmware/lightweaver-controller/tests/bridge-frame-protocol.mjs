// Locks bridge protocol v1 in the card page's embedded bridge script:
//
// 1. VERSIONING — the card→Studio 'ready' postMessages and every relay reply
//    carry `version:1`, and /api/firmware-info reports `bridgeVersion`, so
//    Studio can feature-detect the frame relay and show "card firmware needs
//    an update — open Flash" against older cards instead of failing silently.
//
// 2. FRAME RELAY — Studio posts {type:'frame', payload:{pixels:['RRGGBB',...],
//    seg?}} and the card page forwards it into ONE persistent same-origin
//    WebSocket ws://<own-host>:81/ws as {seg:[{i:pixels}]} — the firmware's
//    WLED JSON frame path (TEXT frames; binary WS is ignored by the firmware,
//    which is why the earlier binary push attempt was a silent no-op — see
//    led-art-mapper/app/src/main.js "C2: WLED live push"). The relay must be
//    latest-frame-wins under congestion (single pending slot, bufferedAmount
//    check), never a growing queue of stale frames.
//
// 3. STOP — streaming stops through the EXISTING 'control' bridge type with
//    {cancelStream:true}. No bespoke stop/cancel message type may appear.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');

// ── versioning ────────────────────────────────────────────────────────────
assert.match(
  web,
  /constexpr int LW_BRIDGE_VERSION = 1;/,
  'LightweaverWeb.cpp should pin the bridge protocol version constant at 1',
);

const readyMessages = web.match(/postMessage\(\{app:'LightweaverCardBridge',type:'ready',[^}]*\}/g) || [];
assert.ok(readyMessages.length >= 2,
  'both card→Studio ready postMessages exist (iframe open + opener handshake)');
for (const ready of readyMessages) {
  assert.match(ready, /version:1/, `every ready handshake carries version:1 — got: ${ready}`);
}

assert.match(
  web,
  /Object\.assign\(\{app:'LightweaverCardBridge',version:1\}/,
  'every bridge relay reply is stamped with version:1 (covers the iframe flow where ready can be missed)',
);

// firmware-info carries bridgeVersion so Studio can gate before any handshake
const fwInfoStart = web.indexOf('void handleFirmwareInfo()');
assert.notEqual(fwInfoStart, -1, 'LightweaverWeb.cpp should define handleFirmwareInfo()');
const fwInfoEnd = web.indexOf('\n}', fwInfoStart);
const fwInfo = web.slice(fwInfoStart, fwInfoEnd);
assert.match(fwInfo, /\\"bridgeVersion\\":/, 'firmware-info JSON gains a bridgeVersion field');
assert.match(fwInfo, /LW_BRIDGE_VERSION/, 'bridgeVersion is derived from the pinned constant');

// ── scope the rest to the embedded bridge script ──────────────────────────
const fnStart = web.indexOf('String studioBridgeScript()');
assert.notEqual(fnStart, -1, 'LightweaverWeb.cpp should define studioBridgeScript()');
const fnEnd = web.indexOf('return script;', fnStart);
assert.notEqual(fnEnd, -1, 'studioBridgeScript() should return its assembled script');
const script = web.slice(fnStart, fnEnd);

// ── frame relay ───────────────────────────────────────────────────────────
assert.match(
  script,
  /m\.type===['"]frame['"]/,
  'bridge script should handle the Studio frame message',
);
assert.match(
  script,
  /new WebSocket\('ws:\/\/'\+location\.hostname\+':81\/ws'\)/,
  'the relay opens ONE same-origin WebSocket to the card\'s own :81/ws frame path',
);
assert.match(
  script,
  /JSON\.stringify\(\{seg:\[s\]\}\)/,
  'frames are forwarded as the WLED JSON {seg:[{i:pixels}]} shape (text, never binary)',
);
assert.match(
  script,
  /\{i:p\.pixels\}/,
  'the segment carries the raw pixels array as seg.i',
);

// latest-frame-wins: exactly one pending slot, replaced on every send —
// congestion (bufferedAmount) defers the flush rather than queueing frames.
assert.match(
  script,
  /lwFrameNext=p;/,
  'an incoming frame REPLACES the pending slot (latest-frame-wins)',
);
assert.match(
  script,
  /bufferedAmount>\d+/,
  'the relay checks bufferedAmount and defers when the socket is congested',
);
assert.doesNotMatch(
  script,
  /lwFrame\w*\.push\(/,
  'frames must never accumulate in an array queue — stale frames are dropped, not delivered late',
);

// reconnect with backoff, capped
assert.match(
  script,
  /Math\.min\(4000,lwFrameWait\*2\)/,
  'socket reconnects use doubling backoff capped at 4s',
);

// ── stop stays on the existing control path ───────────────────────────────
assert.match(
  script,
  /m\.type===['"]control['"]/,
  'the existing control relay is still present',
);
assert.match(
  script,
  /post\('\/api\/control'/,
  'control payloads (including cancelStream) still POST to /api/control',
);
assert.doesNotMatch(
  script,
  /m\.type===['"](cancel|cancel-stream|frame-stop|stop)['"]/,
  'no bespoke stream-stop message type — stopping uses control {cancelStream:true}',
);

console.log('bridge-frame-protocol tests passed');
