'use strict';

const OPERATIONS = new Set(['install-firmware']);
const STATES = new Set([
  'select-card',
  'inspect',
  'confirm',
  'installing',
  'verifying',
  'complete',
  'recovery-required',
]);
const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/i;

function validateOperation(operation) {
  if (typeof operation !== 'string' || !OPERATIONS.has(operation)) {
    throw new TypeError('Unsupported bridge operation');
  }
  return operation;
}

function validateToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new TypeError('Invalid confirmation token');
  }
  return token;
}

function sanitizeText(value, limit = 512) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function sanitizePayload(value) {
  const source = value && typeof value === 'object' ? value : {};
  const payload = {
    state: STATES.has(source.state) ? source.state : 'recovery-required',
    message: sanitizeText(source.message),
  };
  if (Number.isFinite(source.progress)) payload.progress = Math.max(0, Math.min(100, source.progress));
  if (typeof source.code === 'string') payload.code = sanitizeText(source.code, 64);
  if (typeof source.confirmationToken === 'string' && TOKEN_PATTERN.test(source.confirmationToken)) {
    payload.confirmationToken = source.confirmationToken;
  }
  if (typeof source.compatible === 'boolean') payload.compatible = source.compatible;
  if (typeof source.productName === 'string') payload.productName = sanitizeText(source.productName, 128);
  return Object.freeze(payload);
}

function createSubscription(ipc, channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback function is required');
  const listener = (_event, payload) => callback(sanitizePayload(payload));
  ipc.on(channel, listener);
  return () => ipc.removeListener(channel, listener);
}

function createBridgeApi(ipc) {
  const api = {
    inspectCompatibleCard: () => ipc.invoke('bridge:inspect'),
    startOperation: async (operation) => ipc.invoke('bridge:start-operation', validateOperation(operation)),
    confirmDestructiveAction: async (token) => ipc.invoke('bridge:confirm-destructive', validateToken(token)),
    onProgress: (callback) => createSubscription(ipc, 'bridge:progress', callback),
    onResult: (callback) => createSubscription(ipc, 'bridge:result', callback),
    cancelBeforeCriticalSection: () => ipc.invoke('bridge:cancel'),
  };
  return Object.freeze(api);
}

module.exports = {
  createBridgeApi,
  sanitizePayload,
  sanitizeText,
  validateOperation,
  validateToken,
};
