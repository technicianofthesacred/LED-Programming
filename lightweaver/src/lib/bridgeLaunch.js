import {
  BRIDGE_OPERATIONS,
  BRIDGE_RESULT_STATUSES,
  claimBridgeResultReceipt,
  consumeBridgeCallback,
  consumeBridgeReturnCode,
  confirmBridgeResultReceipt,
  createBridgeLaunch,
  revalidateBridgeResultReceipt,
  releaseBridgeResultReceipt,
  validateOperationResult,
} from './bridgeProtocol.js';

export const BRIDGE_RESULT_CHANNEL = 'lightweaver.bridge.result.v1';
export const BRIDGE_RESULT_STORAGE_KEY = 'lightweaver.bridge.result.v1';
export const BRIDGE_ORIGIN_TAB_KEY = 'lightweaver.bridge.origin-tab.v1';

const TAB_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DELIVERY_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const CARD_PATTERN = /^lw-[a-f0-9]{12}$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUILD_PATTERN = /^[a-f0-9]{40}$/;
const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACK_RECEIPT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_MESSAGE_BYTES = 1024;
const STORED_RESULT_KEY = 'lightweaver.bridge.accepted-result-registry.v1';
const STORED_RESULT_LOCK = 'lightweaver.bridge.accepted-result-registry.lock.v1';
const STORED_RESULT_LEASE_KEY = 'lightweaver.bridge.accepted-result-registry.lease.v1';
const MAX_STORED_RESULT_BYTES = 768;
const MAX_STORED_REGISTRY_BYTES = 8_192;
const MAX_STORED_RESULTS = 16;
const STORED_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function defaultNavigate(url) {
  globalThis.location.href = url;
}

function defaultAcknowledge(url) {
  globalThis.location.assign(url);
}

export async function launchBridgeOperation(operation, dependencies = {}) {
  if (!BRIDGE_OPERATIONS.includes(operation)) throw new TypeError('Unsupported Bridge operation');
  if (typeof dependencies.persistProject !== 'function') throw new Error('Project persistence is unavailable');
  await dependencies.persistProject();
  const createLaunch = dependencies.createLaunch ?? createBridgeLaunch;
  const navigate = dependencies.navigate ?? defaultNavigate;
  const url = createLaunch(operation, dependencies.protocolDependencies);
  navigate(url);
  return url;
}

function base64Url(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  const encoded = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
  return encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function makeDeliveryId(cryptoApi) {
  const bytes = new Uint8Array(12);
  cryptoApi.getRandomValues(bytes);
  return base64Url(bytes);
}

function resultFields(result) {
  const fields = {
    version: 1,
    type: 'bridge-result',
    deliveryId: result.deliveryId,
    targetTabId: result.targetTabId ?? result.originTabId,
    operation: result.operation,
    status: result.status,
    code: result.code,
    target: result.target,
    verification: result.verification,
    physicalOutput: result.physicalOutput,
    ackReceipt: result.ackReceipt,
  };
  if (result.cardId !== undefined) fields.cardId = result.cardId;
  if (result.firmwareVersion !== undefined) fields.firmwareVersion = result.firmwareVersion;
  if (result.buildId !== undefined) fields.buildId = result.buildId;
  return fields;
}

function uiResultFields(result) {
  const fields = {
    operation: result.operation,
    status: result.status,
    code: result.code,
    target: result.target,
    verification: result.verification,
    physicalOutput: result.physicalOutput,
    physicalProof: false,
  };
  if (result.cardId !== undefined) fields.cardId = result.cardId;
  if (result.firmwareVersion !== undefined) fields.firmwareVersion = result.firmwareVersion;
  if (result.buildId !== undefined) fields.buildId = result.buildId;
  return fields;
}

function validateBridgeUiResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = uiResultFields(value);
  const expectedKeys = [
    'code', 'operation', 'physicalOutput', 'physicalProof', 'status', 'target', 'verification',
    ...(result.cardId === undefined ? [] : ['cardId']),
    ...(result.firmwareVersion === undefined ? [] : ['firmwareVersion']),
    ...(result.buildId === undefined ? [] : ['buildId']),
  ].sort();
  if (Object.keys(value).sort().join(',') !== expectedKeys.join(',')
    || !BRIDGE_OPERATIONS.includes(result.operation) || !BRIDGE_RESULT_STATUSES.includes(result.status)
    || !CODE_PATTERN.test(result.code || '') || result.target !== 'lightweaver-controller-esp32s3'
    || !['flash-verified', 'not-verified'].includes(result.verification)
    || result.physicalOutput !== 'unconfirmed' || result.physicalProof !== false
    || !validateOperationResult(result.operation, result)) return null;
  const destructive = result.operation === 'install-current-release' || result.operation === 'recover-current-release';
  if (result.status === 'awaiting-card-acknowledgement' && destructive) {
    if (!CARD_PATTERN.test(result.cardId || '') || !SEMVER_PATTERN.test(result.firmwareVersion || '') || !BUILD_PATTERN.test(result.buildId || '')) return null;
  } else if (result.firmwareVersion !== undefined || result.buildId !== undefined
    || (result.cardId !== undefined && !CARD_PATTERN.test(result.cardId))) return null;
  if (JSON.stringify(result).length > MAX_STORED_RESULT_BYTES) return null;
  return Object.freeze(result);
}

function storedResultTabId(sessionStorage, expectedTabId) {
  const tabId = sessionStorage?.getItem?.(BRIDGE_ORIGIN_TAB_KEY) || '';
  if (!TAB_PATTERN.test(tabId) || (expectedTabId && tabId !== expectedTabId)) return null;
  return tabId;
}

function readStoredRegistry(localStorage) {
  const raw = localStorage.getItem(STORED_RESULT_KEY);
  if (raw === null) return { version: 1, records: [] };
  if (typeof raw !== 'string' || raw.length > MAX_STORED_REGISTRY_BYTES) throw new Error('Durable Bridge result registry is invalid');
  let registry;
  try { registry = JSON.parse(raw); } catch { throw new Error('Durable Bridge result registry is invalid'); }
  if (!registry || Object.keys(registry).sort().join(',') !== 'records,version' || registry.version !== 1
    || !Array.isArray(registry.records) || registry.records.length > MAX_STORED_RESULTS) throw new Error('Durable Bridge result registry is invalid');
  const tabs = new Set();
  for (const record of registry.records) {
    if (!record || Object.keys(record).sort().join(',') !== 'acceptedAt,expiresAt,result,tabId'
      || !TAB_PATTERN.test(record.tabId) || tabs.has(record.tabId) || !Number.isSafeInteger(record.acceptedAt)
      || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.acceptedAt
      || record.expiresAt - record.acceptedAt !== STORED_RESULT_TTL_MS || !validateBridgeUiResult(record.result)) {
      throw new Error('Durable Bridge result registry is invalid');
    }
    tabs.add(record.tabId);
  }
  return registry;
}

function writeStoredRegistry(localStorage, registry) {
  let records = [...registry.records].sort((a, b) => a.acceptedAt - b.acceptedAt).slice(-MAX_STORED_RESULTS);
  let raw = JSON.stringify({ version: 1, records });
  while (raw.length > MAX_STORED_REGISTRY_BYTES && records.length) {
    records = records.slice(1);
    raw = JSON.stringify({ version: 1, records });
  }
  if (raw.length > MAX_STORED_REGISTRY_BYTES) throw new Error('Durable Bridge result registry is too large');
  localStorage.setItem(STORED_RESULT_KEY, raw);
  if (localStorage.getItem(STORED_RESULT_KEY) !== raw) throw new Error('Durable Bridge result storage failed');
}

function withStoredRegistryMutation(dependencies, callback) {
  const locks = dependencies.locks;
  if (locks?.request) return locks.request(STORED_RESULT_LOCK, { mode: 'exclusive' }, callback);
  const localStorage = dependencies.localStorage;
  const ownerToken = dependencies.ownerToken;
  const now = dependencies.now ?? Date.now;
  const timestamp = now();
  let existing = null;
  try { existing = JSON.parse(localStorage.getItem(STORED_RESULT_LEASE_KEY) || 'null'); } catch { throw new Error('Durable Bridge result lease is invalid'); }
  if (existing && existing.owner !== ownerToken && Number.isSafeInteger(existing.expiresAt) && existing.expiresAt > timestamp) {
    throw new Error('Durable Bridge result registry is busy');
  }
  const lease = JSON.stringify({ owner: ownerToken, expiresAt: timestamp + 2_000 });
  localStorage.setItem(STORED_RESULT_LEASE_KEY, lease);
  if (localStorage.getItem(STORED_RESULT_LEASE_KEY) !== lease) throw new Error('Durable Bridge result lease was not acquired');
  try { return callback(); } finally {
    if (localStorage.getItem(STORED_RESULT_LEASE_KEY) === lease) localStorage.removeItem(STORED_RESULT_LEASE_KEY);
  }
}

function verifyStoredBridgeResult(result, dependencies) {
  const registry = readStoredRegistry(dependencies.localStorage);
  const record = registry.records.find(item => item.tabId === dependencies.targetTabId);
  return Boolean(record && record.expiresAt > (dependencies.now ?? Date.now)()
    && JSON.stringify(record.result) === JSON.stringify(result));
}

function persistStoredBridgeResult(result, dependencies = {}) {
  const localStorage = dependencies.localStorage ?? globalThis.localStorage;
  const sessionStorage = dependencies.sessionStorage ?? globalThis.sessionStorage;
  const safeResult = validateBridgeUiResult(result);
  const tabId = storedResultTabId(sessionStorage, dependencies.targetTabId);
  if (!localStorage || !tabId || !safeResult) throw new Error('Durable Bridge result storage is unavailable');
  const now = dependencies.now ?? Date.now;
  const acceptedAt = now();
  const original = localStorage.getItem(STORED_RESULT_KEY);
  try {
    const registry = readStoredRegistry(localStorage);
    const records = registry.records.filter(record => record.expiresAt > acceptedAt && record.tabId !== tabId);
    records.push({ tabId, acceptedAt, expiresAt: acceptedAt + STORED_RESULT_TTL_MS, result: safeResult });
    writeStoredRegistry(localStorage, { version: 1, records });
  } catch (error) {
    try {
      if (original === null) localStorage.removeItem(STORED_RESULT_KEY);
      else localStorage.setItem(STORED_RESULT_KEY, original);
    } catch { /* Native and browser correlation remain pending. */ }
    throw error;
  }
  return safeResult;
}

export function readStoredBridgeResult(dependencies = {}) {
  const localStorage = dependencies.localStorage ?? globalThis.localStorage;
  const sessionStorage = dependencies.sessionStorage ?? globalThis.sessionStorage;
  const tabId = storedResultTabId(sessionStorage);
  if (!localStorage || !tabId) return null;
  try {
    const now = (dependencies.now ?? Date.now)();
    const registry = readStoredRegistry(localStorage);
    const active = registry.records.filter(record => record.expiresAt > now);
    if (active.length !== registry.records.length) {
      const cryptoApi = dependencies.crypto ?? globalThis.crypto;
      const bytes = new Uint8Array(16);
      const ownerToken = cryptoApi?.getRandomValues ? base64Url(cryptoApi.getRandomValues(bytes)) : tabId;
      const prune = () => writeStoredRegistry(localStorage, { version: 1, records: active });
      const mutation = withStoredRegistryMutation({
        localStorage, ownerToken, now: dependencies.now, locks: dependencies.locks ?? globalThis.navigator?.locks,
      }, prune);
      mutation?.catch?.(() => {});
    }
    return active.find(record => record.tabId === tabId)?.result ?? null;
  } catch { return null; }
}

export function clearStoredBridgeResult(dependencies = {}) {
  const localStorage = dependencies.localStorage ?? globalThis.localStorage;
  const sessionStorage = dependencies.sessionStorage ?? globalThis.sessionStorage;
  const tabId = storedResultTabId(sessionStorage);
  if (!localStorage || !tabId) return false;
  const mutate = () => {
    const registry = readStoredRegistry(localStorage);
    const records = registry.records.filter(record => record.tabId !== tabId);
    if (records.length === registry.records.length) return false;
    writeStoredRegistry(localStorage, { version: 1, records });
    return true;
  };
  try {
    const cryptoApi = dependencies.crypto ?? globalThis.crypto;
    const bytes = new Uint8Array(16);
    const ownerToken = cryptoApi?.getRandomValues ? base64Url(cryptoApi.getRandomValues(bytes)) : tabId;
    return withStoredRegistryMutation({ localStorage, ownerToken, now: dependencies.now, locks: dependencies.locks ?? globalThis.navigator?.locks }, mutate);
  } catch { return false; }
}

export function validateBridgeResultNotification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = resultFields(value);
  const destructive = message.operation === 'install-current-release' || message.operation === 'recover-current-release';
  const expectedKeys = [
    'code', 'deliveryId', 'operation', 'physicalOutput', 'status', 'target', 'targetTabId', 'type', 'verification', 'version',
    'ackReceipt',
    ...(message.cardId === undefined ? [] : ['cardId']),
    ...(message.firmwareVersion === undefined ? [] : ['firmwareVersion']),
    ...(message.buildId === undefined ? [] : ['buildId']),
  ].sort();
  if (Object.keys(value).sort().join(',') !== expectedKeys.join(',')
    || value.version !== 1 || value.type !== 'bridge-result'
    || !DELIVERY_PATTERN.test(value.deliveryId || '') || !TAB_PATTERN.test(value.targetTabId || '')
    || !ACK_RECEIPT_PATTERN.test(value.ackReceipt || '')
    || !BRIDGE_OPERATIONS.includes(value.operation) || !BRIDGE_RESULT_STATUSES.includes(value.status)
    || !CODE_PATTERN.test(value.code || '') || value.target !== 'lightweaver-controller-esp32s3'
    || !['flash-verified', 'not-verified'].includes(value.verification)
    || value.physicalOutput !== 'unconfirmed' || !validateOperationResult(value.operation, value)) return null;
  if (value.status === 'awaiting-card-acknowledgement' && destructive) {
    if (!CARD_PATTERN.test(value.cardId || '') || !SEMVER_PATTERN.test(value.firmwareVersion || '') || !BUILD_PATTERN.test(value.buildId || '')) return null;
  } else if (value.firmwareVersion !== undefined || value.buildId !== undefined || (value.cardId !== undefined && !CARD_PATTERN.test(value.cardId))) {
    return null;
  }
  if (JSON.stringify(value).length > MAX_MESSAGE_BYTES) return null;
  return Object.freeze({ ...value, physicalProof: false });
}

export function createBridgeResultChannel(dependencies = {}) {
  const sessionStorage = dependencies.sessionStorage ?? globalThis.sessionStorage;
  const localStorage = dependencies.localStorage ?? globalThis.localStorage;
  const eventTarget = dependencies.eventTarget ?? globalThis;
  const BroadcastChannelApi = dependencies.BroadcastChannel === undefined ? globalThis.BroadcastChannel : dependencies.BroadcastChannel;
  const cryptoApi = dependencies.crypto ?? globalThis.crypto;
  const locks = dependencies.locks === undefined ? globalThis.navigator?.locks : dependencies.locks;
  const ownerBytes = new Uint8Array(16);
  const ownerToken = cryptoApi?.getRandomValues ? base64Url(cryptoApi.getRandomValues(ownerBytes)) : '';
  const now = dependencies.now ?? Date.now;
  const onResult = dependencies.onResult;
  const acknowledge = dependencies.acknowledge ?? defaultAcknowledge;
  const claimReceipt = dependencies.claimReceipt ?? ((receipt, message) => claimBridgeResultReceipt(receipt, {
    localStorage, operation: message.operation, targetTabId: message.targetTabId, ownerToken, now,
  }));
  const revalidateReceipt = dependencies.revalidateReceipt ?? (dependencies.claimReceipt
    ? (() => true)
    : ((receipt, message) => revalidateBridgeResultReceipt(receipt, {
      localStorage, operation: message.operation, targetTabId: message.targetTabId, ownerToken, now,
    })));
  const confirmReceipt = dependencies.confirmReceipt ?? ((receipt, message) => confirmBridgeResultReceipt(receipt, {
    localStorage, operation: message.operation, targetTabId: message.targetTabId, ownerToken,
  }));
  const releaseReceipt = dependencies.releaseReceipt ?? ((receipt, message) => releaseBridgeResultReceipt(receipt, {
    localStorage, operation: message.operation, targetTabId: message.targetTabId, ownerToken,
  }));
  const persistResult = dependencies.persistResult ?? ((result, message) => persistStoredBridgeResult(result, {
    localStorage, sessionStorage, targetTabId: message.targetTabId, now,
  }));
  const verifyResult = dependencies.verifyResult ?? (dependencies.persistResult
    ? (() => true)
    : ((result, message) => verifyStoredBridgeResult(result, { localStorage, targetTabId: message.targetTabId, now })));
  const delivered = new Set();
  const acknowledged = new Set();
  let channel = null;

  const receiveUnlocked = raw => {
    let candidate = raw;
    if (typeof raw === 'string') {
      if (raw.length > MAX_MESSAGE_BYTES) return;
      try { candidate = JSON.parse(raw); } catch { return; }
    }
    const message = validateBridgeResultNotification(candidate);
    const tabId = sessionStorage?.getItem?.(BRIDGE_ORIGIN_TAB_KEY) || '';
    if (!message || !tabId || message.targetTabId !== tabId) return;
    if (delivered.has(message.ackReceipt)) {
      if (onResult && !acknowledged.has(message.ackReceipt)) {
        acknowledge(`lightweaver://ack?receipt=${message.ackReceipt}&version=1`);
        acknowledged.add(message.ackReceipt);
      }
      return;
    }
    if (!onResult) return;
    const accept = () => {
      if (!claimReceipt(message.ackReceipt, message)) return;
      const safeMessage = validateBridgeUiResult(uiResultFields(message));
      const { ackReceipt } = message;
      try {
        if (!safeMessage) throw new Error('Bridge UI result is invalid');
        if (!revalidateReceipt(ackReceipt, message)) throw new Error('Bridge receipt claim was lost');
        persistResult(safeMessage, message);
        if (!verifyResult(safeMessage, message)) throw new Error('Durable Bridge result verification failed');
        if (!revalidateReceipt(ackReceipt, message)) throw new Error('Bridge receipt claim was lost');
        onResult(safeMessage);
        if (!revalidateReceipt(ackReceipt, message)) throw new Error('Bridge receipt claim was lost');
        if (!confirmReceipt(ackReceipt, message)) throw new Error('Bridge receipt finalization failed');
      } catch (error) {
        try { releaseReceipt(ackReceipt, message); } catch { /* Preserve the original failure. */ }
        throw error;
      }
      if (delivered.size >= 32) delivered.delete(delivered.values().next().value);
      delivered.add(ackReceipt);
      acknowledge(`lightweaver://ack?receipt=${ackReceipt}&version=1`);
      acknowledged.add(ackReceipt);
    };
    return withStoredRegistryMutation({ localStorage, ownerToken, now, locks }, accept);
  };
  const receive = raw => {
    if (!locks?.request) return receiveUnlocked(raw);
    let receipt = '';
    const candidate = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
    receipt = candidate?.ackReceipt || '';
    if (!ACK_RECEIPT_PATTERN.test(receipt)) return undefined;
    return locks.request(`lightweaver.bridge.result-claim.v1.${receipt}`, { mode: 'exclusive' }, () => receiveUnlocked(raw));
  };
  const onStorage = event => {
    if (event.key === BRIDGE_RESULT_STORAGE_KEY && event.newValue) receive(event.newValue);
  };
  const onLocalResult = event => receive(event.detail);
  if (BroadcastChannelApi) {
    try {
      channel = new BroadcastChannelApi(BRIDGE_RESULT_CHANNEL);
      channel.addEventListener?.('message', event => receive(event.data));
      if (!channel.addEventListener) channel.onmessage = event => receive(event.data);
    } catch {
      channel = null;
    }
  }
  eventTarget?.addEventListener?.('storage', onStorage);
  eventTarget?.addEventListener?.('lightweaver-bridge-result', onLocalResult);

  return {
    publish(result) {
      if (!cryptoApi?.getRandomValues) throw new Error('Secure Bridge result notification is unavailable');
      const candidate = resultFields({ ...result, deliveryId: makeDeliveryId(cryptoApi) });
      const message = validateBridgeResultNotification(candidate);
      if (!message) throw new TypeError('Invalid Bridge result notification semantics');
      if (eventTarget?.dispatchEvent && typeof CustomEvent === 'function') {
        eventTarget.dispatchEvent(new CustomEvent('lightweaver-bridge-result', { detail: candidate }));
      }
      channel?.postMessage?.(candidate);
      if (localStorage) {
        const raw = JSON.stringify(candidate);
        localStorage.setItem(BRIDGE_RESULT_STORAGE_KEY, raw);
        localStorage.removeItem(BRIDGE_RESULT_STORAGE_KEY);
      }
      return candidate;
    },
    receive,
    close() {
      eventTarget?.removeEventListener?.('storage', onStorage);
      eventTarget?.removeEventListener?.('lightweaver-bridge-result', onLocalResult);
      channel?.close?.();
    },
  };
}

export function isBridgeCallbackLocation(href = globalThis.location?.href || '') {
  try { return new URL(href).hash.startsWith('#bridge-result?'); } catch { return false; }
}

export async function bootstrapBridgeCallback(dependencies = {}) {
  const href = dependencies.href ?? globalThis.location?.href ?? '';
  if (!isBridgeCallbackLocation(href)) return { kind: 'none' };
  let result;
  try { result = await (dependencies.consume ?? consumeBridgeCallback)(href); } catch {
    return {
      kind: 'failure',
      message: 'Studio could not match this Bridge return. Paste the one-time return code from Bridge into the original Studio tab.',
    };
  }
  try { dependencies.publish?.(result); } catch { /* The authoritative result remains pending for retry. */ }
  return {
    kind: 'handoff',
    message: 'Bridge return is pending in the Studio tab that started this action.',
  };
}

export async function resumeBridgeReturnCode(value, dependencies = {}) {
  const result = await (dependencies.consume ?? consumeBridgeReturnCode)(value, dependencies.protocolDependencies);
  try { dependencies.publish?.(result); } catch { /* The authoritative result remains pending for retry. */ }
  return {
    kind: 'handoff',
    message: 'Bridge return is pending in this Studio tab.',
  };
}
