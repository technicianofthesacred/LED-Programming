'use strict';

const OPERATIONS = new Set(['install-firmware']);
const STATES = new Set([
  'select-card', 'inspect', 'confirm', 'installing', 'verifying', 'complete', 'recovery-required',
]);
const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/i;

function redactSensitiveText(value, limit = 512) {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, limit)
    .replace(/\/dev\/(?:cu\.[^\s,;]+|ttyUSB\d+)/gi, '[redacted-device]')
    .replace(/\bCOM\d+\b/gi, '[redacted-device]')
    .replace(/["']?(?:serialNumber|serial_number|usbSerialNumber|serial\s+number|USB\s+serial\s+number|SN)["']?\s*[:=]\s*["']?[^"'\s,;}]+["']?/gi, '[redacted-serial]');
}

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

function createRendererResult(state, message, fields = {}) {
  const result = {
    state: STATES.has(state) ? state : 'recovery-required',
    message: redactSensitiveText(message),
  };
  if (typeof fields.compatible === 'boolean') result.compatible = fields.compatible;
  if (typeof fields.productName === 'string') result.productName = redactSensitiveText(fields.productName, 128);
  if (Number.isFinite(fields.progress)) result.progress = Math.max(0, Math.min(100, fields.progress));
  if (typeof fields.code === 'string') result.code = redactSensitiveText(fields.code, 64);
  if (typeof fields.confirmationToken === 'string' && TOKEN_PATTERN.test(fields.confirmationToken)) {
    result.confirmationToken = fields.confirmationToken;
  }
  return Object.freeze(result);
}

module.exports = {
  createRendererResult,
  redactSensitiveText,
  validateOperation,
  validateToken,
};
