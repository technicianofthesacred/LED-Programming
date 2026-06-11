import {
  cardHostToUrl,
  normalizeCardHost,
  readStoredCardHost,
  writeStoredCardHost,
} from './cardConnection.js';

export const CARD_BRIDGE_CHANGED_EVENT = 'lightweaver-card-bridge-changed';
export const STUDIO_BRIDGE_APP = 'LightweaverStudioBridge';
export const CARD_BRIDGE_APP = 'LightweaverCardBridge';
export const LOCAL_CHIP_DEFAULT_KEY = 'lw_local_chip_default';

let bridgeWindow = null;
let bridgeOrigin = '';
let bridgeHost = '';
let bridgeConnected = false;
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
  dispatchBridgeChange();
}

function setBridgeState({
  source = bridgeWindow,
  origin = bridgeOrigin,
  host = bridgeHost,
  connected = bridgeConnected,
} = {}) {
  if (source) bridgeWindow = source;
  if (origin) bridgeOrigin = origin;
  if (host) {
    bridgeHost = normalizeCardHost(host);
    writeStoredCardHost(bridgeHost);
  }
  bridgeConnected = Boolean(connected);
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
  return {
    enabled: params.get('cardBridge') === '1' || params.get('bridge') === 'card',
    host: params.get('cardHost') || params.get('host') || '',
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
    setBridgeState({
      source: event.source,
      origin: event.origin,
      host: data.host || hostFromOrigin(event.origin),
      connected: true,
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

  setBridgeState({
    source: event.source,
    origin: event.origin,
    host: data.host || bridgeHost || hostFromOrigin(event.origin),
    connected: true,
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
    host: bridgeHost || readStoredCardHost(),
    origin: bridgeOrigin || cardHostToUrl(bridgeHost || readStoredCardHost()),
    lastSeenAt: bridgeLastSeenAt,
    open: Boolean(bridgeWindow),
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
