// Locks the card frame streamer contract (src/lib/cardFrameStream.js):
//  - throttled to the configured fps (default 18, hard cap 24)
//  - latest-frame-wins: a burst of pushes sends only the newest frame
//  - keepalive: never a >2s silent gap while active (the card's frame-source
//    watchdog reverts the canvas after 2s of silence), including in a
//    background tab where setInterval is clamped to 1000ms
//  - delivery health: wsOpen:false replies (F1 contract) and send rejections
//    count as failures, exposed via getStats() and the onHealth callback, and
//    stop() can be driven from inside the callback (the UI's auto-stop path)
//  - direct transport backs off between failed WS opens (250ms → 4s cap)
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
  createDirectFrameTransport,
  createFrameOwnershipCoordinator,
  reclaimCardFrameStreams,
  DEFAULT_FRAME_FPS,
  DIRECT_BACKOFF_MAX_MS,
  DIRECT_BACKOFF_MIN_MS,
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

function makeBroadcastHub() {
  const channels = new Map();
  return class FakeBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      const peers = channels.get(name) || new Set();
      peers.add(this);
      channels.set(name, peers);
    }
    postMessage(data) {
      for (const peer of channels.get(this.name) || []) {
        if (peer !== this) peer.onmessage?.({ data: structuredClone(data) });
      }
    }
    close() { channels.get(this.name)?.delete(this); }
  };
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

// ── producer buffers are snapshotted before the next render ─────────
{
  const clock = makeClock();
  const { transport, sends } = makeTransport(clock);
  const stream = createCardFrameStream({
    transport,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    now: clock.now,
  });
  const reusable = FRAME(4);
  const firstSnapshot = [...reusable];
  stream.start();
  stream.push(reusable);
  reusable[0] = 'FFFFFF';
  await clock.advance(60);
  assert.deepEqual(sends[0].pixels, firstSnapshot,
    'push snapshots a reusable producer buffer before it can be mutated again');

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

// ── background tab: 1000ms-clamped ticks still beat the 2s watchdog ───────
{
  assert.ok(FRAME_KEEPALIVE_MS <= 900,
    'keepalive threshold sits under the 1000ms background-tab interval clamp');
  const clock = makeClock();
  const { transport, sends } = makeTransport(clock);
  const stream = createCardFrameStream({
    transport,
    // hidden tabs clamp setInterval to 1000ms — simulate the clamp
    setIntervalImpl: (fn, ms) => clock.setIntervalImpl(fn, Math.max(1000, ms)),
    clearIntervalImpl: clock.clearIntervalImpl,
    now: clock.now,
  });
  stream.start();
  stream.push(FRAME(1));
  await clock.advance(8000);
  assert.ok(sends.length >= 7, `clamped ticks keep sending (${sends.length} sends in 8s)`);
  for (let i = 1; i < sends.length; i++) {
    const gap = sends[i].at - sends[i - 1].at;
    assert.ok(gap <= 2000, `background-tab wire cadence ${gap}ms stays under the 2s watchdog`);
  }
  await stream.stop();
}

// ── ownership: newest same-host stream wins without cancelling it ─────────
{
  const clock = makeClock();
  const health = [];
  const firstRecord = makeTransport(clock);
  const secondRecord = makeTransport(clock);
  const ownership = createFrameOwnershipCoordinator({ BroadcastChannelImpl: null });
  const first = createCardFrameStream({
    host: 'HTTP://LIGHTWEAVER.LOCAL/setup',
    transport: firstRecord.transport,
    ownershipCoordinator: ownership,
    onHealth: report => health.push(report),
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    now: clock.now,
  });
  const second = createCardFrameStream({
    host: 'lightweaver.local',
    transport: secondRecord.transport,
    ownershipCoordinator: ownership,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    now: clock.now,
  });

  first.start();
  first.push(FRAME(1));
  await clock.advance(60);
  second.start();
  assert.equal(first.isActive(), false, 'new same-host stream immediately yields the prior stream');
  assert.equal(firstRecord.cancels, 0, 'yield never sends cancelStream into the new owner');
  assert.equal(firstRecord.closed, 1, 'yield closes the prior transport');
  assert.equal(health.at(-1)?.reason, 'stream-superseded', 'yield surfaces a clear health reason');

  const firstSendCount = firstRecord.sends.length;
  first.push(FRAME(9));
  first.start();
  second.push(FRAME(2));
  await clock.advance(1000);
  assert.equal(firstRecord.sends.length, firstSendCount, 'a yielded stream cannot restart or send after push');
  assert.ok(secondRecord.sends.length > 0, 'the newest owner continues streaming');
  await first.stop();
  assert.equal(firstRecord.cancels, 0, 'stopping a yielded stream still does not cancel the owner');
  await second.stop();
  assert.equal(secondRecord.cancels, 1, 'explicitly stopping the current owner sends one cancel');
}

// ── ownership: BroadcastChannel coordinates tabs and isolates hosts ────────
{
  const BroadcastChannelImpl = makeBroadcastHub();
  const clock = makeClock();
  const tabA = createFrameOwnershipCoordinator({ BroadcastChannelImpl, instanceId: 'tab-a' });
  const tabB = createFrameOwnershipCoordinator({ BroadcastChannelImpl, instanceId: 'tab-b' });
  const firstRecord = makeTransport(clock);
  const secondRecord = makeTransport(clock);
  const otherHostRecord = makeTransport(clock);
  const first = createCardFrameStream({ host: '192.168.4.1', transport: firstRecord.transport, ownershipCoordinator: tabA, now: () => 10, setIntervalImpl: clock.setIntervalImpl, clearIntervalImpl: clock.clearIntervalImpl });
  const otherHost = createCardFrameStream({ host: '192.168.4.2', transport: otherHostRecord.transport, ownershipCoordinator: tabA, now: () => 15, setIntervalImpl: clock.setIntervalImpl, clearIntervalImpl: clock.clearIntervalImpl });
  const second = createCardFrameStream({ host: 'http://192.168.4.1/', transport: secondRecord.transport, ownershipCoordinator: tabB, now: () => 20, setIntervalImpl: clock.setIntervalImpl, clearIntervalImpl: clock.clearIntervalImpl });

  first.start();
  otherHost.start();
  second.start();
  assert.equal(first.isActive(), false, 'newer claim from another tab supersedes the same normalized host');
  assert.equal(firstRecord.cancels, 0);
  assert.equal(otherHost.isActive(), true, 'a stream to another host remains owned and active');
  assert.equal(otherHostRecord.closed, 0, 'different-host transport is untouched');
  let releaseHandoff;
  const reclaimed = reclaimCardFrameStreams('http://192.168.4.1/path', {
    ownershipCoordinator: tabA,
    handoffMs: 25,
    setTimeoutImpl(callback, delay) {
      assert.equal(delay, 25);
      releaseHandoff = callback;
    },
  });
  assert.equal(second.isActive(), false, 'reclaim broadcasts to and terminalizes the current owner in another tab');
  assert.equal(secondRecord.closed, 1, 'reclaimed transport closes immediately');
  assert.equal(secondRecord.cancels, 0, 'browser reclaim never sends card cancel before recovery');
  assert.equal(otherHost.isActive(), true, 'reclaim remains scoped to the normalized target host');
  releaseHandoff();
  await reclaimed;
  second.push(FRAME(8));
  second.start();
  await clock.advance(1000);
  assert.equal(secondRecord.sends.length, 0, 'reclaimed stream cannot restart or send again');
  await second.stop();
  await otherHost.stop();
  assert.equal(secondRecord.cancels, 0);
  assert.equal(otherHostRecord.cancels, 1);
}

// ── wsOpen:false replies are undelivered (F1 contract) ────────────────────
{
  const clock = makeClock();
  const healthReports = [];
  let reply = { ok: true, relayed: false, wsOpen: false }; // relay socket closed
  const transport = {
    kind: 'fake',
    async sendFrame() { return reply; },
    async sendCancel() {},
    close() {},
  };
  const stream = createCardFrameStream({
    transport,
    onHealth: (health) => healthReports.push({ ...health }),
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    now: clock.now,
  });
  stream.start();
  stream.push(FRAME(1));
  await clock.advance(500);
  let stats = stream.getStats();
  assert.equal(stats.sentFrames, 0, 'wsOpen:false replies never count as delivered');
  assert.ok(stats.consecutiveFailures >= 2, `failures accumulate (${stats.consecutiveFailures})`);
  assert.ok(stats.undeliveredFrames >= 2, 'undelivered frames are counted');
  assert.ok(stats.failingForMs > 0, 'the failing window is tracked');
  assert.equal(stats.lastError?.reason, 'relay-socket-closed', 'the failure names the closed relay socket');
  assert.ok(healthReports.length >= 2, 'the health callback fires per attempt');
  assert.ok(healthReports.every((h) => h.delivered === false), 'health reports the frames as undelivered');

  // Old firmware: no wsOpen field at all → unknown → assume delivered.
  reply = { ok: true, relayed: true };
  stream.push(FRAME(2));
  await clock.advance(200);
  stats = stream.getStats();
  assert.ok(stats.sentFrames >= 1, 'a reply without wsOpen (old firmware) counts as delivered');
  assert.equal(stats.consecutiveFailures, 0, 'recovery resets the failure streak');
  assert.ok(stats.lastDeliveredAt > 0, 'delivery timestamp recorded');
  assert.equal(healthReports[healthReports.length - 1].delivered, true, 'health reports the recovery');
  await stream.stop();
}

// ── health callback: rejections count, and stop() works from inside it ────
{
  const clock = makeClock();
  let failing = false;
  const record = { cancels: 0 };
  const stops = [];
  const transport = {
    kind: 'fake',
    async sendFrame() {
      if (failing) {
        const error = new Error('Open the card page once to let Studio use it as the local hardware bridge.');
        error.reason = 'bridge-missing';
        throw error;
      }
      return { ok: true };
    },
    async sendCancel() { record.cancels += 1; },
    close() {},
  };
  const stream = createCardFrameStream({
    transport,
    onHealth(health) {
      // the Show screen's auto-stop path: persistent bridge-missing → stop
      if (health.reason === 'bridge-missing' && health.consecutiveFailures >= 3) {
        stops.push(health.consecutiveFailures);
        void stream.stop();
      }
    },
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    now: clock.now,
  });
  stream.start();
  stream.push(FRAME(1));
  await clock.advance(60);
  assert.equal(stream.getStats().consecutiveFailures, 0, 'healthy sends carry no failures');
  failing = true; // the popup closes
  stream.push(FRAME(2));
  await clock.advance(2000);
  assert.equal(stream.isActive(), false, 'auto-stop from inside the health callback lands');
  assert.equal(record.cancels, 1, 'auto-stop releases the canvas exactly once');
  assert.equal(stops.length, 1, 'the callback fired the stop exactly once');
  const stats = stream.getStats();
  assert.ok(stats.consecutiveFailures >= 3, 'the failure streak is visible in stats');
  assert.equal(stats.lastError?.reason, 'bridge-missing', 'the bridge-missing reason surfaces');
}

// ── direct transport: capped backoff between failed WS opens ──────────────
{
  assert.equal(DIRECT_BACKOFF_MIN_MS, 250);
  assert.equal(DIRECT_BACKOFF_MAX_MS, 4000);
  let t = 0;
  const attempts = [];
  class FailingWS {
    constructor() {
      attempts.push(t);
      // settle asynchronously like a real refused connection
      queueMicrotask(() => { this.onclose?.({}); });
    }

    close() {}
  }
  const transport = createDirectFrameTransport('192.168.4.1', {
    WebSocketImpl: FailingWS,
    nowImpl: () => t,
  });
  // drive a ~55ms pump against an unreachable card for 20 seconds
  const reasons = new Set();
  let deliveredWhileDown = 0;
  for (; t <= 20000; t += 55) {
    try {
      await transport.sendFrame(['FF0000']);
      deliveredWhileDown += 1;
    } catch (error) {
      reasons.add(error.reason || 'open-failed');
    }
  }
  assert.equal(deliveredWhileDown, 0, 'sendFrame always fails while the card is unreachable');
  assert.ok(attempts.length <= 12,
    `backoff limits socket opens to a handful in 20s, not one per tick (${attempts.length})`);
  assert.ok(attempts.length >= 6, `backoff still retries (${attempts.length} attempts)`);
  assert.ok(reasons.has('ws-backoff'), 'ticks inside the backoff window fail fast with ws-backoff');
  const gaps = [];
  for (let i = 1; i < attempts.length; i++) gaps.push(attempts[i] - attempts[i - 1]);
  assert.ok(gaps[0] >= DIRECT_BACKOFF_MIN_MS, `first retry waits ≥250ms (${gaps[0]}ms)`);
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i] + 1 >= gaps[i - 1] || gaps[i] >= DIRECT_BACKOFF_MAX_MS,
      `gaps grow toward the cap (${gaps.join(', ')})`);
  }
  assert.ok(Math.max(...gaps) <= DIRECT_BACKOFF_MAX_MS + 60,
    `backoff caps at 4s (max gap ${Math.max(...gaps)}ms)`);
  transport.close();
}

// A direct stream verifies stable identity before opening its WebSocket.
{
  let socketAttempts = 0;
  class CountingWS { constructor() { socketAttempts += 1; } }
  const values = new Map([['lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-expected' })]]);
  globalThis.window = {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
  };
  const transport = createDirectFrameTransport('192.168.18.70', {
    WebSocketImpl: CountingWS,
    fetchImpl: async () => ({ ok: true, json: async () => ({ cardId: 'lw-wrong' }) }),
  });
  await assert.rejects(transport.sendFrame(['FF0000']), error => error?.reason === 'wrong-card');
  assert.equal(socketAttempts, 0, 'wrong-card stream opens no WebSocket');
  delete globalThis.window;
}

// Every reconnect re-verifies the exact host before constructing a new socket.
{
  let reportedCardId = 'lw-expected';
  const sockets = [];
  class ReconnectingWS {
    constructor() {
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(payload) { this.sent.push(payload); }
    close() {
      this.readyState = 3;
      this.onclose?.({});
    }
  }
  const values = new Map([['lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-expected' })]]);
  globalThis.window = {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
  };
  const identityReads = [];
  const transport = createDirectFrameTransport('192.168.18.70', {
    WebSocketImpl: ReconnectingWS,
    fetchImpl: async (url) => {
      identityReads.push(url);
      return { ok: true, json: async () => ({ cardId: reportedCardId }) };
    },
  });
  await transport.sendFrame(['FF0000']);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].sent.length, 1);
  sockets[0].close();
  reportedCardId = 'lw-different';
  await assert.rejects(transport.sendFrame(['00FF00']), error => error?.reason === 'wrong-card');
  assert.equal(identityReads.length, 2, 'reconnect repeats identity verification');
  assert.equal(sockets.length, 1, 'wrong-card reconnect constructs no second WebSocket');
  assert.equal(sockets[0].sent.length, 1, 'wrong-card reconnect sends no frame');
  delete globalThis.window;
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
          response: message.type === 'firmware-info'
            ? { cardId: 'lw-frame-test', firmwareVersion: '1.0.0', buildId: 'frame-test-build' }
            : message.type === 'status'
              ? {
                app: 'Lightweaver', provisioningContractVersion: 1,
                cardId: 'lw-frame-test', firmwareVersion: '1.0.0', buildId: 'frame-test-build',
                bootId: 'frame-test-boot', runtimePhase: 'ready', knownGoodProject: true,
                commandReady: true, outputReady: true,
              }
              : { ok: true, relayed: message.type === 'frame' },
        },
      });
    }, 0);
  },
};
globalThis.window = {
  location: { search: '?cardBridge=1&cardHost=192.168.18.70' },
  opener: null,
  parent: parentBridge,
  localStorage: {
    getItem: key => key === 'lw_card_identity_v1'
      ? JSON.stringify({ version: 1, id: 'lw-frame-test' })
      : '192.168.18.70',
    setItem: () => {},
  },
  addEventListener(type, listener) { listeners.set(type, listener); },
  removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  dispatchEvent: () => {},
};

const {
  bootstrapCardBridgeFromOpener,
  cardBridgeFeatureGap,
  getCardBridgeVersion,
  sendCardBridgeRequest,
  verifyCardBridgeIdentity,
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

await assert.rejects(
  sendCardBridgeRequest('frame', { pixels: ['FF0000'] }, { host: '192.168.18.70', timeoutMs: 200 }),
  error => error?.reason === 'identity-missing',
  'transport-ready bridge refuses frames before identity verification',
);
await verifyCardBridgeIdentity('192.168.18.70');
await sendCardBridgeRequest('status', {}, { host: '192.168.18.70' });
posted.length = 0;

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
