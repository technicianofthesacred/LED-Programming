export const BRIDGE_OPERATIONS = Object.freeze([
  'install-current-release', 'recover-current-release', 'inspect-compatible-card', 'release-usb', 'restart-card',
]);
export const BRIDGE_RESULT_STATUSES = Object.freeze([
  'awaiting-card-acknowledgement', 'recoverable-failure', 'needs-safe-recovery', 'usb-ownership-uncertain',
]);
export const BRIDGE_CALLBACK_ORIGIN = 'https://led.mandalacodes.com';

const STORAGE_KEY = 'lightweaver.bridge.pending.v1';
const TTL_MS = 300_000;
const TARGET = 'lightweaver-controller-esp32s3';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CARD_PATTERN = /^lw-[a-f0-9]{12}$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BUILD_PATTERN = /^[a-f0-9]{40}$/;

function encodeBase64Url(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  const encoded = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function isCanonicalNonce(value) {
  if (typeof value !== 'string' || !NONCE_PATTERN.test(value)) return false;
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '=';
    const binary = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
    return binary.length === 32 && encodeBase64Url(Uint8Array.from(binary, character => character.charCodeAt(0))) === value;
  } catch { return false; }
}

function readPending(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Pending Bridge operation is invalid'); }
  if (!value || Object.keys(value).sort().join(',') !== 'createdAt,expiresAt,nonce,operation'
    || !BRIDGE_OPERATIONS.includes(value.operation) || !isCanonicalNonce(value.nonce)
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > TTL_MS) throw new Error('Pending Bridge operation is invalid');
  return value;
}

export function createBridgeLaunch(operation, dependencies = {}) {
  const cryptoApi = dependencies.crypto ?? globalThis.crypto;
  const storage = dependencies.storage ?? globalThis.sessionStorage;
  const now = dependencies.now ?? Date.now;
  if (!BRIDGE_OPERATIONS.includes(operation)) throw new TypeError('Unsupported Bridge operation');
  if (!cryptoApi?.getRandomValues || !storage) throw new Error('Secure Bridge launch dependencies are unavailable');
  const timestamp = now();
  const existing = readPending(storage);
  if (existing && existing.expiresAt > timestamp) throw new Error('A Bridge operation is already pending');
  if (existing) storage.removeItem(STORAGE_KEY);
  const bytes = new Uint8Array(32);
  cryptoApi.getRandomValues(bytes);
  const nonce = encodeBase64Url(bytes);
  const pending = { operation, nonce, createdAt: timestamp, expiresAt: timestamp + TTL_MS };
  storage.setItem(STORAGE_KEY, JSON.stringify(pending));
  return `lightweaver://run?operation=${operation}&nonce=${nonce}&version=1`;
}

function parseCallback(value) {
  if (typeof value !== 'string' || value.length > 1024) throw new TypeError('Invalid Bridge callback');
  const url = new URL(value);
  if (url.origin !== BRIDGE_CALLBACK_ORIGIN || url.pathname !== '/' || url.search || !url.hash.startsWith('#bridge-result?')) throw new TypeError('Invalid Bridge callback');
  const params = new URLSearchParams(url.hash.slice('#bridge-result?'.length));
  const keys = [...params.keys()];
  if (keys.length !== new Set(keys).size) throw new TypeError('Duplicate Bridge callback fields');
  const result = Object.fromEntries(params);
  const success = result.status === 'awaiting-card-acknowledgement';
  const flashSuccess = success && result.verification === 'flash-verified';
  const maintenanceSuccess = success && result.verification === 'not-verified' && result.code === 'operation-complete';
  const expected = flashSuccess
    ? ['status', 'code', 'cardId', 'firmwareVersion', 'buildId', 'target', 'verification', 'physicalOutput', 'nonce', 'version']
    : maintenanceSuccess && result.cardId !== undefined
      ? ['status', 'code', 'cardId', 'target', 'verification', 'physicalOutput', 'nonce', 'version']
      : ['status', 'code', 'target', 'verification', 'physicalOutput', 'nonce', 'version'];
  if (keys.join(',') !== expected.join(',') || !BRIDGE_RESULT_STATUSES.includes(result.status)
    || !CODE_PATTERN.test(result.code || '') || result.target !== TARGET
    || !['flash-verified', 'not-verified'].includes(result.verification) || result.physicalOutput !== 'unconfirmed'
    || !isCanonicalNonce(result.nonce) || result.version !== '1' || (success && !flashSuccess && !maintenanceSuccess)) throw new TypeError('Invalid Bridge callback result');
  if (flashSuccess && (!CARD_PATTERN.test(result.cardId || '') || !SEMVER_PATTERN.test(result.firmwareVersion || '')
    || !BUILD_PATTERN.test(result.buildId || ''))) throw new TypeError('Invalid Bridge callback identity');
  if (maintenanceSuccess && result.cardId !== undefined && !CARD_PATTERN.test(result.cardId)) throw new TypeError('Invalid Bridge callback identity');
  const canonical = `${BRIDGE_CALLBACK_ORIGIN}/#bridge-result?${new URLSearchParams(expected.map(key => [key, result[key]])).toString()}`;
  if (value !== canonical) throw new TypeError('Bridge callback is not canonical');
  return { ...result, version: 1 };
}

export function consumeBridgeCallback(value, dependencies = {}) {
  const currentOrigin = dependencies.currentOrigin ?? globalThis.location?.origin;
  const storage = dependencies.storage ?? globalThis.sessionStorage;
  const now = dependencies.now ?? Date.now;
  const history = dependencies.history ?? globalThis.history;
  try {
    if (currentOrigin !== BRIDGE_CALLBACK_ORIGIN || !storage) throw new Error('Bridge callbacks are accepted only in the public Studio');
    const result = parseCallback(value);
    const pending = readPending(storage);
    if (!pending) throw new Error('No pending Bridge operation; callback was already used');
    if (result.nonce !== pending.nonce) throw new Error('Bridge callback nonce does not match');
    if (pending.expiresAt <= now()) { storage.removeItem(STORAGE_KEY); throw new Error('Pending Bridge operation expired'); }
    storage.removeItem(STORAGE_KEY);
    return Object.freeze({ operation: pending.operation, ...result, physicalProof: false });
  } finally {
    history?.replaceState?.(null, '', '/');
  }
}
