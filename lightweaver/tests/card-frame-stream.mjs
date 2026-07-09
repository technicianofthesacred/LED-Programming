// Locks the card frame streamer contract (src/lib/cardFrameStream.js):
//  - throttled to the configured fps (default 18, hard cap 24)
//  - latest-frame-wins: a burst of pushes sends only the newest frame
//  - keepalive: never a >2s silent gap while active (the card's frame-source
//    watchdog reverts the canvas after 2s of silence)
//  - stop releases the canvas through the EXISTING control path
//    ({cancelStream:true}) — no bespoke stop message
// Plus the Studio bridge side of frame streaming: 'frame' is a privileged
// bridge type (local-origin gated) and the card's reported bridge version
// gates v1 features with a "needs a firmware update" gap.

import assert from 'node:assert/strict';
import {
  clampFrameFps,
  createBridgeFrameTransport,
  createCardFrameStream,
  DEFAULT_FRAME_FPS,
  MAX_FRAME_FPS,
  FRAME_KEEPALIVE_MS,
} from '../src/lib/cardFrameStream.js';

// ── deterministic clock: drives the streamer's interval + now() ──────────
function makeClock() {
  let t = 0;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => t,
    setIntervalImpl(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms, due: t + ms });
      return id;
    },
    clearIntervalImpl(id) { timers.delete(id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let soonest = null;
        for (const timer of timers.values()) {
          if (timer.due <= end && (!soonest || timer.due < soonest.due)) soonest = timer;
        }
        if (!soonest) break;
        t = soonest.due;
        soonest.due += soonest.ms;
        await soonest.fn();
      }
      t = end;
    },
  };
}

function makeTransport(clock) {
  const sends = [];
  const record = { sends, cancels: 0, closed: 0 };
  record.transport = {
    kind: 'fake',
    async sendFrame(pixels, seg) { sends.push({ pixels, seg, at: clock.now() }); },
    async sendCancel() { record.cancels += 1; },
    close() { record.closed += 1; },
  };
  return record;
}

const FRAME = (n) => Array.from({ length: 4 }, (_, i) => `0000${(n * 4 + i).toString(16).padStart(2, '0').toUpperCase()}`);

// ── fps clamp ─────────────────────────────────────────────────────────────
assert.equal(DEFAULT_FRAME_FPS, 18);
assert.equal(MAX_FRAME_FPS, 24);
assert.equal(clampFrameFps(60), 24, 'fps caps at 24');
assert.equal(clampFrameFps(0), 1, 'fps floors at 1');
assert.equal(clampFrameFps('nope'), 18, 'garbage fps falls back to the default');

// ── throttle: pushes at 100/s, sends at ~18/s ─────────────────────────────
{
  const clock = makeClock();
  const { transport, sends } = makeTransport(clock);
  const stream = createCardFrameStream({
    transport,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    now: clock.now,
  });
  assert.equal(stream.getStats().fps, 18);
  stream.start();
  for (let i = 0; i < 100; i++) {
    stream.push(FRAME(i));
    await clock.advance(10); // 100 pushes over 1 second
  }
  assert.ok(sends.length >= 15 && sends.length <= 19,
    `1s of 100fps pushes throttles to ~18 sends (got ${sends.length})`);
  const stats = stream.getStats();
  assert.ok(stats.droppedFrames >= 70, `most frames are dropped, not queued (dropped ${stats.droppedFrames})`);
  await stream.stop();
}

// ── latest-frame-wins: a burst sends only the newest ─────────────────────
{
  const clock = makeClock();
  const { transport, sends } = makeTransport(clock);
  const stream = createCardFrameStream({
    transport,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    now: clock.now,
  });
  stream.start();
  stream.push(FRAME(1));
  stream.push(FRAME(2));
  stream.push(FRAME(3));
  await clock.advance(60); // one throttle tick
  assert.equal(sends.length, 1, 'a burst between ticks produces exactly one send');
  assert.deepEqual(sends[0].pixels, FRAME(3), 'and it is the newest frame');
  await stream.stop();
}

// ── keepalive: no >2s gap while active (card watchdog would revert) ──────
{
  const clock = makeClock();
  const { transport, sends } = makeTransport(clock);
  const stream = createCardFrameStream({
    transport,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    now: clock.now,
  });
  stream.start();
  stream.push(FRAME(7));
  await clock.advance(60);
  assert.equal(sends.length, 1);
  await clock.advance(6000); // six idle seconds, no new pushes
  assert.ok(sends.length >= 3, `idle stream re-sends the last frame (${sends.length} sends)`);
  for (let i = 1; i < sends.length; i++) {
    const gap = sends[i].at - sends[i - 1].at;
    assert.ok(gap <= 2000, `send gap ${gap}ms stays under the card's 2s watchdog`);
    assert.deepEqual(sends[i].pixels, FRAME(7), 'keepalive repeats the latest frame');
  }
  assert.ok(FRAME_KEEPALIVE_MS < 2000, 'keepalive interval sits under the watchdog');
  await stream.stop();
}

// ── stop: sends cancelStream via the existing control path, then quiesces ─
{
  const clock = makeClock();
  const record = makeTransport(clock);
  const stream = createCardFrameStream({
    transport: record.transport,
    seg: 2,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    now: clock.now,
  });
  stream.start();
  stream.push(FRAME(1));
  await clock.advance(60);
  assert.equal(record.sends[0].seg, 2, 'segment id rides along with each frame');
  await stream.stop();
  assert.equal(record.cancels, 1, 'stop sends exactly one cancelStream');
  assert.equal(record.closed, 1, 'stop closes the transport');
  assert.equal(stream.isActive(), false);
  const sent = record.sends.length;
  stream.push(FRAME(9));
  await clock.advance(500);
  assert.equal(record.sends.length, sent, 'no frames go out after stop');
  await stream.stop(); // idempotent
  assert.equal(record.cancels, 1, 'double-stop does not double-cancel');
}

// ══════════════════════════════════════════════════════════════════════════
//  Studio bridge side: 'frame' rides the privileged postMessage channel and
//  the reported bridge version gates it.
// ══════════════════════════════════════════════════════════════════════════
const listeners = new Map();
const posted = [];
const parentBridge = {
  postMessage(message, targetOrigin) {
    posted.push({ message, targetOrigin });
    setTimeout(() => {
      listeners.get('message')?.({
        origin: 'http://192.168.18.70',
        source: parentBridge,
        data: {
          app: 'LightweaverCardBridge',
          version: 1,
          id: message.id,
          type: message.type,
          ok: true,
          response: { ok: true, relayed: message.type === 'frame' },
        },
      });
    }, 0);
  },
};
globalThis.window = {
  location: { search: '?cardBridge=1&cardHost=192.168.18.70' },
  opener: null,
  parent: parentBridge,
  localStorage: { getItem: () => '192.168.18.70', setItem: () => {} },
  addEventListener(type, listener) { listeners.set(type, listener); },
  removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  dispatchEvent: () => {},
};

const {
  bootstrapCardBridgeFromOpener,
  cardBridgeFeatureGap,
  getCardBridgeVersion,
  sendCardBridgeRequest,
} = await import('../src/lib/cardBridge.js');

assert.equal(bootstrapCardBridgeFromOpener(), true);

// Before any handshake the card version is unknown → legacy 0 → v1 gap.
assert.equal(getCardBridgeVersion(), 0, 'no handshake yet reads as legacy');
{
  const gap = cardBridgeFeatureGap('frame');
  assert.ok(gap, 'frame streaming is gated against an unversioned card');
  assert.equal(gap.required, 1);
  assert.equal(gap.action, 'open-flash', 'the fix is a firmware update via Flash');
  assert.match(gap.message, /firmware/i, 'the gap message talks about firmware');
}

// A frame request relays through the bridge and its versioned reply clears the gap.
const frameResponse = await sendCardBridgeRequest('frame', { pixels: ['FF8800', '331100'], seg: 1 }, {
  host: '192.168.18.70',
  timeoutMs: 1000,
});
assert.equal(frameResponse.relayed, true);
const frameMessage = posted.find(p => p.message.type === 'frame');
assert.ok(frameMessage, 'a frame postMessage was sent');
assert.equal(frameMessage.targetOrigin, 'http://192.168.18.70', 'frames only target the local card origin');
assert.deepEqual(frameMessage.message.payload, { pixels: ['FF8800', '331100'], seg: 1 });
assert.equal(getCardBridgeVersion(), 1, 'the versioned reply reports bridge v1');
assert.equal(cardBridgeFeatureGap('frame'), null, 'v1 card clears the frame gap');

// 'frame' is privileged: a non-local host is refused before any postMessage.
await assert.rejects(
  () => sendCardBridgeRequest('frame', { pixels: ['FF0000'] }, { host: 'evil.example.com', timeoutMs: 200 }),
  (error) => error.reason === 'bridge-untrusted-origin',
  'frame refuses non-local card hosts',
);

// The bridge transport wraps the same channel.
{
  const before = posted.length;
  const transport = createBridgeFrameTransport('192.168.18.70');
  assert.equal(transport.kind, 'bridge');
  await transport.sendFrame(['00FF00'], 3);
  const sentMessage = posted[posted.length - 1].message;
  assert.equal(sentMessage.type, 'frame');
  assert.deepEqual(sentMessage.payload, { pixels: ['00FF00'], seg: 3 });
  await transport.sendCancel();
  const cancelMessage = posted[posted.length - 1].message;
  assert.equal(cancelMessage.type, 'control', 'stop rides the EXISTING control type');
  assert.deepEqual(cancelMessage.payload, { cancelStream: true });
  assert.ok(posted.length === before + 2, 'exactly two bridge messages');
}

console.log('card-frame-stream tests passed');
