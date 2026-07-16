'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

const JOURNAL_VERSION = 1;
const JOURNAL_MAX_BYTES = 4096;
const OPERATIONS = new Set(['install-current-release', 'recover-current-release']);
const BOUNDARIES = new Set(['before-mutation', 'erase-or-write-started']);
const VERIFICATIONS = new Set(['not-verified', 'flash-verified']);
const RESTART_RESULTS = new Set(['not-attempted', 'restarted', 'failed', 'unknown']);
const USB_STATES = new Set(['not-acquired', 'acquiring-or-owned', 'owned', 'released', 'uncertain']);
const RECORD_KEYS = ['completionCorrelation', 'expectedBuildId', 'expectedCardId', 'flashVerification', 'mutationBoundary', 'operation', 'pendingResult', 'restartResult', 'timestamps', 'usbOwnership', 'version'];
const UPDATE_KEYS = new Set(['completionCorrelation', 'flashVerification', 'mutationBoundary', 'pendingResult', 'restartResult', 'usbOwnership']);
const RESULT_KEYS = ['buildId', 'cardId', 'expectedCardId', 'firmwareVersion', 'message', 'nextCheckpoint', 'physicalOutput', 'pipelineComplete', 'state', 'target', 'verification'];
const CORRELATION_KEYS = ['buildId', 'cardId', 'firmwareVersion', 'operation', 'receiptHash', 'target', 'verification'];
const CARD_ID = /^lw-[a-f0-9]{12}$/;
const BUILD_ID = /^[a-f0-9]{40}$/;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validatePendingResult(result, record) {
  if (result === null) return;
  if (!exactKeys(result, RESULT_KEYS)
    || result.state !== 'awaiting-card-acknowledgement'
    || result.pipelineComplete !== false
    || result.cardId !== record.expectedCardId || result.expectedCardId !== record.expectedCardId
    || result.buildId !== record.expectedBuildId
    || typeof result.firmwareVersion !== 'string' || !/^[0-9A-Za-z.+-]{1,32}$/.test(result.firmwareVersion)
    || result.target !== 'lightweaver-controller-esp32s3'
    || result.verification !== 'flash-verified' || result.physicalOutput !== 'unconfirmed'
    || result.nextCheckpoint !== 'stable-card-identity-acknowledged'
    || result.message !== 'Flash verified. Reconnect in Studio and confirm the physical lights.') {
    throw new Error('Operation journal pending result is invalid');
  }
}

function validateRecord(record) {
  if (!exactKeys(record, RECORD_KEYS)) throw new Error('Operation journal is invalid');
  if (record.version !== JOURNAL_VERSION) throw new Error('Operation journal version is incompatible');
  if (!OPERATIONS.has(record.operation) || !CARD_ID.test(record.expectedCardId) || !BUILD_ID.test(record.expectedBuildId)
    || !BOUNDARIES.has(record.mutationBoundary) || !VERIFICATIONS.has(record.flashVerification)
    || !RESTART_RESULTS.has(record.restartResult) || !USB_STATES.has(record.usbOwnership)
    || !exactKeys(record.timestamps, ['createdAt', 'updatedAt'])
    || !Number.isSafeInteger(record.timestamps.createdAt) || record.timestamps.createdAt < 0
    || !Number.isSafeInteger(record.timestamps.updatedAt) || record.timestamps.updatedAt < record.timestamps.createdAt) {
    throw new Error('Operation journal is invalid');
  }
  if (record.flashVerification === 'flash-verified' && record.mutationBoundary !== 'erase-or-write-started') {
    throw new Error('Operation journal is semantically invalid');
  }
  if (record.restartResult === 'restarted' && record.flashVerification !== 'flash-verified') {
    throw new Error('Operation journal is semantically invalid');
  }
  validatePendingResult(record.pendingResult, record);
  if (record.pendingResult && record.flashVerification !== 'flash-verified') {
    throw new Error('Operation journal is semantically invalid');
  }
  if (record.completionCorrelation !== null) {
    const value = record.completionCorrelation;
    if (!exactKeys(value, CORRELATION_KEYS) || !/^[a-f0-9]{64}$/.test(value.receiptHash)
      || value.operation !== record.operation || value.cardId !== record.expectedCardId
      || value.buildId !== record.expectedBuildId || value.firmwareVersion !== record.pendingResult?.firmwareVersion
      || value.target !== record.pendingResult?.target || value.verification !== record.pendingResult?.verification) {
      throw new Error('Operation journal completion correlation is invalid');
    }
  }
  return record;
}

function deepFreeze(record) {
  if (!record) return null;
  if (record.pendingResult) Object.freeze(record.pendingResult);
  if (record.completionCorrelation) Object.freeze(record.completionCorrelation);
  Object.freeze(record.timestamps);
  return Object.freeze(record);
}

function createOperationJournal({ userDataPath, now = Date.now, fs = nodeFs, randomBytes = crypto.randomBytes } = {}) {
  if (typeof userDataPath !== 'string' || !userDataPath) throw new TypeError('A userData path is required');
  const file = path.join(userDataPath, 'operation-journal.json');

  function load() {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > JOURNAL_MAX_BYTES) throw new Error('Operation journal is too large');
      const data = fs.readFileSync(file, 'utf8');
      if (Buffer.byteLength(data) > JOURNAL_MAX_BYTES) throw new Error('Operation journal is too large');
      return deepFreeze(validateRecord(JSON.parse(data)));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new Error('Operation journal is invalid');
      throw error;
    }
  }

  function persist(record) {
    validateRecord(record);
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > JOURNAL_MAX_BYTES) throw new Error('Operation journal is too large');
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let descriptor;
    try {
      fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      descriptor = fs.openSync(temporary, 'r');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
      try { fs.chmodSync(file, 0o600); } catch (error) { if (process.platform !== 'win32') throw error; }
      const directoryDescriptor = fs.openSync(userDataPath, 'r');
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    return deepFreeze(JSON.parse(data));
  }

  function clear() {
    try { fs.unlinkSync(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  }

  return Object.freeze({
    load,
    begin({ operation, expectedCardId, expectedBuildId } = {}) {
      if (load()) throw new Error('An operation journal is already active');
      const timestamp = now();
      return persist({
        version: JOURNAL_VERSION, operation, expectedCardId, expectedBuildId,
        mutationBoundary: 'before-mutation', flashVerification: 'not-verified',
        restartResult: 'not-attempted', usbOwnership: 'not-acquired', pendingResult: null, completionCorrelation: null,
        timestamps: { createdAt: timestamp, updatedAt: timestamp },
      });
    },
    replaceForRecovery({ operation, expectedCardId, expectedBuildId } = {}) {
      const current = load();
      if (!current || current.mutationBoundary !== 'erase-or-write-started' || current.flashVerification !== 'not-verified'
        || operation !== 'recover-current-release' || expectedCardId !== current.expectedCardId) {
        throw new Error('Operation journal cannot be replaced for recovery');
      }
      const previousBytes = fs.readFileSync(file);
      const timestamp = now();
      try {
        return persist({
          version: JOURNAL_VERSION, operation, expectedCardId, expectedBuildId,
          mutationBoundary: 'before-mutation', flashVerification: 'not-verified',
          restartResult: 'not-attempted', usbOwnership: 'not-acquired', pendingResult: null, completionCorrelation: null,
          timestamps: { createdAt: timestamp, updatedAt: timestamp },
        });
      } catch (error) {
        let temporary;
        let descriptor;
        try {
          if (!fs.existsSync(file) || !fs.readFileSync(file).equals(previousBytes)) {
            temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.restore.tmp`;
            fs.writeFileSync(temporary, previousBytes, { mode: 0o600, flag: 'wx' });
            descriptor = fs.openSync(temporary, 'r');
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(temporary, file);
            try { fs.chmodSync(file, 0o600); } catch (chmodError) { if (process.platform !== 'win32') throw chmodError; }
            const directoryDescriptor = fs.openSync(userDataPath, 'r');
            try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
          }
        } catch {}
        finally {
          if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
          if (temporary) try { fs.unlinkSync(temporary); } catch {}
        }
        throw error;
      }
    },
    update(fields = {}) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)
        || Object.keys(fields).some(key => !UPDATE_KEYS.has(key))) throw new Error('Operation journal update contains an invalid field');
      const current = load();
      if (!current) throw new Error('No active operation journal');
      return persist({ ...current, ...fields, timestamps: { ...current.timestamps, updatedAt: now() } });
    },
    clear,
    get file() { return file; },
  });
}

module.exports = { JOURNAL_MAX_BYTES, JOURNAL_VERSION, createOperationJournal };
