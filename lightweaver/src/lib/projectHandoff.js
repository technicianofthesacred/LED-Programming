import { createProjectEnvelope, validateProjectEnvelope } from './projectRepository.js';

export const PROJECT_HANDOFF_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_HANDOFF_LOCAL_URL = 'http://lightweaver.local/studio/';

function base64url(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function unbase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(value || ''))) throw new TypeError('Invalid project handoff secret.');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64url'));
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function tokenHash(tokenBytes, cryptoImpl) {
  return base64url(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', tokenBytes)));
}

function allowedLocalUrl(raw) {
  const url = new URL(raw || DEFAULT_HANDOFF_LOCAL_URL);
  if (url.protocol !== 'http:' || url.pathname !== '/studio/' || !['lightweaver.local', '192.168.4.1'].includes(url.hostname)) {
    throw new TypeError('A bounded local Lightweaver Studio URL is required.');
  }
  url.search = '';
  url.hash = '';
  return url;
}

export async function createEncryptedProjectHandoff(envelope, {
  cryptoImpl = globalThis.crypto,
  localStudioUrl = DEFAULT_HANDOFF_LOCAL_URL,
  now = Date.now(),
  ttlMs = PROJECT_HANDOFF_TTL_MS,
} = {}) {
  const valid = validateProjectEnvelope(envelope);
  if (!cryptoImpl?.getRandomValues || !cryptoImpl?.subtle) throw new TypeError('Web Crypto is required for project handoff.');
  const lookupBytes = cryptoImpl.getRandomValues(new Uint8Array(32));
  const keyBytes = cryptoImpl.getRandomValues(new Uint8Array(32));
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const keyObject = await cryptoImpl.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify(valid));
  const ciphertext = new Uint8Array(await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv }, keyObject, plaintext));
  const lookupToken = base64url(lookupBytes);
  const key = base64url(keyBytes);
  const url = allowedLocalUrl(localStudioUrl);
  url.hash = `handoff=${lookupToken}.${key}`;
  return Object.freeze({
    lookupToken,
    key,
    localUrl: url.href,
    stagingPayload: Object.freeze({
      tokenHash: await tokenHash(lookupBytes, cryptoImpl),
      iv: base64url(iv),
      ciphertext: base64url(ciphertext),
      expiresAt: now + Math.max(1000, Math.min(PROJECT_HANDOFF_TTL_MS, Number(ttlMs) || PROJECT_HANDOFF_TTL_MS)),
    }),
  });
}

export function parseProjectHandoffFragment(fragment = globalThis.location?.hash || '') {
  const match = /^#?handoff=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(fragment));
  if (!match) throw new TypeError('Invalid project handoff fragment.');
  const lookupBytes = unbase64url(match[1]);
  const keyBytes = unbase64url(match[2]);
  if (lookupBytes.byteLength !== 32 || keyBytes.byteLength !== 32) throw new TypeError('Invalid project handoff secret length.');
  return Object.freeze({ lookupToken: match[1], key: match[2] });
}

export async function decryptProjectHandoff(stagingPayload, fragment, {
  cryptoImpl = globalThis.crypto,
  expectedCardId = '',
  claimedCardId = '',
} = {}) {
  const lookupBytes = unbase64url(fragment?.lookupToken);
  const keyBytes = unbase64url(fragment?.key);
  if (await tokenHash(lookupBytes, cryptoImpl) !== stagingPayload?.tokenHash) throw new Error('Project handoff lookup token did not match.');
  if (claimedCardId && expectedCardId && claimedCardId !== expectedCardId) throw new Error('Project handoff belongs to the wrong card.');
  const keyObject = await cryptoImpl.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  let plaintext;
  try {
    plaintext = await cryptoImpl.subtle.decrypt(
      { name: 'AES-GCM', iv: unbase64url(stagingPayload.iv) },
      keyObject,
      unbase64url(stagingPayload.ciphertext),
    );
  } catch (cause) {
    throw new Error('Project handoff could not be decrypted.', { cause });
  }
  const envelope = validateProjectEnvelope(JSON.parse(new TextDecoder().decode(plaintext)));
  const cardId = String(expectedCardId || claimedCardId || '');
  const bound = cardId
    ? createProjectEnvelope(envelope.project, {
        parentHash: envelope.parentHash,
        localRevision: envelope.localRevision,
        modifiedAt: envelope.modifiedAt,
        source: { kind: 'handoff', cardId },
      })
    : envelope;
  return Object.freeze({ envelope: bound, source: bound.source });
}

export function resolveProjectHandoffConflict({ incomingParentHash = null, currentHead = null } = {}) {
  if ((incomingParentHash || null) === (currentHead || null)) return Object.freeze({ conflict: false, choices: [] });
  return Object.freeze({ conflict: true, choices: Object.freeze(['compare', 'keep-both', 'replace']) });
}
