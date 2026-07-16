import {
  BRIDGE_OPERATIONS,
  BRIDGE_RESULT_STATUSES,
  claimBridgeResultReceipt,
  consumeBridgeCallback,
  consumeBridgeReturnCode,
  confirmBridgeResultReceipt,
  createBridgeLaunch,
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
const STORED_RESULT_PREFIX = 'lightweaver.bridge.accepted-result.v1.';
const MAX_STORED_RESULT_BYTES = 768;

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

function storedResultKey(sessionStorage, expectedTabId) {
  const tabId = sessionStorage?.getItem?.(BRIDGE_ORIGIN_TAB_KEY) || '';
  if (!TAB_PATTERN.test(tabId) || (expectedTabId && tabId !== expectedTabId)) return null;
  return `${STORED_RESULT_PREFIX}${tabId}`;
}

function persistStoredBridgeResult(result, dependencies = {}) {
  const localStorage = dependencies.localStorage ?? globalThis.localStorage;
  const sessionStorage = dependencies.sessionStorage ?? globalThis.sessionStorage;
  const safeResult = validateBridgeUiResult(result);
  const key = storedResultKey(sessionStorage, dependencies.targetTabId);
  if (!localStorage || !key || !safeResult) throw new Error('Durable Bridge result storage is unavailable');
  const raw = JSON.stringify(safeResult);
  const original = localStorage.getItem(key);
  try {
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw new Error('Durable Bridge result storage failed');
  } catch (error) {
    try {
      if (original === null) localStorage.removeItem(key);
      else localStorage.setItem(key, original);
    } catch { /* Native and browser correlation remain pending. */ }
    throw error;
  }
  return safeResult;
}

export function readStoredBridgeResult(dependencies = {}) {
  const localStorage = dependencies.localStorage ?? globalThis.localStorage;
  const sessionStorage = dependencies.sessionStorage ?? globalThis.sessionStorage;
  const key = storedResultKey(sessionStorage);
  if (!localStorage || !key) return null;
  const raw = localStorage.getItem(key);
  if (typeof raw !== 'string' || raw.length > MAX_STORED_RESULT_BYTES) return null;
  try { return validateBridgeUiResult(JSON.parse(raw)); } catch { return null; }
}

export function clearStoredBridgeResult(dependencies = {}) {
  const localStorage = dependencies.localStorage ?? globalThis.localStorage;
  const sessionStorage = dependencies.sessionStorage ?? globalThis.sessionStorage;
  const key = storedResultKey(sessionStorage);
  if (!localStorage || !key || localStorage.getItem(key) === null) return false;
  localStorage.removeItem(key);
  return localStorage.getItem(key) === null;
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
  const onResult = dependencies.onResult;
  const acknowledge = dependencies.acknowledge ?? defaultAcknowledge;
  const claimReceipt = dependencies.claimReceipt ?? ((receipt, message) => claimBridgeResultReceipt(receipt, {
    localStorage, operation: message.operation, targetTabId: message.targetTabId, deliveryId: message.deliveryId,
  }));
  const confirmReceipt = dependencies.confirmReceipt ?? ((receipt, message) => confirmBridgeResultReceipt(receipt, {
    localStorage, operation: message.operation, targetTabId: message.targetTabId, deliveryId: message.deliveryId,
  }));
  const releaseReceipt = dependencies.releaseReceipt ?? ((receipt, message) => releaseBridgeResultReceipt(receipt, {
    localStorage, operation: message.operation, targetTabId: message.targetTabId, deliveryId: message.deliveryId,
  }));
  const persistResult = dependencies.persistResult ?? ((result, message) => persistStoredBridgeResult(result, {
    localStorage, sessionStorage, targetTabId: message.targetTabId,
  }));
  const delivered = new Set();
  const acknowledged = new Set();
  let channel = null;

  const receive = raw => {
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
    if (!claimReceipt(message.ackReceipt, message)) return;
    const safeMessage = validateBridgeUiResult(uiResultFields(message));
    const { ackReceipt } = message;
    try {
      if (!safeMessage) throw new Error('Bridge UI result is invalid');
      persistResult(safeMessage, message);
      onResult(safeMessage);
    } catch (error) {
      releaseReceipt(ackReceipt, message);
      throw error;
    }
    if (!confirmReceipt(ackReceipt, message)) {
      releaseReceipt(ackReceipt, message);
      return;
    }
    if (delivered.size >= 32) delivered.delete(delivered.values().next().value);
    delivered.add(ackReceipt);
    acknowledge(`lightweaver://ack?receipt=${ackReceipt}&version=1`);
    acknowledged.add(ackReceipt);
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
