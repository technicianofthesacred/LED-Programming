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

  const challenge = await authority.request('/api/update/challenge', {
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
  const grantPayload = typeof challenge?.grantPayload === 'string' ? challenge.grantPayload : '';
  if (!grantPayload || grantPayload.length > 3072) {
    throw new Error('The card did not return an exact software update challenge.');
  }

  const response = await fetchImpl('/api/library/firmware-update-grant', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantPayload }),
  });
  let signed;
  try { signed = await response.json(); } catch { signed = null; }
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
