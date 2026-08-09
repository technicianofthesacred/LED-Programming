import { cardHostToUrl, isLocalCardHost, normalizeCardHost } from './cardConnection.js';
import { normalizeCardIdentity, readPersistedCardIdentity } from './cardIdentity.js';
import { classifyCardReadiness } from './cardReadiness.js';
import { getSharedCardLink } from './cardLink.js';

export const CARD_TRANSPORTS = Object.freeze({
  DIRECT: 'direct-lna',
  LOCAL: 'local-origin',
  BRIDGE: 'legacy-bridge',
});

let activeTransportAuthority = null;

export function getActiveCardTransportAuthority(host = '') {
  const authority = activeTransportAuthority;
  if (!authority || authority.revoked) return null;
  const expectedHost = normalizeCardHost(host || authority.host);
  return normalizeCardHost(authority.host) === expectedHost ? authority : null;
}

export function revokeActiveCardTransportAuthority() {
  activeTransportAuthority?.revoke?.();
  activeTransportAuthority = null;
}

function ownerSessionId() {
  try { return globalThis.crypto?.randomUUID?.() || `owner-${Date.now()}-${Math.random()}`; }
  catch { return `owner-${Date.now()}-${Math.random()}`; }
}

export function cardLocalStudioUrl(host = '') {
  const normalized = normalizeCardHost(host);
  if (!isLocalCardHost(normalized)) throw new TypeError('A local Lightweaver card host is required.');
  return `${cardHostToUrl(normalized)}/studio/`;
}

function failure(reason, host, details = {}) {
  return Object.freeze({
    connected: false,
    reason,
    host,
    ...details,
    recovery: Object.freeze({ localStudioUrl: cardLocalStudioUrl(host) }),
  });
}

function authorityError(reason = 'transport-revoked') {
  const error = new Error('Card transport authority was revoked and must be revalidated.');
  error.reason = reason;
  return error;
}

async function parseJsonResponse(response) {
  if (!response?.ok) {
    const error = new Error(`Card returned HTTP ${response?.status || 0}.`);
    error.reason = 'http';
    error.status = Number(response?.status || 0);
    try {
      const details = await response.json();
      error.details = details;
      error.code = details?.reason || details?.code || '';
      if (details?.message) error.message = details.message;
      if (details?.currentHead) error.currentHead = details.currentHead;
    } catch { /* an HTTP status remains sufficient evidence */ }
    throw error;
  }
  return response.json();
}

function exactStatus(status, { expectedCardId = '', host = '' } = {}) {
  const observed = normalizeCardIdentity(status || {}, host);
  const observedCardId = String(observed?.id || status?.cardId || '').trim();
  if (!observedCardId) return { ok: false, reason: 'identity-missing', observedCardId: '' };
  if (expectedCardId && observedCardId !== expectedCardId) return { ok: false, reason: 'wrong-card', observedCardId };
  const classified = classifyCardReadiness(status || {}, {
    expectedCard: expectedCardId ? { id: expectedCardId } : null,
  });
  if (classified.state === 'identity-mismatch') return { ok: false, reason: 'wrong-card', observedCardId };
  if (!classified.bootId) return { ok: false, reason: 'identity-missing', observedCardId };
  return { ok: true, card: observed, bootId: classified.bootId, readiness: status };
}

function sameSnapshot(left, right) {
  return left.host === right.host
    && left.cardId === right.cardId
    && left.bootId === right.bootId
    && left.ownerSessionId === right.ownerSessionId
    && left.operationGeneration === right.operationGeneration;
}

export function createTransportAuthority({
  transport,
  host,
  status,
  card,
  link,
  fetchImpl,
  ownerCapability = '',
}) {
  const normalizedHost = normalizeCardHost(host);
  const session = ownerSessionId();
  const initialState = link?.getState?.() || {};
  const immutableSnapshot = Object.freeze({
    host: normalizedHost,
    cardId: String(card?.id || status?.cardId || ''),
    bootId: String(status?.bootId || initialState.validatedBootId || ''),
    ownerSessionId: session,
    operationGeneration: Number(initialState.operationGeneration || 0),
    projectHead: String(status?.projectHead || ''),
  });
  let revoked = false;
  let capability = String(ownerCapability || '');
  let capabilityExpectedHead = null;
  let capabilityExpiresAt = 0;
  const currentSnapshot = () => {
    const state = link?.getState?.() || initialState;
    return {
      host: normalizeCardHost(state.host || normalizedHost),
      cardId: String(state.card?.id || immutableSnapshot.cardId),
      bootId: String(state.validatedBootId || state.readiness?.bootId || immutableSnapshot.bootId),
      ownerSessionId: session,
      operationGeneration: Number(state.operationGeneration || 0),
    };
  };
  const assertCurrent = () => {
    if (revoked || !sameSnapshot(immutableSnapshot, currentSnapshot())) {
      revoked = true;
      throw authorityError();
    }
  };
  const baseUrl = transport === CARD_TRANSPORTS.LOCAL ? '' : cardHostToUrl(normalizedHost);
  const doFetch = fetchImpl || globalThis.fetch;
  const request = async (path, init = {}) => {
    assertCurrent();
    if (typeof doFetch !== 'function') throw new TypeError('fetch is unavailable');
    const headers = { Accept: 'application/json', ...(init.headers || {}) };
    let body = init.body;
    if (body && typeof body === 'object' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body) && typeof body !== 'string') {
      headers['Content-Type'] ||= 'application/json';
      body = JSON.stringify(body);
    }
    const response = await doFetch(`${baseUrl}${path}`, {
      cache: 'no-store', credentials: 'omit', targetAddressSpace: transport === CARD_TRANSPORTS.DIRECT ? 'local' : undefined,
      ...init, headers, body,
    });
    const result = await parseJsonResponse(response);
    assertCurrent();
    return result;
  };
  const authority = {
    connected: true,
    transport,
    ...immutableSnapshot,
    get ownerCapability() { return capability && Date.now() < capabilityExpiresAt ? capability : ''; },
    get ownerCapabilityExpectedHead() { return capabilityExpectedHead; },
    get revoked() { return revoked; },
    snapshot: () => immutableSnapshot,
    request,
    async stop() {
      if (revoked) return false;
      await request('/api/control', { method: 'POST', body: { cancelStream: true, blackout: true } });
      revoked = true;
      return true;
    },
    async revalidate() {
      assertCurrent();
      const response = await doFetch(`${baseUrl}/api/status`, { method: 'GET', cache: 'no-store', credentials: 'omit', targetAddressSpace: transport === CARD_TRANSPORTS.DIRECT ? 'local' : undefined });
      const nextStatus = await parseJsonResponse(response);
      const exact = exactStatus(nextStatus, { expectedCardId: immutableSnapshot.cardId, host: normalizedHost });
      if (!exact.ok || exact.bootId !== immutableSnapshot.bootId) { revoked = true; throw authorityError('identity-changed'); }
      return nextStatus;
    },
    async issueOwnerCapability({ commissioningProof = '', expectedProjectHead = immutableSnapshot.projectHead } = {}) {
      assertCurrent();
      if (!String(commissioningProof).trim()) throw new Error('Existing commissioning proof or deliberate physical-pairing confirmation is required.');
      const result = await request('/api/owner/capability', {
        method: 'POST',
        body: {
          ...immutableSnapshot,
          expectedProjectHead: expectedProjectHead || '',
          commissioningProof: String(commissioningProof).slice(0, 160),
        },
      });
      if (!result?.capability || result.cardId !== immutableSnapshot.cardId || result.bootId !== immutableSnapshot.bootId) {
        throw new Error('The card did not issue an exact owner capability.');
      }
      capability = String(result.capability);
      capabilityExpectedHead = expectedProjectHead || null;
      capabilityExpiresAt = Date.now() + Math.max(1, Math.min(60000, Number(result.expiresInMs) || 60000));
      return capability;
    },
    advanceOwnerCapabilityHead(nextHead) {
      assertCurrent();
      if (!capability || Date.now() >= capabilityExpiresAt) throw authorityError('owner-capability-expired');
      capabilityExpectedHead = String(nextHead || '') || null;
      return capabilityExpectedHead;
    },
    revoke() { revoked = true; capability = ''; capabilityExpiresAt = 0; return true; },
    watch(listener) {
      if (!link?.subscribe) return () => {};
      return link.subscribe(() => {
        if (revoked) return;
        if (!sameSnapshot(immutableSnapshot, currentSnapshot())) {
          revoked = true;
          listener?.({ type: 'revoked', reason: 'authority-changed' });
        }
      });
    },
  };
  return Object.freeze(authority);
}

export async function connectCardTransport({
  host,
  expectedCardId = readPersistedCardIdentity()?.id || '',
  fetchImpl = globalThis.fetch,
  link = getSharedCardLink(),
  transport = CARD_TRANSPORTS.DIRECT,
  ownerCapability = '',
} = {}) {
  const normalizedHost = normalizeCardHost(host);
  if (!isLocalCardHost(normalizedHost)) throw new TypeError('A valid local Lightweaver card host is required.');
  const baseUrl = transport === CARD_TRANSPORTS.LOCAL ? '' : cardHostToUrl(normalizedHost);
  try {
    const response = await fetchImpl(`${baseUrl}/api/status`, {
      method: 'GET', cache: 'no-store', credentials: 'omit',
      ...(transport === CARD_TRANSPORTS.DIRECT ? { targetAddressSpace: 'local' } : {}),
      headers: { Accept: 'application/json', 'X-Lightweaver-Probe': '1' },
    });
    const status = await parseJsonResponse(response);
    const exact = exactStatus(status, { expectedCardId, host: normalizedHost });
    if (!exact.ok) return failure(exact.reason, normalizedHost, {
      expectedCardId: String(expectedCardId || ''), observedCardId: exact.observedCardId,
    });
    link?.dispatch?.({
      type: 'direct-status', connected: true, host: normalizedHost,
      card: exact.card, expectedCard: expectedCardId ? { id: expectedCardId } : exact.card,
      readiness: status, acknowledgedAt: new Date().toISOString(),
    });
    revokeActiveCardTransportAuthority();
    activeTransportAuthority = createTransportAuthority({ transport, host: normalizedHost, status, card: exact.card, link, fetchImpl, ownerCapability });
    return activeTransportAuthority;
  } catch (cause) {
    if (cause?.reason === 'wrong-card') throw cause;
    return failure('direct-unavailable', normalizedHost, { cause });
  }
}
