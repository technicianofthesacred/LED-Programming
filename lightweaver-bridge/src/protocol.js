'use strict';

const OPERATIONS = new Set([
  'install-current-release',
  'recover-current-release',
  'inspect-compatible-card',
  'release-usb',
  'restart-card',
]);
const STATES = new Set([
  'select-card', 'inspect', 'confirm', 'installing', 'verifying', 'complete', 'recovery-required',
  'awaiting-card-acknowledgement', 'operation-failed', 'usb-ownership-uncertain',
]);
const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/i;

function redactSensitiveText(value, limit = 512) {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, limit)
    .replace(/\/dev\/(?:cu\.[^\s"'`,;}\])]+|tty[^\s"'`,;}\])]+|serial\/[^\s"'`,;}\])]+)/gi, '[redacted-device]')
    .replace(/(?:\\\\\.\\)?\bCOM\d+\b/gi, '[redacted-device]')
    .replace(/["']?(?:serialNumber|serial_number|usbSerialNumber|serial\s+number|USB\s+serial\s+number|serial|SN)["']?\s*[:=]\s*["']?[^"'\s,;}]+["']?/gi, '[redacted-serial]');
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
  if (typeof fields.cardId === 'string' && /^lw-[a-f0-9]{12}$/.test(fields.cardId)) result.cardId = fields.cardId;
  if (typeof fields.productName === 'string') result.productName = redactSensitiveText(fields.productName, 128);
  if (Number.isFinite(fields.progress)) result.progress = Math.max(0, Math.min(100, fields.progress));
  if (typeof fields.code === 'string') result.code = redactSensitiveText(fields.code, 64);
  if (typeof fields.confirmationToken === 'string' && TOKEN_PATTERN.test(fields.confirmationToken)) {
    result.confirmationToken = fields.confirmationToken;
  }
  if (typeof fields.firmwareVersion === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(fields.firmwareVersion)) result.firmwareVersion = fields.firmwareVersion;
  if (typeof fields.buildId === 'string' && /^[a-f0-9]{40}$/.test(fields.buildId)) result.buildId = fields.buildId;
  if (typeof fields.target === 'string' && /^[a-z0-9-]{1,64}$/.test(fields.target)) result.target = fields.target;
  if (fields.verification === 'flash-verified') result.verification = fields.verification;
  if (fields.physicalOutput === 'unconfirmed') result.physicalOutput = fields.physicalOutput;
  if (fields.pipelineComplete === false) result.pipelineComplete = false;
  if (typeof fields.expectedCardId === 'string' && /^lw-[a-f0-9]{12}$/.test(fields.expectedCardId)) result.expectedCardId = fields.expectedCardId;
  if (fields.nextCheckpoint === 'stable-card-identity-acknowledged') result.nextCheckpoint = fields.nextCheckpoint;
  if (['recoverable-failure', 'needs-safe-recovery', 'usb-ownership-uncertain'].includes(fields.classification)) result.classification = fields.classification;
  if (typeof fields.phase === 'string' && /^[a-z0-9-]{1,48}$/.test(fields.phase)) result.phase = fields.phase;
  if (typeof fields.nextAction === 'string' && /^[a-z0-9-]{1,64}$/.test(fields.nextAction)) result.nextAction = fields.nextAction;
  return Object.freeze(result);
}

module.exports = {
  OPERATIONS,
  createRendererResult,
  redactSensitiveText,
  validateOperation,
  validateToken,
};
