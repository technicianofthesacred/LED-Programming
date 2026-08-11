const encoder = new TextEncoder();
const PINNED_UPDATE_GRANT_PUBLIC_KEY_SPKI =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE79R+C1CKiCB9LiaBTnyJAzu85npY+PMDVtnLLfKYk7nB14YtoSehIcyx9ScVPtW9uRQHW9FRZgdhCRAeyd4IWw==';
const KEY_MATCH_PROBE = encoder.encode('Lightweaver update grant key match v1');

export const FIRMWARE_UPDATE_GRANT_ALGORITHM = 'ECDSA_P256_SHA256_P1363';
export const MAX_FIRMWARE_UPDATE_GRANT_PAYLOAD_BYTES = 3072;

const GRANT_KEYS = [
  'bootId',
  'cardHost',
  'cardId',
  'challenge',
  'expectedProjectHead',
  'networkIdentity',
  'operationGeneration',
  'ownerSessionId',
  'releaseBuildId',
  'schemaVersion',
  'scope',
  'studioOrigin',
  'ticketSha256',
].sort();
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;
const BASE64_URL_256 = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REVISION = /^[a-f0-9]{40}$/;

export class FirmwareUpdateGrantValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FirmwareUpdateGrantValidationError';
    this.code = 'invalid_request';
    this.status = 400;
  }
}

export class FirmwareUpdateGrantUnavailableError extends Error {
  constructor() {
    super('Firmware update authorization is unavailable.');
    this.name = 'FirmwareUpdateGrantUnavailableError';
    this.code = 'update_grant_unavailable';
    this.status = 503;
  }
}

function invalid(message) {
  throw new FirmwareUpdateGrantValidationError(`Firmware update grant ${message}.`);
}

function exactKeys(value) {
  const actual = Object.keys(value).sort();
  return actual.length === GRANT_KEYS.length
    && actual.every((key, index) => key === GRANT_KEYS[index]);
}

function boundedIdentifier(value, maximum) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= maximum
    && BOUNDED_IDENTIFIER.test(value);
}

function validCardHost(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255
    || value.includes('/') || value.includes('@') || /\s/.test(value)) return false;
  try {
    const url = new URL(`http://${value}`);
    const port = url.port ? Number(url.port) : 0;
    return url.host === value && (!url.port || (Number.isInteger(port) && port >= 1 && port <= 65535));
  } catch {
    return false;
  }
}

export function validateFirmwareUpdateGrantPayload(grantPayload, { studioOrigin } = {}) {
  if (typeof grantPayload !== 'string') invalid('payload must be a JSON string');
  const bytes = encoder.encode(grantPayload);
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_FIRMWARE_UPDATE_GRANT_PAYLOAD_BYTES) {
    invalid('payload size is invalid');
  }
  let value;
  try {
    value = JSON.parse(grantPayload);
  } catch {
    invalid('payload is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !exactKeys(value)) {
    invalid('payload fields are invalid');
  }
  // Signing the caller's bytes is safe only when those bytes have one
  // unambiguous JSON representation. This rejects whitespace, duplicate keys,
  // alternate escaping, and trailing data without rebuilding the signed bytes.
  if (JSON.stringify(value) !== grantPayload) invalid('payload encoding is not canonical');
  if (value.schemaVersion !== 1) invalid('schema version is unsupported');
  if (value.scope !== 'firmware-update') invalid('scope is unsupported');
  if (!/^lw-[a-f0-9]{12}$/.test(value.cardId)) invalid('card identity is invalid');
  if (!boundedIdentifier(value.bootId, 96)) invalid('boot identity is invalid');
  if (!BASE64_URL_256.test(value.challenge)) invalid('challenge is invalid');
  if (typeof value.studioOrigin !== 'string'
    || (studioOrigin !== undefined && value.studioOrigin !== studioOrigin)) {
    invalid('Studio origin is invalid');
  }
  try {
    const origin = new URL(value.studioOrigin);
    if (origin.origin !== value.studioOrigin || origin.protocol !== 'https:') {
      invalid('Studio origin is invalid');
    }
  } catch (error) {
    if (error instanceof FirmwareUpdateGrantValidationError) throw error;
    invalid('Studio origin is invalid');
  }
  if (!validCardHost(value.cardHost)) invalid('card host is invalid');
  if (typeof value.networkIdentity !== 'string' || value.networkIdentity.length < 1
    || value.networkIdentity.length > 256 || /[^\x20-\x7e]/.test(value.networkIdentity)) {
    invalid('network identity is invalid');
  }
  if (!boundedIdentifier(value.ownerSessionId, 128)) invalid('owner session is invalid');
  if (!Number.isSafeInteger(value.operationGeneration) || value.operationGeneration < 1) {
    invalid('operation generation is invalid');
  }
  if (value.expectedProjectHead !== '' && !SHA256.test(value.expectedProjectHead)) {
    invalid('project head is invalid');
  }
  if (!SOURCE_REVISION.test(value.releaseBuildId)) invalid('release build is invalid');
  if (!SHA256.test(value.ticketSha256)) invalid('ticket digest is invalid');
  return value;
}

function pkcs8Bytes(privateKeyPem) {
  if (typeof privateKeyPem !== 'string') throw new FirmwareUpdateGrantUnavailableError();
  const normalized = privateKeyPem.trim().replaceAll('\r\n', '\n');
  const match = /^-----BEGIN PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END PRIVATE KEY-----$/.exec(normalized);
  if (!match) throw new FirmwareUpdateGrantUnavailableError();
  try {
    const binary = atob(match[1].replaceAll('\n', ''));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (!bytes.byteLength) throw new Error('empty key');
    return bytes;
  } catch {
    throw new FirmwareUpdateGrantUnavailableError();
  }
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64Bytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function createFirmwareUpdateGrantIssuer(env, {
  cryptoProvider = globalThis.crypto,
  verificationPublicKeySpki = base64Bytes(PINNED_UPDATE_GRANT_PUBLIC_KEY_SPKI),
} = {}) {
  let signingKeyPromise;
  async function signingKey() {
    if (!signingKeyPromise) {
      signingKeyPromise = (async () => {
        if (!cryptoProvider?.subtle) throw new FirmwareUpdateGrantUnavailableError();
        try {
          const privateKey = await cryptoProvider.subtle.importKey(
            'pkcs8',
            pkcs8Bytes(env?.LIGHTWEAVER_UPDATE_GRANT_PRIVATE_KEY),
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['sign'],
          );
          const publicKey = await cryptoProvider.subtle.importKey(
            'spki',
            verificationPublicKeySpki,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify'],
          );
          const proof = await cryptoProvider.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' }, privateKey, KEY_MATCH_PROBE,
          );
          if (!await cryptoProvider.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' }, publicKey, proof, KEY_MATCH_PROBE,
          )) throw new FirmwareUpdateGrantUnavailableError();
          return privateKey;
        } catch {
          throw new FirmwareUpdateGrantUnavailableError();
        }
      })();
    }
    return signingKeyPromise;
  }

  return async function issueFirmwareUpdateGrant(grantPayload, { studioOrigin } = {}) {
    validateFirmwareUpdateGrantPayload(grantPayload, { studioOrigin });
    let signature;
    try {
      signature = new Uint8Array(await cryptoProvider.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        await signingKey(),
        encoder.encode(grantPayload),
      ));
    } catch (error) {
      if (error instanceof FirmwareUpdateGrantUnavailableError) throw error;
      throw new FirmwareUpdateGrantUnavailableError();
    }
    if (signature.byteLength !== 64) throw new FirmwareUpdateGrantUnavailableError();
    return {
      grantPayload,
      signature: base64Url(signature),
      algorithm: FIRMWARE_UPDATE_GRANT_ALGORITHM,
    };
  };
}
