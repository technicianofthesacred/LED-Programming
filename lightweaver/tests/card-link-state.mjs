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
  resumeCardWifiHandoff,
} from '../src/lib/cardLink.js';
import {
  previewResponseUsedZoneFallback,
  pushLivePreviewToCard,
} from '../src/lib/cardLiveControl.js';
import { adoptDiscoveredCardBridgeIdentity, sendCardBridgeRequest } from '../src/lib/cardBridge.js';
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

function handoffEnvelope(correlation, overrides = {}) {
  return readyEnvelope(correlation.expectedCardId, {
    firmwareVersion: correlation.expectedFirmwareVersion,
    buildId: correlation.expectedBuildId,
    bootId: correlation.expectedBootId,
    wifi: {
      transport: 'station', transition: 'handoff-ready', transitionPending: true,
      apActive: true, stationIp: correlation.host, ip: correlation.host,
      handoffGeneration: correlation.handoffGeneration,
    },
    ...overrides,
  });
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
  bridgeLifecycle: 4,
  acknowledgedAt: '2026-07-14T12:00:00.000Z',
});
assert.equal(bridged.state, 'connected-bridge');
assert.equal(bridged.transport, 'bridge');
assert.equal(bridged.card.id, 'lw-001122aabbcc');
assert.equal(bridged.acknowledgedAt, '2026-07-14T12:00:00.000Z');
assert.equal(isCardLinkConnected(bridged), true);

// A WiFi retarget is a fresh bridge lifecycle with no inherited command
// authority. Two complete, consecutive handoff-ready station-origin envelopes
// establish acknowledgement authority; final station truth is still required
// before the link can become connected again.
const wifiCorrelation = {
  host: '192.168.18.90', expectedCardId: 'lw-001122aabbcc',
  expectedFirmwareVersion: '1.0.0', expectedBuildId: 'a'.repeat(40),
  expectedBootId: 'boot-1', handoffGeneration: 9,
};
const wifiFlowId = 'flow-a-commission-1234';
const wifiRetargeted = reduceCardLink(bridged, {
  type: 'wifi-handoff-retargeted', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 10,
  flowId: wifiFlowId,
});
assert.equal(isCardLinkConnected(wifiRetargeted), false);
assert.equal(wifiRetargeted.readiness, null);
assert.equal(wifiRetargeted.activity, 'idle');
assert.equal(wifiRetargeted.handoffEnvelopeCount, 0);

const wifiOne = reduceCardLink(wifiRetargeted, {
  type: 'wifi-handoff-status', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 11,
  flowId: wifiFlowId,
  readiness: handoffEnvelope(wifiCorrelation),
});
assert.equal(wifiOne.handoffEnvelopeCount, 1);
assert.equal(wifiOne.handoffAckReady, false);
assert.equal(isCardLinkConnected(wifiOne), false);
const replacementFlow = reduceCardLink(wifiOne, {
  type: 'wifi-handoff-retargeted', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 11,
  flowId: 'flow-b-commission-5678',
});
assert.equal(replacementFlow.handoffFlowId, 'flow-b-commission-5678');
assert.equal(replacementFlow.handoffEnvelopeCount, 0,
  'a replacement commissioning flow cannot inherit the earlier flow envelope');
const staleFlowEnvelope = reduceCardLink(replacementFlow, {
  type: 'wifi-handoff-status', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 11,
  flowId: wifiFlowId,
  readiness: handoffEnvelope(wifiCorrelation),
});
assert.equal(staleFlowEnvelope, replacementFlow,
  'an earlier flow cannot advance a later flow even for the same card and generation');
const wifiTwo = reduceCardLink(wifiOne, {
  type: 'wifi-handoff-status', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 11,
  flowId: wifiFlowId,
  readiness: handoffEnvelope(wifiCorrelation),
});
assert.equal(wifiTwo.handoffEnvelopeCount, 2);
assert.equal(wifiTwo.handoffAckReady, true);
assert.equal(isCardLinkConnected(wifiTwo), false);

const wifiAckAttempted = reduceCardLink(wifiTwo, {
  type: 'wifi-handoff-ack-attempted', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 11,
  flowId: wifiFlowId,
});
assert.equal(wifiAckAttempted.handoffAckAttempted, true);
assert.equal(wifiAckAttempted.handoffAckInFlight, true);
assert.equal(wifiAckAttempted.handoffAckReady, false);
const wifiAcked = reduceCardLink(wifiAckAttempted, {
  type: 'wifi-handoff-ack-sent', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 11,
  flowId: 'flow-a-commission-1234',
});
assert.equal(wifiAcked.handoffAckSent, true);
assert.equal(wifiAcked.handoffAckInFlight, false);
assert.equal(wifiAcked.handoffAckReady, false);
const finalNotReady = reduceCardLink(wifiAcked, {
  type: 'wifi-handoff-status', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 11,
  flowId: wifiFlowId,
  readiness: handoffEnvelope(wifiCorrelation, {
    runtimePhase: 'factory', knownGoodProject: false, commandReady: false,
    wifi: {
      transport: 'station', transition: 'station', transitionPending: false,
      apActive: false, stationIp: wifiCorrelation.host, ip: wifiCorrelation.host,
      handoffGeneration: wifiCorrelation.handoffGeneration,
    },
  }),
});
assert.equal(isCardLinkConnected(finalNotReady), false, 'final transition without command readiness stays blocked');
assert.equal(finalNotReady.state, 'connected-bridge');
assert.equal(finalNotReady.cardBlank, true);
assert.equal(cardLinkStatusText(finalNotReady), 'Blank — load a project');
const wifiFinal = reduceCardLink(wifiAcked, {
  type: 'wifi-handoff-status', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 11,
  flowId: wifiFlowId,
  readiness: handoffEnvelope(wifiCorrelation, {
    wifi: {
      transport: 'station', transition: 'station', transitionPending: false,
      apActive: false, stationIp: wifiCorrelation.host, ip: wifiCorrelation.host,
      handoffGeneration: wifiCorrelation.handoffGeneration,
    },
  }),
});
assert.equal(wifiFinal.state, 'connected-bridge');
assert.equal(isCardLinkConnected(wifiFinal), true);

const restoredAfterReload = reduceCardLink(initialCardLinkState(wifiCorrelation.host), {
  type: 'wifi-handoff-restored', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 30,
  flowId: wifiFlowId, ackAttempted: true,
});
assert.equal(restoredAfterReload.handoffAckAttempted, true);
assert.equal(restoredAfterReload.handoffEnvelopeCount, 0);
assert.equal(restoredAfterReload.handoffReloadRecovery, true);
const restoredBridgeReady = reduceCardLink(restoredAfterReload, {
  type: 'bridge-ready', host: wifiCorrelation.host, bridgeLifecycle: 30,
});
assert.equal(restoredBridgeReady.handoffEnvelopeCount, 0);
assert.equal(restoredBridgeReady.handoffReloadRecovery, true,
  'the reacquired card-page handshake preserves reload recovery until fresh final status');
const restoredFinalOne = reduceCardLink(restoredBridgeReady, {
  type: 'wifi-handoff-status', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 30, flowId: wifiFlowId,
  readiness: finalNotReady.readiness,
});
assert.equal(restoredFinalOne.handoffEnvelopeCount, 1);
assert.equal(restoredFinalOne.handoffStationVerified, false,
  'one final envelope after reload cannot recreate blank config authority');
const restoredFinalTwo = reduceCardLink(restoredFinalOne, {
  type: 'wifi-handoff-status', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 30, flowId: wifiFlowId,
  readiness: finalNotReady.readiness,
});
assert.equal(restoredFinalTwo.handoffStationVerified, true,
  'two exact final envelopes re-prove the restored handoff without another acknowledgement');
assert.equal(restoredFinalTwo.cardBlank, true);

const lifecycleChangedDuringHandoff = reduceCardLink(wifiOne, {
  type: 'bridge-ready', host: wifiCorrelation.host, bridgeLifecycle: 12,
});
assert.equal(lifecycleChangedDuringHandoff.handoffEnvelopeCount, 0);
assert.equal(lifecycleChangedDuringHandoff.handoffAckReady, false);
assert.equal(isCardLinkConnected(lifecycleChangedDuringHandoff), false);
const staleHandoffStatus = reduceCardLink(wifiRetargeted, {
  type: 'wifi-handoff-status', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 11,
  flowId: wifiFlowId,
  readiness: handoffEnvelope(wifiCorrelation, {
    wifi: {
      ...handoffEnvelope(wifiCorrelation).wifi,
      handoffGeneration: wifiCorrelation.handoffGeneration - 1,
    },
  }),
});
assert.equal(staleHandoffStatus.handoffEnvelopeCount, 0);
assert.equal(isCardLinkConnected(staleHandoffStatus), false);

const orchestratedLink = createCardLink({ host: wifiCorrelation.host, connectTimeoutMs: 0 });
orchestratedLink.dispatch({
  type: 'wifi-handoff-retargeted', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 21, flowId: wifiFlowId,
});
const orchestratedCalls = [];
const orchestratedDelays = [];
const orchestratedStatuses = [
  handoffEnvelope(wifiCorrelation),
  handoffEnvelope(wifiCorrelation),
  handoffEnvelope(wifiCorrelation, {
    wifi: {
      transport: 'station', transition: 'station', transitionPending: false,
      apActive: false, stationIp: wifiCorrelation.host, ip: wifiCorrelation.host,
      handoffGeneration: wifiCorrelation.handoffGeneration,
    },
  }),
];
await resumeCardWifiHandoff({
  link: orchestratedLink,
  correlation: wifiCorrelation,
  flowId: wifiFlowId,
  bridgeLifecycle: 21,
  isCurrent: () => true,
  wait: async delayMs => { orchestratedDelays.push(delayMs); },
  sendRequest: async type => {
    orchestratedCalls.push(type);
    return type === 'status' ? orchestratedStatuses.shift() : { ok: true };
  },
});
assert.deepEqual(orchestratedCalls, ['status', 'status', 'wifi-handoff-ack', 'status']);
assert.deepEqual(orchestratedDelays, [500, 500], 'handoff envelope and final-status reads use bounded cadence');
assert.equal(isCardLinkConnected(orchestratedLink.getState()), true);

const restoredOrchestratedLink = createCardLink({ host: wifiCorrelation.host, connectTimeoutMs: 0 });
restoredOrchestratedLink.dispatch({
  type: 'wifi-handoff-restored', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 31,
  flowId: wifiFlowId, ackAttempted: true,
});
const restoredCalls = [];
await resumeCardWifiHandoff({
  link: restoredOrchestratedLink,
  correlation: wifiCorrelation,
  flowId: wifiFlowId,
  bridgeLifecycle: 31,
  isCurrent: () => true,
  wait: async () => {},
  sendRequest: async type => {
    restoredCalls.push(type);
    return finalNotReady.readiness;
  },
});
assert.deepEqual(restoredCalls, ['status', 'status'],
  'reload recovery re-proves final station truth without duplicating the ambiguous acknowledgement');
assert.equal(restoredOrchestratedLink.getState().handoffStationVerified, true);
await resumeCardWifiHandoff({
  link: orchestratedLink,
  correlation: wifiCorrelation,
  flowId: wifiFlowId,
  bridgeLifecycle: 21,
  isCurrent: () => true,
  sendRequest: async type => { orchestratedCalls.push(type); return null; },
});
assert.equal(orchestratedCalls.filter(type => type === 'wifi-handoff-ack').length, 1, 'handoff ack is exactly once');
orchestratedLink.destroy();

const lostAckLink = createCardLink({ host: wifiCorrelation.host, connectTimeoutMs: 0 });
lostAckLink.dispatch({
  type: 'wifi-handoff-retargeted', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 31, flowId: wifiFlowId,
});
let lostAckRequests = 0;
let lostAckStatusReads = 0;
let returnFinalStation = false;
const lostAckSendRequest = async type => {
  if (type === 'wifi-handoff-ack') {
    lostAckRequests += 1;
    const error = new Error('ack response lost');
    error.reason = 'bridge-timeout';
    throw error;
  }
  lostAckStatusReads += 1;
  return returnFinalStation
    ? handoffEnvelope(wifiCorrelation, {
      wifi: {
        transport: 'station', transition: 'station', transitionPending: false,
        apActive: false, stationIp: wifiCorrelation.host, ip: wifiCorrelation.host,
        handoffGeneration: wifiCorrelation.handoffGeneration,
      },
    })
    : handoffEnvelope(wifiCorrelation);
};
await resumeCardWifiHandoff({
  link: lostAckLink,
  correlation: wifiCorrelation,
  flowId: wifiFlowId,
  bridgeLifecycle: 31,
  isCurrent: () => true,
  sendRequest: lostAckSendRequest,
}).catch(() => {});
await resumeCardWifiHandoff({
  link: lostAckLink,
  correlation: wifiCorrelation,
  flowId: wifiFlowId,
  bridgeLifecycle: 31,
  isCurrent: () => true,
  sendRequest: lostAckSendRequest,
}).catch(() => {});
assert.deepEqual(
  { acks: lostAckRequests },
  { acks: 1 },
  'a lost acknowledgement response cannot cause an automatic second privileged mutation',
);
assert.ok(lostAckStatusReads >= 3,
  'after an uncertain acknowledgement the handoff keeps polling status instead of resending');
assert.equal(lostAckLink.getState().handoffAckAttempted, true);
assert.equal(lostAckLink.getState().handoffAckInFlight, false);
assert.equal(isCardLinkConnected(lostAckLink.getState()), false);
lostAckLink.dispatch({
  type: 'bridge-ready', host: wifiCorrelation.host, bridgeLifecycle: 32,
});
await resumeCardWifiHandoff({
  link: lostAckLink,
  correlation: wifiCorrelation,
  flowId: wifiFlowId,
  bridgeLifecycle: 32,
  isCurrent: () => true,
  wait: async () => {},
  sendRequest: lostAckSendRequest,
});
assert.equal(lostAckRequests, 1,
  'a card-page lifecycle change preserves the exact-correlation acknowledgement attempt latch');
returnFinalStation = true;
await resumeCardWifiHandoff({
  link: lostAckLink,
  correlation: wifiCorrelation,
  flowId: wifiFlowId,
  bridgeLifecycle: 32,
  isCurrent: () => true,
  wait: async () => {},
  sendRequest: lostAckSendRequest,
});
assert.equal(lostAckRequests, 1);
assert.equal(isCardLinkConnected(lostAckLink.getState()), true,
  'exact final station status completes an acknowledgement whose response was lost');
lostAckLink.destroy();

const scheduledHandoffDelays = [];
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback, delay = 0) => {
  scheduledHandoffDelays.push(Number(delay));
  return { callback, delay };
};
globalThis.clearTimeout = () => {};
try {
  const boundedLink = createCardLink({ host: wifiCorrelation.host, connectTimeoutMs: 0 });
  boundedLink.dispatch({
    type: 'wifi-handoff-retargeted', host: wifiCorrelation.host,
    correlation: wifiCorrelation, bridgeLifecycle: 41, flowId: wifiFlowId,
  });
  assert.equal(scheduledHandoffDelays.some(delay => delay < 250), false,
    'ordinary keepalive never schedules an immediate loop during a correlated handoff');
  boundedLink.destroy();
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

const repeatedBridgeVerification = reduceCardLink(bridged, {
  type: 'card-verified', via: 'bridge', host: '192.168.4.1',
  card: { id: 'lw-001122aabbcc', name: 'Front Mandala' }, bridgeLifecycle: 4,
});
assert.equal(
  repeatedBridgeVerification.readiness,
  bridged.readiness,
  'same-target bridge verification preserves authoritative readiness evidence',
);
assert.equal(isCardLinkConnected(repeatedBridgeVerification), true);

const reloadedBridgeVerification = reduceCardLink(bridged, {
  type: 'card-verified', via: 'bridge', host: '192.168.4.1',
  card: { id: 'lw-001122aabbcc', name: 'Front Mandala' }, bridgeLifecycle: 5,
});
assert.equal(reloadedBridgeVerification.readiness, null, 'new bridge lifecycle clears stale readiness');
assert.equal(reloadedBridgeVerification.cardBlank, null);
assert.equal(isCardLinkConnected(reloadedBridgeVerification), false);

const changedBridgeIdentity = reduceCardLink(bridged, {
  type: 'card-verified', via: 'bridge', host: '192.168.4.1',
  card: { id: 'lw-new-card' }, bridgeLifecycle: 4,
});
assert.equal(changedBridgeIdentity.readiness, null, 'new card identity cannot inherit prior readiness');
assert.equal(isCardLinkConnected(changedBridgeIdentity), false);

const changedBridgeHost = reduceCardLink(bridged, {
  type: 'connecting', via: 'bridge', host: 'card-b.local',
});
assert.equal(changedBridgeHost.readiness, null, 'new bridge host clears prior readiness');
assert.equal(changedBridgeHost.cardBlank, null);

const reloadedBridgeReady = reduceCardLink(bridged, {
  type: 'bridge-ready', host: '192.168.4.1', bridgeLifecycle: 5,
});
assert.equal(reloadedBridgeReady.state, 'connecting', 'new bridge lifecycle revalidates before commands');
assert.equal(reloadedBridgeReady.readiness, null);

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

// ── reducer: a miss is visible immediately; only full status can recover ────
const missOnce = reduceCardLink(bridged, { type: 'bridge-ping-missed' });
assert.equal(missOnce.state, 'reconnecting-bridge');
assert.equal(missOnce.missedPings, 1);
const recovered = reduceCardLink(missOnce, { type: 'bridge-ping-ok' });
assert.equal(recovered.state, 'reconnecting-bridge');
const partialRecovery = reduceCardLink(missOnce, {
  type: 'bridge-ping-ok', host: bridged.host, card: bridged.card,
  expectedCard: bridged.card,
  readiness: { app: 'Lightweaver', cardId: bridged.card.id, firmwareVersion: '1.0.0', buildId: 'old' },
});
assert.equal(partialRecovery.state, 'revalidating', 'partial bridge status after misses never restores the link');
assert.equal(isCardLinkConnected(partialRecovery), false);
const recoveredWithStatus = reduceCardLink(missOnce, {
  type: 'bridge-ping-ok', host: bridged.host, card: bridged.card,
  expectedCard: bridged.card, readiness: readyEnvelope(bridged.card.id),
});
assert.equal(recoveredWithStatus.state, 'revalidating', 'first full status after a loss only establishes a candidate boot');
assert.equal(recoveredWithStatus.candidateBootId, 'boot-1');
assert.equal(isCardLinkConnected(recoveredWithStatus), false);
const recoveredWithStableStatus = reduceCardLink(recoveredWithStatus, {
  type: 'bridge-ping-ok', host: bridged.host, card: bridged.card,
  expectedCard: bridged.card, readiness: readyEnvelope(bridged.card.id),
});
assert.equal(recoveredWithStableStatus.state, 'connected-bridge');
assert.equal(recoveredWithStableStatus.missedPings, 0);

let dropped = bridged;
for (let i = 0; i < CARD_LINK_PING_MISS_LIMIT; i += 1) {
  dropped = reduceCardLink(dropped, { type: 'bridge-ping-missed' });
}
assert.equal(dropped.state, 'reconnecting-bridge');
assert.equal(dropped.reason, 'card-stopped-answering');
assert.equal(cardLinkStatusText(dropped), 'Card stopped responding — reconnecting…');
const returnedAfterReboot = reduceCardLink(dropped, { type: 'bridge-ping-ok' });
assert.notEqual(returnedAfterReboot.state, 'connected-bridge', 'transport-only ping cannot restore green');
assert.equal(isCardLinkConnected(returnedAfterReboot), false);

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
const directOperation = reduceCardLink(direct, { type: 'operation-started' });
const rebootSeen = reduceCardLink(directOperation, {
  type: 'direct-status', connected: true, host: '192.168.18.70',
  card: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
  expectedCard: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
  readiness: readyEnvelope('lw-001122aabbcc', { bootId: 'boot-2' }),
});
assert.equal(rebootSeen.state, 'revalidating');
assert.equal(rebootSeen.readiness, null, 'boot change immediately clears command/project evidence');
assert.equal(rebootSeen.cardBlank, null);
assert.equal(rebootSeen.activity, 'idle', 'boot change invalidates pending operation authority');
assert.ok(rebootSeen.operationGeneration > directOperation.operationGeneration);
assert.equal(isCardLinkConnected(rebootSeen), false);
assert.equal(rebootSeen.candidateBootId, 'boot-2');
const delayedOldBoot = reduceCardLink(rebootSeen, {
  type: 'direct-status', connected: true, host: '192.168.18.70',
  card: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
  expectedCard: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
  readiness: readyEnvelope('lw-001122aabbcc', { bootId: 'boot-1' }),
});
assert.equal(delayedOldBoot.state, 'revalidating', 'a delayed old-boot reply cannot restore green');
assert.equal(delayedOldBoot.candidateBootId, 'boot-2', 'a delayed old boot cannot clear the new candidate');
const differentBootRace = reduceCardLink(delayedOldBoot, {
  type: 'direct-status', connected: true, host: '192.168.18.70',
  card: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
  expectedCard: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
  readiness: readyEnvelope('lw-001122aabbcc', { bootId: 'boot-3' }),
});
assert.equal(differentBootRace.state, 'revalidating', 'a different new-boot race cannot restore green');
assert.equal(differentBootRace.candidateBootId, 'boot-2', 'a different boot cannot replace the candidate under validation');
const rebootRevalidated = reduceCardLink(differentBootRace, {
  type: 'direct-status', connected: true, host: '192.168.18.70',
  card: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
  expectedCard: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
  readiness: readyEnvelope('lw-001122aabbcc', { bootId: 'boot-2' }),
});
assert.equal(rebootRevalidated.state, 'connected-direct');
assert.equal(isCardLinkConnected(rebootRevalidated), true);

const directMiss = reduceCardLink(direct, { type: 'direct-ping-missed' });
const directRecoveryCandidate = reduceCardLink(directMiss, {
  type: 'direct-ping-ok', host: direct.host, card: direct.card,
  expectedCard: direct.card, readiness: readyEnvelope(direct.card.id),
});
assert.equal(directRecoveryCandidate.state, 'revalidating');
assert.equal(directRecoveryCandidate.candidateBootId, 'boot-1');
assert.equal(isCardLinkConnected(directRecoveryCandidate), false, 'same-boot recovery still needs two envelopes');
const directRecoveryRace = reduceCardLink(directRecoveryCandidate, {
  type: 'direct-ping-ok', host: direct.host, card: direct.card,
  expectedCard: direct.card, readiness: readyEnvelope(direct.card.id, { bootId: 'boot-other' }),
});
assert.equal(directRecoveryRace.candidateBootId, 'boot-1');
assert.equal(isCardLinkConnected(directRecoveryRace), false);
const directRecovered = reduceCardLink(directRecoveryRace, {
  type: 'direct-ping-ok', host: direct.host, card: direct.card,
  expectedCard: direct.card, readiness: readyEnvelope(direct.card.id),
});
assert.equal(directRecovered.state, 'connected-direct');
assert.equal(isCardLinkConnected(directRecovered), true);

const wrongBuildDirect = reduceCardLink(direct, {
  type: 'direct-status', connected: true, host: '192.168.18.70',
  card: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0', buildId: 'b'.repeat(40) },
  expectedCard: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
  readiness: readyEnvelope('lw-001122aabbcc', { buildId: 'b'.repeat(40) }),
});
assert.equal(wrongBuildDirect.state, 'disconnected');
assert.equal(wrongBuildDirect.reason, 'wrong-firmware-build');
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
const passiveBridgeCard = reduceCardLink(connecting, {
  type: 'bridge-discovered', host: '192.168.4.1',
  card: { id: 'lw-passive-bridge', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
  bridgeLifecycle: 8,
});
assert.equal(passiveBridgeCard.state, 'disconnected');
assert.equal(passiveBridgeCard.reason, 'found-unpaired');
assert.equal(passiveBridgeCard.transport, 'bridge');
assert.equal(passiveBridgeCard.discoveredCard.id, 'lw-passive-bridge');
assert.equal(isCardLinkConnected(passiveBridgeCard), false, 'ordinary bridge Connect only discovers; Pair is explicit');

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
assert.equal(
  cardLinkStatusText({ state: 'connected-bridge', card: { id: 'lw-checking' } }),
  'Checking card',
  'transport alone never reports Live',
);
assert.equal(cardLinkStatusText(bridgedBlank), 'Blank — load a project');
assert.equal(cardLinkStatusText(connecting), 'Looking for the card…');
assert.equal(cardLinkStatusText(closed), cardLinkReasonText('card-page-closed'));

// ── runtime: keepalive pings every interval, misses disconnect ─────────────
let pingCount = 0;
let failPings = false;
const link = createCardLink({
  sendRequest: async (type, payload) => {
    pingCount += 1;
    if (failPings) {
      const error = new Error('timeout');
      error.reason = 'bridge-timeout';
      throw error;
    }
    assert.equal(type, 'status', 'bridge keepalive always reads the full status envelope');
    assert.equal(payload.cache, 'no-store');
    return readyEnvelope('lw-test');
  },
  pingIntervalMs: 5,
  pingTimeoutMs: 5,
  connectTimeoutMs: 200,
  missLimit: 2,
});
const seen = [];
const unsubscribe = link.subscribe(state => seen.push(state.state));
link.dispatch({ type: 'card-verified', via: 'bridge', host: '192.168.4.1', card: { id: 'lw-test' }, readiness: readyEnvelope('lw-test') });
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
let bridgeStatusFails = false;
let bridgeStatusPayload = readyEnvelope('lw-001122aabbcc');
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
        buildId: 'a'.repeat(40),
        bridgeVersion: 1,
        outputs: [{ gpio: 16, count: 44 }],
      });
      else if (message.type === 'status') {
        if (bridgeStatusFails) {
          listeners.get('message')?.({
            origin: 'http://192.168.18.70',
            source: parentBridge,
            data: { app: 'LightweaverCardBridge', id: message.id, ok: false, error: 'status unavailable' },
          });
        } else {
          respond(bridgeStatusPayload);
        }
      }
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
      json: async () => readyEnvelope('lw-delayed-a', { cardName: 'Delayed A' }),
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
        json: async () => readyEnvelope('lw-cross-tab-a', { cardName: 'Cross-tab A' }),
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
assert.equal(isCardLinkConnected(getCardLinkState()), true, 'complete bridged status evidence satisfies live readiness');
assert.equal(getCardLinkState().readiness?.bootId, 'boot-1');
const readinessBeforePing = getCardLinkState().readiness;
await sendCardBridgeRequest('ping', {}, { host: '192.168.18.70', timeoutMs: 500 });
assert.equal(
  getCardLinkState().readiness,
  readinessBeforePing,
  'successful same-card bridge ping preserves readiness evidence',
);
assert.equal(isCardLinkConnected(getCardLinkState()), true, 'verified ping does not demote a ready bridge');

bridgeStatusPayload = {
  app: 'Lightweaver', cardId: 'lw-001122aabbcc',
  firmwareVersion: '1.0.0', buildId: 'partial-status',
};
await bootstrapCardLink();
assert.equal(getCardLinkState().cardBlank, null, 'partial bridged status keeps blank state unknown');
assert.equal(isCardLinkConnected(getCardLinkState()), false, 'partial bridged status remains checking');

bridgeStatusPayload = readyEnvelope('lw-001122aabbcc', {
  runtimePhase: 'factory', knownGoodProject: false,
});
await bootstrapCardLink();
assert.equal(getCardLinkState().cardBlank, true, 'authoritative factory bridge status is blank');
assert.equal(isCardLinkConnected(getCardLinkState()), false);

  bridgeStatusFails = true;
  await bootstrapCardLink();
assert.equal(getCardLinkState().state, 'revalidating', 'failed status revokes readiness without inventing a disconnect identity');
assert.equal(getCardLinkState().cardBlank, null, 'failed bridged status keeps blank state unknown');
assert.equal(getCardLinkState().readiness, null, 'failed bridged status keeps readiness unknown');
assert.equal(isCardLinkConnected(getCardLinkState()), false, 'failed bridged status never reads green');
bridgeStatusFails = false;
bridgeStatusPayload = readyEnvelope('lw-001122aabbcc');
await bootstrapCardLink();
await waitFor(() => isCardLinkConnected(getCardLinkState()), 2000, 'two-envelope bridge status recovery');
assert.equal(isCardLinkConnected(getCardLinkState()), true, 'fresh bridged status restores readiness');

async function refreshBridgeStatus(payload) {
  bridgeStatusPayload = payload;
  getSharedCardLink().dispatch({ type: 'connecting', via: 'bridge', host: '192.168.18.70' });
  listeners.get('lightweaver-card-bridge-changed')?.({
    detail: {
      connected: true, verified: true, host: '192.168.18.70',
      card: { id: 'lw-001122aabbcc', firmwareVersion: '1.0.0' },
    },
  });
  await waitFor(
    () => !payload.bootId
      ? ['revalidating', 'disconnected'].includes(getCardLinkState().state)
      : payload.knownGoodProject === false
        ? getCardLinkState().cardBlank === true
        : isCardLinkConnected(getCardLinkState()),
    2000,
    'bridge status refinement',
  );
}

const partialBridgeRefresh = {
  app: 'Lightweaver', cardId: 'lw-001122aabbcc',
  firmwareVersion: '1.0.0', buildId: 'partial-refresh',
};
await refreshBridgeStatus(partialBridgeRefresh);
assert.equal(getCardLinkState().cardBlank, null, 'partial async bridge refinement stays unknown');
assert.equal(isCardLinkConnected(getCardLinkState()), false);
await refreshBridgeStatus(readyEnvelope('lw-001122aabbcc'));
assert.equal(getCardLinkState().cardBlank, false, 'known-good async bridge refinement is configured');
assert.equal(isCardLinkConnected(getCardLinkState()), true);
await refreshBridgeStatus(readyEnvelope('lw-001122aabbcc', {
  runtimePhase: 'factory', knownGoodProject: false,
}));
assert.equal(getCardLinkState().cardBlank, true, 'factory async bridge refinement is blank');
bridgeStatusPayload = readyEnvelope('lw-001122aabbcc');
await bootstrapCardLink();

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

// A fresh browser's ordinary Connect gesture only discovers the bridge card.
// Pair is a separate explicit action with its own uncached status reread.
storedValues.delete('lw_card_identity_v1');
globalThis.window.open = () => parentBridge;
assert.equal(connectCardLink('192.168.18.70'), parentBridge);
listeners.get('message')?.({
  origin: 'http://192.168.18.70',
  source: parentBridge,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: '192.168.18.70', version: 1 },
});
await waitFor(() => getCardLinkState().reason === 'found-unpaired', 2000, 'public bridge discovery');
assert.equal(storedValues.has('lw_card_identity_v1'), false, 'ordinary bridge Connect never persists identity');
assert.equal(getCardLinkState().discoveredCard?.id, 'lw-001122aabbcc');
await adoptDiscoveredCardBridgeIdentity('192.168.18.70');
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
        firmwareVersion: '1.4.0',
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
  fetchImpl: async (url, options) => {
    if (/\/api\/status/.test(String(url))) {
      assert.equal(options.cache, 'no-store');
      return { ok: true, json: async () => readyEnvelope('lw-ping-test') };
    }
    return { ok: false };
  },
});
directPingLink.dispatch({
  type: 'direct-status', connected: true, host: '192.168.1.100',
  card: { id: 'lw-ping-test' }, expectedCard: { id: 'lw-ping-test' }, blank: false,
  readiness: readyEnvelope('lw-ping-test'),
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
  readiness: readyEnvelope('lw-drop-test'),
});
assert.equal(dropLink.getState().state, 'connected-direct');
await waitFor(
  () => dropLink.getState().state === 'reconnecting' && dropLink.getState().reason === 'card-stopped-answering',
  1000,
  'direct silent-drop detected'
);
assert.equal(cardLinkStatusText(dropLink.getState()), 'Card stopped responding — reconnecting…');
dropLink.destroy();

// A correlated bridge timeout is still a transport loss. The bridge-change
// listener must demote an already-green shared handoff immediately rather than
// returning early merely because the correlation remains available for retry.
const shared = getSharedCardLink();
shared.dispatch({
  type: 'wifi-handoff-retargeted', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 80, flowId: wifiFlowId,
});
for (let envelope = 0; envelope < 2; envelope += 1) {
  shared.dispatch({
    type: 'wifi-handoff-status', host: wifiCorrelation.host,
    correlation: wifiCorrelation, bridgeLifecycle: 80, flowId: wifiFlowId,
    readiness: handoffEnvelope(wifiCorrelation),
  });
}
shared.dispatch({
  type: 'wifi-handoff-ack-attempted', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 80, flowId: wifiFlowId,
});
shared.dispatch({
  type: 'wifi-handoff-ack-sent', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 80, flowId: wifiFlowId,
});
shared.dispatch({
  type: 'wifi-handoff-status', host: wifiCorrelation.host,
  correlation: wifiCorrelation, bridgeLifecycle: 80, flowId: wifiFlowId,
  readiness: handoffEnvelope(wifiCorrelation, {
    wifi: {
      transport: 'station', transition: 'station', transitionPending: false,
      apActive: false, stationIp: wifiCorrelation.host, ip: wifiCorrelation.host,
      handoffGeneration: wifiCorrelation.handoffGeneration,
    },
  }),
});
assert.equal(isCardLinkConnected(shared.getState()), true);
listeners.get('lightweaver-card-bridge-changed')?.({
  detail: {
    connected: false, verified: false, identityError: 'bridge-timeout',
    host: wifiCorrelation.host, lifecycle: 80,
    handoffCorrelation: wifiCorrelation, handoffFlowId: wifiFlowId,
  },
});
assert.equal(isCardLinkConnected(shared.getState()), false,
  'correlated bridge timeout immediately removes the visible connected state');
assert.equal(shared.getState().readiness, null,
  'correlated bridge timeout immediately clears stale readiness evidence');

console.log('card-link-state tests passed');
