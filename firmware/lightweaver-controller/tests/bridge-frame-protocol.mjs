// Locks bridge protocol v1 in the card page's embedded bridge script:
//
// 1. VERSIONING — the card→Studio 'ready' postMessages and every relay reply
//    carry `version:N` spliced from the single C++ constant LW_BRIDGE_VERSION
//    (no hand-synced numeric literals in the JS strings), and
//    /api/firmware-info reports `bridgeVersion`, so Studio can feature-detect
//    the frame relay and show "card firmware needs an update — open Flash"
//    against older cards instead of failing silently.
//
// 2. FRAME RELAY — Studio posts {type:'frame', payload:{pixels:['RRGGBB',...],
//    seg?}} and the card page forwards it into ONE persistent same-origin
//    WebSocket ws://<own-host>:81/ws as {seg:[{i:pixels}]} — the firmware's
//    WLED JSON frame path (TEXT frames; binary WS is ignored by the firmware,
//    which is why the earlier binary push attempt was a silent no-op — see
//    led-art-mapper/app/src/main.js "C2: WLED live push"). The relay must be
//    latest-frame-wins under congestion (single pending slot, bufferedAmount
//    check), never a growing queue of stale frames. The 'frame' reply is
//    HONEST: {ok:true, relayed:<bool>, wsOpen:<bool>} — wsOpen is true iff
//    the relay socket readyState===1 at reply time, relayed is true only when
//    the frame was actually handed to an OPEN socket. Studio reads
//    wsOpen===false as "not delivered".
//
// 3. RECONNECT — every reconnect attempt funnels through ONE backoff-gated
//    retry helper (single pending attempt, doubling wait capped at 4s). A
//    burst of incoming frames while the socket is down must not open a
//    socket per frame (reconnect storm).
//
// 4. STOP — streaming stops through the EXISTING 'control' bridge type with
//    {cancelStream:true}. No bespoke stop/cancel message type may appear.
//    cancelStream ALSO drops any undelivered pending frame and cancels the
//    scheduled reconnect, so a stale frame can't land after stop.

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

// The version in every JS script string is spliced from the C++ constant —
// never a hand-synced numeric literal.
assert.doesNotMatch(
  web,
  /version:\d/,
  'no hand-synced `version:<digit>` literal may appear in the source — splice String(LW_BRIDGE_VERSION) instead',
);
const readyMessages = web.match(
  /postMessage\(\{app:'LightweaverCardBridge',type:'ready',version:"\);\s*script \+= (?:bridgeVersion|String\(LW_BRIDGE_VERSION\));/g,
) || [];
assert.ok(readyMessages.length >= 2,
  'both card→Studio ready postMessages exist (iframe open + opener handshake) and splice the version from LW_BRIDGE_VERSION');

assert.match(
  web,
  /const String bridgeVersion = String\(LW_BRIDGE_VERSION\);/,
  'studioBridgeScript() derives the spliced version string from the pinned constant',
);
assert.match(
  web,
  /Object\.assign\(\{app:'LightweaverCardBridge',version:"\);\s*script \+= bridgeVersion;/,
  'every bridge relay reply is stamped with the constant-derived version (covers the iframe flow where ready can be missed)',
);

// firmware-info carries bridgeVersion so Studio can gate before any handshake
const fwInfoStart = web.indexOf('void handleFirmwareInfo()');
assert.notEqual(fwInfoStart, -1, 'LightweaverWeb.cpp should define handleFirmwareInfo()');
const fwInfoEnd = web.indexOf('\n}', fwInfoStart);
const fwInfo = web.slice(fwInfoStart, fwInfoEnd);
assert.match(fwInfo, /\\"bridgeVersion\\":/, 'firmware-info JSON gains a bridgeVersion field');
assert.match(fwInfo, /LW_BRIDGE_VERSION/, 'bridgeVersion is derived from the pinned constant');
// The splice locates the top-level '{' by skipping leading whitespace/BOM —
// not a bare indexOf('{') that trusts the payload shape.
assert.doesNotMatch(fwInfo, /indexOf\('\{'\)/,
  'firmware-info splice must not rely on a bare indexOf(\'{\')');
assert.match(fwInfo, /info\[brace\] == '\{'/,
  'firmware-info splice verifies the first non-whitespace char is the opening brace');

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

// ── reconnect: ONE backoff-gated retry path (no reconnect storm) ──────────
const backoffs = script.match(/Math\.min\(4000,lwFrameWait\*2\)/g) || [];
assert.equal(backoffs.length, 1,
  'the doubling backoff (capped at 4s) lives in exactly ONE retry helper — no duplicated snippets');
assert.match(
  script,
  /const lwFrameRetryLater=\(\)=>\{if\(lwFrameRetry\)return;/,
  'the retry helper is a single gate: a pending retry suppresses further attempts',
);
const directConnects = script.match(/lwFrameConnect\(\)/g) || [];
assert.equal(directConnects.length, 1,
  'lwFrameConnect() is invoked from exactly one place — inside the backoff-gated retry helper');
assert.match(
  script,
  /if\(!lwFrameWs\|\|lwFrameWs\.readyState>1\)\{lwFrameRetryLater\(\);return\}/,
  'a flush against a down socket schedules a backoff-gated reconnect instead of connecting directly',
);

// ── honest frame acks ─────────────────────────────────────────────────────
assert.match(
  script,
  /response=\{ok:true,relayed:sent,wsOpen:!!\(lwFrameWs&&lwFrameWs\.readyState===1\)\}/,
  "the 'frame' reply is {ok, relayed, wsOpen} — wsOpen true iff readyState===1 at reply time (Studio reads wsOpen===false as not-delivered)",
);
assert.match(
  script,
  /lwFrameFlush\(\);return!!\(lwFrameWs&&lwFrameWs\.readyState===1\)/,
  'lwFrameSend reports whether the frame was handed to an OPEN socket — never an unconditional relayed:true',
);
assert.doesNotMatch(
  script,
  /relayed:true/,
  'no hardcoded relayed:true — delivery claims must reflect the socket state',
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

// cancelStream clears the pending frame slot AND the scheduled reconnect so a
// stale frame cannot arrive after stop and re-claim the canvas.
assert.match(
  script,
  /if\(c\.cancelStream\)lwFrameCancel\(\);/,
  'a control message with cancelStream also cancels the frame relay',
);
assert.match(
  script,
  /const lwFrameCancel=\(\)=>\{lwFrameNext=null;if\(lwFrameRetry\)\{clearTimeout\(lwFrameRetry\);lwFrameRetry=null\}\};/,
  'lwFrameCancel drops the pending frame and cancels any scheduled reconnect',
);

console.log('bridge-frame-protocol tests passed');
