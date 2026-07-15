export const BRIDGE_OPERATIONS = Object.freeze([
  'install-current-release', 'recover-current-release', 'inspect-compatible-card', 'release-usb', 'restart-card',
]);
export const BRIDGE_RESULT_STATUSES = Object.freeze([
  'awaiting-card-acknowledgement', 'recoverable-failure', 'needs-safe-recovery', 'usb-ownership-uncertain',
]);
export const BRIDGE_CALLBACK_ORIGIN = 'https://led.mandalacodes.com';

const REGISTRY_PREFIX = 'lightweaver.bridge.pending.v1.';
const TAB_KEY = 'lightweaver.bridge.origin-tab.v1';
const TTL_MS = 300_000;
const MAX_RECORDS = 16;
const MAX_REGISTRY_BYTES = 8_192;
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

function registryKeys(storage) {
  if (!Number.isSafeInteger(storage.length) || storage.length < 0 || typeof storage.key !== 'function') {
    throw new Error('Pending Bridge registry storage is unavailable');
  }
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (typeof key === 'string' && key.startsWith(REGISTRY_PREFIX)) keys.push(key);
  }
  return keys;
}

function readRegistry(storage) {
  const keys = registryKeys(storage);
  if (keys.length > MAX_RECORDS) throw new Error('Too many pending Bridge operations');
  let totalBytes = 0;
  const records = keys.map(key => {
    const raw = storage.getItem(key);
    totalBytes += key.length + (raw?.length ?? 0);
    if (typeof raw !== 'string') throw new Error('Pending Bridge registry is invalid');
    let record;
    try { record = JSON.parse(raw); } catch { throw new Error('Pending Bridge registry is invalid'); }
    if (!record || Object.keys(record).sort().join(',') !== 'createdAt,expiresAt,nonce,operation,tabId'
      || !BRIDGE_OPERATIONS.includes(record.operation) || !isCanonicalNonce(record.nonce)
      || !/^[A-Za-z0-9_-]{22}$/.test(record.tabId) || !Number.isSafeInteger(record.createdAt)
      || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt
      || record.expiresAt - record.createdAt > TTL_MS || key !== `${REGISTRY_PREFIX}${record.nonce}`) {
      throw new Error('Pending Bridge registry is invalid');
    }
    return record;
  });
  if (totalBytes > MAX_REGISTRY_BYTES || new Set(records.map(record => record.tabId)).size !== records.length) {
    throw new Error('Pending Bridge registry is invalid');
  }
  return records;
}

function removeRecord(storage, nonce) {
  storage.removeItem(`${REGISTRY_PREFIX}${nonce}`);
}

function writeRecord(storage, record) {
  const key = `${REGISTRY_PREFIX}${record.nonce}`;
  const raw = JSON.stringify(record);
  if (key.length + raw.length > MAX_REGISTRY_BYTES) throw new Error('Pending Bridge registry is too large');
  storage.setItem(key, raw);
}

function getTabId(sessionStorage, cryptoApi) {
  const existing = sessionStorage.getItem(TAB_KEY);
  if (existing && /^[A-Za-z0-9_-]{22}$/.test(existing)) return existing;
  if (existing) throw new Error('Originating Bridge tab ID is invalid');
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  const tabId = encodeBase64Url(bytes);
  sessionStorage.setItem(TAB_KEY, tabId);
  return tabId;
}

export function createBridgeLaunch(operation, dependencies = {}) {
  const cryptoApi = dependencies.crypto ?? globalThis.crypto;
  const sessionStorage = dependencies.sessionStorage ?? dependencies.storage ?? globalThis.sessionStorage;
  const localStorage = dependencies.localStorage ?? dependencies.storage ?? globalThis.localStorage;
  const now = dependencies.now ?? Date.now;
  if (!BRIDGE_OPERATIONS.includes(operation)) throw new TypeError('Unsupported Bridge operation');
  if (!cryptoApi?.getRandomValues || !sessionStorage || !localStorage) throw new Error('Secure Bridge launch dependencies are unavailable');
  const timestamp = now();
  const tabId = getTabId(sessionStorage, cryptoApi);
  const allRecords = readRegistry(localStorage);
  const records = allRecords.filter(record => record.expiresAt > timestamp);
  for (const record of allRecords) if (record.expiresAt <= timestamp) removeRecord(localStorage, record.nonce);
  if (records.some(record => record.tabId === tabId)) throw new Error('A Bridge operation is already pending in this tab');
  if (records.length >= MAX_RECORDS) throw new Error('Too many pending Bridge operations');
  const bytes = new Uint8Array(32);
  cryptoApi.getRandomValues(bytes);
  const nonce = encodeBase64Url(bytes);
  const pending = { operation, nonce, tabId, createdAt: timestamp, expiresAt: timestamp + TTL_MS };
  writeRecord(localStorage, pending);
  try { readRegistry(localStorage); } catch (error) {
    removeRecord(localStorage, nonce);
    throw error;
  }
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
  const localStorage = dependencies.localStorage ?? dependencies.storage ?? globalThis.localStorage;
  const now = dependencies.now ?? Date.now;
  const history = dependencies.history ?? globalThis.history;
  try {
    if (currentOrigin !== BRIDGE_CALLBACK_ORIGIN || !localStorage) throw new Error('Bridge callbacks are accepted only in the public Studio');
    const result = parseCallback(value);
    const timestamp = now();
    const records = readRegistry(localStorage);
    const pending = records.find(record => record.nonce === result.nonce);
    if (pending && pending.expiresAt <= timestamp) {
      for (const record of records) if (record.expiresAt <= timestamp) removeRecord(localStorage, record.nonce);
      throw new Error('Pending Bridge operation expired');
    }
    if (!pending) {
      const active = records.filter(record => record.expiresAt > timestamp);
      for (const record of records) if (record.expiresAt <= timestamp) removeRecord(localStorage, record.nonce);
      if (active.length) throw new Error('Bridge callback nonce does not match');
      throw new Error('No pending Bridge operation; callback was already used');
    }
    if (!validateOperationResult(pending.operation, result)) throw new Error('Bridge callback result is incompatible with the pending operation semantics');
    removeRecord(localStorage, result.nonce);
    return Object.freeze({ operation: pending.operation, ...result, physicalProof: false });
  } finally {
    history?.replaceState?.(null, '', '/');
  }
}

export function validateOperationResult(operation, result) {
  if (!BRIDGE_OPERATIONS.includes(operation) || !result || !BRIDGE_RESULT_STATUSES.includes(result.status)) return false;
  if (result.status !== 'awaiting-card-acknowledgement') return true;
  const destructive = operation === 'install-current-release' || operation === 'recover-current-release';
  return destructive
    ? result.verification === 'flash-verified' && result.code !== 'operation-complete'
    : result.verification === 'not-verified' && result.code === 'operation-complete';
}
