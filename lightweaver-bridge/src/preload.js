'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const OPERATIONS = new Set([
  'install-current-release', 'recover-current-release', 'inspect-compatible-card', 'release-usb', 'restart-card',
]);
const STATES = new Set([
  'select-card', 'inspect', 'confirm', 'installing', 'verifying', 'complete', 'recovery-required',
  'awaiting-card-acknowledgement', 'operation-failed', 'usb-ownership-uncertain',
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
  if (typeof source.cardId === 'string' && /^lw-[a-f0-9]{12}$/.test(source.cardId)) result.cardId = source.cardId;
  if (typeof source.productName === 'string') result.productName = redactSensitiveText(source.productName, 128);
  if (typeof source.firmwareVersion === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(source.firmwareVersion)) result.firmwareVersion = source.firmwareVersion;
  if (typeof source.buildId === 'string' && /^[a-f0-9]{40}$/.test(source.buildId)) result.buildId = source.buildId;
  if (typeof source.target === 'string' && /^[a-z0-9-]{1,64}$/.test(source.target)) result.target = source.target;
  if (source.verification === 'flash-verified' || source.verification === 'not-verified') result.verification = source.verification;
  if (source.physicalOutput === 'unconfirmed') result.physicalOutput = source.physicalOutput;
  if (source.pipelineComplete === false) result.pipelineComplete = false;
  if (typeof source.expectedCardId === 'string' && /^lw-[a-f0-9]{12}$/.test(source.expectedCardId)) result.expectedCardId = source.expectedCardId;
  if (source.nextCheckpoint === 'stable-card-identity-acknowledged') result.nextCheckpoint = source.nextCheckpoint;
  if (['recoverable-failure', 'needs-safe-recovery', 'usb-ownership-uncertain'].includes(source.classification)) result.classification = source.classification;
  if (typeof source.phase === 'string' && /^[a-z0-9-]{1,48}$/.test(source.phase)) result.phase = source.phase;
  if (typeof source.nextAction === 'string' && /^[a-z0-9-]{1,64}$/.test(source.nextAction)) result.nextAction = source.nextAction;
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
  inspectForOperation: (operation) => {
    if (!['install-current-release', 'recover-current-release'].includes(operation)) {
      return Promise.reject(new TypeError('Unsupported destructive operation'));
    }
    return ipcRenderer.invoke('bridge:inspect-for-operation', operation).then(sanitizePayload);
  },
  startOperation: invokeOperation,
  runMaintenanceOperation: (operation) => {
    if (!['inspect-compatible-card', 'release-usb', 'restart-card'].includes(operation)) {
      return Promise.reject(new TypeError('Unsupported maintenance operation'));
    }
    return ipcRenderer.invoke('bridge:maintenance-operation', operation).then(sanitizePayload);
  },
  confirmDestructiveAction: invokeConfirmation,
  onProgress: (callback) => subscribe('bridge:progress', callback),
  onResult: (callback) => subscribe('bridge:result', callback),
  onLaunchRequest: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A callback function is required');
    const listener = (_event, payload) => {
      if (payload && OPERATIONS.has(payload.operation) && Object.keys(payload).length === 1) callback(Object.freeze({ operation: payload.operation }));
    };
    ipcRenderer.on('bridge:launch-request', listener);
    return () => ipcRenderer.removeListener('bridge:launch-request', listener);
  },
  cancelBeforeCriticalSection: () => ipcRenderer.invoke('bridge:cancel').then(sanitizeCancellation),
}));

ipcRenderer.send('bridge:preload-ready');

ipcRenderer.on('bridge:smoke-attempt-navigation', () => {
  window.location.assign('https://unexpected.invalid/');
  ipcRenderer.send('bridge:smoke-navigation-attempted');
});
