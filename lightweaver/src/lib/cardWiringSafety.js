import {
  canPushDirectlyToCard,
  cardHostToUrl,
  normalizeCardHost,
  readStoredCardHost,
} from './cardConnection.js';
import { sendCardBridgeRequest } from './cardBridge.js';
import { guardDirectCardMutation } from './cardIdentity.js';

export const CARD_WIRING_STATES = Object.freeze([
  'known-good',
  'staged',
  'testing',
  'rolled-back',
  'safe-mode',
]);
const CANDIDATE_STATUS_READBACKS = new WeakSet();

const STATE_ALIASES = Object.freeze({
  none: 'known-good',
  armed: 'staged',
  booting: 'testing',
  'awaiting-confirmation': 'testing',
  rollback: 'rolled-back',
  rolled_back: 'rolled-back',
  safe_mode: 'safe-mode',
});

const ENDPOINTS = Object.freeze({
  'wiring-status': { method: 'GET', path: '/api/wiring/status', retryOnTimeout: true },
  'wiring-candidate': { method: 'POST', path: '/api/wiring/candidate', retryOnTimeout: false },
  'wiring-activate': { method: 'POST', path: '/api/wiring/activate', retryOnTimeout: true },
  'wiring-confirm': { method: 'POST', path: '/api/wiring/confirm', retryOnTimeout: true },
  'wiring-rollback': { method: 'POST', path: '/api/wiring/rollback', retryOnTimeout: true },
  'wiring-discover': { method: 'POST', path: '/api/wiring/discover', retryOnTimeout: false },
});

export class CardWiringSafetyError extends Error {
  constructor(reason, message, { cause = null, status = 0, response = null } = {}) {
    super(message);
    this.name = 'CardWiringSafetyError';
    this.reason = reason;
    if (cause instanceof Error) this.cause = cause;
    if (status) this.status = status;
    if (response) this.response = response;
  }
}

function wiringError(reason, message, details = {}) {
  return new CardWiringSafetyError(reason, message, details);
}

function normalizeState(rawState) {
  const value = String(rawState || '').trim().toLowerCase();
  const state = STATE_ALIASES[value] || value;
  if (!CARD_WIRING_STATES.includes(state)) {
    throw wiringError(
      'invalid-response',
      `Card returned an unknown wiring safety state: ${value || '(missing)'}.`,
    );
  }
  return state;
}

export function normalizeCardWiringStatus(response = {}) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw wiringError('invalid-response', 'Card returned an invalid wiring safety response.');
  }
  if (response.ok === false) {
    throw wiringError(
      'card-rejected',
      response.error || response.message || 'Card rejected the wiring safety request.',
      { response },
    );
  }
  const outputs = response.outputs ?? response.currentOutputs ?? [];
  if (!Array.isArray(outputs)) {
    throw wiringError('invalid-response', 'Card wiring status did not contain a valid output list.');
  }
  const remaining = Number(
    response.remainingMs ??
    response.probationRemainingMs ??
    response.remainingProbationMs ??
    0,
  );
  return {
    ok: response.ok !== false,
    state: normalizeState(response.state),
    activationId: String(response.activationId || ''),
    outputs: outputs.map(output => ({ ...output })),
    remainingMs: Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0,
    nextStep: String(response.nextStep || response.action || ''),
    ...(response.cardId || response.id ? { cardId: String(response.cardId || response.id) } : {}),
    ...(response.firmwareVersion ? { firmwareVersion: String(response.firmwareVersion) } : {}),
    ...(response.buildId || response.firmwareBuild || response.build ? { buildId: String(response.buildId || response.firmwareBuild || response.build) } : {}),
    ...(response.projectRevision !== undefined ? { projectRevision: Number(response.projectRevision) } : {}),
    ...(response.projectFingerprint ? { projectFingerprint: String(response.projectFingerprint) } : {}),
    ...(response.productionJobDigest ? { productionJobDigest: String(response.productionJobDigest).toLowerCase() } : {}),
    raw: response,
  };
}

function selectedTransport(options = {}) {
  if (options.transport === 'bridge' || options.transport === 'direct') return options.transport;
  const protocol = typeof window !== 'undefined' ? window.location?.protocol : 'http:';
  return canPushDirectlyToCard(protocol) ? 'direct' : 'bridge';
}

function normalizeTransportError(error, transport) {
  if (error instanceof CardWiringSafetyError) return error;
  if (['identity-missing', 'wrong-card', 'firmware-too-old', 'stale-host'].includes(error?.reason)) {
    return wiringError(error.reason, error.message, { cause: error });
  }
  if (error?.name === 'AbortError') {
    return wiringError('timeout', 'Timed out waiting for the card wiring API.', { cause: error });
  }
  if (transport === 'bridge') {
    return wiringError(error?.reason || 'bridge', error?.message || 'Card bridge request failed.', { cause: error });
  }
  return wiringError('network', error?.message || 'Could not reach the card wiring API.', { cause: error });
}

async function directRequest(endpoint, payload, {
  host,
  timeoutMs,
  fetchImpl,
}) {
  if (endpoint.method !== 'GET') {
    await guardDirectCardMutation(host, { fetchImpl, timeoutMs });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const request = { method: endpoint.method, signal: ctrl.signal, ...(endpoint.method === 'GET' ? { cache: 'no-store' } : {}) };
    if (endpoint.method !== 'GET') {
      request.headers = { 'Content-Type': 'application/json' };
      request.body = JSON.stringify(payload || {});
    }
    const response = await fetchImpl(`${cardHostToUrl(host)}${endpoint.path}`, request);
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) {
      throw wiringError(
        'http',
        body?.error || body?.message || `Card returned HTTP ${response.status || 'error'}.`,
        { status: response.status, response: body },
      );
    }
    if (!body || typeof body !== 'object') {
      throw wiringError('invalid-response', 'Card returned an empty wiring safety response.');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function requestCardWiring(type, payload = {}, options = {}) {
  const endpoint = ENDPOINTS[type];
  if (!endpoint) throw wiringError('invalid-request', `Unknown wiring request type: ${type}.`);
  const transport = selectedTransport(options);
  const host = normalizeCardHost(options.host || readStoredCardHost());
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 3000);
  try {
    if (transport === 'bridge') {
      const bridgeRequestImpl = options.bridgeRequestImpl || sendCardBridgeRequest;
      const response = await bridgeRequestImpl(type, payload, {
        host,
        timeoutMs,
        retryOnTimeout: endpoint.retryOnTimeout,
      });
      if (response?.ok === false) {
        throw wiringError(
          'card-rejected',
          response.error || response.message || 'Card rejected the wiring safety request.',
          { response },
        );
      }
      return response;
    }
    return await directRequest(endpoint, payload, {
      host,
      timeoutMs,
      fetchImpl: options.fetchImpl || globalThis.fetch,
    });
  } catch (error) {
    throw normalizeTransportError(error, transport);
  }
}

function requireActivationId(activationId) {
  const normalized = String(activationId || '').trim();
  if (!normalized) {
    throw wiringError(
      'activation-required',
      'This wiring transaction is missing the activation identifier issued by the card.',
    );
  }
  return normalized;
}

function requireReturnedActivation(status) {
  if (!status.activationId) {
    throw wiringError('invalid-response', 'Card staged wiring without returning an activation identifier.');
  }
  return status;
}

export async function getCardWiringStatus(options = {}) {
  const status = normalizeCardWiringStatus(await requestCardWiring('wiring-status', {}, options));
  CANDIDATE_STATUS_READBACKS.add(status);
  return status;
}

export async function readCardWiringCandidateEvidence(activationId, options = {}) {
  const id = requireActivationId(activationId);
  const status = await getCardWiringStatus(options);
  if (status.state !== 'staged' || status.activationId !== id) throw wiringError('activation-mismatch', 'Card candidate status belongs to a different wiring transaction.', { response: status.raw });
  if (!status.cardId || !status.firmwareVersion || !status.buildId || !Number.isSafeInteger(status.projectRevision) || !status.projectFingerprint) {
    throw wiringError('invalid-response', 'Card candidate status is waiting for exact candidate identity evidence.', { response: status.raw });
  }
  return status;
}

export function isCardWiringCandidateReadback(value) { return CANDIDATE_STATUS_READBACKS.has(value); }

export async function stageCardWiringCandidate(candidate, options = {}) {
  const response = await requestCardWiring('wiring-candidate', { candidate }, options);
  return requireReturnedActivation(normalizeCardWiringStatus(response));
}

async function activationOperation(type, activationId, options) {
  const id = requireActivationId(activationId);
  const status = normalizeCardWiringStatus(await requestCardWiring(type, { activationId: id }, options));
  if (status.activationId !== id) {
    throw wiringError(
      'activation-mismatch',
      'Card answered for a different wiring transaction.',
      { response: status.raw },
    );
  }
  return status;
}

export function activateCardWiringCandidate(activationId, options = {}) {
  return activationOperation('wiring-activate', activationId, options);
}

export function confirmCardWiringCandidate(activationId, options = {}) {
  return activationOperation('wiring-confirm', activationId, options);
}

export function rollbackCardWiringCandidate(activationId, options = {}) {
  return activationOperation('wiring-rollback', activationId, options);
}

export async function discoverCardWiring({ pins, batch, stop } = {}, options = {}) {
  const payload = {};
  if (pins !== undefined) payload.pins = pins;
  if (batch !== undefined) payload.batch = batch;
  if (stop === true) payload.stop = true;
  const response = await requestCardWiring('wiring-discover', payload, options);
  const assignments = response?.assignments;
  if (!Array.isArray(assignments) || assignments.length > 4) {
    throw wiringError(
      'invalid-response',
      'Card discovery must return between zero and four pin assignments.',
      { response },
    );
  }
  return {
    ok: response.ok !== false,
    batch: response.batch,
    assignments: assignments.map(assignment => ({
      pin: Number(assignment.pin),
      color: String(assignment.color || ''),
      label: String(assignment.label || ''),
    })),
    raw: response,
  };
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function waitForCardWiringReconnect(options = {}) {
  const activationId = requireActivationId(options.activationId);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 15000);
  const pollIntervalMs = Math.max(0, Number(options.pollIntervalMs) || 500);
  const nowImpl = options.nowImpl || Date.now;
  const waitImpl = options.waitImpl || wait;
  const statusImpl = options.statusImpl || getCardWiringStatus;
  const deadline = nowImpl() + timeoutMs;
  let lastError = null;

  while (nowImpl() < deadline) {
    try {
      const status = await statusImpl({
        ...options,
        timeoutMs: Math.min(Number(options.requestTimeoutMs) || 1200, Math.max(1, deadline - nowImpl())),
      });
      if (status?.activationId === activationId && status.state !== 'staged') return status;
      if (status?.activationId && status.activationId !== activationId) {
        lastError = wiringError(
          'activation-mismatch',
          'Card reconnected with a different wiring transaction.',
          { response: status.raw },
        );
      }
    } catch (error) {
      lastError = error;
    }
    if (nowImpl() >= deadline) break;
    await waitImpl(Math.min(pollIntervalMs, Math.max(0, deadline - nowImpl())));
  }

  throw wiringError(
    'reconnect-timeout',
    'The card did not reconnect to this wiring transaction in time.',
    { cause: lastError },
  );
}

// Activation deliberately restarts the card. A dropped HTTP/bridge response is
// therefore ambiguous: the safe answer comes from the card-owned transaction
// status after reconnect, not from whether the activation response survived.
export async function activateAndWaitForCardWiring(activationId, options = {}) {
  const id = requireActivationId(activationId);
  const activateImpl = options.activateImpl || activateCardWiringCandidate;
  const waitForReconnectImpl = options.waitForReconnectImpl || waitForCardWiringReconnect;
  let activationError = null;
  try {
    await activateImpl(id, options);
  } catch (error) {
    activationError = error;
  }
  try {
    return await waitForReconnectImpl({ ...options, activationId: id });
  } catch (error) {
    if (activationError instanceof Error && error instanceof Error && !error.cause) {
      error.cause = activationError;
    }
    throw error;
  }
}
