// Card link — one honest connection state machine for the Studio <-> card path.
//
// The Studio has two live transports to the card:
//   - direct HTTP polling (useCardStatus) when the page itself is on http/file
//   - the card-page postMessage bridge (cardBridge.js) when the page is on
//     HTTPS, where the browser blocks direct HTTP/WS to the card entirely
// Historically the footer indicator mixed several signals and never read the
// bridge at all, so on led.mandalacodes.com it simply lied. Everything that
// wants to know "are we actually talking to the card, and if not, why?" now
// reads THIS module instead.
//
// Shape: a pure reducer (reduceCardLink) that Node contract tests can drive
// directly, a small runtime factory (createCardLink) that adds the bridge
// keepalive ping loop and connect timeout, and a shared browser instance
// wired to cardBridge's change events for the app to subscribe to.
import {
  CARD_BRIDGE_CHANGED_EVENT,
  bootstrapCardBridgeFromOpener,
  getCardBridgeState,
  openCardBridge,
  restoreCardBridgeHandoff,
  sendCardBridgeRequest,
  verifyCardBridgeIdentity,
} from './cardBridge.js';
import { cardHostToUrl, normalizeCardHost, readStoredCardHost, rememberCardHost, writeStoredCardHost } from './cardConnection.js';
import {
  compareCardIdentity,
  normalizeCardIdentity,
  persistCardIdentity,
  readPersistedCardIdentity,
  verifyExpectedCardAtHost,
} from './cardIdentity.js';
import { isCardLinkConnected as isFreshCardLinkConnected } from './cardConnectionFlow.js';
import { classifyCardReadiness } from './cardReadiness.js';
import {
  acceptWifiHandoff,
  clearWifiHandoffRecovery,
  inspectFinalStationHandoff,
  markWifiHandoffAckAttempted,
  normalizeWifiHandoffCorrelation,
} from './cardWifiHandoff.js';

export const CARD_LINK_PING_INTERVAL_MS = 5000;
export const CARD_LINK_DIRECT_PING_INTERVAL_MS = 20000;
export const CARD_LINK_PING_TIMEOUT_MS = 2500;
export const CARD_LINK_PING_MISS_LIMIT = 2;
export const CARD_LINK_CONNECT_TIMEOUT_MS = 15000;
// Set once a bridge session succeeds; on the next app load we try one re-ping
// before showing the one-click "Connect to card" affordance.
export const CARD_LINK_BRIDGE_ACTIVE_KEY = 'lw_card_bridge_was_active';

export const CARD_LINK_STATES = ['disconnected', 'connecting', 'reconnecting', 'reconnecting-bridge', 'revalidating', 'connected-bridge', 'connected-direct'];

function browserWindow() {
  return typeof window !== 'undefined' ? window : null;
}

export function initialCardLinkState(host = '') {
  return {
    state: 'disconnected',
    reason: 'never-connected',
    transport: '',
    host: host || '',
    missedPings: 0,
    card: null,
    acknowledgedAt: '',
    activity: 'idle',
    directDiscoveryRevision: 0,
    readiness: null,
    cardBlank: null,
    expectedCard: null,
    validatedBootId: '',
    candidateBootId: '',
    requiresStableRevalidation: false,
    revalidationGeneration: 0,
    operationGeneration: 0,
    handoffCorrelation: null,
    handoffFlowId: '',
    handoffEnvelopeCount: 0,
    handoffAckReady: false,
    handoffAckAttempted: false,
    handoffAckInFlight: false,
    handoffAckSent: false,
    handoffBridgeLifecycle: null,
    handoffStationVerified: false,
    handoffReloadRecovery: false,
  };
}

function clearedLiveEvidence(prev, additions = {}, {
  requireStable = true,
  clearValidatedBoot = false,
} = {}) {
  return {
    ...prev,
    readiness: null,
    cardBlank: null,
    validatedBootId: clearValidatedBoot ? '' : prev.validatedBootId,
    candidateBootId: '',
    requiresStableRevalidation: requireStable,
    revalidationGeneration: requireStable
      ? (prev.revalidationGeneration || 0) + 1
      : (prev.revalidationGeneration || 0),
    acknowledgedAt: '',
    activity: 'idle',
    operationGeneration: (prev.operationGeneration || 0) + 1,
    handoffCorrelation: null,
    handoffFlowId: '',
    handoffEnvelopeCount: 0,
    handoffAckReady: false,
    handoffAckAttempted: false,
    handoffAckInFlight: false,
    handoffAckSent: false,
    handoffBridgeLifecycle: null,
    handoffStationVerified: false,
    handoffReloadRecovery: false,
    ...additions,
  };
}

function sameWifiHandoffCorrelation(left, right) {
  const a = normalizeWifiHandoffCorrelation(left);
  const b = normalizeWifiHandoffCorrelation(right);
  return Boolean(a && b)
    && a.host === b.host
    && a.expectedCardId === b.expectedCardId
    && a.expectedFirmwareVersion === b.expectedFirmwareVersion
    && a.expectedBuildId === b.expectedBuildId
    && a.expectedBootId === b.expectedBootId
    && a.handoffGeneration === b.handoffGeneration;
}

function normalizeHandoffFlowId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(value) ? value : '';
}

function matchingHandoffReadyStatus(status, correlation) {
  const accepted = acceptWifiHandoff({
    status,
    expectedCard: {
      id: correlation.expectedCardId,
      firmwareVersion: correlation.expectedFirmwareVersion,
      buildId: correlation.expectedBuildId,
    },
    expectedBootId: correlation.expectedBootId,
    lastGeneration: correlation.handoffGeneration - 1,
  });
  return sameWifiHandoffCorrelation(accepted, correlation);
}

function readinessReason(classified = {}) {
  if (classified.reason === 'unexpected-card') return 'wrong-card';
  if (classified.reason === 'unexpected-firmware-version') return 'wrong-firmware-version';
  if (classified.reason === 'unexpected-firmware-build') return 'wrong-firmware-build';
  return classified.reason || '';
}

function applyStatusEnvelope(prev, event, transport, host) {
  const expectedCard = event.expectedCard || prev.expectedCard || null;
  const card = event.card || normalizeCardIdentity(event.readiness || {}, host);
  const readiness = event.readiness ?? null;
  const classified = classifyCardReadiness(readiness || {}, { expectedCard });
  const exactFailure = readinessReason(classified);
  if (classified.state === 'identity-mismatch') {
    return clearedLiveEvidence(prev, {
      state: 'disconnected', reason: exactFailure, transport, host, card: null,
      expectedCard, discoveredCard: card?.id ? card : null, missedPings: 0,
    });
  }

  const incomingBootId = classified.bootId || '';
  const completeEnvelope = classified.state !== 'checking' && Boolean(incomingBootId);
  if (!completeEnvelope) {
    return clearedLiveEvidence(prev, {
      state: 'revalidating', reason: 'checking-card', transport, host,
      card, expectedCard, missedPings: 0,
    });
  }

  const bootChanged = Boolean(prev.validatedBootId && incomingBootId !== prev.validatedBootId);
  const needsStablePair = prev.requiresStableRevalidation
    || prev.state === 'reconnecting'
    || prev.state === 'reconnecting-bridge'
    || prev.state === 'revalidating'
    || bootChanged;
  if (needsStablePair) {
    if (!prev.candidateBootId) {
      return {
        ...clearedLiveEvidence(prev, {
          state: 'revalidating', reason: bootChanged ? 'card-restarted' : 'checking-card',
          transport, host, card, expectedCard, candidateBootId: incomingBootId, missedPings: 0,
        }),
        // Starting a candidate inside an existing recovery generation must not
        // mint another generation or invalidate the operation twice.
        revalidationGeneration: prev.requiresStableRevalidation
          ? prev.revalidationGeneration
          : (prev.revalidationGeneration || 0) + 1,
        operationGeneration: prev.requiresStableRevalidation
          ? prev.operationGeneration
          : (prev.operationGeneration || 0) + 1,
      };
    }
    if (incomingBootId !== prev.candidateBootId) {
      // Responses can arrive out of order across a reboot. Neither the prior
      // boot nor an unrelated newer boot is evidence for the candidate already
      // under validation; ignore it without clearing/replacing that candidate.
      return prev;
    }
  }

  const nextState = transport === 'bridge' ? 'connected-bridge' : 'connected-direct';
  const blank = typeof classified.blank === 'boolean' ? classified.blank : null;
  const acknowledgedAt = classified.connected || classified.state === 'blank'
    ? (event.acknowledgedAt || new Date().toISOString())
    : '';
  const next = {
    ...prev,
    state: nextState,
    reason: nextState === 'revalidating' ? 'checking-card' : '',
    transport,
    host,
    missedPings: 0,
    card,
    expectedCard,
    discoveredCard: null,
    readiness,
    cardBlank: blank,
    validatedBootId: completeEnvelope ? incomingBootId : prev.validatedBootId,
    candidateBootId: '',
    requiresStableRevalidation: false,
    acknowledgedAt,
    bridgeLifecycle: transport === 'bridge' ? (event.bridgeLifecycle ?? prev.bridgeLifecycle ?? null) : null,
  };
  if (
    prev.state === next.state
    && prev.reason === next.reason
    && prev.host === next.host
    && prev.card?.id === next.card?.id
    && prev.readiness === next.readiness
    && prev.cardBlank === next.cardBlank
    && prev.missedPings === 0
  ) return prev;
  return next;
}

// Pure reducer. Returns the previous state object unchanged (same reference)
// when an event does not alter anything, so subscribers can bail out cheaply.
export function reduceCardLink(prev = initialCardLinkState(), event = {}, {
  missLimit = CARD_LINK_PING_MISS_LIMIT,
} = {}) {
  const host = event.host || prev.host;
  switch (event.type) {
    case 'connecting': {
      const via = event.via === 'direct' ? 'direct' : 'bridge';
      // A direct probe starting up never demotes an established link (either
      // transport) and never displaces an in-flight bridge connect — if it
      // did, the runtime dispatch's else branch would cancel the bridge's
      // no-answer timer and the state could sit in 'connecting' forever.
      if (via === 'direct' && (
        prev.state === 'connected-bridge' ||
        prev.state === 'reconnecting-bridge' ||
        prev.state === 'connected-direct' ||
        (prev.state === 'connecting' && prev.transport === 'bridge')
      )) return prev;
      if (prev.state === 'connecting' && prev.transport === via && prev.host === host) return prev;
      return {
        ...(host !== prev.host
          ? clearedLiveEvidence(prev, {}, {
            clearValidatedBoot: true,
            requireStable: Boolean(prev.validatedBootId || prev.requiresStableRevalidation),
          })
          : prev),
        state: 'connecting', reason: '', transport: via, host, missedPings: 0,
        ...(host !== prev.host ? {
          card: null,
          readiness: null,
          cardBlank: null,
          bridgeLifecycle: null,
          acknowledgedAt: '',
        } : {}),
      };
    }
    case 'bridge-ready': {
      const sameLifecycle = event.bridgeLifecycle === prev.bridgeLifecycle;
      if (
        sameLifecycle
        && (prev.state === 'connected-bridge' || prev.state === 'reconnecting-bridge')
        && prev.card?.id
        && prev.host === host
      ) return prev;
      if (prev.state === 'connecting' && prev.transport === 'bridge' && prev.host === host) return prev;
      return clearedLiveEvidence(prev, {
        state: 'connecting', reason: '', transport: 'bridge', host, missedPings: 0,
        card: null,
        bridgeLifecycle: event.bridgeLifecycle ?? null,
        ...(prev.handoffCorrelation ? {
          handoffCorrelation: prev.handoffCorrelation,
          handoffFlowId: prev.handoffFlowId,
          handoffEnvelopeCount: prev.handoffReloadRecovery
            ? prev.handoffEnvelopeCount
            : prev.handoffAckAttempted ? 2 : 0,
          handoffAckReady: false,
          handoffAckAttempted: prev.handoffAckAttempted,
          handoffAckInFlight: false,
          handoffAckSent: prev.handoffAckSent,
          handoffStationVerified: false,
          handoffReloadRecovery: prev.handoffReloadRecovery,
          handoffBridgeLifecycle: event.bridgeLifecycle ?? null,
        } : {}),
      }, { requireStable: Boolean(prev.validatedBootId || prev.requiresStableRevalidation) });
    }
    case 'wifi-handoff-retargeted': {
      const correlation = normalizeWifiHandoffCorrelation(event.correlation);
      const flowId = normalizeHandoffFlowId(event.flowId);
      if (!correlation || correlation.host !== host || !flowId) return prev;
      const sameAuthority = sameWifiHandoffCorrelation(correlation, prev.handoffCorrelation)
        && flowId === prev.handoffFlowId;
      return clearedLiveEvidence(prev, {
        state: 'revalidating', reason: 'wifi-network-switch', transport: 'bridge',
        host, card: null, expectedCard: {
          id: correlation.expectedCardId,
          firmwareVersion: correlation.expectedFirmwareVersion,
          buildId: correlation.expectedBuildId,
        },
        missedPings: 0,
        bridgeLifecycle: event.bridgeLifecycle ?? null,
        handoffCorrelation: correlation,
        handoffFlowId: flowId,
        handoffBridgeLifecycle: event.bridgeLifecycle ?? null,
        ...(sameAuthority ? {
          handoffEnvelopeCount: prev.handoffAckAttempted ? 2 : 0,
          handoffAckReady: false,
          handoffAckAttempted: prev.handoffAckAttempted,
          handoffAckInFlight: false,
          handoffAckSent: prev.handoffAckSent,
          handoffStationVerified: false,
        } : {}),
      }, { clearValidatedBoot: true });
    }
    case 'wifi-handoff-restored': {
      const correlation = normalizeWifiHandoffCorrelation(event.correlation);
      const flowId = normalizeHandoffFlowId(event.flowId);
      if (!correlation || correlation.host !== host || !flowId || typeof event.ackAttempted !== 'boolean') return prev;
      return clearedLiveEvidence(prev, {
        state: 'revalidating', reason: 'checking-card', transport: 'bridge',
        host, card: null, expectedCard: {
          id: correlation.expectedCardId,
          firmwareVersion: correlation.expectedFirmwareVersion,
          buildId: correlation.expectedBuildId,
        },
        missedPings: 0, bridgeLifecycle: event.bridgeLifecycle ?? null,
        handoffCorrelation: correlation, handoffFlowId: flowId,
        handoffBridgeLifecycle: event.bridgeLifecycle ?? null,
        handoffEnvelopeCount: 0, handoffAckReady: false,
        handoffAckAttempted: event.ackAttempted, handoffAckInFlight: false,
        handoffAckSent: false, handoffStationVerified: false,
        handoffReloadRecovery: event.ackAttempted,
      }, { clearValidatedBoot: true });
    }
    case 'wifi-handoff-status': {
      const correlation = normalizeWifiHandoffCorrelation(event.correlation);
      const flowId = normalizeHandoffFlowId(event.flowId);
      if (!correlation || !flowId || flowId !== prev.handoffFlowId
        || !sameWifiHandoffCorrelation(correlation, prev.handoffCorrelation)
        || host !== correlation.host) return prev;
      const lifecycle = event.bridgeLifecycle ?? null;
      if (prev.handoffBridgeLifecycle !== lifecycle) {
        if (prev.handoffEnvelopeCount > 0 || prev.handoffAckAttempted || prev.handoffAckSent) {
          return clearedLiveEvidence(prev, {
            state: 'revalidating', reason: 'checking-card', transport: 'bridge', host,
            expectedCard: prev.expectedCard, bridgeLifecycle: lifecycle,
            handoffCorrelation: correlation, handoffFlowId: flowId,
            handoffBridgeLifecycle: lifecycle,
            handoffEnvelopeCount: prev.handoffAckAttempted ? 2 : 0,
            handoffAckAttempted: prev.handoffAckAttempted,
            handoffAckInFlight: false,
            handoffAckSent: prev.handoffAckSent,
            handoffStationVerified: false,
          }, { clearValidatedBoot: true });
        }
      }
      const status = event.readiness;
      const finalAuthority = inspectFinalStationHandoff({ status, correlation });
      if ((prev.handoffAckAttempted || prev.handoffStationVerified) && finalAuthority) {
        const reloadEnvelopeCount = prev.handoffReloadRecovery
          ? Math.min(2, (prev.handoffEnvelopeCount || 0) + 1)
          : prev.handoffEnvelopeCount;
        if (prev.handoffReloadRecovery && reloadEnvelopeCount < 2) {
          return {
            ...prev,
            state: 'revalidating', reason: 'checking-card', transport: 'bridge', host,
            readiness: null, cardBlank: null, acknowledgedAt: '', activity: 'idle',
            bridgeLifecycle: lifecycle, handoffBridgeLifecycle: lifecycle,
            handoffEnvelopeCount: reloadEnvelopeCount,
            handoffAckReady: false, handoffAckInFlight: false,
            handoffStationVerified: false,
          };
        }
        const expectedCard = {
          id: correlation.expectedCardId,
          firmwareVersion: correlation.expectedFirmwareVersion,
          buildId: correlation.expectedBuildId,
        };
        const classified = classifyCardReadiness(status, { expectedCard });
        return {
          ...prev,
          state: 'connected-bridge', reason: '', transport: 'bridge', host,
          missedPings: 0,
          card: normalizeCardIdentity(status, host), expectedCard,
          discoveredCard: null, readiness: status,
          cardBlank: typeof classified.blank === 'boolean' ? classified.blank : null,
          validatedBootId: classified.bootId, candidateBootId: '',
          requiresStableRevalidation: false,
          acknowledgedAt: event.acknowledgedAt || new Date().toISOString(),
          activity: 'idle', bridgeLifecycle: lifecycle,
          handoffEnvelopeCount: reloadEnvelopeCount,
          handoffAckReady: false, handoffAckAttempted: prev.handoffAckAttempted,
          handoffAckInFlight: false, handoffAckSent: true,
          handoffStationVerified: true,
          handoffReloadRecovery: false,
          handoffBridgeLifecycle: lifecycle,
        };
      }
      if (!matchingHandoffReadyStatus(status, correlation)) {
        return {
          ...prev, state: 'revalidating', reason: 'checking-card', readiness: null,
          cardBlank: null, acknowledgedAt: '', activity: 'idle',
          handoffEnvelopeCount: 0, handoffAckReady: false,
          handoffBridgeLifecycle: lifecycle, bridgeLifecycle: lifecycle,
        };
      }
      const handoffEnvelopeCount = Math.min(2, (prev.handoffEnvelopeCount || 0) + 1);
      return {
        ...prev, state: 'revalidating',
        reason: prev.handoffAckAttempted ? 'checking-card' : 'wifi-network-switch',
        transport: 'bridge', host, readiness: null, cardBlank: null,
        acknowledgedAt: '', activity: 'idle', bridgeLifecycle: lifecycle,
        handoffBridgeLifecycle: lifecycle, handoffEnvelopeCount,
        handoffAckReady: handoffEnvelopeCount >= 2
          && !prev.handoffAckAttempted
          && !prev.handoffAckSent,
      };
    }
    case 'wifi-handoff-ack-attempted': {
      if (!prev.handoffAckReady
        || prev.handoffAckAttempted
        || normalizeHandoffFlowId(event.flowId) !== prev.handoffFlowId
        || !sameWifiHandoffCorrelation(event.correlation, prev.handoffCorrelation)
        || host !== prev.host
        || (event.bridgeLifecycle ?? null) !== prev.handoffBridgeLifecycle) return prev;
      return {
        ...prev, state: 'revalidating', reason: 'checking-card',
        readiness: null, cardBlank: null, acknowledgedAt: '', activity: 'idle',
        handoffAckReady: false, handoffAckAttempted: true, handoffAckInFlight: true,
      };
    }
    case 'wifi-handoff-ack-sent': {
      if (!prev.handoffAckAttempted
        || !prev.handoffAckInFlight
        || normalizeHandoffFlowId(event.flowId) !== prev.handoffFlowId
        || !sameWifiHandoffCorrelation(event.correlation, prev.handoffCorrelation)
        || host !== prev.host
        || (event.bridgeLifecycle ?? null) !== prev.handoffBridgeLifecycle) return prev;
      return {
        ...prev, state: 'revalidating', reason: 'checking-card',
        readiness: null, cardBlank: null, acknowledgedAt: '', activity: 'idle',
        handoffAckReady: false, handoffAckInFlight: false, handoffAckSent: true,
      };
    }
    case 'wifi-handoff-ack-uncertain': {
      if (!prev.handoffAckAttempted
        || !prev.handoffAckInFlight
        || normalizeHandoffFlowId(event.flowId) !== prev.handoffFlowId
        || !sameWifiHandoffCorrelation(event.correlation, prev.handoffCorrelation)
        || host !== prev.host
        || (event.bridgeLifecycle ?? null) !== prev.handoffBridgeLifecycle) return prev;
      return {
        ...prev, state: 'revalidating', reason: 'checking-card',
        readiness: null, cardBlank: null, acknowledgedAt: '', activity: 'idle',
        handoffAckReady: false, handoffAckInFlight: false, handoffAckSent: false,
      };
    }
    case 'card-verified': {
      if (!event.card?.id) return clearedLiveEvidence(prev, { state: 'disconnected', reason: 'identity-missing', transport: '', missedPings: 0, card: null });
      if (prev.host && event.host && prev.host !== event.host) return prev;
      if (event.expectedCard?.id) {
        const comparison = compareCardIdentity(event.expectedCard, event.card);
        if (!comparison.ok) return clearedLiveEvidence(prev, { state: 'disconnected', reason: comparison.reason, transport: '', missedPings: 0, card: null });
      }
      const transport = event.via === 'direct' ? 'direct' : 'bridge';
      const repeatedBridgeVerification = transport === 'bridge'
        && event.bridgeLifecycle === prev.bridgeLifecycle
        && (prev.state === 'connected-bridge' || prev.state === 'reconnecting-bridge')
        && prev.host === host
        && prev.card?.id === event.card.id;
      const readiness = Object.hasOwn(event, 'readiness')
        ? (event.readiness ?? null)
        : (repeatedBridgeVerification ? (prev.readiness ?? null) : null);
      const cardBlank = Object.hasOwn(event, 'blank')
        ? (typeof event.blank === 'boolean' ? event.blank : null)
        : (repeatedBridgeVerification && typeof prev.cardBlank === 'boolean' ? prev.cardBlank : null);
      if (Object.hasOwn(event, 'readiness')) {
        return applyStatusEnvelope(prev, { ...event, readiness, blank: cardBlank }, transport, host);
      }
      return {
        ...prev,
        state: transport === 'direct' ? 'connected-direct' : 'connected-bridge',
        reason: '', transport, host, missedPings: 0,
        card: event.card,
        readiness,
        cardBlank,
        bridgeLifecycle: transport === 'bridge'
          ? (event.bridgeLifecycle ?? (repeatedBridgeVerification ? prev.bridgeLifecycle : null))
          : null,
        acknowledgedAt: event.acknowledgedAt || new Date().toISOString(),
      };
    }
    case 'bridge-blank': {
      // Late blank-state refinement for the bridge path: the card answered
      // /api/status after the green transition. Only touch an established bridge
      // link for the same card/host, and return the same reference when nothing
      // changes so subscribers do not re-render.
      if (prev.state !== 'connected-bridge' && prev.state !== 'reconnecting-bridge') return prev;
      if (prev.host !== host || prev.card?.id !== event.cardId) return prev;
      const readiness = event.readiness ?? null;
      if (!readiness) return prev;
      return applyStatusEnvelope(prev, {
        ...event, readiness, card: normalizeCardIdentity(readiness, host),
        expectedCard: prev.expectedCard || prev.card,
      }, 'bridge', host);
    }
    case 'bridge-ping-ok': {
      if (!prev.card?.id) return prev;
      if (event.readiness) return applyStatusEnvelope(prev, event, 'bridge', host);
      if (prev.state !== 'connected-bridge') return prev;
      if (prev.state === 'connected-bridge' && prev.host === host && prev.missedPings === 0) return prev;
      return prev;
    }
    case 'bridge-ping-missed': {
      // A missed keepalive only matters for an established bridge link.
      if (prev.state !== 'connected-bridge' && prev.state !== 'reconnecting-bridge' && !(prev.state === 'revalidating' && prev.transport === 'bridge')) return prev;
      const missedPings = prev.missedPings + 1;
      return clearedLiveEvidence(prev, {
        state: 'reconnecting-bridge', reason: 'card-stopped-answering',
        transport: 'bridge', host, missedPings,
        ...(prev.handoffCorrelation ? {
          handoffCorrelation: prev.handoffCorrelation,
          handoffFlowId: prev.handoffFlowId,
          handoffEnvelopeCount: prev.handoffEnvelopeCount,
          handoffAckReady: false,
          handoffAckAttempted: prev.handoffAckAttempted,
          handoffAckInFlight: false,
          handoffAckSent: prev.handoffAckSent,
          handoffBridgeLifecycle: prev.handoffBridgeLifecycle,
          handoffStationVerified: false,
        } : {}),
      });
    }
    case 'direct-ping-ok': {
      // A successful keepalive on direct connection.
      if (event.readiness) return applyStatusEnvelope(prev, event, 'direct', host);
      if (prev.state !== 'connected-direct') return prev;
      if (prev.host !== host || prev.missedPings === 0) return prev;
      return prev;
    }
    case 'direct-ping-missed': {
      // A missed keepalive on direct connection demotes to reconnecting.
      if (prev.state !== 'connected-direct' && prev.state !== 'reconnecting' && !(prev.state === 'revalidating' && prev.transport === 'direct')) return prev;
      const missedPings = prev.missedPings + 1;
      return clearedLiveEvidence(prev, {
        state: 'reconnecting', reason: 'card-stopped-answering',
        transport: 'direct', host, missedPings,
      });
    }
    case 'operation-boundary-lost': {
      if (prev.state !== 'connected-bridge' && prev.state !== 'connected-direct') return prev;
      return clearedLiveEvidence(prev, {
        state: 'revalidating',
        reason: event.reason || 'card-stopped-answering',
        transport: prev.transport,
        host: prev.host,
        missedPings: 0,
      });
    }
    case 'bridge-lost': {
      // The card page window closed or never answered. Direct links are a
      // separate transport and are unaffected.
      if (prev.state === 'connected-direct') return prev;
      const reason = event.reason || 'card-page-closed';
      if (prev.state === 'disconnected' && prev.reason === reason && prev.host === host) return prev;
      return clearedLiveEvidence(prev, {
        state: 'disconnected', reason, transport: '', host, missedPings: 0, card: null,
        ...(prev.handoffCorrelation ? {
          handoffCorrelation: prev.handoffCorrelation,
          handoffFlowId: prev.handoffFlowId,
          handoffEnvelopeCount: prev.handoffAckAttempted ? 2 : 0,
          handoffAckReady: false,
          handoffAckAttempted: prev.handoffAckAttempted,
          handoffAckInFlight: false,
          handoffAckSent: prev.handoffAckSent,
          handoffBridgeLifecycle: prev.handoffBridgeLifecycle,
          handoffStationVerified: false,
        } : {}),
      });
    }
    case 'wifi-handoff-cancelled': {
      const flowId = normalizeHandoffFlowId(event.flowId);
      if (!flowId || flowId !== prev.handoffFlowId) return prev;
      return clearedLiveEvidence(prev, {
        state: 'disconnected', reason: 'never-connected', transport: '', card: null,
      });
    }
    case 'direct-status': {
      if (event.connected) {
        // The bridge keepalive is authoritative while a bridge is up.
        if (prev.state === 'connected-bridge' || prev.state === 'reconnecting-bridge') return prev;
        if (!event.card?.id) {
          return clearedLiveEvidence(prev, { state: 'disconnected', reason: 'identity-missing', transport: 'direct', host, missedPings: 0, card: null });
        }
        if (event.expectedCard?.id) {
          const comparison = compareCardIdentity(event.expectedCard, event.card);
          if (!comparison.ok) return clearedLiveEvidence(prev, {
            state: 'disconnected', reason: comparison.reason, transport: 'direct', host, missedPings: 0,
            discoveredCard: event.card,
            expectedCard: event.expectedCard,
            card: null,
            directDiscoveryRevision: (prev.directDiscoveryRevision || 0) + 1,
          });
        } else if (!event.allowAdopt) {
          // A card answered but this origin has no persisted pairing. NOT green —
          // the footer offers a one-tap pair instead of quietly adopting the
          // first card it sees (a wrong-card hazard on a shared network).
          return {
            ...prev,
            state: 'disconnected', reason: 'found-unpaired', transport: 'direct', host, missedPings: 0,
            discoveredCard: event.card,
            card: null,
            directDiscoveryRevision: (prev.directDiscoveryRevision || 0) + 1,
          };
        }
        return applyStatusEnvelope(prev, {
          ...event,
          expectedCard: event.expectedCard || event.card,
        }, 'direct', host);
      }
      // A failed direct probe never tears down a live (or connecting) bridge.
      if (prev.state === 'connected-bridge' || prev.state === 'reconnecting-bridge') return prev;
      if (prev.state === 'connecting' && prev.transport === 'bridge') return prev;
      const reason = event.reason || 'card-unreachable';
      if (prev.state === 'disconnected' && prev.reason === reason && prev.host === host) return prev;
      return clearedLiveEvidence(prev, {
        state: 'disconnected', reason, transport: event.transport || 'direct', host, missedPings: 0, card: null,
        ...(event.discoveredCard ? { discoveredCard: event.discoveredCard } : {}),
      });
    }
    case 'bridge-discovered': {
      if (!event.card?.id) return prev;
      return clearedLiveEvidence(prev, {
        state: 'disconnected', reason: 'found-unpaired', transport: 'bridge', host,
        missedPings: 0, card: null, discoveredCard: event.card,
        bridgeLifecycle: event.bridgeLifecycle ?? prev.bridgeLifecycle ?? null,
      }, { requireStable: Boolean(prev.validatedBootId || prev.requiresStableRevalidation) });
    }
    case 'operation-started':
      return prev.activity === 'pending' ? prev : { ...prev, activity: 'pending' };
    case 'operation-recovering':
      return prev.activity === 'recovering' ? prev : { ...prev, activity: 'recovering' };
    case 'operation-failed':
      return prev.activity === 'failed' ? prev : { ...prev, activity: 'failed' };
    case 'operation-confirmed': {
      const acknowledgedAt = event.acknowledgedAt || new Date().toISOString();
      return { ...prev, activity: 'idle', acknowledgedAt };
    }
    default:
      return prev;
  }
}

export function isCardLinkConnected(state = {}) {
  return isFreshCardLinkConnected(state);
}

// Plain, friendly copy for the footer — the audience is a visual artist.
export function cardLinkReasonText(reason = '') {
  switch (reason) {
    case 'card-page-closed': return 'The card page was closed.';
    case 'card-stopped-answering': return 'The card stopped answering.';
    case 'bridge-missing': return 'The card page is not open.';
    case 'popup-blocked': return 'The browser blocked the card page window — allow popups and try again.';
    case 'no-answer': return 'Could not reach the card.';
    case 'card-unreachable': return 'No card found on this network.';
    case 'found-unpaired': return 'Lightweaver found — tap Connect to pair.';
    case 'identity-missing': return 'This card needs a firmware update before Studio can verify it.';
    case 'wrong-card': return 'This is a different Lightweaver card.';
    case 'wrong-firmware-version': return 'This card has a different firmware version.';
    case 'wrong-firmware-build': return 'This card has a different firmware build.';
    case 'firmware-too-old': return 'This card firmware needs an update.';
    case 'never-connected':
    default:
      return 'Not connected to a card.';
  }
}

export function cardLinkStatusText(state = {}) {
  switch (state.state) {
    case 'connected-bridge':
      if (state.cardBlank === true) return 'Blank — load a project';
      return isCardLinkConnected(state) ? 'Live via card page' : 'Checking card';
    case 'connected-direct':
      if (state.cardBlank === true) return 'Blank — load a project';
      return isCardLinkConnected(state) ? 'Live direct' : 'Checking card';
    case 'reconnecting': return 'Card stopped responding — reconnecting…';
    case 'reconnecting-bridge': return 'Card stopped responding — reconnecting…';
    case 'revalidating': return state.reason === 'card-restarted' ? 'Card restarted — verifying' : 'Checking card';
    case 'connecting': return 'Looking for the card…';
    default: return cardLinkReasonText(state.reason);
  }
}

export function readBridgeWasActive() {
  try {
    return browserWindow()?.localStorage?.getItem(CARD_LINK_BRIDGE_ACTIVE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeBridgeWasActive(active) {
  try {
    if (active) browserWindow()?.localStorage?.setItem(CARD_LINK_BRIDGE_ACTIVE_KEY, '1');
    else browserWindow()?.localStorage?.removeItem(CARD_LINK_BRIDGE_ACTIVE_KEY);
  } catch {
    /* noop */
  }
}

// Runtime around the reducer: keepalive ping loop once a bridge is up, a
// connect timeout while a bridge is being established, and a subscription API.
// Everything time- or transport-shaped is injectable so Node tests can drive it.
export function createCardLink({
  sendRequest = (type, payload = {}, options = {}) => sendCardBridgeRequest(type, payload, options),
  fetchImpl = typeof globalThis !== 'undefined' ? globalThis.fetch : null,
  pingIntervalMs = CARD_LINK_PING_INTERVAL_MS,
  directPingIntervalMs = CARD_LINK_DIRECT_PING_INTERVAL_MS,
  pingTimeoutMs = CARD_LINK_PING_TIMEOUT_MS,
  connectTimeoutMs = CARD_LINK_CONNECT_TIMEOUT_MS,
  missLimit = CARD_LINK_PING_MISS_LIMIT,
  host = '',
} = {}) {
  let state = initialCardLinkState(host);
  const listeners = new Set();
  let pingTimer = null;
  let directPingTimer = null;
  let connectTimer = null;
  let pinging = false;
  let directPinging = false;
  let destroyed = false;

  function emit() {
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        /* one bad listener never breaks the link */
      }
    }
  }

  function stopKeepalive() {
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = null;
  }

  function stopDirectKeepalive() {
    if (directPingTimer) clearTimeout(directPingTimer);
    directPingTimer = null;
  }

  function clearConnectTimer() {
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
  }

  function schedulePing(delayMs = pingIntervalMs) {
    stopKeepalive();
    if (destroyed) return;
    pingTimer = setTimeout(() => {
      pingTimer = null;
      void runPing();
    }, delayMs);
  }

  function scheduleDirectPing(delayMs = directPingIntervalMs) {
    stopDirectKeepalive();
    if (destroyed) return;
    directPingTimer = setTimeout(() => {
      directPingTimer = null;
      void runDirectPing();
    }, delayMs);
  }

  async function runPing() {
    if (destroyed || pinging || state.handoffCorrelation || (
      state.state !== 'connected-bridge'
      && state.state !== 'reconnecting-bridge'
      && !(state.state === 'revalidating' && state.transport === 'bridge')
    )) return;
    const pingHost = state.host;
    pinging = true;
    try {
      const readiness = await sendRequest('status', { cache: 'no-store', nonce: Date.now() }, {
        host: pingHost,
        timeoutMs: pingTimeoutMs,
        retryOnTimeout: false,
      });
      if (state.host === pingHost && (
        state.state === 'connected-bridge'
        || state.state === 'reconnecting-bridge'
        || (state.state === 'revalidating' && state.transport === 'bridge')
      )) {
        dispatch({
          type: 'bridge-ping-ok', host: pingHost, readiness,
          card: normalizeCardIdentity(readiness || {}, pingHost),
          expectedCard: state.expectedCard || state.card,
          bridgeLifecycle: state.bridgeLifecycle,
        });
      }
    } catch (error) {
      if (state.host !== pingHost || (
        state.state !== 'connected-bridge'
        && state.state !== 'reconnecting-bridge'
        && !(state.state === 'revalidating' && state.transport === 'bridge')
      )) return;
      if (error?.reason === 'bridge-missing' || error?.reason === 'bridge-post-failed') {
        dispatch({ type: 'bridge-lost', reason: 'card-page-closed', host: pingHost });
      } else {
        dispatch({ type: 'bridge-ping-missed', reason: 'card-stopped-answering', host: pingHost });
      }
    } finally {
      pinging = false;
    }
    if (!state.handoffCorrelation && (
      state.state === 'connected-bridge'
      || state.state === 'reconnecting-bridge'
      || (state.state === 'revalidating' && state.transport === 'bridge')
    )) schedulePing(state.state === 'revalidating' ? 500 : pingIntervalMs);
  }

  async function runDirectPing() {
    if (destroyed || directPinging || (
      state.state !== 'connected-direct'
      && state.state !== 'reconnecting'
      && !(state.state === 'revalidating' && state.transport === 'direct')
    )) return;
    const pingHost = state.host;
    directPinging = true;
    try {
      const fetcher = fetchImpl || (typeof globalThis !== 'undefined' ? globalThis.fetch : null);
      if (typeof fetcher !== 'function') throw new Error('fetch unavailable');
      const response = await Promise.race([
        fetcher(`${cardHostToUrl(pingHost)}/api/status`, { cache: 'no-store' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), pingTimeoutMs)),
      ]);
      if (!response?.ok) throw new Error('not ok');
      const readiness = await response.json().catch(() => null);
      if (!readiness) throw new Error('invalid status');
      if (state.host === pingHost && (
        state.state === 'connected-direct'
        || state.state === 'reconnecting'
        || (state.state === 'revalidating' && state.transport === 'direct')
      )) {
        dispatch({
          type: 'direct-ping-ok', host: pingHost, readiness,
          card: normalizeCardIdentity(readiness, pingHost),
          expectedCard: state.expectedCard || state.card,
        });
      }
    } catch (error) {
      if (state.host !== pingHost || (
        state.state !== 'connected-direct'
        && state.state !== 'reconnecting'
        && !(state.state === 'revalidating' && state.transport === 'direct')
      )) return;
      dispatch({ type: 'direct-ping-missed', host: pingHost });
    } finally {
      directPinging = false;
    }
    if (state.state === 'connected-direct' || state.state === 'reconnecting' || (state.state === 'revalidating' && state.transport === 'direct')) scheduleDirectPing(state.state === 'revalidating' ? 0 : directPingIntervalMs);
  }

  function dispatch(event) {
    const next = reduceCardLink(state, event, { missLimit });
    if (next === state) return state;
    const prev = state;
    state = next;
    if (state.state === 'connected-bridge') {
      clearConnectTimer();
      if (prev.state !== 'connected-bridge') writeBridgeWasActive(true);
      if (!pinging && (prev.state === 'revalidating' || !pingTimer)) schedulePing();
      stopDirectKeepalive();
    } else if (state.state === 'reconnecting-bridge') {
      if (prev.state !== 'reconnecting-bridge') {
        clearConnectTimer();
        if (connectTimeoutMs > 0) {
          connectTimer = setTimeout(() => {
            connectTimer = null;
            dispatch({ type: 'bridge-lost', reason: 'no-answer' });
          }, connectTimeoutMs);
        }
      }
      if (!pingTimer && !pinging) schedulePing();
      stopDirectKeepalive();
    } else if (state.state === 'revalidating') {
      clearConnectTimer();
      if (state.transport === 'bridge') {
        stopDirectKeepalive();
        if (state.handoffCorrelation) stopKeepalive();
        else if (!pinging && (prev.state !== 'revalidating' || !pingTimer)) schedulePing(500);
      } else {
        stopKeepalive();
        if (!directPinging && (prev.state !== 'revalidating' || !directPingTimer)) scheduleDirectPing(0);
      }
    } else if (state.state === 'connected-direct') {
      clearConnectTimer();
      stopKeepalive();
      if (!directPinging && (prev.state === 'revalidating' || !directPingTimer)) scheduleDirectPing();
    } else if (state.state === 'reconnecting' && state.transport === 'direct') {
      clearConnectTimer();
      stopKeepalive();
      if (connectTimeoutMs > 0) {
        connectTimer = setTimeout(() => {
          connectTimer = null;
          dispatch({ type: 'direct-status', connected: false, host: state.host, reason: 'no-answer' });
        }, connectTimeoutMs);
      }
      if (!directPingTimer && !directPinging) scheduleDirectPing();
    } else if (state.state === 'connecting' && state.transport === 'bridge') {
      stopKeepalive();
      stopDirectKeepalive();
      clearConnectTimer();
      if (connectTimeoutMs > 0) {
        connectTimer = setTimeout(() => {
          connectTimer = null;
          dispatch({ type: 'bridge-lost', reason: 'no-answer' });
        }, connectTimeoutMs);
      }
    } else {
      stopKeepalive();
      stopDirectKeepalive();
      clearConnectTimer();
    }
    emit();
    return state;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    destroy() {
      destroyed = true;
      stopKeepalive();
      stopDirectKeepalive();
      clearConnectTimer();
      listeners.clear();
    },
  };
}

// ── shared browser instance ────────────────────────────────────────────────
let sharedLink = null;
const sharedHandoffAdvances = new Map();
const sharedHandoffRetryTimers = new Map();

function handoffWorkKey(correlation, lifecycle, flowId) {
  return [
    flowId,
    correlation.host,
    correlation.expectedCardId,
    correlation.expectedBootId,
    correlation.handoffGeneration,
    lifecycle,
  ].join('|');
}

function currentBridgeStillOwnsHandoff(correlation, lifecycle, flowId) {
  const bridge = getCardBridgeState();
  return bridge.open
    && bridge.verified
    && bridge.lifecycle === lifecycle
    && bridge.handoffFlowId === flowId
    && sameWifiHandoffCorrelation(bridge.handoffCorrelation, correlation);
}

function clearSharedHandoffRetry(key) {
  const timer = sharedHandoffRetryTimers.get(key);
  if (timer != null) clearTimeout(timer);
  sharedHandoffRetryTimers.delete(key);
}

function scheduleSharedHandoffRetry(correlation, lifecycle, flowId) {
  const key = handoffWorkKey(correlation, lifecycle, flowId);
  clearSharedHandoffRetry(key);
  const timer = setTimeout(() => {
    sharedHandoffRetryTimers.delete(key);
    if (currentBridgeStillOwnsHandoff(correlation, lifecycle, flowId)) {
      void advanceSharedWifiHandoff(correlation, lifecycle, flowId);
    }
  }, 1000);
  sharedHandoffRetryTimers.set(key, timer);
}

export async function resumeCardWifiHandoff({
  link,
  correlation: rawCorrelation,
  flowId: rawFlowId,
  bridgeLifecycle,
  sendRequest,
  isCurrent = () => true,
  wait = delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
  pollIntervalMs = 500,
} = {}) {
  const correlation = normalizeWifiHandoffCorrelation(rawCorrelation);
  const flowId = normalizeHandoffFlowId(rawFlowId);
  if (!link?.getState || !link?.dispatch || !correlation || !flowId
    || typeof sendRequest !== 'function' || typeof wait !== 'function') {
    throw new Error('A correlated card link and bridge request transport are required.');
  }
  const entryState = link.getState();
  const refreshConfiguredBlank = isCardLinkConnected(entryState)
    && sameWifiHandoffCorrelation(entryState.handoffCorrelation, correlation)
    && entryState.handoffFlowId === flowId
    && entryState.cardBlank === true;
  if (isCardLinkConnected(entryState)
    && sameWifiHandoffCorrelation(entryState.handoffCorrelation, correlation)
    && entryState.handoffFlowId === flowId
    && !refreshConfiguredBlank) return entryState;
  const host = correlation.host;
  const assertCurrent = () => {
    if (!isCurrent()) {
      const error = new Error('The card bridge changed during WiFi handoff.');
      error.reason = 'stale-host';
      throw error;
    }
  };
  let readCount = 0;
  const readStatus = async () => {
    if (readCount > 0) await wait(Math.max(250, pollIntervalMs));
    readCount += 1;
    assertCurrent();
    const readiness = await sendRequest('status', { cache: 'no-store', nonce: Date.now() }, {
      host, timeoutMs: CARD_LINK_PING_TIMEOUT_MS, retryOnTimeout: false,
    });
    assertCurrent();
    link.dispatch({
      type: 'wifi-handoff-status', host, correlation,
      flowId, bridgeLifecycle, readiness,
    });
    return readiness;
  };

  while ((link.getState().handoffEnvelopeCount || 0) < 2) {
    await readStatus();
    const current = link.getState();
    if (!sameWifiHandoffCorrelation(current.handoffCorrelation, correlation)
      || current.handoffFlowId !== flowId
      || current.handoffBridgeLifecycle !== bridgeLifecycle) return current;
    if (!current.handoffAckReady && (current.handoffEnvelopeCount || 0) === 0) return current;
  }

  const beforeAck = link.getState();
  // A verified factory card remains under the same commissioning correlation
  // after its one allowed config write. Do not mistake that stale blank
  // envelope for final runtime authority: read one fresh status below so the
  // exact lifecycle can prove the newly configured command-ready state.
  if (beforeAck.handoffStationVerified && !refreshConfiguredBlank) return beforeAck;
  if (!beforeAck.handoffAckAttempted) {
    if (!beforeAck.handoffAckReady) return beforeAck;
    // Latch before the privileged write. A timeout is ambiguous: the card may
    // have applied the acknowledgement even though its response was lost, so
    // automatic recovery may only poll final status, never send it again.
    link.dispatch({
      type: 'wifi-handoff-ack-attempted', host, correlation,
      flowId, bridgeLifecycle,
    });
    const attempted = link.getState();
    if (!attempted.handoffAckInFlight) return attempted;
    markWifiHandoffAckAttempted({ flowId, correlation });
    try {
      await sendRequest('wifi-handoff-ack', {}, {
        host, timeoutMs: CARD_LINK_PING_TIMEOUT_MS, retryOnTimeout: false,
      });
      assertCurrent();
      link.dispatch({
        type: 'wifi-handoff-ack-sent', host, correlation,
        flowId, bridgeLifecycle,
      });
    } catch {
      assertCurrent();
      link.dispatch({
        type: 'wifi-handoff-ack-uncertain', host, correlation,
        flowId, bridgeLifecycle,
      });
    }
  }

  await wait(Math.max(250, pollIntervalMs));
  readCount = 0;
  await readStatus();
  return link.getState();
}

async function advanceSharedWifiHandoff(correlation, lifecycle, flowId) {
  const key = handoffWorkKey(correlation, lifecycle, flowId);
  if (sharedHandoffAdvances.has(key)) return sharedHandoffAdvances.get(key);
  const run = resumeCardWifiHandoff({
    link: getSharedCardLink(), correlation, flowId, bridgeLifecycle: lifecycle,
    sendRequest: sendCardBridgeRequest,
    isCurrent: () => currentBridgeStillOwnsHandoff(correlation, lifecycle, flowId),
  }).then(async state => {
    if (!state.handoffStationVerified) {
      scheduleSharedHandoffRetry(correlation, lifecycle, flowId);
      return;
    }
    clearSharedHandoffRetry(key);
    rememberCardHost(correlation.host);
    writeStoredCardHost(correlation.host);
  }).catch((error) => {
    const link = getSharedCardLink();
    if (currentBridgeStillOwnsHandoff(correlation, lifecycle, flowId)) {
      link.dispatch({
        type: 'bridge-ping-missed', host: correlation.host,
        reason: error?.reason || 'card-stopped-answering',
      });
      scheduleSharedHandoffRetry(correlation, lifecycle, flowId);
    } else {
      const current = getCardBridgeState();
      if (current.handoffCorrelation && current.handoffFlowId) {
        void advanceSharedWifiHandoff(
          current.handoffCorrelation,
          current.lifecycle,
          current.handoffFlowId,
        );
      }
    }
  }).finally(() => {
    if (sharedHandoffAdvances.get(key) === run) sharedHandoffAdvances.delete(key);
  });
  sharedHandoffAdvances.set(key, run);
  return run;
}

export function cancelCardWifiHandoff(rawFlowId = '') {
  const flowId = normalizeHandoffFlowId(rawFlowId);
  if (!flowId) return false;
  suspendCardWifiHandoff(flowId);
  clearWifiHandoffRecovery(flowId);
  getSharedCardLink().dispatch({ type: 'wifi-handoff-cancelled', flowId });
  return true;
}

export function suspendCardWifiHandoff(rawFlowId = '') {
  const flowId = normalizeHandoffFlowId(rawFlowId);
  if (!flowId) return false;
  for (const [key, timer] of sharedHandoffRetryTimers) {
    if (!key.startsWith(`${flowId}|`)) continue;
    clearTimeout(timer);
    sharedHandoffRetryTimers.delete(key);
  }
  return true;
}

export function restoreCardWifiHandoff(rawFlowId = '') {
  const flowId = normalizeHandoffFlowId(rawFlowId);
  if (!flowId) return { ok: false, reason: 'invalid-flow' };
  const restored = restoreCardBridgeHandoff(flowId);
  if (!restored.ok) return restored;
  if (restored.state === 'already-restored') return restored;
  getSharedCardLink().dispatch({
    type: 'wifi-handoff-restored', host: restored.correlation.host,
    correlation: restored.correlation, flowId,
    bridgeLifecycle: restored.lifecycle,
    ackAttempted: restored.ackAttempted,
  });
  return restored;
}

// The bridge is the ONLY live transport on HTTPS (led.mandalacodes.com), where
// the browser blocks direct HTTP to the card. Its verify/keepalive carries card
// identity but not the /api/status fields that reveal a factory-default card, so
// a paired card sitting on defaults would read plain green. Read status over the
// bridge (firmware maps bridge type 'status' -> GET /api/status) to recover the
// complete readiness envelope. A status read failure must never tear down a
// verified bridge or invent configured/ready evidence.
async function fetchBridgeCardReadiness(host) {
  try {
    return await sendCardBridgeRequest('status', {}, { host, timeoutMs: CARD_LINK_PING_TIMEOUT_MS });
  } catch {
    return null;
  }
}

function classifiedCardBlank(readiness, expectedCardId = '') {
  if (!readiness) return null;
  return classifyCardReadiness(readiness, { expectedCardId }).blank;
}

function refreshBridgeCardBlank(host, cardId) {
  return fetchBridgeCardReadiness(host).then(readiness => {
    getSharedCardLink().dispatch({
      type: 'bridge-blank',
      host,
      cardId,
      blank: classifiedCardBlank(readiness, cardId),
      readiness,
    });
  }).catch(() => {
    /* a status probe failure leaves the verified bridge and its cardBlank as-is */
  });
}

// Direct-transport blank read used only at explicit adopt/pair time. The passive
// poll already computes blank from the status it fetched; adopt re-reads it so
// the just-paired card lands with the correct cardBlank on its first render
// instead of flashing green for one poll interval before demoting.
async function probeDirectCardReadiness(host, fetchImpl) {
  try {
    const fetcher = fetchImpl || globalThis.fetch;
    if (typeof fetcher !== 'function') return null;
    const response = await fetcher(`${cardHostToUrl(host)}/api/status`);
    if (!response?.ok) return null;
    return response.json().catch(() => null);
  } catch {
    return null;
  }
}

export function getSharedCardLink() {
  if (sharedLink) return sharedLink;
  sharedLink = createCardLink({ host: browserWindow() ? readStoredCardHost() : '' });
  const win = browserWindow();
  win?.addEventListener?.(CARD_BRIDGE_CHANGED_EVENT, (event) => {
    const detail = event?.detail || {};
    if (detail.handoffCorrelation) {
      const current = sharedLink.getState();
      if (!sameWifiHandoffCorrelation(current.handoffCorrelation, detail.handoffCorrelation)) {
        sharedLink.dispatch({
          type: 'wifi-handoff-retargeted', host: detail.handoffCorrelation.host,
          correlation: detail.handoffCorrelation, flowId: detail.handoffFlowId,
          bridgeLifecycle: detail.lifecycle,
        });
      } else if (current.handoffFlowId !== detail.handoffFlowId) {
        sharedLink.dispatch({
          type: 'wifi-handoff-retargeted', host: detail.handoffCorrelation.host,
          correlation: detail.handoffCorrelation, flowId: detail.handoffFlowId,
          bridgeLifecycle: detail.lifecycle,
        });
      } else if (current.handoffBridgeLifecycle !== detail.lifecycle) {
        sharedLink.dispatch({
          type: 'bridge-ready', host: detail.handoffCorrelation.host,
          bridgeLifecycle: detail.lifecycle,
        });
      }
      if (!detail.connected || !detail.verified) {
        sharedLink.dispatch({
          type: detail.open === false ? 'bridge-lost' : 'bridge-ping-missed',
          reason: detail.identityError || 'card-stopped-answering',
          host: detail.handoffCorrelation.host,
        });
        return;
      }
      const latestHandoff = sharedLink.getState();
      if (detail.connected && detail.verified && (
        detail.handoffAckReady
        || latestHandoff.handoffReloadRecovery
        || (latestHandoff.cardBlank === true && detail.runtimeCommandReady === true)
      )) {
        void advanceSharedWifiHandoff(
          detail.handoffCorrelation,
          detail.lifecycle,
          detail.handoffFlowId,
        );
      }
      // During a correlated handoff, ordinary ready/identity events are only
      // transport evidence. The orchestrator above owns the exact two-envelope,
      // one-ack, final-status transition back to command authority.
      return;
    }
    if (detail.connected && detail.verified) {
      if (detail.discoveredCard?.id && !readPersistedCardIdentity()) {
        sharedLink.dispatch({
          type: 'bridge-discovered', host: detail.host,
          card: detail.discoveredCard, bridgeLifecycle: detail.lifecycle,
        });
        return;
      }
      if (detail.card?.id) {
        const acknowledgedAt = new Date().toISOString();
        const expectedCard = readPersistedCardIdentity() || null;
        const comparison = expectedCard?.id ? compareCardIdentity(expectedCard, detail.card) : { ok: true };
        const prevLink = sharedLink.getState();
        sharedLink.dispatch({
          type: 'card-verified', via: 'bridge', host: detail.host,
          card: detail.card, expectedCard, acknowledgedAt,
          bridgeLifecycle: detail.lifecycle,
        });
        // The change event carries identity/lifecycle but not status, so read
        // /api/status over the bridge to resolve blank state. Only kick this on
        // the TRANSITION into a green bridge link for this card: a status read
        // itself dispatches a bridge-change (which re-enters this handler), so
        // refreshing on every bridge-change would recurse forever. A wrong-card
        // dispatch above stays disconnected and is skipped by the connected-bridge check.
        const nowLink = sharedLink.getState();
        const wasLinked = prevLink.state === 'connected-bridge' && prevLink.card?.id === detail.card.id;
        if (comparison.ok && nowLink.state === 'connected-bridge' && !wasLinked) {
          void refreshBridgeCardBlank(detail.host, detail.card.id);
        }
      } else if (detail.identityError) {
        sharedLink.dispatch({ type: 'bridge-lost', reason: detail.identityError, host: detail.host });
      } else {
        sharedLink.dispatch({
          type: 'bridge-ready', host: detail.host, bridgeLifecycle: detail.lifecycle,
        });
      }
      return;
    }
    if (!detail.open) {
      // Only a live or in-progress bridge can be "lost" — a stray teardown
      // event while disconnected must not rewrite the honest reason.
      const current = sharedLink.getState();
      if (current.state === 'connected-bridge' ||
          current.state === 'reconnecting-bridge' ||
          (current.state === 'revalidating' && current.transport === 'bridge') ||
          (current.state === 'connecting' && current.transport === 'bridge')) {
        sharedLink.dispatch({ type: 'bridge-lost', reason: 'card-page-closed' });
      }
    }
  });
  return sharedLink;
}

// Stable function references for React's useSyncExternalStore.
export function subscribeCardLink(listener) {
  return getSharedCardLink().subscribe(listener);
}

export function getCardLinkState() {
  return getSharedCardLink().getState();
}

// An operation timeout/failure is stronger evidence than the background
// keepalive cadence. Demote immediately, but only when the failing operation's
// immutable lease still names the exact current card lifecycle. A late failure
// from an old tab/boot/host must never knock a newer valid card link offline.
export function invalidateCardLinkOperationLease(lease, {
  link = getSharedCardLink(),
  reason = 'card-stopped-answering',
} = {}) {
  if (!lease || !link?.getState || !link?.dispatch) return false;
  const current = link.getState();
  const currentTransport = current.transport || (current.state === 'connected-bridge' ? 'bridge' : current.state === 'connected-direct' ? 'direct' : '');
  const currentCardId = String(current.card?.id || current.card?.cardId || '').trim().toLowerCase();
  const expectedCardId = String(lease.expectedCardId || '').trim().toLowerCase();
  const exact = (current.state === 'connected-bridge' || current.state === 'connected-direct')
    && expectedCardId && currentCardId === expectedCardId
    && normalizeCardHost(current.host) === normalizeCardHost(lease.host)
    && currentTransport === lease.transport
    && Number.isSafeInteger(lease.operationGeneration)
    && current.operationGeneration === lease.operationGeneration
    && String(current.validatedBootId || '') === String(lease.validatedBootId || '')
    && (lease.transport !== 'bridge' || current.bridgeLifecycle === lease.bridgeLifecycle);
  if (!exact) return false;
  link.dispatch({ type: 'operation-boundary-lost', reason });
  return true;
}

// Feed direct-transport results (useCardStatus on http/file) into the machine.
export function reportDirectCardStatus({
  connected = false,
  checking = false,
  host = '',
  status = null,
  card = null,
  detectedStatus = null,
  reason = '',
  allowAdopt = false,
} = {}) {
  const link = getSharedCardLink();
  if (connected) {
    const identity = card?.id ? card : normalizeCardIdentity(status || card || {}, host);
    const acknowledgedAt = new Date().toISOString();
    const expectedCard = readPersistedCardIdentity() || null;
    const comparison = expectedCard?.id ? compareCardIdentity(expectedCard, identity) : { ok: true };
    if (identity.id && comparison.ok && expectedCard?.id) {
      rememberCardHost(host);
      writeStoredCardHost(host);
    }
    const blank = classifiedCardBlank(status, identity.id);
    link.dispatch({
      type: 'direct-status', connected: true, host, card: identity, expectedCard,
      acknowledgedAt, allowAdopt, blank, readiness: status,
    });
    return;
  }
  if (detectedStatus) {
    const discoveredCard = normalizeCardIdentity(detectedStatus, host);
    const expectedCard = readPersistedCardIdentity() || null;
    link.dispatch({
      type: 'direct-status', connected: true, host, card: discoveredCard, expectedCard,
      allowAdopt: false,
    });
    return;
  }
  if (checking) {
    link.dispatch({ type: 'connecting', via: 'direct', host });
    return;
  }
  link.dispatch({ type: 'direct-status', connected: false, host, reason: reason || 'card-unreachable' });
}

export function reportCardStatusEnvelope({ host = '', status = null, transport = 'direct' } = {}) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return getCardLinkState();
  if (transport === 'bridge') {
    const link = getSharedCardLink();
    if (link.getState().handoffCorrelation) {
      link.dispatch({
        type: 'wifi-handoff-status', host,
        correlation: link.getState().handoffCorrelation,
        flowId: link.getState().handoffFlowId,
        bridgeLifecycle: link.getState().handoffBridgeLifecycle,
        readiness: status,
      });
      return link.getState();
    }
    const expectedCard = readPersistedCardIdentity() || link.getState().expectedCard || null;
    link.dispatch({
      type: 'bridge-ping-ok', host, readiness: status,
      card: normalizeCardIdentity(status, host), expectedCard,
      bridgeLifecycle: link.getState().bridgeLifecycle,
    });
    return link.getState();
  }
  reportDirectCardStatus({ connected: true, host, status });
  return getCardLinkState();
}

function persistedIdentityAuthorityToken(identity) {
  if (!identity) return 'null';
  return JSON.stringify(Object.entries(identity).sort(([left], [right]) => left.localeCompare(right)));
}

export async function adoptDiscoveredDirectCard({ fetchImpl, link = getSharedCardLink() } = {}) {
  const state = link.getState();
  const discoveredCard = state.discoveredCard;
  if (state.transport !== 'direct' || !discoveredCard?.id) {
    const error = new Error('No directly connected Lightweaver card is ready to pair.');
    error.reason = 'identity-missing';
    throw error;
  }
  const snapshot = {
    host: state.host,
    cardId: discoveredCard.id,
    revision: state.directDiscoveryRevision || 0,
    persistedAuthority: persistedIdentityAuthorityToken(readPersistedCardIdentity()),
  };
  const verifyOptions = { expected: discoveredCard };
  if (fetchImpl) verifyOptions.fetchImpl = fetchImpl;
  const verified = await verifyExpectedCardAtHost(state.host, verifyOptions);
  // Read blank state here (before the authority/discovery gates re-check, which
  // stay the last thing before dispatch) so the paired card renders with the
  // correct cardBlank immediately instead of flashing green for one poll.
  const readiness = await probeDirectCardReadiness(state.host, fetchImpl);
  const classified = classifyCardReadiness(readiness || {}, { expectedCard: verified });
  if (classified.state === 'checking' || classified.state === 'identity-mismatch') {
    const error = new Error('Studio could not reverify the full card status before pairing.');
    error.reason = readinessReason(classified) || 'identity-missing';
    throw error;
  }
  const blank = classified.blank;
  if (persistedIdentityAuthorityToken(readPersistedCardIdentity()) !== snapshot.persistedAuthority) {
    const error = new Error('The paired card changed in another tab while this check was running. Review the card now shown and try again.');
    error.reason = 'stale-identity';
    throw error;
  }
  const current = link.getState();
  if (
    current.transport !== 'direct'
    || current.host !== snapshot.host
    || current.discoveredCard?.id !== snapshot.cardId
    || (current.directDiscoveryRevision || 0) !== snapshot.revision
  ) {
    const error = new Error('A newer card discovery replaced this pairing attempt. Try again with the card now shown.');
    error.reason = 'stale-discovery';
    throw error;
  }
  const acknowledgedAt = new Date().toISOString();
  persistCardIdentity(verified, { acknowledgedAt });
  rememberCardHost(state.host);
  writeStoredCardHost(state.host);
  link.dispatch({
    type: 'direct-status', connected: true, host: state.host, card: verified,
    expectedCard: verified, allowAdopt: true, acknowledgedAt, blank, readiness,
  });
  return verified;
}

// App-load behavior: adopt an opener/parent bridge when Studio was launched
// from the card page; otherwise, if a bridge was live last session, try one
// re-ping. Any failure lands in an honest disconnected state whose fix is the
// one-click connect below.
export function cardLinkBootstrapFailureReason(error) {
  const reason = error?.reason;
  if (reason === 'identity-missing' || reason === 'firmware-too-old' || reason === 'wrong-card') {
    return reason;
  }
  return reason === 'bridge-missing' ? 'bridge-missing' : 'no-answer';
}

export async function bootstrapCardLink() {
  const link = getSharedCardLink();
  const hasOpenerBridge = bootstrapCardBridgeFromOpener();
  if (!hasOpenerBridge && !readBridgeWasActive()) return link.getState();
  link.dispatch({ type: 'connecting', via: 'bridge', host: getCardBridgeState().host });
  try {
    await sendCardBridgeRequest('ping', {}, { timeoutMs: CARD_LINK_PING_TIMEOUT_MS });
    const card = await verifyCardBridgeIdentity(getCardBridgeState().host);
    const acknowledgedAt = new Date().toISOString();
    const expectedCard = readPersistedCardIdentity() || null;
    const comparison = expectedCard?.id ? compareCardIdentity(expectedCard, card) : { ok: true };
    // Resolve the complete readiness envelope before the green transition so
    // configured, factory, and unknown cards cannot be conflated.
    const readiness = comparison.ok
      ? await fetchBridgeCardReadiness(getCardBridgeState().host)
      : null;
    const blank = classifiedCardBlank(readiness, card.id);
    link.dispatch({
      type: 'card-verified', via: 'bridge', host: getCardBridgeState().host,
      card, expectedCard, acknowledgedAt, blank, readiness,
      bridgeLifecycle: getCardBridgeState().lifecycle,
    });
  } catch (error) {
    // The remembered bridge is gone — forget it, so future app loads do not
    // pay this failing re-ping on every startup. A successful bridge
    // establishment sets the flag again (see dispatch's connected-bridge arm).
    writeBridgeWasActive(false);
    link.dispatch({
      type: 'bridge-lost',
      reason: cardLinkBootstrapFailureReason(error),
    });
  }
  return link.getState();
}

// One-click "Connect to card": opens the card page popup (needs the user's
// click — that is fine) and waits for its ready handshake, which arrives via
// the CARD_BRIDGE_CHANGED_EVENT wiring above.
export function connectCardLink(rawHost = '') {
  const link = getSharedCardLink();
  const opened = openCardBridge(rawHost);
  if (!opened) {
    link.dispatch({ type: 'bridge-lost', reason: 'popup-blocked' });
    return null;
  }
  link.dispatch({ type: 'connecting', via: 'bridge', host: getCardBridgeState().host });
  return opened;
}
