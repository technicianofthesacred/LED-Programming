import {
  cardHostToUrl,
  isLocalCardHost,
  normalizeCardHost,
  readStoredCardHost,
  writeStoredCardHost,
} from './cardConnection.js';
import {
  adoptExpectedCardIdentity,
  compareCardIdentity,
  normalizeCardIdentity,
  readPersistedCardIdentity,
  requireExpectedCardIdentity,
} from './cardIdentity.js';
import { classifyCardReadiness } from './cardReadiness.js';
import {
  acceptWifiHandoff,
  inspectFinalStationHandoff,
  isFinalStationHandoff,
  normalizeWifiHandoffCorrelation,
} from './cardWifiHandoff.js';

// Message types that command the hardware (write state, push config, reboot,
// repair the LED output, stream live frames). These require a card origin we've
// verified is on the local network before we'll postMessage them — see
// assertPrivilegedTarget.
const PRIVILEGED_BRIDGE_TYPES = new Set([
  'config',
  'control',
  'reboot',
  'recover-lights',
  'frame',
  'wiring-candidate',
  'wiring-activate',
  'wiring-confirm',
  'wiring-rollback',
  'wiring-discover',
  'wifi-handoff-ack',
]);
const IDENTITY_FREE_BRIDGE_TYPES = new Set(['ping', 'status', 'firmware-info']);

// Reads and idempotent transaction operations may safely cross one transient
// bridge timeout. Candidate staging is intentionally absent: retrying it could
// ask the card to mint a second activation identifier for one user action.
const RETRYABLE_BRIDGE_TYPES = new Set([
  'status',
  'ping',
  'config',
  'recover-lights',
  'wiring-status',
  'wiring-activate',
  'wiring-confirm',
  'wiring-rollback',
]);

// Bridge protocol version this Studio speaks, and the version each versioned
// feature first shipped in. Cards report their version in the 'ready'
// handshake (and on every relay reply); firmware older than the versioned
// bridge reports nothing, which we treat as 0 (legacy).
export const CARD_BRIDGE_PROTOCOL_VERSION = 2;
export const CARD_BRIDGE_FEATURE_VERSIONS = { frame: 1, 'wifi-handoff-ack': 2 };

export const CARD_BRIDGE_CHANGED_EVENT = 'lightweaver-card-bridge-changed';
export const STUDIO_BRIDGE_APP = 'LightweaverStudioBridge';
export const CARD_BRIDGE_APP = 'LightweaverCardBridge';
// The one shared auxiliary tab name for card pages. Every Studio-initiated
// card-page open (bridge or plain visit) must target this name so at most one
// card tab ever exists; unnamed '_blank' opens spawn extra tabs that race the
// tracked bridge window.
export const CARD_BRIDGE_WINDOW_NAME = 'lightweaver-card-bridge';
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
let bridgeCard = null;
let bridgeDiscoveredCard = null;
let bridgeIdentityError = '';
let bridgeLastSeenAt = 0;
let bridgeSeq = 0;
let bridgeLifecycle = 0;
// Exact AP evidence retained across the origin switch. It remains present when
// the first station navigation fails, allowing the caller to retry the same
// WindowProxy without accepting a new/stale generation. While this is set,
// identity cannot regain command authority until a fresh station status
// satisfies the complete correlation.
let bridgeHandoffCorrelation = null;
let bridgeHandoffFlowId = '';
let bridgeHandoffAckReady = false;
let bridgeStationIdentityVerified = false;
let bridgeRuntimeCommandReady = false;
let bridgeInitialConfigAvailable = false;
let bridgeInitialConfigAttempted = false;
let listenerAttached = false;
let listenerWindow = null;
const pending = new Map();
const bridgeAcquisitions = new Map();

function browserWindow() {
  return typeof window !== 'undefined' ? window : null;
}

function normalizeCommissioningFlowId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,96}$/.test(value) ? value : '';
}

function handoffExpectedIdentity(correlation = bridgeHandoffCorrelation) {
  return correlation ? {
    id: correlation.expectedCardId,
    firmwareVersion: correlation.expectedFirmwareVersion,
    buildId: correlation.expectedBuildId,
  } : null;
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

function clearBridgeTarget({
  host = bridgeHost,
  origin = bridgeOrigin,
  preserveHandoff = false,
} = {}) {
  bridgeWindow = null;
  bridgeOrigin = origin || '';
  bridgeHost = normalizeCardHost(host || bridgeHost || readStoredCardHost());
  bridgeConnected = false;
  bridgeReady = false;
  bridgeVersion = 0;
  bridgeCard = null;
  bridgeDiscoveredCard = null;
  bridgeIdentityError = '';
  bridgeHandoffAckReady = false;
  bridgeStationIdentityVerified = false;
  bridgeRuntimeCommandReady = false;
  bridgeInitialConfigAvailable = false;
  if (!preserveHandoff) {
    bridgeHandoffCorrelation = null;
    bridgeHandoffFlowId = '';
    bridgeInitialConfigAttempted = false;
  }
  bridgeLifecycle += 1;
  dispatchBridgeChange();
}

function rejectPendingBridgeRequests(reason, message) {
  for (const [id, request] of pending) {
    pending.delete(id);
    clearTimeout(request.timer);
    request.reject(bridgeError(message, reason));
  }
}

// Every navigation of the tracked named window crosses a page lifecycle even
// when WindowProxy, host, and origin stay identical. Revoke the old page before
// invoking window.open or assigning location so no response can arrive in the
// browser's navigation gap with stale command authority.
function revokeBridgeForNavigation({
  host = bridgeHost,
  origin = bridgeOrigin,
  reason = 'bridge-navigated',
  message = 'The tracked card page started a new navigation.',
  preserveHandoff = false,
} = {}) {
  rejectPendingBridgeRequests(reason, message);
  bridgeLifecycle += 1;
  bridgeConnected = false;
  bridgeReady = false;
  bridgeVersion = 0;
  bridgeCard = null;
  bridgeDiscoveredCard = null;
  bridgeIdentityError = '';
  bridgeHandoffAckReady = false;
  bridgeStationIdentityVerified = false;
  bridgeRuntimeCommandReady = false;
  bridgeInitialConfigAvailable = false;
  if (!preserveHandoff) {
    bridgeHandoffCorrelation = null;
    bridgeHandoffFlowId = '';
    bridgeInitialConfigAttempted = false;
  }
  if (host) bridgeHost = normalizeCardHost(host);
  if (origin) bridgeOrigin = origin;
  dispatchBridgeChange();
}

function trackNavigatedBridgeWindow(source, { host, origin, persistHost = true } = {}) {
  if (source) bridgeWindow = source;
  if (origin) bridgeOrigin = origin;
  if (host) {
    bridgeHost = normalizeCardHost(host);
    if (persistHost && !bridgeHandoffCorrelation) writeStoredCardHost(bridgeHost);
  }
  dispatchBridgeChange();
}

function sameHandoffCorrelation(left, right) {
  return Boolean(left && right)
    && left.host === right.host
    && left.expectedCardId === right.expectedCardId
    && left.expectedFirmwareVersion === right.expectedFirmwareVersion
    && left.expectedBuildId === right.expectedBuildId
    && left.expectedBootId === right.expectedBootId
    && left.handoffGeneration === right.handoffGeneration;
}

function applyAuthoritativeBridgeStatus(status, host = bridgeHost) {
  bridgeRuntimeCommandReady = false;
  bridgeInitialConfigAvailable = false;

  if (bridgeHandoffCorrelation) {
    const authority = inspectFinalStationHandoff({
      status,
      correlation: bridgeHandoffCorrelation,
    });
    if (!authority) {
      bridgeStationIdentityVerified = false;
      bridgeCard = null;
      return null;
    }
    try {
      const identity = normalizeCardIdentity(status, host);
      requireExpectedCardIdentity(identity, {
        expected: handoffExpectedIdentity(bridgeHandoffCorrelation),
      });
      bridgeDiscoveredCard = identity;
      bridgeCard = identity;
      bridgeStationIdentityVerified = true;
      bridgeRuntimeCommandReady = authority.runtimeReady;
      bridgeInitialConfigAvailable = Boolean(
        authority.blank
        && bridgeHandoffFlowId
        && !bridgeInitialConfigAttempted
      );
      bridgeIdentityError = bridgeRuntimeCommandReady ? '' : 'runtime-not-ready';
      bridgeHandoffAckReady = false;
      writeStoredCardHost(bridgeHandoffCorrelation.host);
      return authority;
    } catch (error) {
      bridgeStationIdentityVerified = false;
      bridgeCard = null;
      bridgeIdentityError = error?.reason || 'handoff-correlation';
      return null;
    }
  }

  const expected = readPersistedCardIdentity();
  const readiness = classifyCardReadiness(status || {}, { expectedCard: expected });
  if (expected?.id && readiness.state === 'checking') {
    try {
      const identity = normalizeCardIdentity(status, host);
      requireExpectedCardIdentity(identity, { expected });
      bridgeDiscoveredCard = identity;
      bridgeCard = identity;
      bridgeStationIdentityVerified = true;
      bridgeIdentityError = 'runtime-not-ready';
      return Object.freeze({
        verified: true,
        commandReady: false,
        runtimeReady: false,
        blank: false,
        readinessState: 'checking',
      });
    } catch {
      // Incomplete status without the exact identity cannot retain authority.
    }
  }
  if (!expected?.id || ['checking', 'identity-mismatch'].includes(readiness.state)) {
    bridgeStationIdentityVerified = false;
    bridgeCard = null;
    bridgeIdentityError = readiness.reason === 'unexpected-card' ? 'wrong-card' : 'identity-missing';
    return null;
  }
  try {
    const identity = normalizeCardIdentity(status, host);
    requireExpectedCardIdentity(identity, { expected });
    bridgeDiscoveredCard = identity;
    bridgeCard = identity;
    bridgeStationIdentityVerified = true;
    bridgeRuntimeCommandReady = readiness.connected === true;
    bridgeIdentityError = bridgeRuntimeCommandReady ? '' : 'runtime-not-ready';
    return Object.freeze({
      verified: true,
      commandReady: status.commandReady === true,
      runtimeReady: readiness.connected === true,
      blank: readiness.blank === true,
      readinessState: readiness.state,
    });
  } catch (error) {
    bridgeStationIdentityVerified = false;
    bridgeCard = null;
    bridgeIdentityError = error?.reason || 'identity-missing';
    return null;
  }
}

function isAllowedStudioOrigin(origin = '') {
  return origin === 'https://led.mandalacodes.com'
    || origin === 'https://lightweaver-edw.pages.dev'
    || /^https:\/\/[a-z0-9-]+\.lightweaver-edw\.pages\.dev$/.test(origin)
    || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function currentStudioOrigin(candidate = '') {
  const win = browserWindow();
  for (const value of [win?.location?.origin, win?.location?.href, candidate]) {
    try {
      const origin = new URL(String(value || '')).origin;
      if (isAllowedStudioOrigin(origin)) return origin;
    } catch {
      /* try the next bounded source */
    }
  }
  return '';
}

function setBridgeState({
  source = bridgeWindow,
  origin = bridgeOrigin,
  host = bridgeHost,
  connected = bridgeConnected,
  ready = undefined,
} = {}) {
  const normalizedHost = host ? normalizeCardHost(host) : bridgeHost;
  const targetChanged = Boolean(
    (source && bridgeWindow && source !== bridgeWindow) ||
    (normalizedHost && bridgeHost && normalizedHost !== bridgeHost)
  );
  if (targetChanged) {
    bridgeLifecycle += 1;
    bridgeReady = false;
    bridgeCard = null;
    bridgeDiscoveredCard = null;
    bridgeIdentityError = '';
    bridgeVersion = 0;
    bridgeHandoffAckReady = false;
    bridgeStationIdentityVerified = false;
    bridgeRuntimeCommandReady = false;
    bridgeInitialConfigAvailable = false;
  }
  if (source) bridgeWindow = source;
  if (origin) bridgeOrigin = origin;
  if (host) {
    bridgeHost = normalizedHost;
    if (!bridgeHandoffCorrelation || bridgeStationIdentityVerified) writeStoredCardHost(bridgeHost);
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
    if (bridgeWindow && event.source && event.source !== bridgeWindow) return;
    if (bridgeOrigin && event.origin !== bridgeOrigin) return;
    // A card-page reload may retain the exact same WindowProxy and host. Revoke
    // the prior lifecycle synchronously before exposing transport readiness;
    // fresh firmware identity is the only path back to command authority.
    bridgeLifecycle += 1;
    bridgeReady = false;
    bridgeCard = null;
    bridgeDiscoveredCard = null;
    bridgeIdentityError = '';
    bridgeHandoffAckReady = false;
    bridgeStationIdentityVerified = false;
    bridgeRuntimeCommandReady = false;
    bridgeInitialConfigAvailable = false;
    bridgeVersion = Number(data.version) || 0;
    setBridgeState({
      source: event.source,
      origin: event.origin,
      host: claimedHost,
      connected: true,
      ready: true,
    });
    void verifyCardBridgeIdentity(claimedHost).catch(() => {
      // Identity failures are surfaced through bridge state; the ready message
      // handler must never create an unhandled async rejection.
    });
    return;
  }

  const request = pending.get(data.id);
  if (!request) return;
  if (
    request.lifecycle !== bridgeLifecycle ||
    (bridgeOrigin && request.origin !== bridgeOrigin) ||
    normalizeCardHost(request.host) !== normalizeCardHost(bridgeHost)
  ) {
    pending.delete(data.id);
    clearTimeout(request.timer);
    request.reject(bridgeError('Ignored a response from an older card target.', 'stale-host'));
    return;
  }
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

  const responsePayload = data.response ?? data.status ?? { ok: true };
  if (request.type === 'firmware-info') {
    try {
      const identity = normalizeCardIdentity(responsePayload, request.host || bridgeHost);
      if (!identity.id) throw bridgeError('The card firmware did not report a stable identity.', 'identity-missing');
      bridgeDiscoveredCard = identity;
      try {
        requireExpectedCardIdentity(identity, {
          expected: bridgeHandoffCorrelation
            ? handoffExpectedIdentity(bridgeHandoffCorrelation)
            : readPersistedCardIdentity(),
        });
        const sameVerifiedIdentity = bridgeStationIdentityVerified
          && bridgeCard?.id === identity.id
          && bridgeCard?.firmwareVersion === identity.firmwareVersion
          && bridgeCard?.buildId === identity.buildId;
        // A station retarget has stronger requirements than ordinary bridge
        // discovery: firmware-info alone contains no current boot/generation
        // proof. Keep commands locked until verifyCardBridgeIdentity reads the
        // fresh full station status below.
        bridgeCard = bridgeHandoffCorrelation ? null : identity;
        bridgeStationIdentityVerified = bridgeHandoffCorrelation ? false : true;
        // An ordinary identity refresh must not erase a ready status from the
        // same exact card and bridge lifecycle. A new/different identity still
        // starts fail-closed until a complete status arrives.
        bridgeRuntimeCommandReady = bridgeHandoffCorrelation
          ? false
          : (sameVerifiedIdentity && bridgeRuntimeCommandReady);
        bridgeIdentityError = '';
      } catch (error) {
        // Discovery is read-only and must still succeed. Keep commands locked
        // until an explicit first-pair adoption or re-pair verifies this card.
        bridgeCard = null;
        bridgeStationIdentityVerified = false;
        bridgeRuntimeCommandReady = false;
        bridgeIdentityError = error?.reason || 'identity-missing';
      }
    } catch (error) {
      bridgeDiscoveredCard = null;
      bridgeCard = null;
      bridgeStationIdentityVerified = false;
      bridgeRuntimeCommandReady = false;
      bridgeIdentityError = error?.reason || 'identity-missing';
      dispatchBridgeChange();
      request.reject(error);
      return;
    }
  }
  if (request.type === 'status') {
    applyAuthoritativeBridgeStatus(responsePayload, request.host || bridgeHost);
  }
  if (request.type === 'wifi-handoff-ack') bridgeHandoffAckReady = false;

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
  request.resolve(responsePayload);
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

export function buildCardBridgeLaunchUrl(rawHost = '', studioUrl = '') {
  const host = normalizeCardHost(rawHost || readStoredCardHost());
  const url = new URL(`${cardHostToUrl(host)}/`);
  const fragment = new URLSearchParams({ studioBridge: '1' });
  const studioOrigin = currentStudioOrigin(studioUrl);
  if (studioOrigin) fragment.set('studioOrigin', studioOrigin);
  url.hash = fragment.toString();
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
  const bridgeUrl = buildCardBridgeLaunchUrl(host, studioUrl);
  revokeBridgeForNavigation({ host, origin });
  const opened = win.open(bridgeUrl, CARD_BRIDGE_WINDOW_NAME);
  if (opened) {
    trackNavigatedBridgeWindow(opened, { host, origin });
  }
  return opened;
}

// Opens the card's own page (visitor UI, settings, playlist views) in the SAME
// named auxiliary tab that openCardBridge uses, so a plain "open the card page"
// click reuses the one card tab instead of minting a new unnamed tab that races
// the tracked bridge window. Returns { ok: true, window } on success, or
// { ok: false, reason: 'invalid-host' | 'popup-blocked' } so callers can show
// the existing visible popup-blocked copy.
//
// Safety: navigating the shared named tab reloads whatever page it held, so any
// previous bridge handshake is void. This routes through the same
// setBridgeState acquisition path as openCardBridge with ready:false — the
// bridge fails closed (privileged sends stay identity-locked) until the card
// page performs a fresh verified ready/response handshake. `reason` is a
// caller-side diagnostic label only; it never reaches the card URL.
export function openLocalCardPage(rawHost = '', { path = '/', reason = 'open-card-page' } = {}) {
  void reason;
  const win = browserWindow();
  const host = normalizeCardHost(rawHost || readStoredCardHost());
  if (!isLocalCardHost(host)) return { ok: false, reason: 'invalid-host' };
  const origin = cardHostToUrl(host);
  let url;
  try {
    url = new URL(String(path || '/'), `${origin}/`);
  } catch {
    return { ok: false, reason: 'invalid-host' };
  }
  // A crafted path ('//evil.example/') must not steer the named card tab to a
  // non-card origin.
  if (url.origin !== origin) return { ok: false, reason: 'invalid-host' };
  if (!win?.open) return { ok: false, reason: 'popup-blocked' };
  attachCardBridgeListener();
  revokeBridgeForNavigation({ host, origin });
  const opened = win.open(url.href, CARD_BRIDGE_WINDOW_NAME);
  if (!opened) return { ok: false, reason: 'popup-blocked' };
  // Same bookkeeping as openCardBridge: adopt the (possibly reused) named
  // window and drop any prior handshake so identity must re-verify.
  trackNavigatedBridgeWindow(opened, { host, origin });
  try {
    opened.focus?.();
  } catch {
    /* Browser focus permission is best-effort. */
  }
  return { ok: true, window: opened };
}

// Move the already-authorized named card tab from the setup AP to the exact
// station address proven by acceptWifiHandoff. No popup is opened here: the
// stable WindowProxy is the retry surface while the workstation changes WiFi.
export function retargetCardBridge(rawHost = '', rawCorrelation = {}, { flowId: rawFlowId = '' } = {}) {
  const correlation = normalizeWifiHandoffCorrelation(rawCorrelation);
  const flowId = normalizeCommissioningFlowId(rawFlowId);
  const host = normalizeCardHost(rawHost);
  if (!correlation || !flowId || host !== correlation.host) {
    return { ok: false, state: 'invalid-correlation', reason: 'invalid-correlation', retryable: false };
  }
  // A replaced top-level Studio window cannot own a WindowProxy acquired by
  // the prior document. Browsers normally tear the module down too; this guard
  // also makes that lifecycle explicit for embedded/test hosts.
  if (listenerWindow && listenerWindow !== browserWindow()) {
    rejectPendingBridgeRequests('bridge-missing', 'The Studio bridge owner changed.');
    clearBridgeTarget({ host: bridgeHost, origin: bridgeOrigin });
  }
  if (!bridgeWindow) {
    return { ok: false, state: 'missing-window', reason: 'bridge-missing', retryable: true };
  }
  if (bridgeTargetClosed()) {
    clearBridgeTarget({ host: bridgeHost, origin: bridgeOrigin });
    return { ok: false, state: 'closed-window', reason: 'bridge-closed', retryable: true };
  }
  const studioOrigin = currentStudioOrigin();
  if (!studioOrigin) {
    return { ok: false, state: 'invalid-correlation', reason: 'invalid-studio-origin', retryable: false };
  }

  const previous = bridgeHandoffCorrelation;
  const repeated = sameHandoffCorrelation(previous, correlation) && bridgeHandoffFlowId === flowId;
  if (previous && !repeated) {
    const sameCardBoot = previous.expectedCardId === correlation.expectedCardId
      && previous.expectedFirmwareVersion === correlation.expectedFirmwareVersion
      && previous.expectedBuildId === correlation.expectedBuildId
      && previous.expectedBootId === correlation.expectedBootId;
    if (bridgeHandoffFlowId === flowId
      && (!sameCardBoot || correlation.handoffGeneration <= previous.handoffGeneration)) {
      return { ok: false, state: 'stale-correlation', reason: 'stale-correlation', retryable: false };
    }
  }

  const target = bridgeWindow;
  const origin = cardHostToUrl(host);
  if (!repeated) {
    // Settle every AP promise and revoke its lifecycle synchronously before the
    // cross-origin location assignment. A delayed AP response can no longer
    // mutate identity or readiness after this point.
    revokeBridgeForNavigation({
      host,
      origin,
      reason: 'bridge-retargeted',
      message: 'The setup-AP bridge was replaced by the correlated station target.',
    });
    bridgeHandoffCorrelation = correlation;
    bridgeHandoffFlowId = flowId;
    bridgeInitialConfigAttempted = false;
    dispatchBridgeChange();
  }

  const url = new URL(`${origin}/`);
  url.hash = new URLSearchParams({
    studioBridge: '1',
    wifiHandoff: String(correlation.handoffGeneration),
    expectedCardId: correlation.expectedCardId,
    expectedBootId: correlation.expectedBootId,
    studioOrigin,
  }).toString();
  // Once the station page has answered at the correlated origin, another copy
  // of the same AP evidence is a true no-op. Reloading here would create a
  // brief interval where the old page's authority survived a new navigation.
  if (repeated && bridgeReady && bridgeOrigin === origin) {
    return {
      ok: true,
      state: 'already-retargeted',
      retryable: false,
      window: target,
      host,
      url: url.href,
      correlation,
      repeated: true,
    };
  }
  if (repeated) {
    revokeBridgeForNavigation({ host, origin, preserveHandoff: true });
  }
  try {
    target.location.href = url.href;
  } catch (cause) {
    return {
      ok: false,
      state: 'navigation-failed',
      reason: 'bridge-navigation-failed',
      retryable: true,
      window: target,
      host,
      url: url.href,
      correlation,
      repeated,
      error: cause,
    };
  }
  return {
    ok: true,
    state: 'retargeted',
    retryable: false,
    window: target,
    host,
    url: url.href,
    correlation,
    repeated,
  };
}

export function getCardBridgeState() {
  const identityVerified = bridgeStationIdentityVerified;
  return {
    connected: bridgeConnected,
    // True once a handshake (ready event or verified response) confirmed the
    // bridge speaks from the local card origin.
    verified: bridgeReady,
    // Bridge protocol version the card reported (0 = legacy firmware).
    version: bridgeVersion,
    card: bridgeCard,
    discoveredCard: bridgeDiscoveredCard,
    identityError: bridgeIdentityError,
    identityVerified,
    stationIdentityVerified: bridgeStationIdentityVerified,
    runtimeCommandReady: bridgeRuntimeCommandReady,
    initialConfigAuthority: bridgeInitialConfigAvailable,
    // Monotonic target generation. A card-page reload can keep the same
    // WindowProxy, host, and card identity, so consumers need this to revoke
    // readiness evidence from the previous page lifecycle.
    lifecycle: bridgeLifecycle,
    handoffCorrelation: bridgeHandoffCorrelation,
    handoffFlowId: bridgeHandoffFlowId,
    handoffAckReady: bridgeHandoffAckReady,
    host: bridgeHost || readStoredCardHost(),
    origin: bridgeOrigin || cardHostToUrl(bridgeHost || readStoredCardHost()),
    lastSeenAt: bridgeLastSeenAt,
    open: Boolean(bridgeWindow),
  };
}

export function clearCardBridgeHandoff(rawFlowId = '') {
  const flowId = normalizeCommissioningFlowId(rawFlowId);
  if (!flowId || flowId !== bridgeHandoffFlowId) return false;
  bridgeHandoffCorrelation = null;
  bridgeHandoffFlowId = '';
  bridgeHandoffAckReady = false;
  bridgeStationIdentityVerified = false;
  bridgeRuntimeCommandReady = false;
  bridgeInitialConfigAvailable = false;
  bridgeInitialConfigAttempted = false;
  bridgeCard = null;
  bridgeIdentityError = '';
  dispatchBridgeChange();
  return true;
}

function requireDiscoveredBridgeCard(rawHost = bridgeHost) {
  const host = normalizeCardHost(rawHost || bridgeHost || readStoredCardHost());
  if (!bridgeReady || normalizeCardHost(bridgeHost) !== host) {
    throw bridgeError('The discovered card belongs to an older bridge host.', 'stale-host');
  }
  if (!bridgeDiscoveredCard?.id) {
    throw bridgeError('Discover the card identity before pairing it.', 'identity-missing');
  }
  return bridgeDiscoveredCard;
}

async function reverifyDiscoveredBridgeCard(rawHost = bridgeHost) {
  const identity = requireDiscoveredBridgeCard(rawHost);
  const host = normalizeCardHost(rawHost || bridgeHost);
  const lifecycle = bridgeLifecycle;
  const status = await sendCardBridgeRequest('status', { cache: 'no-store', nonce: Date.now() }, {
    host,
    retryOnTimeout: false,
  });
  const readiness = classifyCardReadiness(status || {}, { expectedCard: identity });
  if (readiness.state === 'checking' || readiness.state === 'identity-mismatch') {
    throw bridgeError(
      'Studio could not reverify the full card status before pairing it.',
      readiness.reason === 'unexpected-card' ? 'wrong-card'
        : readiness.reason === 'unexpected-firmware-version' ? 'wrong-firmware-version'
          : readiness.reason === 'unexpected-firmware-build' ? 'wrong-firmware-build'
            : 'identity-missing',
    );
  }
  if (bridgeLifecycle !== lifecycle || normalizeCardHost(bridgeHost) !== host || bridgeDiscoveredCard?.id !== identity.id) {
    throw bridgeError('The card page changed while Studio was pairing it.', 'stale-host');
  }
  return identity;
}

export async function adoptDiscoveredCardBridgeIdentity(rawHost = bridgeHost) {
  const identity = await reverifyDiscoveredBridgeCard(rawHost);
  const expected = readPersistedCardIdentity();
  if (expected?.id) {
    const comparison = compareCardIdentity(expected, identity);
    if (!comparison.ok) {
      throw bridgeError('Use the explicit re-pair action to replace the expected Lightweaver card.', comparison.reason);
    }
  }
  if (!adoptExpectedCardIdentity(identity)) {
    throw bridgeError('Could not save the paired Lightweaver identity.', 'identity-storage');
  }
  bridgeCard = identity;
  bridgeIdentityError = '';
  dispatchBridgeChange();
  return identity;
}

export async function rePairDiscoveredCardBridgeIdentity(rawHost = bridgeHost) {
  const identity = await reverifyDiscoveredBridgeCard(rawHost);
  if (!adoptExpectedCardIdentity(identity)) {
    throw bridgeError('Could not replace the paired Lightweaver identity.', 'identity-storage');
  }
  bridgeCard = identity;
  bridgeIdentityError = '';
  dispatchBridgeChange();
  return identity;
}

export async function verifyCardBridgeIdentity(rawHost = bridgeHost) {
  const expectedHost = normalizeCardHost(rawHost || bridgeHost || readStoredCardHost());
  const expectedWindow = bridgeWindow;
  const expectedLifecycle = bridgeLifecycle;
  const expectedHandoffCorrelation = bridgeHandoffCorrelation;
  try {
    const response = await sendCardBridgeRequest('firmware-info', {}, { host: expectedHost });
    const identity = normalizeCardIdentity(response, expectedHost);
    if (!identity.id) throw bridgeError('The card firmware did not report a stable identity.', 'identity-missing');
    if (bridgeWindow !== expectedWindow || normalizeCardHost(bridgeHost) !== expectedHost || bridgeLifecycle !== expectedLifecycle) {
      throw bridgeError('Ignored identity from an older card connection.', 'stale-host');
    }
    requireExpectedCardIdentity(identity, {
      expected: expectedHandoffCorrelation
        ? handoffExpectedIdentity(expectedHandoffCorrelation)
        : readPersistedCardIdentity(),
    });
    if (expectedHandoffCorrelation) {
      const status = await sendCardBridgeRequest('status', { cache: 'no-store', nonce: Date.now() }, {
        host: expectedHost,
        retryOnTimeout: false,
      });
      if (bridgeHandoffCorrelation !== expectedHandoffCorrelation) {
        throw bridgeError('The active WiFi handoff changed during station verification.', 'handoff-correlation');
      }
      const finalStationVerified = isFinalStationHandoff({
        status,
        correlation: expectedHandoffCorrelation,
      });
      if (!finalStationVerified) {
        const readyCorrelation = acceptWifiHandoff({
          status,
          expectedCard: {
            id: expectedHandoffCorrelation.expectedCardId,
            firmwareVersion: expectedHandoffCorrelation.expectedFirmwareVersion,
            buildId: expectedHandoffCorrelation.expectedBuildId,
          },
          expectedBootId: expectedHandoffCorrelation.expectedBootId,
          lastGeneration: expectedHandoffCorrelation.handoffGeneration - 1,
        });
        if (!sameHandoffCorrelation(readyCorrelation, expectedHandoffCorrelation)) {
          throw bridgeError(
            'The station card page did not match the active WiFi handoff.',
            'handoff-correlation',
          );
        }
        // This exact status is sufficient only for the one acknowledgement.
        // General card commands stay locked until transition:'station' arrives.
        bridgeHandoffAckReady = true;
        bridgeCard = null;
        bridgeIdentityError = 'handoff-awaiting-ack';
        dispatchBridgeChange();
        return identity;
      }
      if (!bridgeStationIdentityVerified || bridgeCard?.id !== identity.id) {
        throw bridgeError('The card status did not verify mutation authority for this lifecycle.', 'identity-missing');
      }
    } else {
      bridgeCard = identity;
      bridgeStationIdentityVerified = true;
    }
    bridgeCard = identity;
    bridgeHandoffAckReady = false;
    bridgeIdentityError = bridgeRuntimeCommandReady ? '' : 'runtime-not-ready';
    dispatchBridgeChange();
    return identity;
  } catch (error) {
    if (bridgeWindow === expectedWindow && normalizeCardHost(bridgeHost) === expectedHost && bridgeLifecycle === expectedLifecycle) {
      bridgeCard = null;
      bridgeHandoffAckReady = false;
      bridgeStationIdentityVerified = false;
      bridgeRuntimeCommandReady = false;
      bridgeInitialConfigAvailable = false;
      bridgeIdentityError = error?.reason || 'identity-missing';
      dispatchBridgeChange();
    }
    throw error;
  }
}

export function getCardBridgeVersion() {
  return bridgeVersion;
}

export function acquireCardBridgeFromGesture(rawHost = '', {
  studioUrl = '',
  timeoutMs = 2500,
} = {}) {
  const win = browserWindow();
  const host = normalizeCardHost(rawHost || readStoredCardHost());
  attachCardBridgeListener();
  bootstrapCardBridgeFromOpener();

  const current = getCardBridgeState();
  if (current.identityVerified && !bridgeTargetClosed() && normalizeCardHost(current.host) === host) {
    return { window: bridgeWindow, ready: Promise.resolve(current) };
  }

  const existing = bridgeAcquisitions.get(host);
  if (existing) return existing;

  let timer = null;
  let settle = null;
  const ready = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const attempt = { window: null, ready };
  bridgeAcquisitions.set(host, attempt);

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    win?.removeEventListener?.(CARD_BRIDGE_CHANGED_EVENT, onBridgeChange);
    if (bridgeAcquisitions.get(host) === attempt) bridgeAcquisitions.delete(host);
  };
  const resolveWhenVerified = (state = getCardBridgeState()) => {
    if (state?.identityError && !state?.identityVerified) {
      cleanup();
      settle.reject(bridgeError('The card page did not verify the paired Lightweaver identity.', state.identityError));
      return true;
    }
    if (!state?.identityVerified || normalizeCardHost(state.host) !== host) return false;
    cleanup();
    try {
      win?.focus?.();
    } catch {
      /* Browser focus permission is best-effort. */
    }
    settle.resolve(state);
    return true;
  };
  function onBridgeChange(event) {
    resolveWhenVerified(event?.detail || getCardBridgeState());
  }

  win?.addEventListener?.(CARD_BRIDGE_CHANGED_EVENT, onBridgeChange);

  // Keep this before any asynchronous boundary: popup permission is attached
  // to the user's pattern-click gesture, and the stable name reuses one tab.
  const opened = openCardBridge(host, { autoOpenStudio: false, studioUrl });
  attempt.window = opened;
  if (!opened) {
    cleanup();
    settle.reject(bridgeError(
      'Allow the Lightweaver card window, then try the pattern again.',
      'popup-blocked',
    ));
    return attempt;
  }

  if (resolveWhenVerified()) return attempt;
  timer = setTimeout(() => {
    cleanup();
    settle.reject(bridgeError(
      'The card page opened but did not answer. Check that this device is on the card\'s Wi-Fi.',
      'bridge-timeout',
    ));
  }, Math.max(0, Number(timeoutMs) || 0));

  return attempt;
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
    clearBridgeTarget({ preserveHandoff: Boolean(bridgeHandoffCorrelation) });
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
    pending.set(id, {
      resolve, reject, timer, origin: targetOrigin, type, host: resolvedHost,
      lifecycle: bridgeLifecycle,
    });
    try {
      bridgeWindow.postMessage(message, targetOrigin);
    } catch (cause) {
      pending.delete(id);
      clearTimeout(timer);
      if (bridgeTargetClosed()) clearBridgeTarget({
        host: resolvedHost,
        origin: targetOrigin,
        preserveHandoff: Boolean(bridgeHandoffCorrelation),
      });
      reject(bridgeError('Could not send a message to the card bridge.', 'bridge-post-failed', cause));
    }
  });
}

export function sendCardBridgeRequest(type, payload = {}, {
  host = '',
  timeoutMs = 3000,
  reboot = undefined,
  retryOnTimeout = undefined,
  commissioningFlowId: rawCommissioningFlowId = '',
} = {}) {
  attachCardBridgeListener();
  bootstrapCardBridgeFromOpener();
  const resolvedHost = normalizeCardHost(host || bridgeHost || readStoredCardHost());
  const targetOrigin = cardHostToUrl(resolvedHost);
  const commissioningFlowId = normalizeCommissioningFlowId(rawCommissioningFlowId);
  let consumeInitialConfigAuthority = false;

  if (PRIVILEGED_BRIDGE_TYPES.has(type) && !isLocalCardHost(resolvedHost)) {
    return Promise.reject(bridgeError(
      'Refused to send a privileged card command to a non-local origin.',
      'bridge-untrusted-origin',
    ));
  }

  if (type === 'wifi-handoff-ack') {
    if (
      !bridgeReady
      || !bridgeHandoffAckReady
      || !bridgeHandoffCorrelation
      || normalizeCardHost(bridgeHost) !== resolvedHost
      || bridgeVersion < CARD_BRIDGE_FEATURE_VERSIONS['wifi-handoff-ack']
    ) {
      return Promise.reject(bridgeError(
        'The station card page has not verified the active WiFi handoff.',
        'handoff-correlation',
      ));
    }
  } else if (!IDENTITY_FREE_BRIDGE_TYPES.has(type)) {
    try {
      if (!bridgeReady || !bridgeStationIdentityVerified || !bridgeCard?.id) {
        throw bridgeError(
          'The card bridge transport is open, but card identity is not verified.',
          bridgeIdentityError || 'identity-missing',
        );
      }
      requireExpectedCardIdentity(bridgeCard, {
        expected: bridgeHandoffCorrelation
          ? handoffExpectedIdentity(bridgeHandoffCorrelation)
          : readPersistedCardIdentity(),
      });
      if (normalizeCardHost(bridgeHost) !== resolvedHost) {
        throw bridgeError('The verified card belongs to an older bridge host.', 'stale-host');
      }
      if (PRIVILEGED_BRIDGE_TYPES.has(type) && !bridgeRuntimeCommandReady) {
        const exactInitialConfig = type === 'config'
          && bridgeInitialConfigAvailable
          && !bridgeInitialConfigAttempted
          && commissioningFlowId
          && commissioningFlowId === bridgeHandoffFlowId
          && Boolean(bridgeHandoffCorrelation);
        if (!exactInitialConfig) {
          throw bridgeError(
            'The verified card is not runtime-ready for this mutation.',
            'runtime-not-ready',
          );
        }
        consumeInitialConfigAuthority = true;
      }
    } catch (error) {
      return Promise.reject(error?.reason ? error : bridgeError(error?.message || 'Card identity verification failed.', 'identity-missing', error));
    }
  }

  // Privileged messages (write hardware state / push config / reboot / repair)
  // must target a verified local card origin. This blocks the core threat: a
  // crafted page steering Studio into posting control commands to an
  // attacker-controlled origin. The target origin is derived from the resolved
  // host, which only comes from a URL param after isLocalCardHost validation
  // (parseBridgeParams) or from the stored/verified card host — so a public
  // origin can never be the target here. Status/ping/info reads stay
  // unrestricted so the handshake can complete and so discovery still works.
  if (!bridgeWindow || bridgeTargetClosed()) {
    clearBridgeTarget({
      host: resolvedHost,
      origin: targetOrigin,
      preserveHandoff: Boolean(bridgeHandoffCorrelation),
    });
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

  if (consumeInitialConfigAuthority) {
    bridgeInitialConfigAttempted = true;
    bridgeInitialConfigAvailable = false;
    dispatchBridgeChange();
  }

  const shouldRetryTimeout = consumeInitialConfigAuthority
    ? false
    : (retryOnTimeout ?? RETRYABLE_BRIDGE_TYPES.has(type));
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
