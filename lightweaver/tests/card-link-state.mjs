import assert from 'node:assert/strict';
import {
  CARD_LINK_PING_MISS_LIMIT,
  bootstrapCardLink,
  cardLinkBootstrapFailureReason,
  cardLinkReasonText,
  cardLinkStatusText,
  createCardLink,
  getCardLinkState,
  getSharedCardLink,
  initialCardLinkState,
  isCardLinkConnected,
  reportDirectCardStatus,
  reduceCardLink,
} from '../src/lib/cardLink.js';
import {
  previewResponseUsedZoneFallback,
  pushLivePreviewToCard,
} from '../src/lib/cardLiveControl.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

for (const reason of ['identity-missing', 'firmware-too-old', 'wrong-card', 'bridge-missing']) {
  assert.equal(cardLinkBootstrapFailureReason({ reason }), reason, `bootstrap preserves ${reason}`);
}
assert.equal(cardLinkBootstrapFailureReason({ reason: 'bridge-timeout' }), 'no-answer');
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

const bridgeReadyOnly = reduceCardLink(connecting, { type: 'bridge-ready', host: '192.168.4.1' });
assert.equal(bridgeReadyOnly.state, 'connecting', 'bridge transport readiness is not card verification');
assert.equal(isCardLinkConnected(bridgeReadyOnly), false);
const bridged = reduceCardLink(bridgeReadyOnly, {
  type: 'card-verified',
  via: 'bridge',
  host: '192.168.4.1',
  card: { id: 'lw-001122aabbcc', name: 'Front Mandala' },
  acknowledgedAt: '2026-07-14T12:00:00.000Z',
});
assert.equal(bridged.state, 'connected-bridge');
assert.equal(bridged.transport, 'bridge');
assert.equal(bridged.card.id, 'lw-001122aabbcc');
assert.equal(bridged.acknowledgedAt, '2026-07-14T12:00:00.000Z');
assert.equal(isCardLinkConnected(bridged), true);

const wrongBridgeCard = reduceCardLink(bridgeReadyOnly, {
  type: 'card-verified',
  via: 'bridge',
  host: '192.168.4.1',
  expectedCard: { id: 'lw-expected' },
  card: { id: 'lw-different' },
});
assert.equal(wrongBridgeCard.state, 'disconnected');
assert.equal(wrongBridgeCard.reason, 'wrong-card');
assert.equal(isCardLinkConnected(wrongBridgeCard), false);
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
assert.equal(dropped.state, 'reconnecting-bridge');
assert.equal(dropped.reason, 'card-restarting');
assert.equal(cardLinkStatusText(dropped), 'Card restarting…');
const returnedAfterReboot = reduceCardLink(dropped, { type: 'bridge-ping-ok' });
assert.equal(returnedAfterReboot.state, 'connected-bridge');
assert.equal(returnedAfterReboot.missedPings, 0);

// a missed ping while there is no bridge is meaningless
assert.equal(reduceCardLink(initial, { type: 'bridge-ping-missed' }), initial);

// ── reducer: bridge lost (card page closed) is immediate ───────────────────
const closed = reduceCardLink(bridged, { type: 'bridge-lost' });
assert.equal(closed.state, 'disconnected');
assert.equal(closed.reason, 'card-page-closed');
const popupBlocked = reduceCardLink(closed, { type: 'bridge-lost', reason: 'popup-blocked' });
assert.equal(popupBlocked.reason, 'popup-blocked');

// ── reducer: direct transport ───────────────────────────────────────────────
const missingDirectIdentity = reduceCardLink(initial, { type: 'direct-status', connected: true, host: '192.168.18.70' });
assert.equal(missingDirectIdentity.state, 'disconnected');
assert.equal(missingDirectIdentity.reason, 'identity-missing');
assert.equal(isCardLinkConnected(missingDirectIdentity), false);
const direct = reduceCardLink(initial, {
  type: 'direct-status',
  connected: true,
  host: '192.168.18.70',
  card: { id: 'lw-001122aabbcc', name: 'Front Mandala' },
});
assert.equal(direct.state, 'connected-direct');
assert.equal(direct.transport, 'direct');
assert.equal(isCardLinkConnected(direct), true);
const wrongDirectCard = reduceCardLink(initial, {
  type: 'direct-status',
  connected: true,
  host: '192.168.18.70',
  expectedCard: { id: 'lw-expected' },
  card: { id: 'lw-different' },
});
assert.equal(wrongDirectCard.state, 'disconnected');
assert.equal(wrongDirectCard.reason, 'wrong-card');
assert.equal(isCardLinkConnected(wrongDirectCard), false);
assert.equal(reduceCardLink(direct, {
  type: 'direct-status', connected: true, host: '192.168.18.70', card: { id: 'lw-001122aabbcc' },
}), direct);

const directDown = reduceCardLink(direct, { type: 'direct-status', connected: false, host: '192.168.18.70' });
assert.equal(directDown.state, 'disconnected');
assert.equal(directDown.reason, 'card-unreachable');

// a live bridge is authoritative: direct probe results never demote it
assert.equal(reduceCardLink(bridged, { type: 'direct-status', connected: false }), bridged);
assert.equal(reduceCardLink(bridged, { type: 'direct-status', connected: true, host: '10.0.0.9' }), bridged);
assert.equal(reduceCardLink(bridged, { type: 'connecting', via: 'direct' }), bridged);
// and a failed direct probe never cancels an in-progress bridge connect
assert.equal(reduceCardLink(connecting, { type: 'direct-status', connected: false }), connecting);
// a direct 'connecting' never displaces an in-flight bridge connect either
// (same reference back means the runtime dispatch bails out and the bridge's
// 15s no-answer timer keeps running)
assert.equal(reduceCardLink(connecting, { type: 'connecting', via: 'direct', host: '10.0.0.9' }), connecting);
// a bridge losing its window does not touch a live direct link
assert.equal(reduceCardLink(direct, { type: 'bridge-lost' }), direct);

// Identity from an old host/session cannot authenticate the newly selected card.
const selectingB = reduceCardLink(bridged, { type: 'connecting', via: 'bridge', host: 'card-b.local' });
assert.equal(reduceCardLink(selectingB, {
  type: 'card-verified',
  via: 'bridge',
  host: 'card-a.local',
  card: { id: 'lw-old' },
}), selectingB);

// Physical-operation activity is explicit and independent of transport state.
const pendingActivity = reduceCardLink(bridged, { type: 'operation-started' });
assert.equal(pendingActivity.activity, 'pending');
const recoveringActivity = reduceCardLink(pendingActivity, { type: 'operation-recovering' });
assert.equal(recoveringActivity.activity, 'recovering');
const failedActivity = reduceCardLink(recoveringActivity, { type: 'operation-failed' });
assert.equal(failedActivity.activity, 'failed');
const confirmedActivity = reduceCardLink(failedActivity, {
  type: 'operation-confirmed',
  acknowledgedAt: '2026-07-14T12:01:00.000Z',
});
assert.equal(confirmedActivity.activity, 'idle');
assert.equal(confirmedActivity.acknowledgedAt, '2026-07-14T12:01:00.000Z');

// ── reducer: checking semantics for the footer's direct transport ───────────
// an established direct link can never be demoted by a routine poll starting
assert.equal(reduceCardLink(direct, { type: 'connecting', via: 'direct', host: '192.168.18.70' }), direct);
// but a disconnected re-probe shows the searching state again
const reprobe = reduceCardLink(directDown, { type: 'connecting', via: 'direct', host: '192.168.18.70' });
assert.equal(reprobe.state, 'connecting');
assert.equal(reprobe.transport, 'direct');
assert.equal(cardLinkStatusText(reprobe), 'Looking for the card…');

// ── friendly copy ───────────────────────────────────────────────────────────
for (const reason of ['card-page-closed', 'card-stopped-answering', 'bridge-missing', 'popup-blocked', 'no-answer', 'card-unreachable', 'identity-missing', 'wrong-card', 'firmware-too-old', 'never-connected']) {
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
link.dispatch({ type: 'card-verified', via: 'bridge', host: '192.168.4.1', card: { id: 'lw-test' } });
assert.equal(link.getState().state, 'connected-bridge');
await waitFor(() => pingCount >= 2, 2000, 'two keepalive pings');
assert.equal(link.getState().state, 'connected-bridge');
failPings = true;
await waitFor(() => link.getState().state === 'reconnecting-bridge', 2000, 'reboot-period reconnect state');
const pingsAtReconnect = pingCount;
await waitFor(() => pingCount > pingsAtReconnect, 2000, 'keepalive continues while card reboots');
failPings = false;
await waitFor(() => link.getState().state === 'connected-bridge', 2000, 'automatic bridge recovery');
assert.ok(seen.includes('connected-bridge') && seen.includes('reconnecting-bridge'));
unsubscribe();
link.destroy();

// A card that never returns eventually becomes an honest no-answer state.
const deadLink = createCardLink({
  sendRequest: async () => {
    const error = new Error('timeout');
    error.reason = 'bridge-timeout';
    throw error;
  },
  pingIntervalMs: 5,
  pingTimeoutMs: 5,
  connectTimeoutMs: 35,
  missLimit: 2,
});
deadLink.dispatch({ type: 'card-verified', via: 'bridge', host: '192.168.4.1', card: { id: 'lw-test' } });
await waitFor(() => deadLink.getState().state === 'disconnected', 2000, 'reconnect deadline');
assert.equal(deadLink.getState().reason, 'no-answer');
deadLink.destroy();

// A reply from an old host/session must never authenticate a newly selected card.
let resolveStalePing;
const hostSwitchLink = createCardLink({
  sendRequest: async () => new Promise(resolve => { resolveStalePing = resolve; }),
  pingIntervalMs: 1,
  pingTimeoutMs: 50,
  connectTimeoutMs: 200,
});
hostSwitchLink.dispatch({ type: 'card-verified', via: 'bridge', host: 'card-a.local', card: { id: 'lw-a' } });
await waitFor(() => typeof resolveStalePing === 'function', 2000, 'old-host ping to start');
hostSwitchLink.dispatch({ type: 'connecting', via: 'bridge', host: 'card-b.local' });
resolveStalePing({ ok: true });
await sleep(10);
assert.equal(hostSwitchLink.getState().state, 'connecting');
assert.equal(hostSwitchLink.getState().host, 'card-b.local');
hostSwitchLink.destroy();

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
goneLink.dispatch({ type: 'card-verified', via: 'bridge', host: '192.168.4.1', card: { id: 'lw-test' } });
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

// ── runtime: a direct probe cannot cancel the bridge no-answer timer ────────
// Before the guard, a direct 'connecting' dispatched mid-bridge-connect moved
// the state to connecting-direct, dispatch's else branch cleared the timer,
// and the link sat in 'connecting' forever. Now the bridge connect (and its
// timer) survive and still resolve to an honest no-answer.
const guardedLink = createCardLink({
  sendRequest: async () => ({ ok: true }),
  pingIntervalMs: 1000,
  connectTimeoutMs: 30,
});
guardedLink.dispatch({ type: 'connecting', via: 'bridge', host: 'lightweaver.local' });
guardedLink.dispatch({ type: 'connecting', via: 'direct', host: '192.168.18.70' });
assert.equal(guardedLink.getState().transport, 'bridge', 'bridge connect stays in flight');
await waitFor(() => guardedLink.getState().state === 'disconnected', 2000, 'bridge no-answer timer survives a direct probe');
assert.equal(guardedLink.getState().reason, 'no-answer');
guardedLink.destroy();

// ── no-silent-fallback contract on the HTTPS bridge path ────────────────────
// Production Studio is HTTPS; live pushes travel over the card-page bridge.
// A section push whose zone the card does not have must come back flagged —
// never silently collapsed to the whole strip.
const sent = [];
const listeners = new Map();
const storedValues = new Map([
  ['lw_chip_card_host', '192.168.18.70'],
  ['lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-001122aabbcc', name: 'Expected card' })],
]);
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
      else if (message.type === 'firmware-info') respond({
        cardId: 'lw-001122aabbcc',
        firmwareVersion: '1.0.0',
        buildId: 'test',
        bridgeVersion: 1,
        outputs: [{ gpio: 16, count: 44 }],
      });
      else respond({ ok: true });
    }, 0);
  },
};
globalThis.window = {
  location: { protocol: 'https:', search: '?cardBridge=1&cardHost=192.168.18.70' },
  opener: null,
  parent: parentBridge,
  localStorage: {
    getItem: key => storedValues.get(key) ?? null,
    setItem: (key, value) => storedValues.set(key, value),
    removeItem: key => storedValues.delete(key),
  },
  addEventListener(type, listener) { listeners.set(type, listener); },
  removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  dispatchEvent: () => {},
};
globalThis.localStorage = globalThis.window.localStorage;

// Runtime connection paths compare stable identity before persistence. A card
// at the remembered IP is still the wrong card when its eFuse-derived ID differs.
reportDirectCardStatus({
  connected: true,
  host: '192.168.18.70',
  status: { cardId: 'lw-different', firmwareVersion: '1.0.0' },
});
assert.equal(getCardLinkState().state, 'disconnected');
assert.equal(getCardLinkState().reason, 'wrong-card');
assert.equal(JSON.parse(storedValues.get('lw_card_identity_v1')).id, 'lw-001122aabbcc');

listeners.get('lightweaver-card-bridge-changed')?.({
  detail: {
    connected: true,
    verified: true,
    host: '192.168.18.70',
    card: { id: 'lw-different', firmwareVersion: '1.0.0' },
  },
});
assert.equal(getCardLinkState().state, 'disconnected');
assert.equal(getCardLinkState().reason, 'wrong-card');
assert.equal(JSON.parse(storedValues.get('lw_card_identity_v1')).id, 'lw-001122aabbcc');

await bootstrapCardLink();
assert.equal(getCardLinkState().state, 'connected-bridge', 'bootstrap verifies the real bridge before commands');

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
