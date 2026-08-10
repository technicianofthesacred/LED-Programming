import {
  canPushDirectlyToCard,
  cardHostToUrl,
  discoverCardStatus,
  normalizeCardHost,
  readStoredCardHost,
} from './cardConnection.js';
import { normalizeCardVisualLook } from './cardVisualLook.js';
import { getCardPatternRuntimeId } from './cardPatternBank.js';
import { DEFAULT_CARD_PATTERN_BANK, normalizeCardOutputSettings } from './cardRuntimeContract.js';
import {
  CardPushError,
  pushConfigToCard,
  readCardStatusEnvelope,
  requestCardReboot,
} from './cardPushClient.js';
import { getCardBridgeState, sendCardBridgeRequest } from './cardBridge.js';
import {
  compareCardIdentity,
  guardDirectCardMutation,
  readPersistedCardIdentity,
} from './cardIdentity.js';
import { reclaimCardFrameStreams } from './cardFrameStream.js';
import { connectCardTransport, getActiveCardTransportAuthority } from './cardTransport.js';
import { discoverCardWiring, getCardWiringStatus, rollbackCardWiringCandidate } from './cardWiringSafety.js';
import { CUSTOMER_CONTROL_WIRE_FIELDS } from './cardCustomerControlContract.js';

function isMixedContentBlocked() {
  return typeof window !== 'undefined' && !canPushDirectlyToCard(window.location.protocol);
}

const COLOR_ORDER_OPTIONS = new Set(['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR']);
const MIRRORED_REPAIR_OUTPUT_PIN = 16;
const MIRRORED_REPAIR_DEFAULT_PIXELS = 44;
const MIRRORED_REPAIR_LOOK_IDS = ['fire', 'ripple', 'warm-white', 'aurora', 'plasma', 'ocean', 'rainbow', 'scanner'];
const MAX_CONTROL_RESPONSE_BYTES = 8192;
const MAX_CARD_PATTERNS = 48;
const MAX_CARD_PATTERN_ZONES = 16;
const CARD_PATTERN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const latestPreviewQueues = new Map();

export const LIVE_CONTROL_AUTHORITY_MESSAGES = Object.freeze({
  disconnected: 'Connect this Lightweaver card before sending live control.',
  'not-ready': 'The card is connected, but its runtime is not ready for live control.',
  'project-mismatch': 'Install this exact Studio project on the card before sending live control.',
  'pattern-not-installed': 'This pattern is not installed in the matching project on the card.',
});

function liveProjectIdentity(project = {}) {
  const config = project?.config || project;
  const startupPatternId = String(config?.startupPatternId || config?.startupLook || project?.startupPatternId || '').trim();
  const startupLook = Array.isArray(config?.looks)
    ? config.looks.find(look => {
        const id = String(look?.id || '').trim();
        const preset = String(look?.preset || '').trim();
        return startupPatternId === id || startupPatternId === preset;
      }) || null
    : null;
  const patternIds = project?.patternIds || [
    ...(Array.isArray(config?.patterns) ? config.patterns.map(pattern => pattern?.id) : []),
    ...(Array.isArray(config?.looks) ? config.looks.flatMap(look => [look?.id, look?.preset]) : []),
  ];
  return {
    projectId: String(config?.projectId || config?.piece?.id || project?.id || '').trim(),
    projectFingerprint: String(config?.projectFingerprint || project?.fingerprint || '').trim().toLowerCase(),
    patternIds: new Set((patternIds || []).map(String).map(id => id.trim()).filter(Boolean)),
    startupPatternId,
    startupLookId: String(startupLook?.id || startupPatternId).trim(),
    startupRuntimePatternId: (() => {
      const configuredRuntimeId = String(startupLook?.preset || startupLook?.patternId || startupPatternId).trim();
      return getCardPatternRuntimeId(configuredRuntimeId) || configuredRuntimeId;
    })(),
    startupLook,
  };
}

export function decideLiveControlProjectAuthority({
  connected = false,
  studioProject = {},
  cardStatus = {},
  patternId = '',
} = {}) {
  if (!connected) return { ok: false, state: 'disconnected', message: LIVE_CONTROL_AUTHORITY_MESSAGES.disconnected };
  const runtimeReady = cardStatus?.playbackReady === true || (
    cardStatus?.runtimePhase === 'ready'
    && cardStatus?.knownGoodProject !== false
    && cardStatus?.outputReady !== false
    && cardStatus?.commandReady === true
  );
  if (!runtimeReady) return { ok: false, state: 'not-ready', message: LIVE_CONTROL_AUTHORITY_MESSAGES['not-ready'] };

  const studio = liveProjectIdentity(studioProject);
  const cardProjectId = String(cardStatus?.projectId || cardStatus?.piece?.id || '').trim();
  const cardFingerprint = String(cardStatus?.projectFingerprint || '').trim().toLowerCase();
  const exactProject = Boolean(studio.projectId && cardProjectId && studio.projectId === cardProjectId)
    && (!studio.projectFingerprint || Boolean(cardFingerprint && studio.projectFingerprint === cardFingerprint));
  if (!exactProject) {
    return { ok: false, state: 'project-mismatch', message: LIVE_CONTROL_AUTHORITY_MESSAGES['project-mismatch'] };
  }
  const requestedPatternId = String(patternId || '').trim();
  if (requestedPatternId && !studio.patternIds.has(requestedPatternId)) {
    return {
      ok: false,
      state: 'project-mismatch',
      reason: 'pattern-not-installed',
      message: LIVE_CONTROL_AUTHORITY_MESSAGES['pattern-not-installed'],
    };
  }
  return { ok: true, state: 'ready', message: '' };
}

export function createLiveControlAuthorityGate(initialInput = {}) {
  let authority = decideLiveControlProjectAuthority(initialInput);
  let contractKey = '';
  let contractInvalidated = false;
  return Object.freeze({
    update(nextInput = {}, transition = {}) {
      authority = decideLiveControlProjectAuthority(nextInput);
      const tracksContract = Object.hasOwn(transition, 'contractKey');
      const nextContractKey = tracksContract ? String(transition.contractKey || '') : contractKey;
      const streamActive = transition.streamActive === true;
      const contractChanged = Boolean(
        tracksContract
        && streamActive
        && contractKey
        && nextContractKey !== contractKey
      );
      if (tracksContract && !streamActive) contractInvalidated = false;
      if (contractChanged) contractInvalidated = true;
      if (tracksContract) contractKey = nextContractKey;
      return {
        ...authority,
        contractChanged,
        requiresStop: streamActive && (!authority.ok || contractInvalidated),
      };
    },
    canSend() {
      return authority.ok && !contractInvalidated;
    },
    decision() {
      return authority;
    },
  });
}

export function requireResetLiveOutputReadback(cardStatus = {}, studioProject = {}) {
  const authority = decideLiveControlProjectAuthority({ connected: true, studioProject, cardStatus });
  if (!authority.ok) throw new CardPushError(authority.state, authority.message);
  const project = liveProjectIdentity(studioProject);
  const currentPatternId = String(cardStatus?.currentPatternId || cardStatus?.currentLookId || '').trim();
  const expectedRuntimePatternId = project.startupRuntimePatternId;
  const reportedStartupPatternId = String(cardStatus?.startupPatternId || '').trim();
  const acceptedStartupClaims = new Set([
    project.startupPatternId,
    project.startupLookId,
    project.startupRuntimePatternId,
    String(project.startupLook?.preset || '').trim(),
  ].filter(Boolean));
  if (
    !currentPatternId
    || !expectedRuntimePatternId
    || currentPatternId !== expectedRuntimePatternId
    || !project.patternIds.has(currentPatternId)
    || (reportedStartupPatternId && !acceptedStartupClaims.has(reportedStartupPatternId))
  ) {
    throw new CardPushError(
      'reset-readback-unconfirmed',
      'The card answered, but did not restore the installed startup look.',
    );
  }
  return cardStatus;
}

function supersededPreviewError() {
  return new CardPushError('superseded', 'Superseded by a newer live preview request.');
}

function previewAckError(reason, message, cause) {
  return new CardPushError(reason, message, cause);
}

function oversizedControlResponseError() {
  return new CardPushError(
    'response-too-large',
    `The card returned more than ${MAX_CONTROL_RESPONSE_BYTES} bytes for a control command.`,
  );
}

function utf8Length(value = '') {
  return new TextEncoder().encode(String(value)).byteLength;
}

async function readBoundedControlResponseText(response) {
  const declaredLength = Number(response?.headers?.get?.('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CONTROL_RESPONSE_BYTES) {
    try {
      await response?.body?.cancel?.();
    } catch {
      // The response is already rejected; cancellation is best-effort only.
    }
    throw oversizedControlResponseError();
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength || 0;
      if (bytes > MAX_CONTROL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw oversizedControlResponseError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  if (typeof response?.text === 'function') {
    const text = await response.text();
    if (utf8Length(text) > MAX_CONTROL_RESPONSE_BYTES) throw oversizedControlResponseError();
    return text;
  }

  // Small unit-test and embedded bridge mocks may expose only json(). Keep
  // them on the same byte contract by serializing before returning the value.
  if (typeof response?.json === 'function') {
    let text;
    try {
      text = JSON.stringify(await response.json());
    } catch (error) {
      throw previewAckError('invalid-acknowledgement', 'The card returned an unreadable control acknowledgement.', error);
    }
    if (utf8Length(text) > MAX_CONTROL_RESPONSE_BYTES) throw oversizedControlResponseError();
    return text;
  }
  return '';
}

function requireBoundedControlObject(response) {
  let encoded;
  try {
    encoded = JSON.stringify(response);
  } catch (error) {
    throw previewAckError('invalid-acknowledgement', 'The card returned an unreadable preview acknowledgement.', error);
  }
  if (utf8Length(encoded) > MAX_CONTROL_RESPONSE_BYTES) throw oversizedControlResponseError();
  return response;
}

function expectedPreviewCardId(options = {}) {
  return String(options.expectedCardId || readPersistedCardIdentity()?.id || '').trim();
}

function acknowledgementRevision(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

export function requireLivePreviewAcknowledgement(response, look = {}, options = {}, verifiedCard = null) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw previewAckError('invalid-acknowledgement', 'The card returned an unreadable preview acknowledgement.');
  }
  if (response.ok !== true) {
    throw previewAckError('preview-unconfirmed', 'The card runtime did not accept the preview command.');
  }

  const expectedId = expectedPreviewCardId(options);
  const actualId = String(response.cardId || response.card?.id || '').trim();
  if (expectedId) {
    const comparison = compareCardIdentity({ id: expectedId }, { id: actualId });
    if (!comparison.ok) {
      throw previewAckError(
        comparison.reason === 'missing-identity' ? 'identity-missing' : comparison.reason,
        comparison.reason === 'wrong-card'
          ? 'A different Lightweaver card answered the preview request.'
          : 'The card did not identify itself in the preview acknowledgement.',
      );
    }
  }

  const requestedPatternId = String(look?.patternId || '').trim();
  const requestedRuntimePatternId = String(options.exactCardPatternId || '').trim()
    || getCardPatternRuntimeId(requestedPatternId) || requestedPatternId;
  const echoedPatternId = String(response.appliedPatternId || '').trim();
  if (requestedRuntimePatternId && echoedPatternId && requestedRuntimePatternId !== echoedPatternId) {
    throw previewAckError('preview-mismatch', 'The card runtime reported a different pattern.');
  }
  const requestedRevision = acknowledgementRevision(options.revision ?? look?.revision);
  const echoedRevision = acknowledgementRevision(response.revision ?? response.confirmedRevision);
  if (requestedRevision !== null && echoedRevision !== null && requestedRevision !== echoedRevision) {
    throw previewAckError('preview-mismatch', 'The card runtime reported a different preview revision.');
  }
  const expectedPatch = options.expectedControlPatch;
  if (expectedPatch && typeof expectedPatch === 'object') {
    // The caller's changed-control patch is the intent being confirmed. Merge
    // it over the look so stale render state cannot make a wrong applied value
    // appear valid during a rapid slider update.
    const payload = buildLivePreviewControlPayload({ ...look, ...expectedPatch }, options);
    for (const key of Object.keys(expectedPatch)) {
      const field = CUSTOMER_CONTROL_WIRE_FIELDS.find(candidate => candidate.control === key);
      const expected = payload[field?.wire];
      const actual = response[field?.acknowledgement];
      const equal = typeof expected === 'number'
        ? Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) < 0.0001
        : actual === expected;
      if (!field || actual === undefined || !equal) {
        throw previewAckError('control-field-unconfirmed', 'The card did not confirm every changed control.');
      }
    }
  }
  const hasConfirmedLook = Boolean(requestedRuntimePatternId && echoedPatternId === requestedRuntimePatternId);
  const hasConfirmedRevision = Boolean(requestedRevision !== null && echoedRevision === requestedRevision);
  const hasRequestedIntent = Boolean(requestedPatternId || requestedRevision !== null);
  const explicitlyLegacy = options.previewAcknowledgementCapability === 'legacy-ok-only';
  if (hasRequestedIntent && !hasConfirmedLook && !hasConfirmedRevision && !explicitlyLegacy) {
    throw previewAckError(
      'runtime-state-unconfirmed',
      'The card answered, but did not report which pattern or revision it applied.',
    );
  }
  return response;
}

function latestPreviewQueueKey(host = '') {
  return normalizeCardHost(host || readStoredCardHost());
}

function enqueueLatestPreview(key, task) {
  let queue = latestPreviewQueues.get(key);
  if (!queue) {
    queue = { running: false, pending: null, generation: 0 };
    latestPreviewQueues.set(key, queue);
  }

  return new Promise((resolve, reject) => {
    const generation = ++queue.generation;
    if (queue.pending) {
      queue.pending.reject(supersededPreviewError());
    }
    queue.pending = {
      task,
      resolve,
      reject,
      arbitration: { isCurrent: () => queue.generation === generation },
    };
    void drainLatestPreviewQueue(key, queue);
  });
}

async function drainLatestPreviewQueue(key, queue) {
  if (queue.running) return;
  while (queue.pending) {
    const request = queue.pending;
    queue.pending = null;
    queue.running = true;
    try {
      request.resolve(await request.task(request.arbitration));
    } catch (error) {
      request.reject(error);
    } finally {
      queue.running = false;
    }
  }
  if (!queue.pending) latestPreviewQueues.delete(key);
}

function requireCurrentPreviewIntent(options = {}) {
  if (options.previewArbitration?.isCurrent?.() === false) throw supersededPreviewError();
}

// Live-preview pushes may fall back from a specific zone to the whole strip
// when the card does not have that zone yet. The resolved response always
// carries `previewZoneFallback` when that happened; callers use this helper so
// the fallback can never pass silently (contract: no silent zone fallback).
export function previewResponseUsedZoneFallback(response) {
  return Boolean(response?.previewZoneFallback);
}

export function buildLiveHardwareControlPayload(settings = {}) {
  const colorOrder = String(settings.colorOrder || '').toUpperCase();
  return {
    ...(COLOR_ORDER_OPTIONS.has(colorOrder) ? { colorOrder } : {}),
  };
}

export function buildLivePreviewControlPayload(look = {}, options = {}) {
  const normalized = normalizeCardVisualLook(look);
  const exactCardPatternId = String(options.exactCardPatternId || '').trim();
  if (exactCardPatternId && (!CARD_PATTERN_ID.test(exactCardPatternId) || exactCardPatternId !== String(look.patternId || '').trim())) {
    throw new CardPushError('invalid-pattern-id', 'The selected card pattern ID is invalid.');
  }
  const runtimePatternId = exactCardPatternId || getCardPatternRuntimeId(normalized.patternId) || normalized.patternId;
  const driftMin = Number(look.driftHueMin);
  const driftMax = Number(look.driftHueMax);
  const values = {
    patternId: runtimePatternId,
    brightness: normalized.brightness,
    speed: normalized.speed,
    hueShift: normalized.hueShift,
    customHue: normalized.customHue,
    customSaturation: normalized.customSaturation,
    customBreathe: normalized.customBreathe,
    breatheLowerPct: normalized.breatheLowerPct,
    breatheUpperPct: normalized.breatheUpperPct,
    breatheCycleSeconds: normalized.breatheCycleSeconds,
    customDrift: normalized.customDrift,
    ...(typeof look.blackout === 'boolean' ? { blackout: look.blackout } : {}),
    ...(Number.isFinite(driftMin) ? { driftHueMin: Math.max(0, Math.min(255, Math.trunc(driftMin))) } : {}),
    ...(Number.isFinite(driftMax) ? { driftHueMax: Math.max(0, Math.min(255, Math.trunc(driftMax))) } : {}),
  };
  const controlPayload = Object.fromEntries(CUSTOMER_CONTROL_WIRE_FIELDS.flatMap(field => (
    values[field.control] === undefined ? [] : [[field.wire, values[field.control]]]
  )));
  return {
    cancelStream: true,
    ...(look.zone ? { zone: String(look.zone) } : {}),
    ...(typeof look.syncZones === 'boolean' ? { syncZones: look.syncZones } : {}),
    ...controlPayload,
  };
}

function buildRecoverLightsPayload(look = {}) {
  const normalized = normalizeCardVisualLook(look);
  const runtimePatternId = getCardPatternRuntimeId(normalized.patternId) || normalized.patternId;
  return {
    patternId: runtimePatternId,
    brightness: normalized.brightness,
    ...(typeof look.syncZones === 'boolean' ? { syncZones: look.syncZones } : {}),
  };
}

function requireRecoveryAcknowledgement(response) {
  const diagnostics = response?.diagnostics;
  const commandAccepted = response?.ok === true && (response?.accepted === true || response?.recovered === true);
  const visibleFramePrepared = diagnostics?.rendered !== false &&
    diagnostics?.frameSubmitted !== false &&
    Number(diagnostics?.nonBlackPixels) > 0 && Number(diagnostics?.brightnessByte) > 0;
  if (!commandAccepted || !visibleFramePrepared) {
    throw new CardPushError(
      'recovery-unconfirmed',
      'The card answered, but it did not confirm a visible recovery frame. Restart the card, then try Recover lights again.',
    );
  }
  return response;
}

export function requireBlackoutAcknowledgement(response) {
  const patternId = String(response?.patternId || response?.confirmedPatternId || '').trim();
  const appliedPatternId = String(response?.appliedPatternId || '').trim();
  const hasStateRevision = Number.isInteger(Number(response?.stateRevision))
    && Number(response.stateRevision) >= 0;
  const affectedOutputCount = Number(response?.affectedOutputCount);
  if (
    response?.ok !== true
    || patternId !== 'blackout'
    || appliedPatternId !== 'blackout'
    || response?.blackout !== true
    || !hasStateRevision
    || !Number.isInteger(affectedOutputCount)
    || affectedOutputCount < 1
  ) {
    throw new CardPushError(
      'blackout-unconfirmed',
      'The card answered, but did not confirm that blackout was applied to an LED output.',
    );
  }
  return response;
}

export function requireBlackoutReadback(status, zonesPayload, acknowledgement = {}) {
  const expectedCardId = String(acknowledgement?.cardId || '').trim();
  const actualCardId = String(status?.cardId || '').trim();
  const zones = Array.isArray(zonesPayload?.zones) ? zonesPayload.zones : [];
  const exactCard = !expectedCardId || compareCardIdentity(
    { id: expectedCardId },
    { id: actualCardId },
  ).ok;
  const patternReadBack = String(status?.currentPatternId || status?.currentLookId || '').trim() === 'blackout';
  const outputIsZero = Number(status?.lwOutput?.brightnessByte) === 0;
  const everyZoneIsBlack = zones.length > 0 && zones.every(zone => (
    String(zone?.patternId || '').trim() === 'blackout' && zone?.blackout === true
  ));
  if (!exactCard || !patternReadBack || !outputIsZero || !everyZoneIsBlack) {
    throw new CardPushError(
      'blackout-readback-unconfirmed',
      'The card accepted blackout, but its fresh state did not confirm zero LED output.',
    );
  }
  return { acknowledgement, status, zones: zonesPayload };
}

function waitForRecoveryRetry(ms, setTimeoutImpl = setTimeout) {
  return new Promise(resolve => setTimeoutImpl(resolve, ms));
}

async function redeliverRecoveryAfterRestart(host, payload, options = {}) {
  const deadline = Date.now() + (options.restartTimeoutMs || 15000);
  await waitForRecoveryRetry(options.restartSettleMs ?? 800, options.setTimeoutImpl);
  let lastError = null;
  do {
    try {
      const response = isMixedContentBlocked()
        ? await sendCardBridgeRequest('recover-lights', payload, {
            host,
            timeoutMs: Math.min(options.timeoutMs || 3000, 1200),
            retryOnTimeout: false,
          })
        : await postRecoverLightsToHost(host, payload, {
            ...options,
            timeoutMs: Math.min(options.timeoutMs || 3000, 1200),
          });
      return requireRecoveryAcknowledgement(response);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await waitForRecoveryRetry(options.restartRetryMs ?? 500, options.setTimeoutImpl);
    }
  } while (Date.now() < deadline);
  throw new CardPushError(
    'recovery-timeout',
    'The card restarted but did not reconnect in time. Wait a moment, then use Recover lights again.',
    lastError,
  );
}

async function finishRecovery(host, payload, response, options = {}) {
  const acknowledged = requireRecoveryAcknowledgement(response);
  if (options.restartCard !== true) return acknowledged;
  if (isMixedContentBlocked()) {
    await sendCardBridgeRequest('reboot', {}, { host, timeoutMs: Math.min(options.timeoutMs || 3000, 1200) });
  } else {
    await requestCardReboot(host, options);
  }
  const restored = await redeliverRecoveryAfterRestart(host, payload, options);
  return { ...restored, restarted: true };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function sumOutputPixels(outputs = []) {
  return Array.isArray(outputs)
    ? outputs.reduce((sum, output) => sum + Math.max(0, Math.floor(Number(output?.pixels ?? output?.pixelCount) || 0)), 0)
    : 0;
}

function defaultRepairPatterns() {
  return DEFAULT_CARD_PATTERN_BANK.map(pattern => ({
    id: pattern.id,
    label: pattern.label,
    mode: pattern.mode || (pattern.id === 'warm-white' ? 'preset' : 'procedural'),
    ...(pattern.preset ? { preset: pattern.preset } : {}),
  }));
}

function defaultRepairLooks() {
  return MIRRORED_REPAIR_LOOK_IDS.map(id => {
    const pattern = DEFAULT_CARD_PATTERN_BANK.find(item => item.id === id) || { id, label: id };
    return {
      id,
      label: pattern.label || id,
      mode: id === 'warm-white' ? 'preset' : 'procedural',
      preset: id,
      brightness: 1,
    };
  });
}

export function buildMirroredLedRepairPackage(runtimePackage = {}, options = {}) {
  const sourcePackage = runtimePackage?.config ? runtimePackage : { config: runtimePackage };
  const sourceConfig = cloneJson(sourcePackage.config || {});
  const outputSettings = normalizeCardOutputSettings(sourceConfig.led);
  const configuredOutputPixels = sumOutputPixels(sourceConfig.led?.outputs || sourceConfig.outputs);
  const pixelCount = Math.max(
    1,
    Math.floor(Number(options.pixels || configuredOutputPixels || sourceConfig.led?.pixels || MIRRORED_REPAIR_DEFAULT_PIXELS) || MIRRORED_REPAIR_DEFAULT_PIXELS),
  );
  const patterns = Array.isArray(sourceConfig.patterns) && sourceConfig.patterns.length
    ? sourceConfig.patterns
    : defaultRepairPatterns();
  const looks = Array.isArray(sourceConfig.looks) && sourceConfig.looks.length
    ? sourceConfig.looks
    : defaultRepairLooks();
  const startupPatternId = sourceConfig.startupPatternId || looks[0]?.id || 'fire';
  const zones = Array.isArray(sourceConfig.zones) && sourceConfig.zones.length
    ? sourceConfig.zones
    : [{
        id: 'full-piece',
        label: 'Full piece',
        patternId: startupPatternId,
        brightness: 1,
        speed: 1,
        hueShift: 0,
        customHue: 32,
        customSaturation: 230,
        ranges: [{ start: 0, count: pixelCount }],
      }];

  return {
    app: sourcePackage.app || 'Lightweaver',
    format: sourcePackage.format || 'lightweaver-card-runtime-package',
    version: sourcePackage.version || 1,
    config: {
      ...sourceConfig,
      version: sourceConfig.version || 1,
      mode: sourceConfig.mode || 'website-flash',
      piece: {
        id: sourceConfig.piece?.id || sourceConfig.projectId || 'lightweaver-repair',
        name: options.projectName || sourceConfig.piece?.name || sourceConfig.projectName || 'Lightweaver repair',
      },
      led: {
        ...(sourceConfig.led || {}),
        ...outputSettings,
        pixels: pixelCount,
        colorOrder: sourceConfig.led?.colorOrder || 'RGB',
        brightnessLimit: Number.isFinite(Number(sourceConfig.led?.brightnessLimit))
          ? Number(sourceConfig.led.brightnessLimit)
          : 0.65,
        outputs: [{
          id: 'out1',
          name: 'Output 1 mirrored',
          pin: MIRRORED_REPAIR_OUTPUT_PIN,
          pixels: pixelCount,
        }],
      },
      controls: sourceConfig.controls || {},
      patterns,
      looks,
      startupPatternId,
      zones,
      syncZones: true,
    },
  };
}

async function postControlPayloadToHost(host, payload, options = {}) {
  const authority = options.authority || getActiveCardTransportAuthority(host);
  if (authority) return authority.request('/api/control', { method: 'POST', body: payload });
  await guardDirectCardMutation(host, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs || 2500 });
  const url = `${cardHostToUrl(host)}/api/control`;
  const body = JSON.stringify(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 2500);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    const text = await readBoundedControlResponseText(response);
    if (!response.ok) {
      throw new CardPushError('http', `card returned ${response.status}: ${text || 'no body'}`);
    }
    if (!text) return { ok: true };
    try {
      return JSON.parse(text);
    } catch (error) {
      throw previewAckError('invalid-acknowledgement', 'The card returned an unreadable control acknowledgement.', error);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function postRecoverLightsToHost(host, payload, options = {}) {
  const authority = options.authority || getActiveCardTransportAuthority(host);
  if (authority) return authority.request('/api/recover-lights', { method: 'POST', body: payload });
  await guardDirectCardMutation(host, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs || 3000 });
  const url = `${cardHostToUrl(host)}/api/recover-lights`;
  const body = JSON.stringify(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 3000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CardPushError('http', `card returned ${response.status}: ${text || 'no body'}`);
    }
    return await response.json().catch(() => ({ ok: true }));
  } finally {
    clearTimeout(timer);
  }
}

async function postIdentifyToHost(host, options = {}) {
  const authority = options.authority || getActiveCardTransportAuthority(host);
  if (authority) return authority.request('/api/identify', { method: 'POST', body: {} });
  await guardDirectCardMutation(host, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs || 1200 });
  const url = `${cardHostToUrl(host)}/api/identify`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 1200);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CardPushError('http', `card returned ${response.status}: ${text || 'no body'}`);
    }
    return await response.json().catch(() => ({ ok: true }));
  } finally {
    clearTimeout(timer);
  }
}

async function readCardZones(host, input = {}) {
  const options = typeof input === 'number' ? { timeoutMs: input } : input;
  const timeoutMs = options.timeoutMs || 1200;
  let authority = options.authority || getActiveCardTransportAuthority(host);
  if (!authority && options.expectedCardId) {
    const acquired = await (options.connectTransportImpl || connectCardTransport)({
      host,
      expectedCardId: options.expectedCardId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (acquired?.connected) authority = acquired;
    else if (acquired?.reason === 'wrong-card') throw new CardPushError('wrong-card', 'A different Lightweaver card answered.');
  }
  if (authority) return requireBoundedControlObject(await authority.request('/api/zones'));
  if (hasVerifiedBridgeForHost(host) || isMixedContentBlocked()) {
    return requireBoundedControlObject(await sendCardBridgeRequest('zones', {}, { host, timeoutMs }));
  }
  if (options.verifyIdentity) {
    await guardDirectCardMutation(host, {
      fetchImpl: options.fetchImpl,
      timeoutMs,
      expected: options.expectedCardId ? { id: options.expectedCardId } : null,
    });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(`${cardHostToUrl(host)}/api/zones`, { signal: ctrl.signal });
    const text = await readBoundedControlResponseText(response);
    if (!response.ok) throw new CardPushError('http', `card returned ${response.status}: ${text || 'no body'}`);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new CardPushError('invalid-zones', 'The card returned an invalid zone list.', error);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function readCardZonesFromCard(options = {}) {
  const host = options.host || readStoredCardHost();
  try {
    return await readCardZones(host, { ...options, verifyIdentity: true });
  } catch (error) {
    throw normalizePreviewError(host, error);
  }
}

function hasVerifiedBridgeForHost(host) {
  const bridge = getCardBridgeState();
  return bridge?.connected === true
    && bridge?.verified === true
    && normalizeCardHost(bridge.host || '') === normalizeCardHost(host || '');
}

function boundedPatternText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text && text.length <= 96 ? text : fallback;
}

function normalizeCardPatternsPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.patterns)
    || payload.patterns.length > MAX_CARD_PATTERNS) {
    throw new CardPushError('invalid-patterns', 'The card returned an invalid pattern list.');
  }
  const seen = new Set();
  const patterns = payload.patterns.map(pattern => {
    const id = boundedPatternText(pattern?.id);
    const label = boundedPatternText(pattern?.label);
    const mode = boundedPatternText(pattern?.mode, 'procedural');
    if (!CARD_PATTERN_ID.test(id) || !label || seen.has(id) || !CARD_PATTERN_ID.test(mode)
      || !Array.isArray(pattern?.zones) || pattern.zones.length > MAX_CARD_PATTERN_ZONES) {
      throw new CardPushError('invalid-patterns', 'The card returned an invalid pattern list.');
    }
    seen.add(id);
    const zones = pattern.zones.map(zone => {
      const zoneId = boundedPatternText(zone?.id);
      const zoneLabel = boundedPatternText(zone?.label);
      const patternId = boundedPatternText(zone?.patternId);
      if (!CARD_PATTERN_ID.test(zoneId) || !zoneLabel || !CARD_PATTERN_ID.test(patternId)) {
        throw new CardPushError('invalid-patterns', 'The card returned an invalid pattern list.');
      }
      return { id: zoneId, label: zoneLabel, patternId };
    });
    const runtimePatternId = boundedPatternText(pattern.runtimePatternId);
    if (pattern.runtimePatternId !== undefined && (!runtimePatternId || !CARD_PATTERN_ID.test(runtimePatternId))) {
      throw new CardPushError('invalid-patterns', 'The card returned an invalid pattern list.');
    }
    const controls = pattern.controls;
    if (controls !== undefined && (!controls || typeof controls !== 'object' || Array.isArray(controls))) {
      throw new CardPushError('invalid-patterns', 'The card returned an invalid pattern list.');
    }
    if (controls && ['customColor', 'breathe', 'drift'].some(key => controls[key] !== undefined && typeof controls[key] !== 'boolean')) {
      throw new CardPushError('invalid-patterns', 'The card returned an invalid pattern list.');
    }
    return {
      id, label, mode, ...(runtimePatternId ? { runtimePatternId } : {}), zones,
      ...(controls ? { controls: {
        customColor: controls.customColor === true,
        breathe: controls.breathe === true,
        drift: controls.drift === true,
      } } : {}),
    };
  });
  const currentId = boundedPatternText(payload.currentId);
  const currentIndex = Number(payload.currentIndex);
  if (!patterns.length || !seen.has(currentId) || !Number.isInteger(currentIndex) || currentIndex < -1 || currentIndex >= patterns.length) {
    throw new CardPushError('invalid-patterns', 'The card returned an invalid pattern list.');
  }
  return { currentId, currentIndex, patterns };
}

async function readCardPatterns(host, options = {}) {
  const timeoutMs = options.timeoutMs || 1200;
  let authority = options.authority || getActiveCardTransportAuthority(host);
  if (!authority && options.expectedCardId) {
    const acquired = await (options.connectTransportImpl || connectCardTransport)({
      host,
      expectedCardId: options.expectedCardId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    if (acquired?.connected) authority = acquired;
    else if (acquired?.reason === 'wrong-card') throw new CardPushError('wrong-card', 'A different Lightweaver card answered.');
  }
  if (authority) return normalizeCardPatternsPayload(requireBoundedControlObject(await authority.request('/api/patterns')));
  if (hasVerifiedBridgeForHost(host)) {
    return normalizeCardPatternsPayload(requireBoundedControlObject(await sendCardBridgeRequest('patterns', {}, { host, timeoutMs })));
  }
  await guardDirectCardMutation(host, {
    fetchImpl: options.fetchImpl,
    timeoutMs,
    expected: options.expectedCardId ? { id: options.expectedCardId } : null,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(`${cardHostToUrl(host)}/api/patterns`, { signal: ctrl.signal });
    const text = await readBoundedControlResponseText(response);
    if (!response.ok) throw new CardPushError('http', `card returned ${response.status}: ${text || 'no body'}`);
    try {
      return normalizeCardPatternsPayload(JSON.parse(text));
    } catch (error) {
      if (error instanceof CardPushError) throw error;
      throw new CardPushError('invalid-patterns', 'The card returned an invalid pattern list.', error);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function readCardPatternsFromCard(options = {}) {
  const host = options.host || readStoredCardHost();
  try {
    return await readCardPatterns(host, options);
  } catch (error) {
    throw normalizePreviewError(host, error);
  }
}

function zoneExists(zonesPayload, zoneId = '') {
  if (!zoneId || !Array.isArray(zonesPayload?.zones)) return false;
  return zonesPayload.zones.some(zone => String(zone?.id || '') === zoneId);
}

function hasCardZones(zonesPayload) {
  return Array.isArray(zonesPayload?.zones) && zonesPayload.zones.length > 0;
}

function liveLookFromZone(zone = {}, fallbackLook = {}) {
  return {
    ...normalizeCardVisualLook({
      ...fallbackLook,
      ...(zone.patternId ? { patternId: zone.patternId } : {}),
      ...(Number.isFinite(Number(zone.brightness)) ? { brightness: Number(zone.brightness) } : {}),
      ...(Number.isFinite(Number(zone.speed)) ? { speed: Number(zone.speed) } : {}),
      ...(Number.isFinite(Number(zone.hueShift)) ? { hueShift: Number(zone.hueShift) } : {}),
      ...(Number.isFinite(Number(zone.customHue)) ? { customHue: Number(zone.customHue) } : {}),
      ...(Number.isFinite(Number(zone.customSaturation)) ? { customSaturation: Number(zone.customSaturation) } : {}),
      ...(typeof zone.customBreathe === 'boolean' ? { customBreathe: zone.customBreathe } : {}),
      ...(Number.isFinite(Number(zone.breatheLowerPct)) ? { breatheLowerPct: Number(zone.breatheLowerPct) } : {}),
      ...(Number.isFinite(Number(zone.breatheUpperPct)) ? { breatheUpperPct: Number(zone.breatheUpperPct) } : {}),
      ...(Number.isFinite(Number(zone.breatheCycleSeconds)) ? { breatheCycleSeconds: Number(zone.breatheCycleSeconds) } : {}),
      ...(typeof zone.customDrift === 'boolean' ? { customDrift: zone.customDrift } : {}),
    }),
    blackout: false,
  };
}

function liveTargetsFromZones(zonesPayload = {}, fallbackLook = {}) {
  return hasCardZones(zonesPayload)
    ? zonesPayload.zones
        .filter(zone => zone?.id)
        .map(zone => ({
          kind: 'section',
          zone: String(zone.id),
          look: liveLookFromZone(zone, fallbackLook),
        }))
    : [];
}

async function pushLivePreviewToHost(host, look, options = {}) {
  const authority = options.authority || getActiveCardTransportAuthority(host);
  if (authority) {
    requireCurrentPreviewIntent(options);
    const previewLook = look;
    const response = requireBoundedControlObject(await authority.request('/api/control', {
      method: 'POST',
      body: {
        ...buildLivePreviewControlPayload(previewLook, options),
        ...(options.revision !== undefined ? { revision: options.revision } : {}),
      },
    }));
    return requireLivePreviewAcknowledgement(response, previewLook, options, { id: authority.cardId });
  }
  // Local-card mode deliberately exercises the same verified postMessage path
  // as public HTTPS, even when Studio itself is running from an HTTP dev host.
  if (options.preferBridge || isMixedContentBlocked()) {
    return pushLivePreviewToBridge(host, look, options);
  }
  const verifiedCard = await guardDirectCardMutation(host, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs || 2500,
    expected: options.expectedCardId ? { id: options.expectedCardId } : null,
  });
  requireCurrentPreviewIntent(options);
  let previewLook = look;
  let previewZoneFallback = null;
  if (options.fallbackMissingZoneToAll && look?.zone) {
    try {
      const zonesPayload = await readCardZones(host, Math.min(options.timeoutMs || 2500, 1200));
      if (hasCardZones(zonesPayload) && !zoneExists(zonesPayload, String(look.zone))) {
        const { zone: requestedZone, ...fallbackLook } = look;
        previewLook = fallbackLook;
        previewZoneFallback = {
          requestedZone: String(requestedZone),
          availableZones: zonesPayload.zones.map(zone => String(zone?.id || '')).filter(Boolean),
        };
      }
    } catch {
      // If the zone probe fails, keep the original targeted request so the
      // normal connection error path can report the real card reachability issue.
    }
    requireCurrentPreviewIntent(options);
  }
  const url = `${cardHostToUrl(host)}/api/control`;
  const body = JSON.stringify({
    ...buildLivePreviewControlPayload(previewLook, options),
    ...(options.revision !== undefined ? { revision: options.revision } : {}),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 2500);
  try {
    requireCurrentPreviewIntent(options);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    const text = await readBoundedControlResponseText(response);
    if (!response.ok) {
      throw new CardPushError('http', `card returned ${response.status}: ${text || 'no body'}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw previewAckError('invalid-acknowledgement', 'The card returned an unreadable preview acknowledgement.', error);
    }
    const acknowledged = requireLivePreviewAcknowledgement(json, previewLook, options, verifiedCard);
    return previewZoneFallback
      ? { ...acknowledged, previewZoneFallback: true, ...previewZoneFallback }
      : acknowledged;
  } finally {
    clearTimeout(timer);
  }
}

async function pushLivePreviewToBridge(host, look, options = {}) {
  let previewLook = look;
  let previewZoneFallback = null;
  if (options.fallbackMissingZoneToAll && look?.zone) {
    try {
      const zonesPayload = await readCardZones(host, Math.min(options.timeoutMs || 2500, 1200));
      if (hasCardZones(zonesPayload) && !zoneExists(zonesPayload, String(look.zone))) {
        const { zone: requestedZone, ...fallbackLook } = look;
        previewLook = fallbackLook;
        previewZoneFallback = {
          requestedZone: String(requestedZone),
          availableZones: zonesPayload.zones.map(zone => String(zone?.id || '')).filter(Boolean),
        };
      }
    } catch {
      // Keep the original request so the bridge error path can report the
      // actual handoff problem if the card page is not open or not updated.
    }
    requireCurrentPreviewIntent(options);
  }
  requireCurrentPreviewIntent(options);
  const json = requireBoundedControlObject(await sendCardBridgeRequest(
    'control',
    {
      ...buildLivePreviewControlPayload(previewLook, options),
      ...(options.revision !== undefined ? { revision: options.revision } : {}),
    },
    { host, timeoutMs: options.timeoutMs || 2500 },
  ));
  const acknowledged = requireLivePreviewAcknowledgement(json, previewLook, options, getCardBridgeState().card);
  return previewZoneFallback
    ? { ...acknowledged, previewZoneFallback: true, ...previewZoneFallback }
    : acknowledged;
}

function normalizedPreviewTargets(targets = []) {
  return Array.isArray(targets)
    ? targets
        .filter(Boolean)
        .map(target => {
          const sourceLook = target.look || target;
          return {
            kind: target.kind || 'section',
            zone: target.kind === 'section' ? String(target.zoneId || target.id || '') : '',
            look: {
              ...normalizeCardVisualLook(sourceLook),
              ...(typeof sourceLook.blackout === 'boolean' ? { blackout: sourceLook.blackout } : {}),
            },
          };
        })
    : [];
}

async function pushSectionPreviewToHost(host, targets = [], options = {}) {
  if (isMixedContentBlocked()) {
    return pushSectionPreviewToBridge(host, targets, options);
  }
  const normalizedTargets = normalizedPreviewTargets(targets);
  const sectionTargets = normalizedTargets.filter(target => target.kind === 'section' && target.zone);
  const allTarget = normalizedTargets.find(target => target.kind === 'all') || normalizedTargets[0];

  if (!sectionTargets.length) {
    requireCurrentPreviewIntent(options);
    return allTarget
      ? pushLivePreviewToHost(host, { ...allTarget.look, syncZones: true }, options)
      : { ok: true, zonesPreviewed: 0 };
  }

  let zonesPayload = null;
  try {
    zonesPayload = await readCardZones(host, Math.min(options.timeoutMs || 2500, 1200));
  } catch {
    zonesPayload = null;
  }

  if (hasCardZones(zonesPayload)) {
    const missingZones = sectionTargets
      .map(target => target.zone)
      .filter(zoneId => !zoneExists(zonesPayload, zoneId));
    if (missingZones.length) {
      requireCurrentPreviewIntent(options);
      const fallback = allTarget || sectionTargets[0];
      const response = await pushLivePreviewToHost(host, { ...fallback.look, syncZones: true }, options);
      return {
        ...response,
        previewZoneFallback: true,
        requestedZones: sectionTargets.map(target => target.zone),
        missingZones,
        availableZones: zonesPayload.zones.map(zone => String(zone?.id || '')).filter(Boolean),
      };
    }
  }

  const results = [];
  for (const target of sectionTargets) {
    requireCurrentPreviewIntent(options);
    results.push(await pushLivePreviewToHost(
      host,
      { ...target.look, zone: target.zone, syncZones: false },
      options,
    ));
  }
  return { ok: true, zonesPreviewed: sectionTargets.length, results };
}

async function pushSectionPreviewToBridge(host, targets = [], options = {}) {
  const normalizedTargets = normalizedPreviewTargets(targets);
  const sectionTargets = normalizedTargets.filter(target => target.kind === 'section' && target.zone);
  const allTarget = normalizedTargets.find(target => target.kind === 'all') || normalizedTargets[0];

  if (!sectionTargets.length) {
    requireCurrentPreviewIntent(options);
    return allTarget
      ? pushLivePreviewToBridge(host, { ...allTarget.look, syncZones: true }, options)
      : { ok: true, zonesPreviewed: 0 };
  }

  let zonesPayload = null;
  try {
    zonesPayload = await readCardZones(host, Math.min(options.timeoutMs || 2500, 1200));
  } catch {
    zonesPayload = null;
  }

  if (hasCardZones(zonesPayload)) {
    const missingZones = sectionTargets
      .map(target => target.zone)
      .filter(zoneId => !zoneExists(zonesPayload, zoneId));
    if (missingZones.length) {
      requireCurrentPreviewIntent(options);
      const fallback = allTarget || sectionTargets[0];
      const response = await pushLivePreviewToBridge(host, { ...fallback.look, syncZones: true }, options);
      return {
        ...response,
        previewZoneFallback: true,
        requestedZones: sectionTargets.map(target => target.zone),
        missingZones,
        availableZones: zonesPayload.zones.map(zone => String(zone?.id || '')).filter(Boolean),
      };
    }
  }

  const results = [];
  for (const target of sectionTargets) {
    requireCurrentPreviewIntent(options);
    results.push(await pushLivePreviewToBridge(
      host,
      { ...target.look, zone: target.zone, syncZones: false },
      options,
    ));
  }
  return { ok: true, zonesPreviewed: sectionTargets.length, results };
}

function normalizePreviewError(host, error) {
  if (error instanceof CardPushError) return error;
  if (['identity-missing', 'wrong-card', 'firmware-too-old', 'stale-host', 'bridge-missing', 'card-rejected', 'runtime-state-unconfirmed', 'physical-output-unconfirmed'].includes(error?.reason)) {
    return new CardPushError(error.reason, error.message, error);
  }
  if (['bridge-timeout', 'timeout', 'card-page-closed'].includes(error?.reason)) {
    return new CardPushError('timeout', 'The card did not answer before the preview request timed out.', error);
  }
  if (isMixedContentBlocked()) {
    return new CardPushError(
      'mixed-content',
      error?.reason === 'bridge-missing' || error?.reason === 'bridge-timeout'
        ? 'Open the card page once by clicking Card disconnected, then return to Studio so it can use the card as a local bridge.'
        : 'Browser blocked the local card connection. Open the Studio from localhost or copy the config to the card page.',
      error,
    );
  }
  if (error?.name === 'AbortError') {
    return new CardPushError('timeout', `Timed out reaching ${cardHostToUrl(host)}`, error);
  }
  return new CardPushError('offline', `Could not reach ${cardHostToUrl(host)}`, error);
}

async function sendLivePreviewToCard(look, options = {}) {
  const host = options.host || readStoredCardHost();
  try {
    return await pushLivePreviewToHost(host, look, options);
  } catch (error) {
    if (error?.reason === 'superseded') throw error;
    if (!isMixedContentBlocked() && options.autoDiscover !== false) {
      requireCurrentPreviewIntent(options);
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 2500, 900),
      });
      requireCurrentPreviewIntent(options);
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          requireCurrentPreviewIntent(options);
          return await pushLivePreviewToHost(found.host, look, options);
        } catch (retryError) {
          throw normalizePreviewError(found.host, retryError);
        }
      }
    }
    throw normalizePreviewError(host, error);
  }
}

export async function pushLivePreviewToCard(look, options = {}) {
  const host = options.host || readStoredCardHost();
  if (options.latestOnly === false) {
    return sendLivePreviewToCard(look, options);
  }
  return enqueueLatestPreview(
    latestPreviewQueueKey(host),
    arbitration => sendLivePreviewToCard(look, { ...options, previewArbitration: arbitration }),
  );
}

export async function pushLiveHardwareToCard(settings, options = {}) {
  const host = options.host || readStoredCardHost();
  const payload = buildLiveHardwareControlPayload(settings);
  const authority = options.authority || getActiveCardTransportAuthority(host);
  if (authority) {
    try { return await authority.request('/api/control', { method: 'POST', body: payload }); }
    catch (error) { throw normalizePreviewError(host, error); }
  }
  if (isMixedContentBlocked()) {
    try {
      return await sendCardBridgeRequest('control', payload, { host, timeoutMs: options.timeoutMs || 2500 });
    } catch (error) {
      throw normalizePreviewError(host, error);
    }
  }
  try {
    return await postControlPayloadToHost(host, payload, options);
  } catch (error) {
    if (!isMixedContentBlocked() && options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 2500, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          return await postControlPayloadToHost(found.host, payload, options);
        } catch (retryError) {
          throw normalizePreviewError(found.host, retryError);
        }
      }
    }
    throw normalizePreviewError(host, error);
  }
}

export async function identifyCardLights(options = {}) {
  const host = options.host || readStoredCardHost();
  try {
    return await postIdentifyToHost(host, options);
  } catch (error) {
    if (!isMixedContentBlocked() && options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 1200, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          return await postIdentifyToHost(found.host, options);
        } catch (retryError) {
          throw normalizePreviewError(found.host, retryError);
        }
      }
    }
    throw normalizePreviewError(host, error);
  }
}

export async function recoverCardLights(look = {}, options = {}) {
  const host = options.host || readStoredCardHost();
  if (!isMixedContentBlocked()) {
    await guardDirectCardMutation(host, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs || 3000 });
  }
  const payload = buildRecoverLightsPayload(look);
  const reclaim = options.reclaimFrameStreams || reclaimCardFrameStreams;
  await reclaim(host, {
    ownershipCoordinator: options.ownershipCoordinator,
    handoffMs: options.reclaimDelayMs ?? 50,
    setTimeoutImpl: options.setTimeoutImpl,
  });
  // A recovery action is also the emergency exit from an unconfirmed wiring
  // trial. Roll it back before asking the LED driver for a visible frame; this
  // prevents recovery from faithfully lighting the same wrong GPIO candidate.
  let safety = null;
  try {
    safety = await getCardWiringStatus({ host, timeoutMs: Math.min(options.timeoutMs || 3000, 1200) });
  } catch {
    // Older firmware has no wiring-safety API. Continue to the dedicated
    // recovery endpoint, which preserves backward-compatible recovery.
  }
  if (safety?.activationId && (safety.state === 'staged' || safety.state === 'testing')) {
    await rollbackCardWiringCandidate(safety.activationId, { host, timeoutMs: options.timeoutMs || 3000 });
    const deadline = Date.now() + (options.restartTimeoutMs || 15000);
    await waitForRecoveryRetry(options.restartSettleMs ?? 800, options.setTimeoutImpl);
    while (Date.now() < deadline) {
      try {
        const restored = await getCardWiringStatus({ host, timeoutMs: 1200 });
        if (restored.state === 'known-good' || restored.state === 'rolled-back') break;
      } catch { /* card may be between reboot and WiFi reconnect */ }
      await waitForRecoveryRetry(options.restartRetryMs ?? 500, options.setTimeoutImpl);
    }
  }
  if (safety?.raw?.discovery?.active) {
    await discoverCardWiring({ stop: true }, { host, timeoutMs: options.timeoutMs || 3000 });
    const deadline = Date.now() + (options.restartTimeoutMs || 15000);
    await waitForRecoveryRetry(options.restartSettleMs ?? 800, options.setTimeoutImpl);
    while (Date.now() < deadline) {
      try {
        const restored = await getCardWiringStatus({ host, timeoutMs: 1200 });
        if (!restored.raw?.discovery?.active) break;
      } catch { /* rebooting */ }
      await waitForRecoveryRetry(options.restartRetryMs ?? 500, options.setTimeoutImpl);
    }
  }
  if (isMixedContentBlocked()) {
    try {
      const response = await sendCardBridgeRequest('recover-lights', payload, { host, timeoutMs: options.timeoutMs || 3000 });
      return await finishRecovery(host, payload, response, options);
    } catch (error) {
      throw normalizePreviewError(host, error);
    }
  }
  try {
    return await finishRecovery(host, payload, await postRecoverLightsToHost(host, payload, options), options);
  } catch (error) {
    if (options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 3000, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          return await finishRecovery(found.host, payload, await postRecoverLightsToHost(found.host, payload, options), options);
        } catch (retryError) {
          throw normalizePreviewError(found.host, retryError);
        }
      }
    }
    throw normalizePreviewError(host, error);
  }
}

export async function stopCardLights(options = {}) {
  const host = options.host || readStoredCardHost();
  const pushImpl = options.pushImpl || pushLivePreviewToCard;
  const readStatusImpl = options.readStatusImpl || readCardStatusEnvelope;
  const readZonesImpl = options.readZonesImpl || readCardZonesFromCard;
  const acknowledgement = requireBlackoutAcknowledgement(await pushImpl(
    {
      patternId: 'blackout',
      brightness: 0,
      blackout: true,
      syncZones: true,
    },
    {
      ...options,
      host,
      latestOnly: false,
    },
  ));

  const attempts = Math.max(1, Math.min(6, Number(options.blackoutReadbackAttempts) || 4));
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const [status, zones] = await Promise.all([
        readStatusImpl({
          host,
          timeoutMs: Math.min(options.timeoutMs || 3200, 1400),
          fetchImpl: options.fetchImpl,
        }),
        readZonesImpl({
          host,
          timeoutMs: Math.min(options.timeoutMs || 3200, 1400),
        }),
      ]);
      return requireBlackoutReadback(status, zones, acknowledgement);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await waitForRecoveryRetry(options.blackoutReadbackDelayMs ?? 60, options.setTimeoutImpl);
      }
    }
  }
  if (lastError instanceof CardPushError) throw lastError;
  throw new CardPushError(
    'blackout-readback-unconfirmed',
    'The card accepted blackout, but its fresh state did not confirm zero LED output.',
    lastError,
  );
}

async function sendSectionPreviewToCard(targets, options = {}) {
  const host = options.host || readStoredCardHost();
  try {
    return await pushSectionPreviewToHost(host, targets, options);
  } catch (error) {
    if (error?.reason === 'superseded') throw error;
    if (!isMixedContentBlocked() && options.autoDiscover !== false) {
      const found = await discoverCardStatus({
        preferredHost: host,
        timeoutMs: Math.min(options.timeoutMs || 2500, 900),
      });
      if (found.connected && normalizeCardHost(found.host) !== normalizeCardHost(host)) {
        try {
          return await pushSectionPreviewToHost(found.host, targets, options);
        } catch (retryError) {
          throw normalizePreviewError(found.host, retryError);
        }
      }
    }
    throw normalizePreviewError(host, error);
  }
}

export async function pushSectionPreviewToCard(targets, options = {}) {
  const host = options.host || readStoredCardHost();
  if (options.latestOnly === false) return sendSectionPreviewToCard(targets, options);
  return enqueueLatestPreview(
    latestPreviewQueueKey(host),
    arbitration => sendSectionPreviewToCard(targets, { ...options, previewArbitration: arbitration }),
  );
}

export async function resetLiveOutputOnCard(fallbackLook = {}, options = {}) {
  const host = options.host || readStoredCardHost();
  try {
    const project = liveProjectIdentity(options.studioProject);
    const recoverImpl = options.recoverImpl || recoverCardLights;
    const readStatusImpl = options.readStatusImpl || readCardStatusEnvelope;
    const startupLook = {
      ...normalizeCardVisualLook(fallbackLook),
      ...(project.startupLook ? normalizeCardVisualLook(project.startupLook) : {}),
      patternId: project.startupRuntimePatternId,
    };
    const response = await recoverImpl(startupLook, { ...options, host });
    if (response?.diagnostics?.rendered === false) {
      throw new CardPushError(
        'recovery-unconfirmed',
        'The card answered, but it did not confirm a visible recovery frame. Restart the card, then try Recover lights again.',
      );
    }
    const acknowledgedPatternId = String(response?.patternId || response?.appliedPatternId || '').trim();
    if (!acknowledgedPatternId || acknowledgedPatternId !== project.startupRuntimePatternId) {
      throw new CardPushError(
        'reset-readback-unconfirmed',
        'The card answered, but did not restore the installed startup look.',
      );
    }
    const status = await readStatusImpl({
      host,
      timeoutMs: Math.min(options.timeoutMs || 3000, 1400),
      transport: options.transport,
      fetchImpl: options.fetchImpl,
    });
    requireResetLiveOutputReadback(status, options.studioProject);
    return {
      ...response,
      source: 'startup-recovery',
      status,
    };
  } catch (error) {
    throw normalizePreviewError(host, error);
  }
}

export async function repairMirroredLedOutputOnCard(runtimePackage = {}, options = {}) {
  const host = options.host || readStoredCardHost();
  const repairPackage = buildMirroredLedRepairPackage(runtimePackage, options);
  const response = await pushConfigToCard(repairPackage, {
    ...options,
    host,
    timeoutMs: options.timeoutMs || 6000,
    reboot: options.reboot || 'if-needed',
    allowLayoutChange: true,
  });
  return {
    ...response,
    repairPackage,
    outputPin: MIRRORED_REPAIR_OUTPUT_PIN,
    pixels: repairPackage.config.led.pixels,
  };
}
