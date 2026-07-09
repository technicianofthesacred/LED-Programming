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
  sendCardBridgeRequest,
} from './cardBridge.js';
import { readStoredCardHost } from './cardConnection.js';

export const CARD_LINK_PING_INTERVAL_MS = 5000;
export const CARD_LINK_PING_TIMEOUT_MS = 2500;
export const CARD_LINK_PING_MISS_LIMIT = 2;
export const CARD_LINK_CONNECT_TIMEOUT_MS = 15000;
// Set once a bridge session succeeds; on the next app load we try one re-ping
// before showing the one-click "Connect to card" affordance.
export const CARD_LINK_BRIDGE_ACTIVE_KEY = 'lw_card_bridge_was_active';

export const CARD_LINK_STATES = ['disconnected', 'connecting', 'connected-bridge', 'connected-direct'];

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
      // A direct probe starting up never demotes an established bridge link.
      if (via === 'direct' && prev.state === 'connected-bridge') return prev;
      if (prev.state === 'connecting' && prev.transport === via && prev.host === host) return prev;
      return { state: 'connecting', reason: '', transport: via, host, missedPings: 0 };
    }
    case 'bridge-ready':
    case 'bridge-ping-ok': {
      if (prev.state === 'connected-bridge' && prev.host === host && prev.missedPings === 0) return prev;
      return { state: 'connected-bridge', reason: '', transport: 'bridge', host, missedPings: 0 };
    }
    case 'bridge-ping-missed': {
      // A missed keepalive only matters for an established bridge link.
      if (prev.state !== 'connected-bridge') return prev;
      const missedPings = prev.missedPings + 1;
      if (missedPings >= Math.max(1, missLimit)) {
        return {
          state: 'disconnected',
          reason: event.reason || 'card-stopped-answering',
          transport: '',
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
      return { state: 'disconnected', reason, transport: '', host, missedPings: 0 };
    }
    case 'direct-status': {
      if (event.connected) {
        // The bridge keepalive is authoritative while a bridge is up.
        if (prev.state === 'connected-bridge') return prev;
        if (prev.state === 'connected-direct' && prev.host === host) return prev;
        return { state: 'connected-direct', reason: '', transport: 'direct', host, missedPings: 0 };
      }
      // A failed direct probe never tears down a live (or connecting) bridge.
      if (prev.state === 'connected-bridge') return prev;
      if (prev.state === 'connecting' && prev.transport === 'bridge') return prev;
      const reason = event.reason || 'card-unreachable';
      if (prev.state === 'disconnected' && prev.reason === reason && prev.host === host) return prev;
      return { state: 'disconnected', reason, transport: '', host, missedPings: 0 };
    }
    default:
      return prev;
  }
}

export function isCardLinkConnected(state = {}) {
  return state.state === 'connected-bridge' || state.state === 'connected-direct';
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
    case 'never-connected':
    default:
      return 'Not connected to a card.';
  }
}

export function cardLinkStatusText(state = {}) {
  switch (state.state) {
    case 'connected-bridge': return 'Live via card page';
    case 'connected-direct': return 'Live direct';
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
    if (destroyed || pinging || state.state !== 'connected-bridge') return;
    pinging = true;
    try {
      await sendRequest('ping', {}, { timeoutMs: pingTimeoutMs });
      dispatch({ type: 'bridge-ping-ok' });
    } catch (error) {
      if (error?.reason === 'bridge-missing' || error?.reason === 'bridge-post-failed') {
        dispatch({ type: 'bridge-lost', reason: 'card-page-closed' });
      } else {
        dispatch({ type: 'bridge-ping-missed', reason: 'card-stopped-answering' });
      }
    } finally {
      pinging = false;
    }
    if (state.state === 'connected-bridge') schedulePing();
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

export function getSharedCardLink() {
  if (sharedLink) return sharedLink;
  sharedLink = createCardLink({ host: browserWindow() ? readStoredCardHost() : '' });
  const win = browserWindow();
  win?.addEventListener?.(CARD_BRIDGE_CHANGED_EVENT, (event) => {
    const detail = event?.detail || {};
    if (detail.connected && detail.verified) {
      // A verified handshake (ready event or verified response) from the card
      // origin — the bridge is genuinely live.
      sharedLink.dispatch({ type: 'bridge-ready', host: detail.host });
      return;
    }
    if (!detail.open) {
      // Only a live or in-progress bridge can be "lost" — a stray teardown
      // event while disconnected must not rewrite the honest reason.
      const current = sharedLink.getState();
      if (current.state === 'connected-bridge' ||
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
export function reportDirectCardStatus({ connected = false, checking = false, host = '' } = {}) {
  const link = getSharedCardLink();
  if (connected) {
    link.dispatch({ type: 'direct-status', connected: true, host });
    return;
  }
  if (checking) {
    link.dispatch({ type: 'connecting', via: 'direct', host });
    return;
  }
  link.dispatch({ type: 'direct-status', connected: false, host, reason: 'card-unreachable' });
}

// App-load behavior: adopt an opener/parent bridge when Studio was launched
// from the card page; otherwise, if a bridge was live last session, try one
// re-ping. Any failure lands in an honest disconnected state whose fix is the
// one-click connect below.
export async function bootstrapCardLink() {
  const link = getSharedCardLink();
  const hasOpenerBridge = bootstrapCardBridgeFromOpener();
  if (!hasOpenerBridge && !readBridgeWasActive()) return link.getState();
  link.dispatch({ type: 'connecting', via: 'bridge', host: getCardBridgeState().host });
  try {
    await sendCardBridgeRequest('ping', {}, { timeoutMs: CARD_LINK_PING_TIMEOUT_MS });
    link.dispatch({ type: 'bridge-ready', host: getCardBridgeState().host });
  } catch (error) {
    link.dispatch({
      type: 'bridge-lost',
      reason: error?.reason === 'bridge-missing' ? 'bridge-missing' : 'no-answer',
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
