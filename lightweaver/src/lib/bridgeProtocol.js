export const BRIDGE_OPERATIONS = Object.freeze([
  'install-current-release', 'recover-current-release', 'inspect-compatible-card', 'release-usb', 'restart-card',
]);
export const BRIDGE_RESULT_STATUSES = Object.freeze([
  'awaiting-card-acknowledgement', 'recoverable-failure', 'needs-safe-recovery', 'usb-ownership-uncertain',
]);
export const BRIDGE_CALLBACK_ORIGIN = 'https://led.mandalacodes.com';

const REGISTRY_PREFIX = 'lightweaver.bridge.pending.v1.';
const TAB_KEY = 'lightweaver.bridge.origin-tab.v1';
const CLAIM_PREFIX = 'lightweaver.bridge.callback-claim.v1.';
const TTL_MS = 300_000;
const CLAIM_TTL_MS = 2_000;
const CLAIM_SETTLE_MS = 25;
const MAX_RECORDS = 16;
const MAX_REGISTRY_BYTES = 8_192;
const MAX_CLAIMS = 16;
const MAX_CLAIM_BYTES = 4_096;
const TARGET = 'lightweaver-controller-esp32s3';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RETURN_CODE_PATTERN = /^LW1-([A-Za-z0-9_-]{1,900})$/;
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

function validateRegistryRecords(records, totalBytes) {
  for (const record of records) {
    const expectedKeys = record?.receipt === undefined
      ? 'createdAt,expiresAt,nonce,operation,tabId'
      : 'createdAt,expiresAt,nonce,operation,receipt,tabId';
    if (!record || Object.keys(record).sort().join(',') !== expectedKeys
      || !BRIDGE_OPERATIONS.includes(record.operation) || !isCanonicalNonce(record.nonce)
      || (record.receipt !== undefined && !isCanonicalNonce(record.receipt))
      || !/^[A-Za-z0-9_-]{22}$/.test(record.tabId) || !Number.isSafeInteger(record.createdAt)
      || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt
      || record.expiresAt - record.createdAt > TTL_MS) {
      throw new Error('Pending Bridge registry is invalid');
    }
  }
  const size = totalBytes ?? records.reduce((sum, record) => {
    const key = `${REGISTRY_PREFIX}${record.nonce}`;
    return sum + key.length + JSON.stringify(record).length;
  }, 0);
  const receipts = records.filter(record => record.receipt !== undefined).map(record => record.receipt);
  if (records.length > MAX_RECORDS || size > MAX_REGISTRY_BYTES
    || new Set(records.map(record => record.tabId)).size !== records.length
    || new Set(receipts).size !== receipts.length) {
    throw new Error('Pending Bridge registry is invalid');
  }
  return records;
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
    if (!record || key !== `${REGISTRY_PREFIX}${record.nonce}`) {
      throw new Error('Pending Bridge registry is invalid');
    }
    return record;
  });
  return validateRegistryRecords(records, totalBytes);
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

function replaceRecord(storage, records, pending, replacement) {
  const proposed = records.map(record => record.nonce === pending.nonce ? replacement : record);
  validateRegistryRecords(proposed);
  const key = `${REGISTRY_PREFIX}${pending.nonce}`;
  const original = storage.getItem(key);
  try {
    writeRecord(storage, replacement);
    readRegistry(storage);
  } catch (error) {
    if (original === null) storage.removeItem(key);
    else storage.setItem(key, original);
    throw error;
  }
}

function readClaim(storage, key) {
  const raw = storage.getItem(key);
  if (!raw) return null;
  if (raw.length > 128) throw new Error('Bridge callback claim is invalid');
  let claim;
  try { claim = JSON.parse(raw); } catch { throw new Error('Bridge callback claim is invalid'); }
  if (!claim || Object.keys(claim).sort().join(',') !== 'createdAt,expiresAt,owner'
    || !/^[A-Za-z0-9_-]{22}$/.test(claim.owner) || !Number.isSafeInteger(claim.createdAt)
    || !Number.isSafeInteger(claim.expiresAt) || claim.createdAt < 0
    || claim.expiresAt - claim.createdAt !== CLAIM_TTL_MS) {
    throw new Error('Bridge callback claim is invalid');
  }
  return claim;
}

function pruneAndReadClaims(storage, timestamp) {
  if (!Number.isSafeInteger(storage.length) || storage.length < 0 || typeof storage.key !== 'function') {
    throw new Error('Bridge callback claim storage is unavailable');
  }
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (typeof key === 'string' && key.startsWith(CLAIM_PREFIX)) keys.push(key);
  }
  let totalBytes = 0;
  const active = [];
  for (const key of keys) {
    const nonce = key.slice(CLAIM_PREFIX.length);
    if (!isCanonicalNonce(nonce)) throw new Error('Bridge callback claim is invalid');
    const raw = storage.getItem(key);
    const claim = readClaim(storage, key);
    if (claim.expiresAt <= timestamp) storage.removeItem(key);
    else {
      totalBytes += key.length + (raw?.length ?? 0);
      active.push({ key, claim });
    }
  }
  if (totalBytes > MAX_CLAIM_BYTES || active.length > MAX_CLAIMS) throw new Error('Too many active Bridge callback claims');
  return active;
}

async function withFallbackClaim(nonce, dependencies, consume) {
  const storage = dependencies.localStorage;
  const cryptoApi = dependencies.crypto ?? globalThis.crypto;
  const now = dependencies.now;
  const delay = dependencies.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  if (!cryptoApi?.getRandomValues || typeof delay !== 'function') throw new Error('Atomic Bridge callback claim is unavailable');
  const ownerBytes = new Uint8Array(16);
  cryptoApi.getRandomValues(ownerBytes);
  const owner = encodeBase64Url(ownerBytes);
  const key = `${CLAIM_PREFIX}${nonce}`;
  const activeClaims = pruneAndReadClaims(storage, now());
  if (activeClaims.length >= MAX_CLAIMS) throw new Error('Too many active Bridge callback claims');
  const existing = readClaim(storage, key);
  if (existing?.expiresAt > now()) throw new Error('Bridge callback is already being consumed');
  if (existing) storage.removeItem(key);
  const createdAt = now();
  storage.setItem(key, JSON.stringify({ owner, createdAt, expiresAt: createdAt + CLAIM_TTL_MS }));
  try { pruneAndReadClaims(storage, createdAt); } catch (error) {
    const claim = readClaim(storage, key);
    if (claim?.owner === owner) storage.removeItem(key);
    throw error;
  }
  await delay(CLAIM_SETTLE_MS);
  const assertOwner = () => {
    const claim = readClaim(storage, key);
    if (!claim || claim.owner !== owner || claim.expiresAt <= now()) throw new Error('Bridge callback claim was not acquired');
  };
  try {
    assertOwner();
    return consume(assertOwner);
  } finally {
    const claim = readClaim(storage, key);
    if (claim?.owner === owner) storage.removeItem(key);
  }
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

export function clearPendingBridgeLaunch(dependencies = {}) {
  const sessionStorage = dependencies.sessionStorage ?? dependencies.storage ?? globalThis.sessionStorage;
  const localStorage = dependencies.localStorage ?? dependencies.storage ?? globalThis.localStorage;
  if (!sessionStorage || !localStorage) throw new Error('Pending Bridge registry storage is unavailable');
  const tabId = sessionStorage.getItem(TAB_KEY);
  if (!tabId) return false;
  if (!/^[A-Za-z0-9_-]{22}$/.test(tabId)) throw new Error('Originating Bridge tab ID is invalid');
  const records = readRegistry(localStorage);
  let cleared = false;
  for (const record of records) {
    if (record.tabId === tabId) {
      removeRecord(localStorage, record.nonce);
      cleared = true;
    }
  }
  return cleared;
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
    ? ['status', 'code', 'cardId', 'firmwareVersion', 'buildId', 'target', 'verification', 'physicalOutput', 'nonce', ...(result.receipt === undefined ? [] : ['receipt']), 'version']
    : maintenanceSuccess && result.cardId !== undefined
      ? ['status', 'code', 'cardId', 'target', 'verification', 'physicalOutput', 'nonce', ...(result.receipt === undefined ? [] : ['receipt']), 'version']
      : ['status', 'code', 'target', 'verification', 'physicalOutput', 'nonce', ...(result.receipt === undefined ? [] : ['receipt']), 'version'];
  if (keys.join(',') !== expected.join(',') || !BRIDGE_RESULT_STATUSES.includes(result.status)
    || !CODE_PATTERN.test(result.code || '') || result.target !== TARGET
    || !['flash-verified', 'not-verified'].includes(result.verification) || result.physicalOutput !== 'unconfirmed'
    || !isCanonicalNonce(result.nonce) || (result.receipt !== undefined && !isCanonicalNonce(result.receipt))
    || result.version !== '1' || (success && !flashSuccess && !maintenanceSuccess)) throw new TypeError('Invalid Bridge callback result');
  if (flashSuccess && (!CARD_PATTERN.test(result.cardId || '') || !SEMVER_PATTERN.test(result.firmwareVersion || '')
    || !BUILD_PATTERN.test(result.buildId || ''))) throw new TypeError('Invalid Bridge callback identity');
  if (maintenanceSuccess && result.cardId !== undefined && !CARD_PATTERN.test(result.cardId)) throw new TypeError('Invalid Bridge callback identity');
  const canonical = `${BRIDGE_CALLBACK_ORIGIN}/#bridge-result?${new URLSearchParams(expected.map(key => [key, result[key]])).toString()}`;
  if (value !== canonical) throw new TypeError('Bridge callback is not canonical');
  return { ...result, version: 1 };
}

export async function consumeBridgeCallback(value, dependencies = {}) {
  const currentOrigin = dependencies.currentOrigin ?? globalThis.location?.origin;
  const localStorage = dependencies.localStorage ?? dependencies.storage ?? globalThis.localStorage;
  const now = dependencies.now ?? Date.now;
  const history = dependencies.history ?? globalThis.history;
  try {
    if (currentOrigin !== BRIDGE_CALLBACK_ORIGIN || !localStorage) throw new Error('Bridge callbacks are accepted only in the public Studio');
    const result = parseCallback(value);
    const consume = assertOwner => {
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
      let targetTabId = pending.tabId;
      if (dependencies.takeoverTab === true) {
        const sessionStorage = dependencies.sessionStorage ?? dependencies.storage ?? globalThis.sessionStorage;
        const cryptoApi = dependencies.crypto ?? globalThis.crypto;
        if (!sessionStorage) throw new Error('Replacement Studio tab storage is unavailable');
        targetTabId = getTabId(sessionStorage, cryptoApi);
      }
      assertOwner?.();
      if (result.receipt) {
        if (pending.receipt && pending.receipt !== result.receipt) throw new Error('Bridge callback receipt does not match');
        replaceRecord(localStorage, records, pending, { ...pending, tabId: targetTabId, receipt: result.receipt });
      } else removeRecord(localStorage, result.nonce);
      const { nonce: _consumedNonce, receipt, ...safeResult } = result;
      return Object.freeze({
        operation: pending.operation, ...safeResult, originTabId: targetTabId, physicalProof: false,
        ...(receipt ? { ackReceipt: receipt } : {}),
      });
    };
    const locks = dependencies.locks === undefined ? globalThis.navigator?.locks : dependencies.locks;
    if (locks?.request) {
      return await locks.request(`${CLAIM_PREFIX}${result.nonce}`, { mode: 'exclusive' }, () => consume());
    }
    return await withFallbackClaim(result.nonce, { ...dependencies, localStorage, now }, consume);
  } finally {
    history?.replaceState?.(null, '', '/');
  }
}

export function confirmBridgeResultReceipt(receipt, dependencies = {}) {
  if (!isCanonicalNonce(receipt)) return false;
  const localStorage = dependencies.localStorage ?? dependencies.storage ?? globalThis.localStorage;
  if (!localStorage) return false;
  const records = readRegistry(localStorage);
  const targetTabId = dependencies.targetTabId;
  const operation = dependencies.operation;
  if (!/^[A-Za-z0-9_-]{22}$/.test(targetTabId || '') || !BRIDGE_OPERATIONS.includes(operation)) return false;
  const pending = records.find(record => record.receipt === receipt
    && record.tabId === targetTabId && record.operation === operation);
  if (!pending) return false;
  removeRecord(localStorage, pending.nonce);
  return true;
}

export async function consumeBridgeReturnCode(value, dependencies = {}) {
  if (typeof value !== 'string' || value.length > 904) throw new TypeError('Invalid Bridge return code');
  const trimmed = value.trim();
  const match = RETURN_CODE_PATTERN.exec(trimmed);
  if (!match) throw new TypeError('Invalid Bridge return code');
  let payload;
  try {
    const base64 = match[1].replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (match[1].length % 4)) % 4);
    const binary = typeof atob === 'function' ? atob(base64) : Buffer.from(match[1], 'base64url').toString('binary');
    payload = new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
    if (encodeBase64Url(new TextEncoder().encode(payload)) !== match[1]) throw new Error('non-canonical');
  } catch { throw new TypeError('Invalid Bridge return code'); }
  if (payload.length > 675 || payload.includes('#')) throw new TypeError('Invalid Bridge return code');
  return consumeBridgeCallback(`${BRIDGE_CALLBACK_ORIGIN}/#bridge-result?${payload}`, { ...dependencies, takeoverTab: true });
}

export function validateOperationResult(operation, result) {
  if (!BRIDGE_OPERATIONS.includes(operation) || !result || !BRIDGE_RESULT_STATUSES.includes(result.status)) return false;
  if (result.status !== 'awaiting-card-acknowledgement') return true;
  const destructive = operation === 'install-current-release' || operation === 'recover-current-release';
  return destructive
    ? result.verification === 'flash-verified' && result.code !== 'operation-complete'
    : result.verification === 'not-verified' && result.code === 'operation-complete';
}
