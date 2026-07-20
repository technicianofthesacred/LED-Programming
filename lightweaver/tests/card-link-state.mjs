import assert from 'node:assert/strict';
import {
  CARD_LINK_PING_MISS_LIMIT,
  adoptDiscoveredDirectCard,
  bootstrapCardLink,
  cardLinkBootstrapFailureReason,
  cardLinkReasonText,
  cardLinkStatusText,
  connectCardLink,
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
import { isFactoryCardStatus } from '../src/lib/cardConnection.js';
import { requireExpectedCardIdentity } from '../src/lib/cardIdentity.js';
import { nextCardConnectionAction } from '../src/lib/cardConnectionFlow.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function readyEnvelope(cardId, overrides = {}) {
  return {
    app: 'Lightweaver', provisioningContractVersion: 1,
    cardId, firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
    bootId: 'boot-1', runtimePhase: 'ready', knownGoodProject: true,
    commandReady: true, outputReady: true,
    ...overrides,
  };
}

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
  readiness: readyEnvelope('lw-001122aabbcc'),
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
const directReadiness = readyEnvelope('lw-001122aabbcc');
const direct = reduceCardLink(initial, {
  type: 'direct-status',
  connected: true,
  host: '192.168.18.70',
  card: { id: 'lw-001122aabbcc', name: 'Front Mandala' },
  readiness: directReadiness,
  allowAdopt: true,
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
assert.equal(wrongDirectCard.transport, 'direct');
assert.equal(wrongDirectCard.discoveredCard.id, 'lw-different');
assert.equal(isCardLinkConnected(wrongDirectCard), false);
const passiveUnpairedCard = reduceCardLink(initial, {
  type: 'direct-status',
  connected: true,
  host: '192.168.18.71',
  card: { id: 'lw-passive-discovery' },
});
assert.equal(passiveUnpairedCard.state, 'disconnected');
assert.equal(passiveUnpairedCard.reason, 'found-unpaired');
assert.equal(passiveUnpairedCard.discoveredCard.id, 'lw-passive-discovery');
assert.equal(isCardLinkConnected(passiveUnpairedCard), false, 'background polling never adopts a first card');

// A paired card reporting factory/blank stays connected but carries cardBlank.
const blankPaired = reduceCardLink(initial, {
  type: 'direct-status', connected: true, host: '192.168.18.72',
  card: { id: 'lw-blank' }, expectedCard: { id: 'lw-blank' }, blank: true,
  readiness: readyEnvelope('lw-blank', { runtimePhase: 'factory', knownGoodProject: false }),
});
assert.equal(blankPaired.state, 'connected-direct');
assert.equal(isCardLinkConnected(blankPaired), false);
assert.equal(blankPaired.cardBlank, true);
const configuredPaired = reduceCardLink(initial, {
  type: 'direct-status', connected: true, host: '192.168.18.72',
  card: { id: 'lw-blank' }, expectedCard: { id: 'lw-blank' }, blank: false,
  readiness: readyEnvelope('lw-blank'),
});
assert.equal(configuredPaired.cardBlank, false);
// A blank→configured transition must return a NEW object, not the short-circuited prev.
const afterInstall = reduceCardLink(blankPaired, {
  type: 'direct-status', connected: true, host: '192.168.18.72',
  card: { id: 'lw-blank' }, expectedCard: { id: 'lw-blank' }, blank: false,
  readiness: readyEnvelope('lw-blank'),
});
assert.notEqual(afterInstall, blankPaired);
assert.equal(afterInstall.cardBlank, false);

// ── isFactoryCardStatus: raw /api/status blank detection ────────────────────
// A blank card is identified by the firmware's factory signals — mode
// 'factory-flash' or source 'defaults' (set together while unconfigured, both
// cleared on the first saved config). Wiring revision/digest are NOT a blank
// signal: a genuinely paired card with a saved config can be unversioned
// (wiringRevision 0, empty digest) and must stay command-ready, not "blank".
assert.equal(isFactoryCardStatus({ mode: 'factory-flash' }), true, 'factory-flash mode is blank');
assert.equal(isFactoryCardStatus({ source: 'defaults' }), true, 'defaults source is blank');
assert.equal(isFactoryCardStatus({ source: 'defaults', wiringRevision: 0, wiringDigest: '' }), true, 'defaults source with zeroed wiring is blank');
assert.equal(isFactoryCardStatus({ source: 'internal-flash', mode: 'website-flash', wiringRevision: 0, wiringDigest: '' }), false, 'a saved-but-unversioned config is command-ready, not blank');
assert.equal(isFactoryCardStatus({ wiringRevision: 0, wiringDigest: '' }), false, 'zeroed wiring alone is not a blank signal');
assert.equal(isFactoryCardStatus({ mode: 'run', source: 'project', wiringRevision: 3, wiringDigest: 'd'.repeat(64) }), false, 'a configured card is not blank');
assert.equal(isFactoryCardStatus({ wiringRevision: 2, wiringDigest: 'abc' }), false, 'a real revision + digest is not blank');
assert.equal(isFactoryCardStatus(null), false, 'a missing status is not blank');

// A paired blank card routes the Connection Center to install, NOT green ready.
assert.equal(nextCardConnectionAction({
  link: {
    state: 'connected-direct', card: { id: 'lw-blank' }, cardBlank: true,
    readiness: readyEnvelope('lw-blank', { runtimePhase: 'factory', knownGoodProject: false }),
  },
}).id, 'card-needs-project', 'blank paired card offers install, not ready-local-card');
assert.equal(nextCardConnectionAction({
  link: {
    state: 'connected-direct', card: { id: 'lw-blank' }, cardBlank: false,
    readiness: readyEnvelope('lw-blank'),
  },
}).id, 'ready-local-card', 'a configured paired card is ready');

// ── bridge transport carries blank state too (the only live path on HTTPS) ──
// A bridged card-verified with a known blank status is "needs project", never
// plain green — this is the led.mandalacodes.com case the direct poll misses.
const bridgedBlank = reduceCardLink(bridgeReadyOnly, {
  type: 'card-verified', via: 'bridge', host: '192.168.4.1',
  card: { id: 'lw-bridge-blank' }, blank: true,
  readiness: readyEnvelope('lw-bridge-blank', { runtimePhase: 'factory', knownGoodProject: false }),
});
assert.equal(bridgedBlank.state, 'connected-bridge');
assert.equal(bridgedBlank.cardBlank, true, 'a bridged factory card is blank, not plain green');
assert.equal(nextCardConnectionAction({ link: bridgedBlank }).id, 'card-needs-project');
// A verify that did not yet know blank state stays unknown, then a
// follow-up 'bridge-blank' (status read completed) refines it.
const bridgedUnknown = reduceCardLink(bridgeReadyOnly, {
  type: 'card-verified', via: 'bridge', host: '192.168.4.1', card: { id: 'lw-bridge-x' },
});
assert.equal(bridgedUnknown.cardBlank, null, 'unknown blank state stays unknown');
const refinedBlank = reduceCardLink(bridgedUnknown, {
  type: 'bridge-blank', host: '192.168.4.1', cardId: 'lw-bridge-x', blank: true,
  readiness: readyEnvelope('lw-bridge-x', { runtimePhase: 'factory', knownGoodProject: false }),
});
assert.equal(refinedBlank.cardBlank, true, 'a late bridge-blank demotes the bridge link');
assert.equal(nextCardConnectionAction({ link: refinedBlank }).id, 'card-needs-project');
// A stale bridge-blank (wrong card or host) or an unchanged value is ignored.
assert.equal(reduceCardLink(refinedBlank, { type: 'bridge-blank', host: '192.168.4.1', cardId: 'other', blank: false }), refinedBlank);
assert.equal(reduceCardLink(refinedBlank, { type: 'bridge-blank', host: 'other.local', cardId: 'lw-bridge-x', blank: false }), refinedBlank);
assert.equal(reduceCardLink(refinedBlank, { type: 'bridge-blank', host: '192.168.4.1', cardId: 'lw-bridge-x', blank: true }), refinedBlank);
// A bridge-blank has no meaning without an established bridge link.
assert.equal(reduceCardLink(initial, { type: 'bridge-blank', host: '192.168.4.1', cardId: 'lw-bridge-x', blank: true }), initial);

assert.equal(reduceCardLink(direct, {
  type: 'direct-status', connected: true, host: '192.168.18.70', card: { id: 'lw-001122aabbcc' },
  expectedCard: { id: 'lw-001122aabbcc' }, readiness: directReadiness,
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
      else if (message.type === 'control') respond({
        ok: true,
        cardId: 'lw-001122aabbcc',
        patternId: message.payload.patternId,
        revision: message.payload.revision,
        applied: message.payload,
      });
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
  dispatchEvent(event) { listeners.get(event?.type)?.(event); },
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

const isolatedDirectLink = createCardLink({ host: '192.168.18.70' });
isolatedDirectLink.dispatch({
  type: 'direct-status', connected: true, host: '192.168.18.70',
  expectedCard: { id: 'lw-001122aabbcc' },
  card: { id: 'lw-delayed-a', name: 'Delayed A' },
});
let releaseDirectVerification;
const directVerificationGate = new Promise(resolve => { releaseDirectVerification = resolve; });
const delayedDirectAdoption = adoptDiscoveredDirectCard({
  link: isolatedDirectLink,
  fetchImpl: async () => {
    await directVerificationGate;
    return {
      ok: true,
      json: async () => ({ cardId: 'lw-delayed-a', cardName: 'Delayed A' }),
    };
  },
});
isolatedDirectLink.dispatch({
  type: 'direct-status', connected: true, host: '192.168.18.71',
  expectedCard: { id: 'lw-001122aabbcc' },
  card: { id: 'lw-newer-b', name: 'Newer B' },
});
releaseDirectVerification();
await assert.rejects(
  delayedDirectAdoption,
  error => error?.reason === 'stale-discovery',
  'a delayed adoption of A cannot persist or connect after host/newer discovery B replaces it',
);
assert.equal(JSON.parse(storedValues.get('lw_card_identity_v1')).id, 'lw-001122aabbcc');
assert.equal(isolatedDirectLink.getState().discoveredCard.id, 'lw-newer-b');
assert.equal(isolatedDirectLink.getState().state, 'disconnected');

async function assertPersistedAuthorityRace({ initialIdentity, nextIdentity, label }) {
  if (initialIdentity) {
    storedValues.set('lw_card_identity_v1', JSON.stringify(initialIdentity));
  } else {
    storedValues.delete('lw_card_identity_v1');
  }
  const link = createCardLink({ host: '192.168.18.72' });
  link.dispatch({
    type: 'direct-status', connected: true, host: '192.168.18.72',
    expectedCard: { id: 'lw-authority-before' },
    card: { id: 'lw-cross-tab-a', name: 'Cross-tab A' },
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const adoption = adoptDiscoveredDirectCard({
    link,
    fetchImpl: async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({ cardId: 'lw-cross-tab-a', cardName: 'Cross-tab A' }),
      };
    },
  });
  if (nextIdentity) {
    storedValues.set('lw_card_identity_v1', JSON.stringify(nextIdentity));
  } else {
    storedValues.delete('lw_card_identity_v1');
  }
  release();
  await assert.rejects(
    adoption,
    error => error?.reason === 'stale-identity',
    label,
  );
  assert.deepEqual(
    storedValues.has('lw_card_identity_v1')
      ? JSON.parse(storedValues.get('lw_card_identity_v1'))
      : null,
    nextIdentity,
    `${label}: the newer cross-tab authority remains untouched`,
  );
}

await assertPersistedAuthorityRace({
  initialIdentity: null,
  nextIdentity: { version: 1, id: 'lw-cross-tab-b' },
  label: 'null-to-card cross-tab pairing invalidates delayed direct adoption',
});
await assertPersistedAuthorityRace({
  initialIdentity: { version: 1, id: 'lw-authority-before' },
  nextIdentity: null,
  label: 'card-to-null cross-tab forgetting invalidates delayed direct adoption',
});
await assertPersistedAuthorityRace({
  initialIdentity: {
    version: 1, id: 'lw-same-card', address: '192.168.18.72', acknowledgedAt: '2026-07-14T10:00:00.000Z',
  },
  nextIdentity: {
    version: 1, id: 'lw-same-card', address: '192.168.18.73', acknowledgedAt: '2026-07-15T10:00:00.000Z',
  },
  label: 'same-ID generation/address change invalidates delayed direct adoption',
});

storedValues.set('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-001122aabbcc', name: 'Expected card' }));

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

// A fresh browser adopts its first discovered identity only after the existing
// Connect button's user gesture opens the card bridge.
storedValues.delete('lw_card_identity_v1');
globalThis.window.open = () => parentBridge;
assert.equal(connectCardLink('192.168.18.70'), parentBridge);
listeners.get('message')?.({
  origin: 'http://192.168.18.70',
  source: parentBridge,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: '192.168.18.70', version: 1 },
});
await waitFor(() => storedValues.has('lw_card_identity_v1'), 2000, 'explicit Connect first-pair adoption');
assert.equal(JSON.parse(storedValues.get('lw_card_identity_v1')).id, 'lw-001122aabbcc');
await waitFor(() => getCardLinkState().state === 'connected-bridge', 2000, 'first-pair verified connection');
getSharedCardLink().destroy();

// ── honest-connection contract: read path and write guard must agree ────────
// The confirmed root-cause bug was that a reachable-but-unpaired card showed a
// green "Connected" indicator while EVERY hardware command died with a pairing
// error. These assertions lock the indicator (reducer) and the write guard
// (requireExpectedCardIdentity) to the same precondition: a persisted pairing.
storedValues.delete('lw_card_identity_v1');

// (a) A passive poll (allowAdopt:false) of a card this origin has never paired
// is discovered but NOT connected — reason found-unpaired.
const honestLink = createCardLink({ host: '192.168.18.72' });
honestLink.dispatch({
  type: 'direct-status', connected: true, host: '192.168.18.72',
  card: { id: 'lw-honest-01' }, allowAdopt: false,
});
assert.equal(honestLink.getState().state, 'disconnected', 'passive poll of an unpaired card is not connected');
assert.equal(honestLink.getState().reason, 'found-unpaired');
assert.equal(isCardLinkConnected(honestLink.getState()), false, 'an unpaired card must never read as green');
assert.equal(honestLink.getState().discoveredCard.id, 'lw-honest-01');

// The write guard refuses that same unpaired card — proving the OLD green
// indicator was a lie: it claimed ready while every command would throw.
assert.throws(
  () => requireExpectedCardIdentity({ id: 'lw-honest-01' }, {}),
  error => error?.reason === 'identity-missing',
  'unpaired write path throws identity-missing — the state the indicator must reflect',
);

// (d) That identity-missing condition surfaces the one-tap pair affordance.
assert.equal(nextCardConnectionAction({
  link: honestLink.getState(),
  discoveredCard: honestLink.getState().discoveredCard,
  rememberedCard: null,
}).id, 'pair-local-card', 'a found-unpaired / identity-missing state offers pairing');

// (b) The explicit Connect (adopt) path verifies + persists identity, flips the
// indicator green, AND makes the write guard pass — read and write now agree.
const honestVerified = await adoptDiscoveredDirectCard({
  link: honestLink,
  fetchImpl: async (url) => ({
    ok: /\/api\/(?:firmware-info|status)$/.test(String(url)),
    json: async () => ({
      ...readyEnvelope('lw-honest-01'),
      piece: { name: 'Honest card' },
    }),
  }),
});
assert.equal(honestVerified.id, 'lw-honest-01');
assert.equal(honestLink.getState().state, 'connected-direct', 'after Connect the card is genuinely linked');
assert.equal(isCardLinkConnected(honestLink.getState()), true, 'a paired card reads green');
assert.equal(Boolean(honestLink.getState().cardBlank), false, 'a configured paired card is not blank');
assert.equal(JSON.parse(storedValues.get('lw_card_identity_v1')).id, 'lw-honest-01', 'Connect persisted the pairing');
// The write guard that killed commands before now passes for the paired card.
assert.doesNotThrow(
  () => requireExpectedCardIdentity({ id: 'lw-honest-01' }, {}),
  'after pairing, the hardware write guard accepts the card',
);
assert.equal(nextCardConnectionAction({
  link: honestLink.getState(),
}).id, 'ready-local-card', 'the paired configured card presents as ready');
honestLink.destroy();

// (c) A paired card that answers with a factory/blank status stays linked but is
// surfaced as "needs project", never plain green.
const blankLink = createCardLink({ host: '192.168.18.72' });
blankLink.dispatch({
  type: 'direct-status', connected: true, host: '192.168.18.72',
  card: { id: 'lw-honest-01' }, expectedCard: { id: 'lw-honest-01' },
  blank: isFactoryCardStatus({ mode: 'factory-flash', source: 'defaults', wiringRevision: 0, wiringDigest: '' }),
  readiness: readyEnvelope('lw-honest-01', { runtimePhase: 'factory', knownGoodProject: false }),
});
assert.equal(blankLink.getState().state, 'connected-direct');
assert.equal(blankLink.getState().cardBlank, true, 'a factory status marks the paired card blank');
assert.equal(nextCardConnectionAction({
  link: blankLink.getState(),
}).id, 'card-needs-project', 'a blank card is routed to install, not advertised as ready');
blankLink.destroy();

// (e) Adopting a blank card on the DIRECT path re-reads /api/status so the
// paired card lands with cardBlank set on its first render — no green flash.
storedValues.delete('lw_card_identity_v1');
const blankAdoptLink = createCardLink({ host: '192.168.18.72' });
blankAdoptLink.dispatch({
  type: 'direct-status', connected: true, host: '192.168.18.72',
  card: { id: 'lw-blank-adopt' }, allowAdopt: false,
});
assert.equal(blankAdoptLink.getState().reason, 'found-unpaired');
await adoptDiscoveredDirectCard({
  link: blankAdoptLink,
  fetchImpl: async (url) => {
    const u = String(url);
    if (/\/api\/firmware-info$/.test(u)) return {
      ok: true,
      json: async () => ({ app: 'Lightweaver', cardId: 'lw-blank-adopt', firmwareVersion: '1.4.0', buildId: 'a'.repeat(40) }),
    };
    if (/\/api\/status$/.test(u)) return {
      ok: true,
      json: async () => readyEnvelope('lw-blank-adopt', {
        runtimePhase: 'factory', knownGoodProject: false,
        mode: 'factory-flash', source: 'defaults',
      }),
    };
    return { ok: false };
  },
});
assert.equal(blankAdoptLink.getState().state, 'connected-direct');
assert.equal(blankAdoptLink.getState().cardBlank, true, 'adopting a blank card sets cardBlank immediately');
assert.equal(nextCardConnectionAction({ link: blankAdoptLink.getState() }).id, 'card-needs-project');
blankAdoptLink.destroy();

// ── runtime: direct keepalive ping (idle-time silent-drop detection) ────────
// When a paired card is connected-direct, the link should poll /api/status
// every 20 seconds. If the card stops answering, demote to 'reconnecting' and
// surface the disconnection to the user.
const directPingLink = createCardLink({
  host: '192.168.1.100',
  directPingIntervalMs: 50,
  pingTimeoutMs: 100,
  fetchImpl: async (url) => {
    if (/\/api\/status/.test(String(url))) {
      return { ok: true, json: async () => ({ cardId: 'lw-ping-test', firmwareVersion: '1.4.0' }) };
    }
    return { ok: false };
  },
});
directPingLink.dispatch({
  type: 'direct-status', connected: true, host: '192.168.1.100',
  card: { id: 'lw-ping-test' }, expectedCard: { id: 'lw-ping-test' }, blank: false,
});
assert.equal(directPingLink.getState().state, 'connected-direct', 'start connected-direct');
assert.equal(directPingLink.getState().missedPings, 0);

// Let a successful ping run.
await waitFor(() => directPingLink.getState().missedPings >= 0, 500, 'ping scheduled');
directPingLink.destroy();

// Test silent-drop recovery: start connected, then fail pings.
let pingMisses = 0;
const dropLink = createCardLink({
  host: '192.168.1.101',
  directPingIntervalMs: 30,
  pingTimeoutMs: 50,
  missLimit: 2,
  fetchImpl: async () => {
    pingMisses += 1;
    throw new Error('timeout'); // simulate card stopped answering
  },
});
dropLink.dispatch({
  type: 'direct-status', connected: true, host: '192.168.1.101',
  card: { id: 'lw-drop-test' }, expectedCard: { id: 'lw-drop-test' }, blank: false,
});
assert.equal(dropLink.getState().state, 'connected-direct');
await waitFor(
  () => dropLink.getState().state === 'reconnecting' && dropLink.getState().reason === 'card-stopped-answering',
  1000,
  'direct silent-drop detected'
);
assert.equal(cardLinkStatusText(dropLink.getState()), 'Card stopped responding — reconnecting…');
dropLink.destroy();

console.log('card-link-state tests passed');
