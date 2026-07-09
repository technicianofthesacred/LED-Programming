import assert from 'node:assert/strict';
import {
  CARD_LINK_PING_MISS_LIMIT,
  bootstrapCardLink,
  cardLinkReasonText,
  cardLinkStatusText,
  createCardLink,
  getCardLinkState,
  getSharedCardLink,
  initialCardLinkState,
  isCardLinkConnected,
  reduceCardLink,
} from '../src/lib/cardLink.js';
import {
  previewResponseUsedZoneFallback,
  pushLivePreviewToCard,
} from '../src/lib/cardLiveControl.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

// ── reducer: initial state ──────────────────────────────────────────────────
const initial = initialCardLinkState('lightweaver.local');
assert.equal(initial.state, 'disconnected');
assert.equal(initial.reason, 'never-connected');
assert.equal(initial.host, 'lightweaver.local');
assert.equal(isCardLinkConnected(initial), false);

// ── reducer: bridge connect flow ────────────────────────────────────────────
const connecting = reduceCardLink(initial, { type: 'connecting', via: 'bridge', host: '192.168.4.1' });
assert.equal(connecting.state, 'connecting');
assert.equal(connecting.transport, 'bridge');
assert.equal(connecting.host, '192.168.4.1');
// repeated identical connecting events do not create new state objects
assert.equal(reduceCardLink(connecting, { type: 'connecting', via: 'bridge', host: '192.168.4.1' }), connecting);

const bridged = reduceCardLink(connecting, { type: 'bridge-ready', host: '192.168.4.1' });
assert.equal(bridged.state, 'connected-bridge');
assert.equal(bridged.transport, 'bridge');
assert.equal(isCardLinkConnected(bridged), true);
// steady-state pings return the same reference (no re-render churn)
assert.equal(reduceCardLink(bridged, { type: 'bridge-ping-ok' }), bridged);

// ── reducer: missed pings disconnect at the limit, not before ───────────────
const missOnce = reduceCardLink(bridged, { type: 'bridge-ping-missed' });
assert.equal(missOnce.state, 'connected-bridge');
assert.equal(missOnce.missedPings, 1);
const recovered = reduceCardLink(missOnce, { type: 'bridge-ping-ok' });
assert.equal(recovered.state, 'connected-bridge');
assert.equal(recovered.missedPings, 0);

let dropped = bridged;
for (let i = 0; i < CARD_LINK_PING_MISS_LIMIT; i += 1) {
  dropped = reduceCardLink(dropped, { type: 'bridge-ping-missed' });
}
assert.equal(dropped.state, 'disconnected');
assert.equal(dropped.reason, 'card-stopped-answering');

// a missed ping while there is no bridge is meaningless
assert.equal(reduceCardLink(initial, { type: 'bridge-ping-missed' }), initial);

// ── reducer: bridge lost (card page closed) is immediate ───────────────────
const closed = reduceCardLink(bridged, { type: 'bridge-lost' });
assert.equal(closed.state, 'disconnected');
assert.equal(closed.reason, 'card-page-closed');
const popupBlocked = reduceCardLink(closed, { type: 'bridge-lost', reason: 'popup-blocked' });
assert.equal(popupBlocked.reason, 'popup-blocked');

// ── reducer: direct transport ───────────────────────────────────────────────
const direct = reduceCardLink(initial, { type: 'direct-status', connected: true, host: '192.168.18.70' });
assert.equal(direct.state, 'connected-direct');
assert.equal(direct.transport, 'direct');
assert.equal(isCardLinkConnected(direct), true);
assert.equal(reduceCardLink(direct, { type: 'direct-status', connected: true, host: '192.168.18.70' }), direct);

const directDown = reduceCardLink(direct, { type: 'direct-status', connected: false, host: '192.168.18.70' });
assert.equal(directDown.state, 'disconnected');
assert.equal(directDown.reason, 'card-unreachable');

// a live bridge is authoritative: direct probe results never demote it
assert.equal(reduceCardLink(bridged, { type: 'direct-status', connected: false }), bridged);
assert.equal(reduceCardLink(bridged, { type: 'direct-status', connected: true, host: '10.0.0.9' }), bridged);
assert.equal(reduceCardLink(bridged, { type: 'connecting', via: 'direct' }), bridged);
// and a failed direct probe never cancels an in-progress bridge connect
assert.equal(reduceCardLink(connecting, { type: 'direct-status', connected: false }), connecting);
// a bridge losing its window does not touch a live direct link
assert.equal(reduceCardLink(direct, { type: 'bridge-lost' }), direct);

// ── friendly copy ───────────────────────────────────────────────────────────
for (const reason of ['card-page-closed', 'card-stopped-answering', 'bridge-missing', 'popup-blocked', 'no-answer', 'card-unreachable', 'never-connected']) {
  const text = cardLinkReasonText(reason);
  assert.ok(text && typeof text === 'string', `reason text for ${reason}`);
}
assert.equal(cardLinkStatusText(bridged), 'Live via card page');
assert.equal(cardLinkStatusText(direct), 'Live direct');
assert.equal(cardLinkStatusText(connecting), 'Looking for the card…');
assert.equal(cardLinkStatusText(closed), cardLinkReasonText('card-page-closed'));

// ── runtime: keepalive pings every interval, misses disconnect ─────────────
let pingCount = 0;
let failPings = false;
const link = createCardLink({
  sendRequest: async () => {
    pingCount += 1;
    if (failPings) {
      const error = new Error('timeout');
      error.reason = 'bridge-timeout';
      throw error;
    }
    return { ok: true };
  },
  pingIntervalMs: 5,
  pingTimeoutMs: 5,
  connectTimeoutMs: 200,
  missLimit: 2,
});
const seen = [];
const unsubscribe = link.subscribe(state => seen.push(state.state));
link.dispatch({ type: 'bridge-ready', host: '192.168.4.1' });
assert.equal(link.getState().state, 'connected-bridge');
await waitFor(() => pingCount >= 2, 2000, 'two keepalive pings');
assert.equal(link.getState().state, 'connected-bridge');
failPings = true;
await waitFor(() => link.getState().state === 'disconnected', 2000, 'keepalive miss disconnect');
assert.equal(link.getState().reason, 'card-stopped-answering');
const pingsAtDisconnect = pingCount;
await sleep(40);
assert.equal(pingCount, pingsAtDisconnect, 'keepalive stops after disconnect');
assert.ok(seen.includes('connected-bridge') && seen.includes('disconnected'));
unsubscribe();
link.destroy();

// ── runtime: a missing bridge window disconnects immediately ────────────────
const goneLink = createCardLink({
  sendRequest: async () => {
    const error = new Error('gone');
    error.reason = 'bridge-missing';
    throw error;
  },
  pingIntervalMs: 5,
  pingTimeoutMs: 5,
  connectTimeoutMs: 0,
  missLimit: 3,
});
goneLink.dispatch({ type: 'bridge-ready', host: '192.168.4.1' });
await waitFor(() => goneLink.getState().state === 'disconnected', 2000, 'bridge-missing disconnect');
assert.equal(goneLink.getState().reason, 'card-page-closed');
goneLink.destroy();

// ── runtime: connecting times out into an honest reason ────────────────────
const slowLink = createCardLink({
  sendRequest: async () => ({ ok: true }),
  pingIntervalMs: 1000,
  connectTimeoutMs: 10,
});
slowLink.dispatch({ type: 'connecting', via: 'bridge', host: 'lightweaver.local' });
assert.equal(slowLink.getState().state, 'connecting');
await waitFor(() => slowLink.getState().state === 'disconnected', 2000, 'connect timeout');
assert.equal(slowLink.getState().reason, 'no-answer');
slowLink.destroy();

// ── no-silent-fallback contract on the HTTPS bridge path ────────────────────
// Production Studio is HTTPS; live pushes travel over the card-page bridge.
// A section push whose zone the card does not have must come back flagged —
// never silently collapsed to the whole strip.
const sent = [];
const listeners = new Map();
const parentBridge = {
  postMessage(message, targetOrigin) {
    sent.push({ message, targetOrigin });
    setTimeout(() => {
      const respond = (response) => listeners.get('message')?.({
        origin: 'http://192.168.18.70',
        source: parentBridge,
        data: { app: 'LightweaverCardBridge', id: message.id, ok: true, response },
      });
      if (message.type === 'zones') respond({ zones: [{ id: 'zone-a' }] });
      else if (message.type === 'control') respond({ ok: true, applied: message.payload });
      else respond({ ok: true });
    }, 0);
  },
};
globalThis.window = {
  location: { protocol: 'https:', search: '?cardBridge=1&cardHost=192.168.18.70' },
  opener: null,
  parent: parentBridge,
  localStorage: {
    getItem: () => '192.168.18.70',
    setItem: () => {},
    removeItem: () => {},
  },
  addEventListener(type, listener) { listeners.set(type, listener); },
  removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  dispatchEvent: () => {},
};

const fallbackResponse = await pushLivePreviewToCard(
  { patternId: 'ocean', brightness: 0.8, zone: 'zone-b', syncZones: false },
  { host: '192.168.18.70', timeoutMs: 500, fallbackMissingZoneToAll: true },
);
assert.equal(previewResponseUsedZoneFallback(fallbackResponse), true, 'fallback must be reported');
assert.equal(fallbackResponse.requestedZone, 'zone-b');
assert.deepEqual(fallbackResponse.availableZones, ['zone-a']);
const fallbackControl = sent.find(entry => entry.message.type === 'control');
assert.ok(fallbackControl, 'control message was relayed over the bridge');
assert.equal(fallbackControl.message.payload.zone, undefined, 'fallback drops the missing zone');

sent.length = 0;
const targetedResponse = await pushLivePreviewToCard(
  { patternId: 'ocean', brightness: 0.8, zone: 'zone-a', syncZones: false },
  { host: '192.168.18.70', timeoutMs: 500, fallbackMissingZoneToAll: true },
);
assert.equal(previewResponseUsedZoneFallback(targetedResponse), false, 'existing zone pushes are not fallbacks');
const targetedControl = sent.find(entry => entry.message.type === 'control');
assert.equal(targetedControl.message.payload.zone, 'zone-a');

// ── shared link: app-load bootstrap adopts an opener/parent bridge ──────────
const bootState = await bootstrapCardLink();
assert.equal(bootState.state, 'connected-bridge');
assert.equal(bootState.host, '192.168.18.70');
assert.equal(getCardLinkState().state, 'connected-bridge');
getSharedCardLink().destroy();

console.log('card-link-state tests passed');
