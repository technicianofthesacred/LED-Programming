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
  adoptDiscoveredCardBridgeIdentity,
  bootstrapCardBridgeFromOpener,
  getCardBridgeState,
  openCardBridge,
  sendCardBridgeRequest,
  verifyCardBridgeIdentity,
} from './cardBridge.js';
import { readStoredCardHost, rememberCardHost, writeStoredCardHost } from './cardConnection.js';
import {
  compareCardIdentity,
  normalizeCardIdentity,
  persistCardIdentity,
  readPersistedCardIdentity,
  verifyExpectedCardAtHost,
} from './cardIdentity.js';

export const CARD_LINK_PING_INTERVAL_MS = 5000;
export const CARD_LINK_PING_TIMEOUT_MS = 2500;
export const CARD_LINK_PING_MISS_LIMIT = 2;
export const CARD_LINK_CONNECT_TIMEOUT_MS = 15000;
// Set once a bridge session succeeds; on the next app load we try one re-ping
// before showing the one-click "Connect to card" affordance.
export const CARD_LINK_BRIDGE_ACTIVE_KEY = 'lw_card_bridge_was_active';

export const CARD_LINK_STATES = ['disconnected', 'connecting', 'reconnecting-bridge', 'connected-bridge', 'connected-direct'];

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
  };
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
        ...prev,
        state: 'connecting', reason: '', transport: via, host, missedPings: 0,
        ...(host !== prev.host ? { card: null, acknowledgedAt: '' } : {}),
      };
    }
    case 'bridge-ready': {
      if ((prev.state === 'connected-bridge' || prev.state === 'reconnecting-bridge') && prev.card?.id && prev.host === host) return prev;
      if (prev.state === 'connecting' && prev.transport === 'bridge' && prev.host === host) return prev;
      return { ...prev, state: 'connecting', reason: '', transport: 'bridge', host, missedPings: 0 };
    }
    case 'card-verified': {
      if (!event.card?.id) return { ...prev, state: 'disconnected', reason: 'identity-missing', transport: '', missedPings: 0 };
      if (prev.host && event.host && prev.host !== event.host) return prev;
      if (event.expectedCard?.id) {
        const comparison = compareCardIdentity(event.expectedCard, event.card);
        if (!comparison.ok) return { ...prev, state: 'disconnected', reason: comparison.reason, transport: '', missedPings: 0 };
      }
      const transport = event.via === 'direct' ? 'direct' : 'bridge';
      return {
        ...prev,
        state: transport === 'direct' ? 'connected-direct' : 'connected-bridge',
        reason: '', transport, host, missedPings: 0,
        card: event.card,
        acknowledgedAt: event.acknowledgedAt || new Date().toISOString(),
      };
    }
    case 'bridge-ping-ok': {
      if (!prev.card?.id) return prev;
      if (prev.state === 'connected-bridge' && prev.host === host && prev.missedPings === 0) return prev;
      return { ...prev, state: 'connected-bridge', reason: '', transport: 'bridge', host, missedPings: 0 };
    }
    case 'bridge-ping-missed': {
      // A missed keepalive only matters for an established bridge link.
      if (prev.state !== 'connected-bridge' && prev.state !== 'reconnecting-bridge') return prev;
      const missedPings = prev.missedPings + 1;
      if (missedPings >= Math.max(1, missLimit)) {
        return {
          ...prev,
          state: 'reconnecting-bridge',
          reason: 'card-restarting',
          transport: 'bridge',
          host,
          missedPings,
        };
      }
      return { ...prev, missedPings };
    }
    case 'bridge-lost': {
      // The card page window closed or never answered. Direct links are a
      // separate transport and are unaffected.
      if (prev.state === 'connected-direct') return prev;
      const reason = event.reason || 'card-page-closed';
      if (prev.state === 'disconnected' && prev.reason === reason && prev.host === host) return prev;
      return { ...prev, state: 'disconnected', reason, transport: '', host, missedPings: 0 };
    }
    case 'direct-status': {
      if (event.connected) {
        // The bridge keepalive is authoritative while a bridge is up.
        if (prev.state === 'connected-bridge' || prev.state === 'reconnecting-bridge') return prev;
        if (!event.card?.id) {
          return { ...prev, state: 'disconnected', reason: 'identity-missing', transport: 'direct', host, missedPings: 0 };
        }
        if (event.expectedCard?.id) {
          const comparison = compareCardIdentity(event.expectedCard, event.card);
          if (!comparison.ok) return {
            ...prev,
            state: 'disconnected', reason: comparison.reason, transport: 'direct', host, missedPings: 0,
            discoveredCard: event.card,
            expectedCard: event.expectedCard,
            card: null,
          };
        } else if (!event.allowAdopt) {
          return {
            ...prev,
            state: 'disconnected', reason: 'never-connected', transport: 'direct', host, missedPings: 0,
            discoveredCard: event.card,
            card: null,
          };
        }
        if (prev.state === 'connected-direct' && prev.host === host && prev.card?.id === event.card.id) return prev;
        return {
          ...prev, state: 'connected-direct', reason: '', transport: 'direct', host, missedPings: 0,
          card: event.card,
          discoveredCard: null,
          expectedCard: event.card,
          acknowledgedAt: event.acknowledgedAt || new Date().toISOString(),
        };
      }
      // A failed direct probe never tears down a live (or connecting) bridge.
      if (prev.state === 'connected-bridge' || prev.state === 'reconnecting-bridge') return prev;
      if (prev.state === 'connecting' && prev.transport === 'bridge') return prev;
      const reason = event.reason || 'card-unreachable';
      if (prev.state === 'disconnected' && prev.reason === reason && prev.host === host) return prev;
      return {
        ...prev, state: 'disconnected', reason, transport: event.transport || 'direct', host, missedPings: 0,
        ...(event.discoveredCard ? { discoveredCard: event.discoveredCard } : {}),
      };
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
  return Boolean(state.card?.id) && (state.state === 'connected-bridge' || state.state === 'connected-direct');
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
    case 'identity-missing': return 'This card needs a firmware update before Studio can verify it.';
    case 'wrong-card': return 'This is a different Lightweaver card.';
    case 'firmware-too-old': return 'This card firmware needs an update.';
    case 'never-connected':
    default:
      return 'Not connected to a card.';
  }
}

export function cardLinkStatusText(state = {}) {
  switch (state.state) {
    case 'connected-bridge': return 'Live via card page';
    case 'connected-direct': return 'Live direct';
    case 'reconnecting-bridge': return 'Card restarting…';
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
  pingIntervalMs = CARD_LINK_PING_INTERVAL_MS,
  pingTimeoutMs = CARD_LINK_PING_TIMEOUT_MS,
  connectTimeoutMs = CARD_LINK_CONNECT_TIMEOUT_MS,
  missLimit = CARD_LINK_PING_MISS_LIMIT,
  host = '',
} = {}) {
  let state = initialCardLinkState(host);
  const listeners = new Set();
  let pingTimer = null;
  let connectTimer = null;
  let pinging = false;
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

  async function runPing() {
    if (destroyed || pinging || (state.state !== 'connected-bridge' && state.state !== 'reconnecting-bridge')) return;
    const pingHost = state.host;
    pinging = true;
    try {
      await sendRequest('ping', {}, { timeoutMs: pingTimeoutMs });
      if (state.host === pingHost && (state.state === 'connected-bridge' || state.state === 'reconnecting-bridge')) {
        dispatch({ type: 'bridge-ping-ok', host: pingHost });
      }
    } catch (error) {
      if (state.host !== pingHost || (state.state !== 'connected-bridge' && state.state !== 'reconnecting-bridge')) return;
      if (error?.reason === 'bridge-missing' || error?.reason === 'bridge-post-failed') {
        dispatch({ type: 'bridge-lost', reason: 'card-page-closed', host: pingHost });
      } else {
        dispatch({ type: 'bridge-ping-missed', reason: 'card-stopped-answering', host: pingHost });
      }
    } finally {
      pinging = false;
    }
    if (state.state === 'connected-bridge' || state.state === 'reconnecting-bridge') schedulePing();
  }

  function dispatch(event) {
    const next = reduceCardLink(state, event, { missLimit });
    if (next === state) return state;
    const prev = state;
    state = next;
    if (state.state === 'connected-bridge') {
      clearConnectTimer();
      if (prev.state !== 'connected-bridge') writeBridgeWasActive(true);
      if (!pingTimer && !pinging) schedulePing();
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
    } else if (state.state === 'connecting' && state.transport === 'bridge') {
      stopKeepalive();
      clearConnectTimer();
      if (connectTimeoutMs > 0) {
        connectTimer = setTimeout(() => {
          connectTimer = null;
          dispatch({ type: 'bridge-lost', reason: 'no-answer' });
        }, connectTimeoutMs);
      }
    } else {
      stopKeepalive();
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
      clearConnectTimer();
      listeners.clear();
    },
  };
}

// ── shared browser instance ────────────────────────────────────────────────
let sharedLink = null;
let pendingFirstPairHost = '';
let pendingFirstPairTimer = null;

function clearPendingFirstPair() {
  pendingFirstPairHost = '';
  if (pendingFirstPairTimer) clearTimeout(pendingFirstPairTimer);
  pendingFirstPairTimer = null;
}

export function getSharedCardLink() {
  if (sharedLink) return sharedLink;
  sharedLink = createCardLink({ host: browserWindow() ? readStoredCardHost() : '' });
  const win = browserWindow();
  win?.addEventListener?.(CARD_BRIDGE_CHANGED_EVENT, (event) => {
    const detail = event?.detail || {};
    if (detail.connected && detail.verified) {
      if (pendingFirstPairHost && detail.discoveredCard?.id && !readPersistedCardIdentity()) {
        const host = pendingFirstPairHost;
        clearPendingFirstPair();
        try {
          adoptDiscoveredCardBridgeIdentity(host);
        } catch (error) {
          sharedLink.dispatch({ type: 'bridge-lost', reason: error?.reason || 'identity-missing', host });
        }
        return;
      }
      if (detail.card?.id) {
        const acknowledgedAt = new Date().toISOString();
        const expectedCard = readPersistedCardIdentity() || null;
        const comparison = expectedCard?.id ? compareCardIdentity(expectedCard, detail.card) : { ok: true };
        if (comparison.ok) persistCardIdentity(detail.card, { acknowledgedAt });
        sharedLink.dispatch({
          type: 'card-verified', via: 'bridge', host: detail.host,
          card: detail.card, expectedCard, acknowledgedAt,
        });
      } else if (detail.identityError) {
        sharedLink.dispatch({ type: 'bridge-lost', reason: detail.identityError, host: detail.host });
      } else {
        sharedLink.dispatch({ type: 'bridge-ready', host: detail.host });
      }
      return;
    }
    if (!detail.open) {
      // Only a live or in-progress bridge can be "lost" — a stray teardown
      // event while disconnected must not rewrite the honest reason.
      const current = sharedLink.getState();
      if (current.state === 'connected-bridge' ||
          current.state === 'reconnecting-bridge' ||
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
    if (identity.id && comparison.ok && (expectedCard?.id || allowAdopt)) {
      persistCardIdentity(identity, { acknowledgedAt });
      rememberCardHost(host);
      writeStoredCardHost(host);
    }
    link.dispatch({
      type: 'direct-status', connected: true, host, card: identity, expectedCard,
      acknowledgedAt, allowAdopt,
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

export async function adoptDiscoveredDirectCard({ fetchImpl } = {}) {
  const link = getSharedCardLink();
  const state = link.getState();
  const discoveredCard = state.discoveredCard;
  if (state.transport !== 'direct' || !discoveredCard?.id) {
    const error = new Error('No directly connected Lightweaver card is ready to pair.');
    error.reason = 'identity-missing';
    throw error;
  }
  const verifyOptions = { expected: discoveredCard };
  if (fetchImpl) verifyOptions.fetchImpl = fetchImpl;
  const verified = await verifyExpectedCardAtHost(state.host, verifyOptions);
  const acknowledgedAt = new Date().toISOString();
  persistCardIdentity(verified, { acknowledgedAt });
  rememberCardHost(state.host);
  writeStoredCardHost(state.host);
  link.dispatch({
    type: 'direct-status', connected: true, host: state.host, card: verified,
    expectedCard: verified, allowAdopt: true, acknowledgedAt,
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
    if (comparison.ok) persistCardIdentity(card, { acknowledgedAt });
    link.dispatch({ type: 'card-verified', via: 'bridge', host: getCardBridgeState().host, card, expectedCard, acknowledgedAt });
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
  const host = rawHost || readStoredCardHost();
  clearPendingFirstPair();
  if (!readPersistedCardIdentity()) {
    pendingFirstPairHost = host;
    pendingFirstPairTimer = setTimeout(clearPendingFirstPair, CARD_LINK_CONNECT_TIMEOUT_MS);
  }
  const opened = openCardBridge(rawHost);
  if (!opened) {
    clearPendingFirstPair();
    link.dispatch({ type: 'bridge-lost', reason: 'popup-blocked' });
    return null;
  }
  link.dispatch({ type: 'connecting', via: 'bridge', host: getCardBridgeState().host });
  return opened;
}
