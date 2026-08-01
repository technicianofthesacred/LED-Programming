export const PRODUCTION_PBKDF2_ITERATIONS = 600_000;
export const SESSION_COOKIE_NAME = '__Host-lightweaver_session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const PASSWORD_SCHEME = 'pbkdf2-sha256';
const PASSWORD_VERSION = 'v1';
const MINIMUM_PASSWORD_LENGTH = 12;
const MAXIMUM_PASSWORD_LENGTH = 256;

function cryptoApi(candidate) {
  const value = candidate || globalThis.crypto;
  if (!value?.subtle || typeof value.getRandomValues !== 'function') {
    throw new Error('Web Crypto is required.');
  }
  return value;
}

function randomBytes(length, cryptoProvider) {
  const bytes = new Uint8Array(length);
  cryptoProvider.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/')
      + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function validatePassword(password) {
  const length = typeof password === 'string' ? [...password].length : -1;
  if (length < MINIMUM_PASSWORD_LENGTH) {
    throw new TypeError('Password must be at least 12 characters.');
  }
  if (length > MAXIMUM_PASSWORD_LENGTH) {
    throw new TypeError('Password must be at most 256 characters.');
  }
  return password;
}

function validateIterations(iterations) {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new TypeError('PBKDF2 iterations must be a positive integer.');
  }
  return iterations;
}

async function derivePassword(password, salt, iterations, cryptoProvider) {
  const material = await cryptoProvider.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await cryptoProvider.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations,
  }, material, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password, options = {}) {
  validatePassword(password);
  const iterations = validateIterations(
    options.iterations ?? PRODUCTION_PBKDF2_ITERATIONS,
  );
  const webCrypto = cryptoApi(options.crypto);
  const salt = randomBytes(16, webCrypto);
  const digest = await derivePassword(password, salt, iterations, webCrypto);
  return [
    PASSWORD_SCHEME,
    PASSWORD_VERSION,
    iterations,
    bytesToBase64Url(salt),
    bytesToBase64Url(digest),
  ].join('$');
}

export function createPasswordVerificationPlaceholder(options = {}) {
  const iterations = validateIterations(
    options.iterations ?? PRODUCTION_PBKDF2_ITERATIONS,
  );
  return [
    PASSWORD_SCHEME,
    PASSWORD_VERSION,
    iterations,
    bytesToBase64Url(new Uint8Array(16)),
    bytesToBase64Url(new Uint8Array(32)),
  ].join('$');
}

export async function verifyPassword(password, encoded, options = {}) {
  if (typeof password !== 'string'
    || [...password].length > MAXIMUM_PASSWORD_LENGTH
    || typeof encoded !== 'string') return false;
  const [scheme, version, rawIterations, rawSalt, rawDigest, ...rest] = encoded.split('$');
  const iterations = Number(rawIterations);
  const salt = base64UrlToBytes(rawSalt);
  const expected = base64UrlToBytes(rawDigest);
  if (rest.length
    || scheme !== PASSWORD_SCHEME
    || version !== PASSWORD_VERSION
    || !Number.isSafeInteger(iterations)
    || iterations < 1
    || salt?.byteLength !== 16
    || expected?.byteLength !== 32) {
    return false;
  }

  try {
    const webCrypto = cryptoApi(options.crypto);
    const actual = await derivePassword(password, salt, iterations, webCrypto);
    let difference = 0;
    for (let index = 0; index < expected.byteLength; index += 1) {
      difference |= expected[index] ^ actual[index];
    }
    return difference === 0;
  } catch {
    return false;
  }
}

export async function hashSessionToken(token, options = {}) {
  if (typeof token !== 'string' || !token) throw new TypeError('A session token is required.');
  const webCrypto = cryptoApi(options.crypto);
  const digest = await webCrypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

export async function createSessionCredential(options = {}) {
  const webCrypto = cryptoApi(options.crypto);
  const token = bytesToBase64Url(randomBytes(32, webCrypto));
  return {
    token,
    digest: await hashSessionToken(token, { crypto: webCrypto }),
  };
}

export function serializeSessionCookie(token, options = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new TypeError('A valid session token is required.');
  }
  const maxAge = options.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS;
  if (!Number.isSafeInteger(maxAge) || maxAge < 1) {
    throw new TypeError('Session cookie Max-Age must be a positive integer.');
  }
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export function serializeSessionCookieRemoval() {
  return `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function readSessionCookie(source) {
  const raw = typeof source === 'string'
    ? source
    : source instanceof Headers
      ? source.get('cookie')
      : source?.headers?.get?.('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === SESSION_COOKIE_NAME && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return null;
}
