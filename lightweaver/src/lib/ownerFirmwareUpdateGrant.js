const BUILD_ID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

function exactText(value, maximum) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function studioOrigin() {
  const origin = globalThis.location?.origin;
  if (!origin || origin === 'null') throw new Error('Studio must have a secure web origin to authorize this update.');
  return origin;
}

export async function requestSoftwareFirmwareUpdateGrant({
  authority,
  release,
  fetchImpl = globalThis.fetch,
  origin = studioOrigin(),
} = {}) {
  const releaseBuildId = exactText(release?.manifest?.buildId, 40).toLowerCase();
  const ticketSha256 = exactText(release?.ticketSha256, 64).toLowerCase();
  if (!authority?.request || authority.revoked || !BUILD_ID.test(releaseBuildId) || !SHA256.test(ticketSha256)) {
    throw new Error('A current exact-card connection and verified firmware release are required.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Studio authorization is unavailable.');

  let challenge;
  try {
    challenge = await requestChallenge(authority, { origin, releaseBuildId, ticketSha256 });
  } catch (cause) {
    // A card-side HTTP refusal already carries the card's own message; only a
    // network-level failure surfaces as a bare TypeError ("Failed to fetch"),
    // which tells the owner nothing they can act on.
    if (cause?.reason || cause?.message !== 'Failed to fetch') throw cause;
    const error = new Error('Studio could not reach this card to request its secure update challenge. Reconnect the exact card, then retry — or use the card button instead.');
    error.cause = cause;
    throw error;
  }
  const grantPayload = typeof challenge?.grantPayload === 'string' ? challenge.grantPayload : '';
  if (!grantPayload || grantPayload.length > 3072) {
    throw new Error('The card did not return an exact software update challenge.');
  }

  let response;
  try {
    response = await fetchImpl('/api/library/firmware-update-grant', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantPayload }),
    });
  } catch (cause) {
    const error = new Error(OWNER_SIGN_IN_GUIDANCE);
    error.reason = 'grant-service-unreachable';
    error.cause = cause;
    throw error;
  }
  if (isOwnerAccessRedirect(response)) {
    const error = new Error(OWNER_SIGN_IN_GUIDANCE);
    error.reason = 'owner-sign-in-required';
    throw error;
  }
  let signed;
  try { signed = await response.json(); } catch { signed = null; }
  if (response.status === 401 || response.status === 403) {
    const error = new Error(signed?.error?.message || OWNER_SIGN_IN_GUIDANCE);
    error.reason = 'owner-sign-in-required';
    throw error;
  }
  if (!response.ok) {
    throw new Error(signed?.error?.message || 'Studio could not authorize this firmware update.');
  }
  if (signed?.grantPayload !== grantPayload
    || signed?.algorithm !== 'ECDSA_P256_SHA256_P1363'
    || !SIGNATURE.test(signed?.signature || '')) {
    throw new Error('Studio returned an invalid software update authorization.');
  }
  return Object.freeze({
    grantPayload,
    grantSignature: signed.signature,
    grantAlgorithm: signed.algorithm,
  });
}

export const OWNER_SIGN_IN_GUIDANCE = 'Secure software authorization needs the owner sign-in for this Studio site, and this browser is not signed in. Open the owner sign-in and retry, or use the card button instead.';

// A Cloudflare Access wall answers /api/library/* with an off-site login
// redirect before the Studio's own code ever runs. Under `redirect: 'manual'`
// that is an opaqueredirect (or a 3xx from a test double); either way it means
// "sign in first", never "the update is broken".
function isOwnerAccessRedirect(response) {
  const status = Number(response?.status || 0);
  return response?.type === 'opaqueredirect' || (status >= 300 && status < 400);
}

function requestChallenge(authority, { origin, releaseBuildId, ticketSha256 }) {
  return authority.request('/api/update/challenge', {
    method: 'POST',
    body: {
      cardId: authority.cardId,
      bootId: authority.bootId,
      ownerSessionId: authority.ownerSessionId,
      operationGeneration: authority.operationGeneration,
      expectedProjectHead: authority.projectHead || '',
      studioOrigin: origin,
      releaseBuildId,
      ticketSha256,
    },
  });
}

// Answers whether this browser could obtain a software update grant right
// now, without spending the card's challenge. `/api/library/session` sits
// behind the same owner protection as the grant route, so its answer is the
// grant route's answer.
export async function probeFirmwareUpdateGrantService({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return { state: 'unavailable', reason: 'no-fetch' };
  try {
    const response = await fetchImpl('/api/library/session', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (isOwnerAccessRedirect(response)) return { state: 'sign-in-required', reason: 'owner-access' };
    if (response.status === 401 || response.status === 403) return { state: 'sign-in-required', reason: 'native-session' };
    if (response.ok || response.status === 204) return { state: 'ready', reason: '' };
    return { state: 'unavailable', reason: `http-${response.status || 0}` };
  } catch {
    return { state: 'unavailable', reason: 'unreachable' };
  }
}
