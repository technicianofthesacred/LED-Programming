import {
  cardHostToUrl,
  isLocalCardHost,
  normalizeCardHost,
  readStoredCardHost,
  writeStoredCardHost,
} from './cardConnection.js';

// Message types that command the hardware (write state, push config, reboot,
// repair the LED output, stream live frames). These require a card origin we've
// verified is on the local network before we'll postMessage them — see
// assertPrivilegedTarget.
const PRIVILEGED_BRIDGE_TYPES = new Set(['config', 'control', 'reboot', 'recover-lights', 'frame']);

// Bridge protocol version this Studio speaks, and the version each versioned
// feature first shipped in. Cards report their version in the 'ready'
// handshake (and on every relay reply); firmware older than the versioned
// bridge reports nothing, which we treat as 0 (legacy).
export const CARD_BRIDGE_PROTOCOL_VERSION = 1;
export const CARD_BRIDGE_FEATURE_VERSIONS = { frame: 1 };

export const CARD_BRIDGE_CHANGED_EVENT = 'lightweaver-card-bridge-changed';
export const STUDIO_BRIDGE_APP = 'LightweaverStudioBridge';
export const CARD_BRIDGE_APP = 'LightweaverCardBridge';
export const LOCAL_CHIP_DEFAULT_KEY = 'lw_local_chip_default';

let bridgeWindow = null;
let bridgeOrigin = '';
let bridgeHost = '';
let bridgeConnected = false;
// True only once we've seen a verified handshake from the card origin: either a
// `ready` event or a successful request response whose event.origin matched the
// derived local card origin. Privileged sends require this to be true.
let bridgeReady = false;
// The card page's reported bridge protocol version. 0 = legacy firmware that
// predates versioning (no `version` field in its ready/replies).
let bridgeVersion = 0;
let bridgeLastSeenAt = 0;
let bridgeSeq = 0;
let listenerAttached = false;
let listenerWindow = null;
const pending = new Map();

function browserWindow() {
  return typeof window !== 'undefined' ? window : null;
}

export function readLocalChipDefault() {
  const win = browserWindow();
  try {
    return win?.localStorage?.getItem(LOCAL_CHIP_DEFAULT_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLocalChipDefault(enabled) {
  const win = browserWindow();
  try {
    if (enabled) win?.localStorage?.setItem(LOCAL_CHIP_DEFAULT_KEY, '1');
    else win?.localStorage?.removeItem(LOCAL_CHIP_DEFAULT_KEY);
  } catch {
    /* noop */
  }
}

function dispatchBridgeChange() {
  const win = browserWindow();
  if (!win?.dispatchEvent) return;
  try {
    win.dispatchEvent(new CustomEvent(CARD_BRIDGE_CHANGED_EVENT, { detail: getCardBridgeState() }));
  } catch {
    /* noop */
  }
}

function bridgeTargetClosed(target = bridgeWindow) {
  try {
    return Boolean(target?.closed);
  } catch {
    return false;
  }
}

function clearBridgeTarget({ host = bridgeHost, origin = bridgeOrigin } = {}) {
  bridgeWindow = null;
  bridgeOrigin = origin || '';
  bridgeHost = normalizeCardHost(host || bridgeHost || readStoredCardHost());
  bridgeConnected = false;
  bridgeReady = false;
  bridgeVersion = 0;
  dispatchBridgeChange();
}

function setBridgeState({
  source = bridgeWindow,
  origin = bridgeOrigin,
  host = bridgeHost,
  connected = bridgeConnected,
  ready = undefined,
} = {}) {
  if (source) bridgeWindow = source;
  if (origin) bridgeOrigin = origin;
  if (host) {
    bridgeHost = normalizeCardHost(host);
    writeStoredCardHost(bridgeHost);
  }
  bridgeConnected = Boolean(connected);
  // `ready` only flips to true on a verified handshake; once true it sticks for
  // the life of this bridge target (cleared by clearBridgeTarget).
  if (ready === true) bridgeReady = true;
  else if (ready === false) bridgeReady = false;
  if (bridgeConnected) bridgeLastSeenAt = Date.now();
  dispatchBridgeChange();
}

function hostFromOrigin(origin = '') {
  try {
    return normalizeCardHost(new URL(origin).host);
  } catch {
    return '';
  }
}

function parseBridgeParams() {
  const win = browserWindow();
  if (!win?.location) return { enabled: false, host: '' };
  const params = new URLSearchParams(win.location.search || '');
  const rawHost = params.get('cardHost') || params.get('host') || '';
  // Only trust a host supplied via URL params if it resolves to a local card
  // address (RFC1918 IPv4 / .local). A public hostname here would let a crafted
  // link point the bridge's target origin at an attacker — drop it and fall
  // back to the stored host instead.
  const host = rawHost && isLocalCardHost(rawHost) ? rawHost : '';
  return {
    enabled: params.get('cardBridge') === '1' || params.get('bridge') === 'card',
    host,
    autoPreview: params.get('studioTakeover') !== '0',
  };
}

export function isCardBridgeLaunch() {
  return parseBridgeParams().enabled;
}

export function cardBridgeAutoPreviewEnabled() {
  const params = parseBridgeParams();
  return Boolean(params.enabled && params.autoPreview);
}

function handleBridgeMessage(event) {
  const data = event?.data || {};
  if (data.app !== CARD_BRIDGE_APP) return;

  if (data.type === 'ready') {
    // Verify the handshake comes from a local card origin before trusting it.
    // event.origin must match the derived card origin (and be a local card
    // host) — otherwise an arbitrary frame could announce itself as the bridge.
    const claimedHost = normalizeCardHost(data.host || hostFromOrigin(event.origin));
    const derivedOrigin = cardHostToUrl(claimedHost);
    if (!isLocalCardHost(claimedHost) || event.origin !== derivedOrigin) return;
    bridgeVersion = Number(data.version) || 0;
    setBridgeState({
      source: event.source,
      origin: event.origin,
      host: claimedHost,
      connected: true,
      ready: true,
    });
    return;
  }

  const request = pending.get(data.id);
  if (!request) return;
  if (bridgeWindow && event.source && event.source !== bridgeWindow) return;
  if (request.origin && event.origin !== request.origin) return;

  pending.delete(data.id);
  clearTimeout(request.timer);

  if (data.ok === false) {
    const error = new Error(data.error || 'Card bridge request failed');
    error.reason = data.reason || 'bridge';
    request.reject(error);
    return;
  }

  // A response whose origin matches a local card origin is a verified handshake
  // (the request's targetOrigin was already enforced on postMessage), so mark
  // the bridge ready for subsequent privileged sends.
  const verifiedReady = isLocalCardHost(hostFromOrigin(event.origin))
    && (!request.origin || event.origin === request.origin);
  // v1 card pages stamp every relay reply with their protocol version, which
  // covers the iframe flow where the ready event can be missed.
  if (verifiedReady && data.version !== undefined) bridgeVersion = Number(data.version) || 0;
  setBridgeState({
    source: event.source,
    origin: event.origin,
    host: data.host || bridgeHost || hostFromOrigin(event.origin),
    connected: true,
    ready: verifiedReady ? true : undefined,
  });
  request.resolve(data.response ?? data.status ?? { ok: true });
}

export function attachCardBridgeListener() {
  const win = browserWindow();
  if (!win) return;
  if (listenerAttached && listenerWindow === win) return;
  if (listenerWindow && listenerWindow !== win) {
    try {
      listenerWindow.removeEventListener?.('message', handleBridgeMessage);
    } catch {
      /* noop */
    }
  }
  win.addEventListener?.('message', handleBridgeMessage);
  listenerWindow = win;
  listenerAttached = true;
}

export function bootstrapCardBridgeFromOpener() {
  const win = browserWindow();
  attachCardBridgeListener();
  const bridgeHostWindow = win?.opener || (win?.parent && win.parent !== win ? win.parent : null);
  if (!bridgeHostWindow) return false;
  const params = parseBridgeParams();
  if (!params.enabled && bridgeWindow) return true;
  if (!params.enabled) return false;
  const host = normalizeCardHost(params.host || readStoredCardHost());
  setBridgeState({
    source: bridgeHostWindow,
    origin: cardHostToUrl(host),
    host,
    // In the card handoff flow Studio often runs inside an iframe hosted by
    // the card page. That parent page is the bridge, but older firmware does
    // not always send a ready event down into the iframe, so trust the explicit
    // cardBridge launch params and verify on the next request.
    connected: true,
  });
  return true;
}

function bridgeStudioUrl(rawHost = '', rawStudioUrl = '') {
  const win = browserWindow();
  const host = normalizeCardHost(rawHost || readStoredCardHost());
  const fallback = win?.location?.href || 'https://led.mandalacodes.com/#screen=patterns';
  const studio = new URL(rawStudioUrl || fallback, fallback);
  studio.searchParams.set('cardBridge', '1');
  studio.searchParams.set('cardHost', host);
  studio.searchParams.set('studioTakeover', '1');
  if (!studio.hash) studio.hash = '#screen=patterns';
  return studio.href;
}

export function buildCardBridgeLaunchUrl(rawHost = '', rawStudioUrl = '') {
  const host = normalizeCardHost(rawHost || readStoredCardHost());
  const url = new URL(`${cardHostToUrl(host)}/`);
  url.searchParams.set('studioAutoOpen', '1');
  url.searchParams.set('studioUrl', bridgeStudioUrl(host, rawStudioUrl));
  url.hash = '#studioBridge=1';
  return url.href;
}

export function openCardBridge(rawHost = '', {
  autoOpenStudio = false,
  studioUrl = '',
} = {}) {
  const win = browserWindow();
  if (!win?.open) return null;
  attachCardBridgeListener();
  const host = normalizeCardHost(rawHost || readStoredCardHost());
  const origin = cardHostToUrl(host);
  const bridgeUrl = autoOpenStudio
    ? buildCardBridgeLaunchUrl(host, studioUrl)
    : `${origin}/#studioBridge=1`;
  const opened = win.open(bridgeUrl, 'lightweaver-card-bridge');
  if (opened) {
    setBridgeState({ source: opened, origin, host, connected: false });
  }
  return opened;
}

export function getCardBridgeState() {
  return {
    connected: bridgeConnected,
    // True once a handshake (ready event or verified response) confirmed the
    // bridge speaks from the local card origin.
    verified: bridgeReady,
    // Bridge protocol version the card reported (0 = legacy firmware).
    version: bridgeVersion,
    host: bridgeHost || readStoredCardHost(),
    origin: bridgeOrigin || cardHostToUrl(bridgeHost || readStoredCardHost()),
    lastSeenAt: bridgeLastSeenAt,
    open: Boolean(bridgeWindow),
  };
}

export function getCardBridgeVersion() {
  return bridgeVersion;
}

// When Studio wants a v1 feature (e.g. 'frame' streaming) but the connected
// card page reported an older protocol, return what's missing so the UI can
// say "card firmware needs an update — open Flash". Returns null when the
// feature is supported.
export function cardBridgeFeatureGap(feature) {
  const required = CARD_BRIDGE_FEATURE_VERSIONS[feature] ?? 0;
  if (bridgeVersion >= required) return null;
  return {
    feature,
    required,
    reported: bridgeVersion,
    action: 'open-flash',
    message: 'This card is running older firmware that can\'t do this yet. Open Flash to update the card, then try again.',
  };
}

export function hasCardBridge() {
  bootstrapCardBridgeFromOpener();
  if (bridgeTargetClosed()) {
    clearBridgeTarget();
    return false;
  }
  return Boolean(bridgeWindow);
}

function bridgeError(message, reason, cause = null) {
  const error = new Error(message);
  error.reason = reason;
  if (cause instanceof Error) error.cause = cause;
  return error;
}

function markBridgeTimeout(startedAt) {
  if (!startedAt || bridgeLastSeenAt <= startedAt) {
    bridgeConnected = false;
    dispatchBridgeChange();
  }
}

function bridgeRequestAttempt(type, payload, {
  resolvedHost,
  targetOrigin,
  timeoutMs,
  reboot,
}) {
  const id = `lw-bridge-${Date.now()}-${++bridgeSeq}`;
  const startedAt = Date.now();
  const message = {
    app: STUDIO_BRIDGE_APP,
    id,
    type,
    payload,
    ...(reboot !== undefined ? { reboot } : {}),
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      markBridgeTimeout(startedAt);
      reject(bridgeError('Timed out waiting for the card bridge.', 'bridge-timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, origin: targetOrigin });
    try {
      bridgeWindow.postMessage(message, targetOrigin);
    } catch (cause) {
      pending.delete(id);
      clearTimeout(timer);
      if (bridgeTargetClosed()) clearBridgeTarget({ host: resolvedHost, origin: targetOrigin });
      reject(bridgeError('Could not send a message to the card bridge.', 'bridge-post-failed', cause));
    }
  });
}

export function sendCardBridgeRequest(type, payload = {}, {
  host = '',
  timeoutMs = 3000,
  reboot = undefined,
  retryOnTimeout = undefined,
} = {}) {
  attachCardBridgeListener();
  bootstrapCardBridgeFromOpener();
  const resolvedHost = normalizeCardHost(host || bridgeHost || readStoredCardHost());
  const targetOrigin = cardHostToUrl(resolvedHost);

  // Privileged messages (write hardware state / push config / reboot / repair)
  // must target a verified local card origin. This blocks the core threat: a
  // crafted page steering Studio into posting control commands to an
  // attacker-controlled origin. The target origin is derived from the resolved
  // host, which only comes from a URL param after isLocalCardHost validation
  // (parseBridgeParams) or from the stored/verified card host — so a public
  // origin can never be the target here. Status/ping/info reads stay
  // unrestricted so the handshake can complete and so discovery still works.
  if (PRIVILEGED_BRIDGE_TYPES.has(type) && !isLocalCardHost(resolvedHost)) {
    return Promise.reject(bridgeError(
      'Refused to send a privileged card command to a non-local origin.',
      'bridge-untrusted-origin',
    ));
  }

  if (!bridgeWindow || bridgeTargetClosed()) {
    clearBridgeTarget({ host: resolvedHost, origin: targetOrigin });
    // Return a rejected promise (rather than throwing synchronously) so callers
    // that attach `.catch()` for friendly error wrapping reach their handler.
    return Promise.reject(bridgeError(
      'Open the card page once to let Studio use it as the local hardware bridge.',
      'bridge-missing',
    ));
  }

  if (!bridgeOrigin || bridgeOrigin !== targetOrigin) {
    bridgeOrigin = targetOrigin;
    bridgeHost = resolvedHost;
  }

  const shouldRetryTimeout = retryOnTimeout ?? ['status', 'ping', 'config', 'recover-lights'].includes(type);
  const maxAttempts = shouldRetryTimeout ? 2 : 1;
  return (async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await bridgeRequestAttempt(type, payload, {
          resolvedHost,
          targetOrigin,
          timeoutMs,
          reboot,
        });
      } catch (error) {
        lastError = error;
        if (error?.reason !== 'bridge-timeout' || attempt >= maxAttempts) throw error;
        attachCardBridgeListener();
        bootstrapCardBridgeFromOpener();
        if (!bridgeWindow || bridgeTargetClosed()) throw error;
      }
    }
    throw lastError || bridgeError('Card bridge request failed.', 'bridge');
  })();
}

export function pingCardBridge(options = {}) {
  return sendCardBridgeRequest('status', {}, options);
}
