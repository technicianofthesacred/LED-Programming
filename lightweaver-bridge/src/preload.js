'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const OPERATIONS = new Set(['install-firmware']);
const STATES = new Set([
  'select-card', 'inspect', 'confirm', 'installing', 'verifying', 'complete', 'recovery-required',
]);
const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/i;

function invokeOperation(operation) {
  if (typeof operation !== 'string' || !OPERATIONS.has(operation)) {
    return Promise.reject(new TypeError('Unsupported bridge operation'));
  }
  return ipcRenderer.invoke('bridge:start-operation', operation);
}

function invokeConfirmation(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return Promise.reject(new TypeError('Invalid confirmation token'));
  }
  return ipcRenderer.invoke('bridge:confirm-destructive', token);
}

function sanitizePayload(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {
    state: STATES.has(source.state) ? source.state : 'recovery-required',
    message: typeof source.message === 'string' ? source.message.slice(0, 512) : '',
  };
  if (Number.isFinite(source.progress)) result.progress = Math.max(0, Math.min(100, source.progress));
  if (typeof source.code === 'string') result.code = source.code.slice(0, 64);
  if (typeof source.confirmationToken === 'string' && TOKEN_PATTERN.test(source.confirmationToken)) {
    result.confirmationToken = source.confirmationToken;
  }
  if (typeof source.compatible === 'boolean') result.compatible = source.compatible;
  if (typeof source.productName === 'string') result.productName = source.productName.slice(0, 128);
  return Object.freeze(result);
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback function is required');
  const listener = (_event, payload) => callback(sanitizePayload(payload));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('lightweaverBridge', Object.freeze({
  inspectCompatibleCard: () => ipcRenderer.invoke('bridge:inspect'),
  startOperation: invokeOperation,
  confirmDestructiveAction: invokeConfirmation,
  onProgress: (callback) => subscribe('bridge:progress', callback),
  onResult: (callback) => subscribe('bridge:result', callback),
  cancelBeforeCriticalSection: () => ipcRenderer.invoke('bridge:cancel'),
}));

ipcRenderer.send('bridge:preload-ready');
