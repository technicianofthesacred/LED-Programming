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
  return ipcRenderer.invoke('bridge:start-operation', operation).then(sanitizePayload);
}

function invokeConfirmation(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return Promise.reject(new TypeError('Invalid confirmation token'));
  }
  return ipcRenderer.invoke('bridge:confirm-destructive', token).then(sanitizePayload);
}

function redactSensitiveText(value, limit = 512) {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, limit)
    .replace(/\/dev\/(?:cu\.[^\s"'`,;}\])]+|tty[^\s"'`,;}\])]+|serial\/[^\s"'`,;}\])]+)/gi, '[redacted-device]')
    .replace(/(?:\\\\\.\\)?\bCOM\d+\b/gi, '[redacted-device]')
    .replace(/["']?(?:serialNumber|serial_number|usbSerialNumber|serial\s+number|USB\s+serial\s+number|serial|SN)["']?\s*[:=]\s*["']?[^"'\s,;}]+["']?/gi, '[redacted-serial]');
}

function sanitizePayload(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = {
    state: STATES.has(source.state) ? source.state : 'recovery-required',
    message: redactSensitiveText(source.message),
  };
  if (Number.isFinite(source.progress)) result.progress = Math.max(0, Math.min(100, source.progress));
  if (typeof source.code === 'string') result.code = redactSensitiveText(source.code, 64);
  if (typeof source.confirmationToken === 'string' && TOKEN_PATTERN.test(source.confirmationToken)) {
    result.confirmationToken = source.confirmationToken;
  }
  if (typeof source.compatible === 'boolean') result.compatible = source.compatible;
  if (typeof source.productName === 'string') result.productName = redactSensitiveText(source.productName, 128);
  return Object.freeze(result);
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback function is required');
  const listener = (_event, payload) => callback(sanitizePayload(payload));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function sanitizeCancellation(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.freeze({
    cancelled: source.cancelled === true,
    state: STATES.has(source.state) ? source.state : 'recovery-required',
  });
}

contextBridge.exposeInMainWorld('lightweaverBridge', Object.freeze({
  inspectCompatibleCard: () => ipcRenderer.invoke('bridge:inspect').then(sanitizePayload),
  startOperation: invokeOperation,
  confirmDestructiveAction: invokeConfirmation,
  onProgress: (callback) => subscribe('bridge:progress', callback),
  onResult: (callback) => subscribe('bridge:result', callback),
  cancelBeforeCriticalSection: () => ipcRenderer.invoke('bridge:cancel').then(sanitizeCancellation),
}));

ipcRenderer.send('bridge:preload-ready');

ipcRenderer.on('bridge:smoke-attempt-navigation', () => {
  window.location.assign('https://unexpected.invalid/');
  ipcRenderer.send('bridge:smoke-navigation-attempted');
});
