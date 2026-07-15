'use strict';

const { redactSensitiveText, validateOperation } = require('./protocol');

const CARD_ID_PATTERN = /^lw-[a-f0-9]{12}$/;
const DESTRUCTIVE_OPERATIONS = new Set(['install-current-release', 'recover-current-release']);

class BridgeOperationError extends Error {
  constructor(code, message, { mutation = 'none', outcome = 'recoverable-failure' } = {}) {
    super(redactSensitiveText(message, 256) || 'Bridge operation failed');
    this.name = 'BridgeOperationError';
    this.code = code;
    this.mutation = mutation;
    this.outcome = outcome;
  }
}

function classifyDiscoveryError(error) {
  const message = String(error?.message || 'Card inspection failed');
  if (/USB release failed/i.test(message)) return new BridgeOperationError('usb-release-failed', message, { outcome: 'usb-ownership-uncertain' });
  if (/multiple/i.test(message)) return new BridgeOperationError('multiple-compatible-cards', 'Multiple compatible cards are connected. Disconnect all but one and inspect again.');
  if (/\bno\b.*(?:candidate|card|port)|not found/i.test(message)) return new BridgeOperationError('no-compatible-card', 'No compatible Lightweaver card was found.');
  return new BridgeOperationError('inspection-failed', message);
}

function classifyExecutionError(error, eraseStarted) {
  if (error instanceof BridgeOperationError) return error;
  const message = String(error?.message || 'Installation failed');
  if (!eraseStarted) {
    if (/USB release failed/i.test(message)) return new BridgeOperationError('usb-release-failed', message, { outcome: 'usb-ownership-uncertain' });
    const code = /disconnect|device.*lost|not open/i.test(message) ? 'card-disconnected' : 'preflight-failed';
    return new BridgeOperationError(code, message);
  }
  if (/md5|hash|verif/i.test(message)) {
    return new BridgeOperationError('flash-verification-failed', message, { mutation: 'uncertain', outcome: 'needs-safe-recovery' });
  }
  return new BridgeOperationError('installation-interrupted', message, { mutation: 'uncertain', outcome: 'needs-safe-recovery' });
}

function publicInspection(identity) {
  return Object.freeze({ compatible: true, cardId: identity.cardId, productName: 'Lightweaver ESP32-S3 card' });
}

function createOperationRunner({
  runtime,
  core,
  loadRelease,
  now = Date.now,
  randomBytes,
  inspectionTtlMs = 60_000,
  confirmationTtlMs = 120_000,
} = {}) {
  if (!runtime || !core || typeof loadRelease !== 'function' || typeof randomBytes !== 'function') {
    throw new TypeError('Operation runner dependencies are incomplete');
  }
  if (confirmationTtlMs > 120_000 || confirmationTtlMs <= 0) throw new RangeError('Confirmation lifetime must be at most two minutes');
  let inspection = null;
  let verifiedRelease = null;
  let authority = null;
  let active = false;

  function emit(onEvent, checkpoint, fields = {}) {
    onEvent?.(Object.freeze({ checkpoint, ...fields }));
  }

  function assertFreshInspection() {
    if (!inspection || inspection.expiresAt <= now()) {
      inspection = null;
      authority = null;
      verifiedRelease = null;
      throw new BridgeOperationError('stale-inspection', 'Card inspection has expired. Inspect the card again.');
    }
    return inspection;
  }

  async function exclusive(work) {
    if (active) throw new BridgeOperationError('operation-active', 'Another bridge operation is already active.');
    active = true;
    try { return await work(); } finally { active = false; }
  }

  async function inspect({ onEvent } = {}) {
    return exclusive(async () => {
      authority = null;
      verifiedRelease = null;
      inspection = null;
      emit(onEvent, 'environment-selected', { environment: 'native-usb' });
      let identity;
      try {
        identity = await runtime.inspectOne();
        core.validateInstallHardware(identity);
      } catch (error) {
        throw classifyDiscoveryError(error);
      }
      if (!CARD_ID_PATTERN.test(identity?.cardId) || typeof identity.fingerprint !== 'string' || identity.fingerprint.length > 128) {
        throw new BridgeOperationError('identity-invalid', 'The connected card identity could not be verified.');
      }
      inspection = Object.freeze({
        cardId: identity.cardId,
        fingerprint: identity.fingerprint,
        expiresAt: now() + inspectionTtlMs,
      });
      emit(onEvent, 'compatible-card-identified', { cardId: inspection.cardId });
      emit(onEvent, 'usb-released');
      return publicInspection(inspection);
    });
  }

  async function prepare(operation, { onEvent } = {}) {
    validateOperation(operation);
    if (!DESTRUCTIVE_OPERATIONS.has(operation)) throw new BridgeOperationError('unsupported-operation', 'Unsupported destructive bridge operation');
    return exclusive(async () => {
      const selected = assertFreshInspection();
      let release;
      try {
        release = await loadRelease();
        core.validateProductionInstallRelease(release);
      } catch (error) {
        throw new BridgeOperationError('release-verification-failed', error?.message || 'Signed firmware release verification failed');
      }
      emit(onEvent, 'release-verified', {
        firmwareVersion: release.manifest.firmwareVersion,
        buildId: release.manifest.buildId,
        target: release.manifest.target,
      });
      const token = randomBytes(24).toString('hex');
      verifiedRelease = release;
      authority = Object.freeze({
        token,
        operation,
        cardId: selected.cardId,
        buildId: release.manifest.buildId,
        expiresAt: now() + confirmationTtlMs,
      });
      return Object.freeze({
        confirmationToken: token,
        cardId: selected.cardId,
        firmwareVersion: release.manifest.firmwareVersion,
        buildId: release.manifest.buildId,
        warning: 'Factory install replaces the card configuration.',
      });
    });
  }

  async function execute({ operation, cardId, token, onEvent } = {}) {
    validateOperation(operation);
    if (!DESTRUCTIVE_OPERATIONS.has(operation)) throw new BridgeOperationError('unsupported-operation', 'Unsupported destructive bridge operation');
    return exclusive(async () => {
      if (!authority || authority.token !== token || authority.operation !== operation || authority.cardId !== cardId || authority.buildId !== verifiedRelease?.manifest?.buildId) {
        throw new BridgeOperationError('confirmation-mismatch', 'Confirmation token was already used or does not match this card and operation.');
      }
      if (authority.expiresAt <= now()) {
        authority = null;
        throw new BridgeOperationError('confirmation-expired', 'Confirmation token has expired.');
      }
      const selected = assertFreshInspection();
      authority = null;
      emit(onEvent, 'destructive-action-confirmed', { cardId: selected.cardId });

      let connection = null;
      let eraseStarted = false;
      let primaryError = null;
      let result;
      try {
        connection = await runtime.connectForWrite();
        const current = connection.identity;
        core.validateInstallHardware(current);
        if (current?.cardId !== selected.cardId || current?.fingerprint !== selected.fingerprint) {
          throw new BridgeOperationError('card-changed', 'The inspected card changed or was swapped. Nothing was erased.');
        }
        emit(onEvent, 'compatible-card-identified', { cardId: selected.cardId });
        eraseStarted = true;
        emit(onEvent, 'erase-started', { progress: 0 });
        await core.writeVerifiedFlash(connection.loader, {
          fileArray: [{ data: verifiedRelease.bytes, address: 0 }],
          flashSize: 'keep',
          flashMode: 'keep',
          flashFreq: 'keep',
          eraseAll: true,
          compress: true,
          reportProgress: (_index, written, total) => emit(onEvent, 'erase-started', {
            progress: total > 0 ? Math.min(99, Math.round((written / total) * 100)) : 0,
          }),
        });
        emit(onEvent, 'write-completed', { progress: 100 });
        emit(onEvent, 'flash-verification-completed', { verification: 'flash-verified' });
        try {
          await runtime.reset(connection);
        } catch (error) {
          throw new BridgeOperationError('restart-failed', error?.message || 'Card restart failed', { mutation: 'written', outcome: 'needs-safe-recovery' });
        }
        emit(onEvent, 'card-restarted');
        result = Object.freeze({
          cardId: selected.cardId,
          firmwareVersion: verifiedRelease.manifest.firmwareVersion,
          buildId: verifiedRelease.manifest.buildId,
          target: verifiedRelease.manifest.target,
          verification: 'flash-verified',
          physicalOutput: 'unconfirmed',
          message: 'Flash verified. Reconnect in Studio and confirm the physical lights.',
        });
      } catch (error) {
        primaryError = classifyExecutionError(error, eraseStarted);
      } finally {
        if (connection?.transport) {
          try {
            await connection.transport.disconnect();
            emit(onEvent, 'usb-released');
          } catch (error) {
            primaryError = new BridgeOperationError('usb-release-failed', error?.message || 'USB release failed', {
              mutation: eraseStarted ? 'uncertain' : 'none',
              outcome: eraseStarted ? 'needs-safe-recovery' : 'usb-ownership-uncertain',
            });
          }
        }
        inspection = null;
        verifiedRelease = null;
      }
      if (primaryError) throw primaryError;
      return result;
    });
  }

  return Object.freeze({ inspect, prepare, execute, hasInspection: () => Boolean(inspection && inspection.expiresAt > now()) });
}

module.exports = { BridgeOperationError, createOperationRunner };
