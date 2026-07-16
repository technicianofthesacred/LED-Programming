'use strict';

const crypto = require('node:crypto');
const { redactSensitiveText, validateOperation } = require('./protocol');

const CARD_ID_PATTERN = /^lw-[a-f0-9]{12}$/;
const DESTRUCTIVE_OPERATIONS = new Set(['install-current-release', 'recover-current-release']);
const MUTATING_LOADER_METHODS = Object.freeze(['eraseFlash', 'flashDeflBegin', 'flashBegin']);

class BridgeOperationError extends Error {
  constructor(code, message, { mutation = 'none', outcome = 'recoverable-failure', phase, nextAction } = {}) {
    super(redactSensitiveText(message, 256) || 'Bridge operation failed');
    this.name = 'BridgeOperationError';
    this.code = code;
    this.mutation = mutation;
    this.outcome = outcome;
    this.classification = outcome;
    this.phase = phase || (outcome === 'needs-safe-recovery' ? 'after-erase' : outcome === 'usb-ownership-uncertain' ? 'usb-release' : 'before-erase');
    this.nextAction = nextAction || (outcome === 'needs-safe-recovery' ? 'recover-current-release' : outcome === 'usb-ownership-uncertain' ? 'restart-bridge-before-retrying' : 'inspect-again');
  }
}

function classifyDiscoveryError(error) {
  const message = String(error?.message || 'Card inspection failed');
  if (error?.code === 'usb-release-failed' || /USB release failed/i.test(message)) return new BridgeOperationError('usb-release-failed', message, { outcome: 'usb-ownership-uncertain' });
  if (error?.code === 'card-restoration-failed') {
    return new BridgeOperationError('card-restoration-failed', message, {
      phase: 'inspection-restoration',
      nextAction: 'unplug-replug-card',
    });
  }
  if (/multiple/i.test(message)) return new BridgeOperationError('multiple-compatible-cards', 'Multiple compatible cards are connected. Disconnect all but one and inspect again.', { phase: 'inspection' });
  if (/\bno\b.*(?:candidate|card|port)|not found/i.test(message)) return new BridgeOperationError('no-compatible-card', 'No compatible Lightweaver card was found.', { phase: 'inspection' });
  return new BridgeOperationError('inspection-failed', message, { phase: 'inspection' });
}

function classifyExecutionError(error, eraseStarted) {
  if (error instanceof BridgeOperationError && !eraseStarted) return error;
  if (error instanceof BridgeOperationError && error.outcome === 'needs-safe-recovery') return error;
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

function trackFlashMutation(loader, onMutationStart) {
  const required = loader?.IS_STUB === true ? ['eraseFlash', 'flashDeflBegin'] : ['flashDeflBegin'];
  for (const name of required) {
    if (typeof loader?.[name] !== 'function') {
      throw new BridgeOperationError('write-capability-missing', 'The connected card is missing a required flash method. Nothing was erased.');
    }
  }

  const originals = [];
  try {
    for (const name of MUTATING_LOADER_METHODS) {
      const method = loader[name];
      if (typeof method !== 'function') continue;
      const descriptor = Object.getOwnPropertyDescriptor(loader, name);
      const wrapped = function trackedFlashMutation(...args) {
        onMutationStart();
        return method.apply(this, args);
      };
      Object.defineProperty(loader, name, {
        configurable: descriptor?.configurable ?? true,
        enumerable: descriptor?.enumerable ?? false,
        writable: descriptor?.writable ?? true,
        value: wrapped,
      });
      originals.push({ name, descriptor });
    }
  } catch (error) {
    restoreFlashMethods(loader, originals);
    throw new BridgeOperationError('write-capability-missing', error?.message || 'Flash methods could not be tracked. Nothing was erased.');
  }
  return () => restoreFlashMethods(loader, originals);
}

function restoreFlashMethods(loader, originals) {
  for (const { name, descriptor } of originals.reverse()) {
    if (descriptor) Object.defineProperty(loader, name, descriptor);
    else delete loader[name];
  }
}

function trackFlashVerification(loader, expectedHash, onVerified) {
  if (typeof loader?.flashMd5sum !== 'function') return () => {};
  const descriptor = Object.getOwnPropertyDescriptor(loader, 'flashMd5sum');
  const method = loader.flashMd5sum;
  const wrapped = async function trackedFlashVerification(...args) {
    const actual = await method.apply(this, args);
    if (typeof actual === 'string' && actual.toLowerCase() === expectedHash) onVerified();
    return actual;
  };
  Object.defineProperty(loader, 'flashMd5sum', {
    configurable: descriptor?.configurable ?? true,
    enumerable: descriptor?.enumerable ?? false,
    writable: descriptor?.writable ?? true,
    value: wrapped,
  });
  return () => {
    if (descriptor) Object.defineProperty(loader, 'flashMd5sum', descriptor);
    else delete loader.flashMd5sum;
  };
}

function createOperationRunner({
  runtime,
  core,
  loadRelease,
  now = Date.now,
  randomBytes,
  journal = null,
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

  function journalUpdate(fields) {
    return journal?.update?.(fields);
  }

  function emit(onEvent, checkpoint, fields = {}) {
    try { onEvent?.(Object.freeze({ checkpoint, ...fields })); } catch {}
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
      return publicInspection(inspection);
    });
  }

  async function prepare(operation, { onEvent } = {}) {
    validateOperation(operation);
    if (!DESTRUCTIVE_OPERATIONS.has(operation)) throw new BridgeOperationError('unsupported-operation', 'Unsupported destructive bridge operation');
    return exclusive(async () => {
      const selected = assertFreshInspection();
      const interrupted = journal?.load?.();
      if (interrupted) {
        if (interrupted.flashVerification === 'flash-verified') {
          throw new BridgeOperationError('operation-result-pending', 'The verified operation result must be acknowledged or explicitly dismissed before another operation.', {
            phase: 'result-pending', nextAction: 'return-to-studio',
          });
        }
        if (operation !== 'recover-current-release' || interrupted.mutationBoundary !== 'erase-or-write-started'
          || interrupted.expectedCardId !== selected.cardId) {
          throw new BridgeOperationError('interrupted-operation-pending', 'The interrupted operation must be safely recovered on its expected card.', {
            outcome: 'needs-safe-recovery', phase: 'restart-recovery', nextAction: 'recover-current-release',
          });
        }
      }
      let release;
      try {
        release = await loadRelease();
        core.validateProductionInstallRelease(release);
      } catch (error) {
        throw new BridgeOperationError('release-verification-failed', error?.message || 'Signed firmware release verification failed', { phase: 'release-verification' });
      }
      emit(onEvent, 'release-verified', {
        firmwareVersion: release.manifest.firmwareVersion,
        buildId: release.manifest.buildId,
        target: release.manifest.target,
      });
      emit(onEvent, 'compatible-card-identified', { cardId: selected.cardId });
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
      let flashVerified = false;
      let cardRestarted = false;
      let journalArmed = false;
      let journalCreatedFresh = false;
      let preexistingJournal = false;
      let primaryError = null;
      let result;
      try {
        const journalStart = {
          operation,
          expectedCardId: selected.cardId,
          expectedBuildId: verifiedRelease.manifest.buildId,
        };
        const interrupted = journal?.load?.();
        preexistingJournal = Boolean(interrupted);
        if (!interrupted) {
          journal?.begin?.(journalStart);
          journalArmed = Boolean(journal);
          journalCreatedFresh = journalArmed;
          journalUpdate({ usbOwnership: 'acquiring-or-owned' });
        } else {
          journal?.markRecoveryAcquiring?.({ expectedCardId: selected.cardId });
        }
        connection = await runtime.connectForWrite();
        const current = connection.identity;
        core.validateInstallHardware(current);
        if (current?.cardId !== selected.cardId || current?.fingerprint !== selected.fingerprint) {
          throw new BridgeOperationError('card-changed', 'The inspected card changed or was swapped. Nothing was erased.');
        }
        if (typeof connection.loader?.writeFlash !== 'function') {
          throw new BridgeOperationError('write-capability-missing', 'The connected card cannot be written. Nothing was erased.');
        }
        if (interrupted) {
          try {
            journal.replaceForRecovery(journalStart);
          } catch (error) {
            throw new BridgeOperationError('recovery-journal-activation-uncertain', error?.message || 'Recovery journal activation failed', {
              mutation: 'uncertain', outcome: 'needs-safe-recovery', phase: 'recovery-journal-activation',
              nextAction: 'recover-current-release',
            });
          }
          journalArmed = true;
        }
        journalUpdate({ usbOwnership: 'owned' });
        const writeOptions = {
          fileArray: [{ data: verifiedRelease.bytes, address: 0 }],
          flashSize: 'keep',
          flashMode: 'keep',
          flashFreq: 'keep',
          eraseAll: true,
          compress: true,
          reportProgress: (_index, written, total) => {
            try {
              onEvent?.(Object.freeze({
                phase: 'write',
                progress: total > 0 ? Math.min(99, Math.round((written / total) * 100)) : 0,
              }));
            } catch {}
          },
        };
        result = Object.freeze({
          state: 'awaiting-card-acknowledgement',
          pipelineComplete: false,
          cardId: selected.cardId,
          expectedCardId: selected.cardId,
          firmwareVersion: verifiedRelease.manifest.firmwareVersion,
          buildId: verifiedRelease.manifest.buildId,
          target: verifiedRelease.manifest.target,
          verification: 'flash-verified',
          physicalOutput: 'unconfirmed',
          nextCheckpoint: 'stable-card-identity-acknowledged',
          message: 'Flash verified. Reconnect in Studio and confirm the physical lights.',
        });
        const markFlashVerified = () => {
          if (flashVerified) return;
          journalUpdate({ flashVerification: 'flash-verified', pendingResult: result });
          flashVerified = true;
        };
        const restoreMutationMethods = trackFlashMutation(connection.loader, () => {
          if (eraseStarted) return;
          journalUpdate({ mutationBoundary: 'erase-or-write-started' });
          eraseStarted = true;
          emit(onEvent, 'erase-started', { progress: 0 });
        });
        const expectedHash = crypto.createHash('md5').update(verifiedRelease.bytes).digest('hex');
        let restoreVerificationMethod = () => {};
        try {
          restoreVerificationMethod = trackFlashVerification(connection.loader, expectedHash, markFlashVerified);
          await core.writeVerifiedFlash(connection.loader, writeOptions);
        } finally {
          restoreVerificationMethod();
          restoreMutationMethods();
        }
        if (!eraseStarted) {
          throw new BridgeOperationError('write-not-started', 'The verified flash operation ended before writing began. Nothing was erased.');
        }
        markFlashVerified();
        emit(onEvent, 'write-completed', { progress: 100 });
        emit(onEvent, 'flash-verification-completed', { verification: 'flash-verified' });
        try {
          await runtime.reset(connection);
        } catch (error) {
          throw new BridgeOperationError('restart-failed', error?.message || 'Card restart failed', { mutation: 'written', outcome: 'needs-safe-recovery' });
        }
        cardRestarted = true;
        journalUpdate({ restartResult: 'restarted' });
        emit(onEvent, 'card-restarted');
      } catch (error) {
        primaryError = classifyExecutionError(error, eraseStarted);
        if ((journalArmed || preexistingJournal) && !connection) {
          if (journalArmed) try { journalUpdate({ usbOwnership: 'uncertain' }); } catch {}
          primaryError = new BridgeOperationError('usb-acquisition-uncertain', 'USB acquisition did not return a confirmed release state.', {
            outcome: 'usb-ownership-uncertain', phase: 'usb-acquire', nextAction: 'restart-bridge-before-retrying',
          });
        }
        if (eraseStarted && !flashVerified) {
          try { journalUpdate({ restartResult: 'unknown' }); } catch (journalError) { primaryError = classifyExecutionError(journalError, true); }
        } else if (flashVerified && !cardRestarted) {
          try { journalUpdate({ restartResult: 'failed' }); } catch (journalError) { primaryError = classifyExecutionError(journalError, true); }
        }
      } finally {
        if (connection?.transport) {
          try {
            await connection.transport.disconnect();
            if (journalArmed) journalUpdate({ usbOwnership: 'released' });
            else if (preexistingJournal) journal?.clearRecoveryAcquisition?.();
            emit(onEvent, 'usb-released');
          } catch (error) {
            const verifiedAndRestarted = flashVerified && cardRestarted;
            primaryError = new BridgeOperationError('usb-release-failed', error?.message || 'USB release failed', {
              mutation: verifiedAndRestarted ? 'written' : eraseStarted ? 'uncertain' : 'none',
              outcome: verifiedAndRestarted || !eraseStarted ? 'usb-ownership-uncertain' : 'needs-safe-recovery',
              phase: 'usb-release',
              nextAction: verifiedAndRestarted ? 'restart-bridge-or-unplug-replug-card' : eraseStarted ? 'recover-current-release' : 'restart-bridge-before-retrying',
            });
            if (verifiedAndRestarted) {
              Object.assign(primaryError, {
                verification: 'flash-verified',
                physicalOutput: 'unconfirmed',
                pipelineComplete: false,
                expectedCardId: selected.cardId,
                firmwareVersion: verifiedRelease.manifest.firmwareVersion,
                buildId: verifiedRelease.manifest.buildId,
                target: verifiedRelease.manifest.target,
                nextCheckpoint: 'stable-card-identity-acknowledged',
              });
            }
            if (journalArmed) try { journalUpdate({ usbOwnership: 'uncertain' }); } catch {}
          }
        }
        if (journalCreatedFresh && !eraseStarted && primaryError?.classification !== 'usb-ownership-uncertain') {
          try { journal?.clear?.(); } catch (error) { if (!primaryError) primaryError = classifyExecutionError(error, false); }
        }
        inspection = null;
        verifiedRelease = null;
      }
      if (primaryError) throw primaryError;
      return result;
    });
  }

  async function runMaintenance(operation) {
    validateOperation(operation);
    if (operation === 'inspect-compatible-card') return inspect();
    if (operation === 'restart-card') {
      return exclusive(async () => {
        let identity;
        try {
          identity = await runtime.restartOne();
          core.validateInstallHardware(identity);
        } catch (error) { throw classifyDiscoveryError(error); }
        return Object.freeze({ ...publicInspection(identity), restarted: true });
      });
    }
    if (operation === 'release-usb') {
      return exclusive(async () => {
        try { await runtime.releaseUsb(); } catch (error) { throw classifyDiscoveryError(error); }
        inspection = null;
        authority = null;
        verifiedRelease = null;
        return Object.freeze({ released: true });
      });
    }
    throw new BridgeOperationError('unsupported-operation', 'Unsupported maintenance bridge operation');
  }

  async function recoverInterrupted() {
    return exclusive(async () => {
      const saved = journal?.load?.();
      if (!saved) return null;
      let identity;
      try {
        identity = await runtime.inspectOne();
        core.validateInstallHardware(identity);
      } catch (error) {
        try { journalUpdate({ usbOwnership: 'uncertain' }); } catch {}
        if (saved.flashVerification === 'flash-verified' && saved.pendingResult) return Object.freeze({ ...saved.pendingResult, ...recoveredContextFrom(saved) });
        throw new BridgeOperationError('recovery-inspection-failed', 'The interrupted operation could not inspect and release its expected card.', {
          mutation: saved.mutationBoundary === 'before-mutation' ? 'none' : 'uncertain',
          outcome: saved.mutationBoundary === 'before-mutation' ? 'recoverable-failure' : 'needs-safe-recovery',
          phase: 'restart-recovery',
          nextAction: saved.mutationBoundary === 'before-mutation' ? 'inspect-again' : 'recover-current-release',
        });
      }
      if (identity?.cardId !== saved.expectedCardId) {
        try { journalUpdate({ usbOwnership: 'uncertain' }); } catch {}
        if (saved.flashVerification === 'flash-verified' && saved.pendingResult) return Object.freeze({ ...saved.pendingResult, ...recoveredContextFrom(saved) });
        throw new BridgeOperationError('recovery-card-mismatch', 'The connected card does not match the interrupted operation.', {
          mutation: saved.mutationBoundary === 'before-mutation' ? 'none' : 'uncertain',
          outcome: saved.mutationBoundary === 'before-mutation' ? 'recoverable-failure' : 'needs-safe-recovery',
          phase: 'restart-recovery',
          nextAction: saved.mutationBoundary === 'before-mutation' ? 'inspect-again' : 'recover-current-release',
        });
      }
      journalUpdate(saved.flashVerification === 'flash-verified'
        ? { restartResult: 'restarted', usbOwnership: 'released' }
        : { usbOwnership: 'released' });
      if (saved.flashVerification === 'flash-verified' && saved.pendingResult) {
        return Object.freeze({ ...saved.pendingResult, ...recoveredContextFrom(journal.load()) });
      }
      if (saved.mutationBoundary === 'before-mutation') {
        journal.clear();
        return null;
      }
      throw new BridgeOperationError('installation-interrupted', 'Installation was interrupted after mutation began.', {
        mutation: 'uncertain', outcome: 'needs-safe-recovery', phase: 'restart-recovery', nextAction: 'recover-current-release',
      });
    });
  }

  function completionTupleMatches(saved, value) {
    if (!saved?.completionCorrelation || !value || typeof value !== 'object') return false;
    return ['receiptHash', 'operation', 'cardId', 'firmwareVersion', 'buildId', 'target', 'verification']
      .every(field => saved.completionCorrelation[field] === value[field]);
  }

  function recoveredContextFrom(saved) {
    if (!saved?.pendingResult || saved.flashVerification !== 'flash-verified' || saved.restartResult !== 'restarted') return null;
    const tuple = {
      operation: saved.operation,
      cardId: saved.expectedCardId,
      firmwareVersion: saved.pendingResult.firmwareVersion,
      buildId: saved.expectedBuildId,
      target: saved.pendingResult.target,
      verification: saved.pendingResult.verification,
    };
    const identity = crypto.createHash('sha256').update(JSON.stringify({
      ...tuple, generationId: saved.generationId, receiptHash: saved.completionCorrelation?.receiptHash || 'local-recovery',
    })).digest('hex');
    return Object.freeze({ ...tuple, resultIdentityHash: identity });
  }

  function recoveredResultContext() {
    return recoveredContextFrom(journal?.load?.());
  }

  function bindCompletedResult(value) {
    const saved = journal?.load?.();
    if (!saved || saved.flashVerification !== 'flash-verified' || saved.restartResult !== 'restarted' || !saved.pendingResult
      || value?.operation !== saved.operation || value?.cardId !== saved.expectedCardId
      || value?.firmwareVersion !== saved.pendingResult.firmwareVersion || value?.buildId !== saved.expectedBuildId
      || value?.target !== saved.pendingResult.target || value?.verification !== saved.pendingResult.verification
      || typeof value?.receiptHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.receiptHash)) return false;
    journal.update({ completionCorrelation: Object.freeze({ ...value }) });
    return true;
  }

  function acknowledgeResult(value) {
    const saved = journal?.load?.();
    if (!completionTupleMatches(saved, value)) return false;
    const cleared = journal.clear();
    return cleared === true || cleared?.cleared === true;
  }

  function dismissCompletedResult(value) {
    const saved = journal?.load?.();
    const expected = recoveredContextFrom(saved);
    if (!expected || !value || value.confirmed !== true
      || Object.keys(value).sort().join(',') !== [...Object.keys(expected), 'confirmed'].sort().join(',')
      || Object.keys(expected).some(field => value[field] !== expected[field])) return false;
    const cleared = journal.clear();
    return cleared === true || cleared?.cleared === true;
  }

  return Object.freeze({
    inspect, prepare, execute, runMaintenance, recoverInterrupted,
    bindCompletedResult, acknowledgeResult, dismissCompletedResult, recoveredResultContext,
    hasInterruptedOperation: () => Boolean(journal?.load?.()),
    hasInspection: () => Boolean(inspection && inspection.expiresAt > now()),
    isActive: () => active,
  });
}

module.exports = { BridgeOperationError, createOperationRunner };
