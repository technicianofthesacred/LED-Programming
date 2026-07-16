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
const RECORD_KEYS = ['completionCorrelation', 'expectedBuildId', 'expectedCardId', 'flashVerification', 'generationId', 'mutationBoundary', 'operation', 'pendingResult', 'restartResult', 'timestamps', 'usbOwnership', 'version'];
const UPDATE_KEYS = new Set(['completionCorrelation', 'flashVerification', 'mutationBoundary', 'pendingResult', 'restartResult', 'usbOwnership']);
const RESULT_KEYS = ['buildId', 'cardId', 'expectedCardId', 'firmwareVersion', 'message', 'nextCheckpoint', 'physicalOutput', 'pipelineComplete', 'state', 'target', 'verification'];
const CORRELATION_KEYS = ['buildId', 'cardId', 'firmwareVersion', 'operation', 'receiptHash', 'target', 'verification'];
const CARD_ID = /^lw-[a-f0-9]{12}$/;
const BUILD_ID = /^[a-f0-9]{40}$/;
const GENERATION_ID = /^[a-f0-9]{32}$/;

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
  if (!GENERATION_ID.test(record.generationId) || !OPERATIONS.has(record.operation) || !CARD_ID.test(record.expectedCardId) || !BUILD_ID.test(record.expectedBuildId)
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

function createOperationJournal({ userDataPath, now = Date.now, fs = nodeFs, randomBytes = crypto.randomBytes, platform = process.platform } = {}) {
  if (typeof userDataPath !== 'string' || !userDataPath) throw new TypeError('A userData path is required');
  const file = path.join(userDataPath, 'operation-journal.json');
  const recoveryFile = path.join(userDataPath, 'operation-journal.recovery.json');
  const acquisitionFile = path.join(userDataPath, 'operation-journal.acquisition.json');
  const corruptRecoveryFile = path.join(userDataPath, 'operation-journal.corrupt-recovery.json');
  const quarantineFiles = Object.freeze([
    path.join(userDataPath, 'operation-journal.quarantine.canonical'),
    path.join(userDataPath, 'operation-journal.quarantine.recovery'),
    path.join(userDataPath, 'operation-journal.quarantine.acquisition'),
  ]);
  let activeFile = null;
  let warning = '';

  function corruptionFailure() {
    const error = new Error('Operation journal generations are corrupt. Recover the current release with the same card.');
    Object.assign(error, {
      code: 'operation-journal-corrupt', classification: 'needs-safe-recovery', phase: 'journal-load',
      nextAction: 'recover-current-release',
    });
    return error;
  }

  function setWarning(labels) {
    warning = labels.length ? `Ignored corrupt operation journal ${labels.join(' and ')} evidence.`.slice(0, 160) : '';
  }

  function readRecord(candidate) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || stat.size > JOURNAL_MAX_BYTES) throw new Error('Operation journal is too large');
      const data = fs.readFileSync(candidate, 'utf8');
      if (Buffer.byteLength(data) > JOURNAL_MAX_BYTES) throw new Error('Operation journal is too large');
      return deepFreeze(validateRecord(JSON.parse(data)));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new Error('Operation journal is invalid');
      throw error;
    }
  }

  function readAcquisition() {
    try {
      const stat = fs.statSync(acquisitionFile);
      if (!stat.isFile() || stat.size > JOURNAL_MAX_BYTES) throw new Error('Operation journal acquisition marker is invalid');
      const value = JSON.parse(fs.readFileSync(acquisitionFile, 'utf8'));
      if (!exactKeys(value, ['attemptId', 'createdAt', 'expectedCardId', 'state', 'version'])
        || value.version !== JOURNAL_VERSION || !GENERATION_ID.test(value.attemptId)
        || !CARD_ID.test(value.expectedCardId) || value.state !== 'acquiring-or-owned'
        || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
        throw new Error('Operation journal acquisition marker is invalid');
      }
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new Error('Operation journal acquisition marker is invalid');
      throw error;
    }
  }

  function readCorruptRecovery() {
    try {
      const stat = fs.statSync(corruptRecoveryFile);
      if (!stat.isFile() || stat.size > JOURNAL_MAX_BYTES) throw new Error('Corrupt recovery marker is invalid');
      const value = JSON.parse(fs.readFileSync(corruptRecoveryFile, 'utf8'));
      if (!exactKeys(value, ['createdAt', 'expectedBuildId', 'expectedCardId', 'operation', 'state', 'transactionId', 'version'])
        || value.version !== JOURNAL_VERSION || !GENERATION_ID.test(value.transactionId)
        || value.operation !== 'recover-current-release' || !CARD_ID.test(value.expectedCardId)
        || !BUILD_ID.test(value.expectedBuildId) || value.state !== 'corrupt-recovery-active'
        || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
        throw new Error('Corrupt recovery marker is invalid');
      }
      return value;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  function safely(read, label) {
    try {
      const value = read();
      return { value, corrupt: false, label };
    } catch {
      return { value: null, corrupt: true, label };
    }
  }

  function recognizedQuarantines() {
    const recognized = [];
    for (const candidate of quarantineFiles) {
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isFile() && stat.size <= JOURNAL_MAX_BYTES) recognized.push(path.basename(candidate));
      } catch {}
    }
    return recognized;
  }

  function withAcquisition(record, acquisitionRead, corruptLabels) {
    if (!record) return null;
    if (acquisitionRead.corrupt) corruptLabels.push('acquisition');
    if ((acquisitionRead.corrupt || acquisitionRead.value?.expectedCardId === record.expectedCardId)
      && record.usbOwnership !== 'uncertain') {
      return deepFreeze({ ...record, usbOwnership: 'uncertain' });
    }
    return record;
  }

  function selection() {
    const canonicalRead = safely(() => readRecord(file), 'canonical');
    const recoveryRead = safely(() => readRecord(recoveryFile), 'recovery');
    const acquisitionRead = safely(readAcquisition, 'acquisition');
    const transactionRead = safely(readCorruptRecovery, 'corrupt-recovery-marker');
    const quarantines = recognizedQuarantines();
    const canonical = canonicalRead.value;
    const recovery = recoveryRead.value;
    const corruptLabels = [canonicalRead, recoveryRead].filter(value => value.corrupt).map(value => value.label);
    const validPostMutation = recovery?.mutationBoundary === 'erase-or-write-started'
      ? recovery : canonical?.mutationBoundary === 'erase-or-write-started' ? canonical : null;
    if (transactionRead.corrupt && !validPostMutation) {
      setWarning(['corrupt-recovery-marker']);
      throw corruptionFailure();
    }
    if (transactionRead.value && !validPostMutation) {
      setWarning(corruptLabels);
      throw corruptionFailure();
    }
    if (quarantines.length && !transactionRead.value && !validPostMutation) {
      setWarning(['recognized quarantine']);
      throw corruptionFailure();
    }
    if (!canonical && recovery && recovery.mutationBoundary === 'before-mutation' && !transactionRead.value) {
      setWarning(['missing canonical']);
      throw corruptionFailure();
    }
    if (canonicalRead.corrupt && recovery && recovery.mutationBoundary === 'before-mutation') {
      setWarning(['canonical']);
      throw corruptionFailure();
    }
    if (!canonical && !recovery && (corruptLabels.length || acquisitionRead.corrupt || acquisitionRead.value)) {
      setWarning([...corruptLabels, ...(acquisitionRead.corrupt || acquisitionRead.value ? ['acquisition'] : [])]);
      throw corruptionFailure();
    }
    let selected;
    let source;
    if (recovery && (!canonical || recovery.mutationBoundary === 'erase-or-write-started')) {
      selected = recovery;
      source = recoveryFile;
    } else {
      selected = canonical;
      source = canonical ? file : null;
    }
    selected = withAcquisition(selected, acquisitionRead, corruptLabels);
    setWarning([...corruptLabels, ...(transactionRead.corrupt ? ['corrupt-recovery-marker'] : [])]);
    return { record: selected, source };
  }

  function load() {
    if (activeFile) {
      const activeRead = safely(() => readRecord(activeFile), path.basename(activeFile).includes('recovery') ? 'recovery' : 'canonical');
      if (activeRead.value) {
        const acquisitionRead = safely(readAcquisition, 'acquisition');
        const corruptLabels = [];
        const record = withAcquisition(activeRead.value, acquisitionRead, corruptLabels);
        setWarning(corruptLabels);
        return record;
      }
      activeFile = null;
    }
    return selection().record;
  }

  function syncDirectory() {
    if (platform === 'win32') return;
    const directoryDescriptor = fs.openSync(userDataPath, 'r');
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  }

  function atomicWrite(destination, data) {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, data, { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, destination);
      try { fs.chmodSync(destination, 0o600); } catch (error) { if (platform !== 'win32') throw error; }
      syncDirectory();
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function persist(record, destination = file) {
    validateRecord(record);
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > JOURNAL_MAX_BYTES) throw new Error('Operation journal is too large');
    atomicWrite(destination, data);
    return deepFreeze(JSON.parse(data));
  }

  function persistAcquisition(value) {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > JOURNAL_MAX_BYTES) throw new Error('Operation journal acquisition marker is too large');
    atomicWrite(acquisitionFile, data);
    return Object.freeze({ ...value });
  }

  function clear() {
    const candidates = [file, recoveryFile, acquisitionFile, corruptRecoveryFile, ...quarantineFiles];
    let authority = activeFile;
    if (!authority) {
      try { authority = selection().source; } catch {}
    }
    const auxiliary = candidates.filter(candidate => candidate !== authority);
    for (const candidate of auxiliary) {
      try { fs.unlinkSync(candidate); } catch (error) { if (error?.code !== 'ENOENT') continue; }
    }
    const auxiliaryRemaining = auxiliary.some(candidate => {
      try { return fs.existsSync(candidate); } catch { return true; }
    });
    if (!auxiliaryRemaining && authority) {
      try { fs.unlinkSync(authority); } catch (error) { if (error?.code !== 'ENOENT') {} }
    }
    const remaining = candidates.filter(candidate => {
      try { return fs.existsSync(candidate); } catch { return true; }
    }).map(candidate => path.basename(candidate));
    if (!remaining.length) activeFile = null;
    return Object.freeze({ cleared: remaining.length === 0, remaining: Object.freeze(remaining) });
  }

  function logicalTime(previous) {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Operation journal clock is invalid');
    return Math.max(value, previous?.timestamps?.createdAt || 0, previous?.timestamps?.updatedAt || 0);
  }

  return Object.freeze({
    load,
    begin({ operation, expectedCardId, expectedBuildId } = {}) {
      if (load()) throw new Error('An operation journal is already active');
      const timestamp = logicalTime();
      const record = persist({
        version: JOURNAL_VERSION, generationId: randomBytes(16).toString('hex'), operation, expectedCardId, expectedBuildId,
        mutationBoundary: 'before-mutation', flashVerification: 'not-verified',
        restartResult: 'not-attempted', usbOwnership: 'not-acquired', pendingResult: null, completionCorrelation: null,
        timestamps: { createdAt: timestamp, updatedAt: timestamp },
      });
      activeFile = file;
      return record;
    },
    replaceForRecovery({ operation, expectedCardId, expectedBuildId } = {}) {
      const current = load();
      if (!current || current.mutationBoundary !== 'erase-or-write-started' || current.flashVerification !== 'not-verified'
        || operation !== 'recover-current-release' || expectedCardId !== current.expectedCardId) {
        throw new Error('Operation journal cannot be replaced for recovery');
      }
      const timestamp = logicalTime(current);
      const record = persist({
        version: JOURNAL_VERSION, generationId: randomBytes(16).toString('hex'), operation, expectedCardId, expectedBuildId,
        mutationBoundary: 'before-mutation', flashVerification: 'not-verified',
        restartResult: 'not-attempted', usbOwnership: 'not-acquired', pendingResult: null, completionCorrelation: null,
        timestamps: { createdAt: timestamp, updatedAt: timestamp },
      }, recoveryFile);
      activeFile = recoveryFile;
      return record;
    },
    markRecoveryAcquiring({ expectedCardId } = {}) {
      const current = load();
      if (!current || current.expectedCardId !== expectedCardId || current.mutationBoundary !== 'erase-or-write-started') {
        throw new Error('Recovery acquisition marker does not match active mutation evidence');
      }
      return persistAcquisition({
        version: JOURNAL_VERSION, attemptId: randomBytes(16).toString('hex'), expectedCardId,
        state: 'acquiring-or-owned', createdAt: logicalTime(current),
      });
    },
    markCorruptRecoveryAcquiring({ expectedCardId } = {}) {
      if (!CARD_ID.test(expectedCardId)) throw new Error('Corrupt recovery acquisition card is invalid');
      return persistAcquisition({
        version: JOURNAL_VERSION, attemptId: randomBytes(16).toString('hex'), expectedCardId,
        state: 'acquiring-or-owned', createdAt: logicalTime(),
      });
    },
    beginCorruptRecovery({ operation, expectedCardId, expectedBuildId } = {}) {
      let confirmedCorrupt = false;
      try { load(); } catch (error) { confirmedCorrupt = error?.code === 'operation-journal-corrupt'; }
      if (!confirmedCorrupt || operation !== 'recover-current-release' || !CARD_ID.test(expectedCardId) || !BUILD_ID.test(expectedBuildId)) {
        throw new Error('Corrupt operation journal cannot enter recovery');
      }
      let transaction;
      try { transaction = readCorruptRecovery(); } catch { transaction = null; }
      if (transaction && (transaction.expectedCardId !== expectedCardId || transaction.expectedBuildId !== expectedBuildId)) {
        throw new Error('Corrupt recovery transaction does not match the inspected card and release');
      }
      if (!transaction) {
        transaction = Object.freeze({
          version: JOURNAL_VERSION, transactionId: randomBytes(16).toString('hex'), operation,
          expectedCardId, expectedBuildId, state: 'corrupt-recovery-active', createdAt: logicalTime(),
        });
        atomicWrite(corruptRecoveryFile, JSON.stringify(transaction));
      }
      for (const [index, source] of [file, recoveryFile, acquisitionFile].entries()) {
        if (!fs.existsSync(source) || fs.existsSync(quarantineFiles[index])) continue;
        const stat = fs.statSync(source);
        if (!stat.isFile() || stat.size > JOURNAL_MAX_BYTES) throw new Error('Corrupt operation journal evidence exceeds its bounded quarantine');
        fs.renameSync(source, quarantineFiles[index]);
      }
      syncDirectory();
      const timestamp = logicalTime();
      const record = persist({
        version: JOURNAL_VERSION, generationId: randomBytes(16).toString('hex'), operation, expectedCardId, expectedBuildId,
        mutationBoundary: 'before-mutation', flashVerification: 'not-verified', restartResult: 'not-attempted',
        usbOwnership: 'not-acquired', pendingResult: null, completionCorrelation: null,
        timestamps: { createdAt: timestamp, updatedAt: timestamp },
      }, recoveryFile);
      activeFile = recoveryFile;
      return record;
    },
    completeCorruptRecovery() {
      const current = activeFile ? readRecord(activeFile) : selection().record;
      if (!current || current.flashVerification !== 'flash-verified' || current.restartResult !== 'restarted') return false;
      const remaining = [];
      for (const candidate of [corruptRecoveryFile, ...quarantineFiles]) {
        try { fs.unlinkSync(candidate); } catch (error) { if (error?.code !== 'ENOENT') remaining.push(path.basename(candidate)); }
      }
      return Object.freeze({ cleared: remaining.length === 0, remaining: Object.freeze(remaining) });
    },
    restoreCompletedAuthority(value = {}) {
      if (load()) return false;
      const timestamp = logicalTime();
      const pendingResult = {
        state: 'awaiting-card-acknowledgement', pipelineComplete: false, cardId: value.cardId,
        expectedCardId: value.cardId, firmwareVersion: value.firmwareVersion, buildId: value.buildId,
        target: value.target, verification: value.verification, physicalOutput: 'unconfirmed',
        nextCheckpoint: 'stable-card-identity-acknowledged',
        message: 'Flash verified. Reconnect in Studio and confirm the physical lights.',
      };
      const record = persist({
        version: JOURNAL_VERSION, generationId: randomBytes(16).toString('hex'), operation: value.operation,
        expectedCardId: value.cardId, expectedBuildId: value.buildId, mutationBoundary: 'erase-or-write-started',
        flashVerification: 'flash-verified', restartResult: 'restarted', usbOwnership: 'released',
        pendingResult, completionCorrelation: { ...value }, timestamps: { createdAt: timestamp, updatedAt: timestamp },
      });
      activeFile = file;
      return record;
    },
    clearRecoveryAcquisition() {
      try { fs.unlinkSync(acquisitionFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      return !fs.existsSync(acquisitionFile);
    },
    update(fields = {}) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)
        || Object.keys(fields).some(key => !UPDATE_KEYS.has(key))) throw new Error('Operation journal update contains an invalid field');
      const selected = activeFile ? { record: readRecord(activeFile), source: activeFile } : selection();
      const current = selected.record;
      if (!current) throw new Error('No active operation journal');
      const record = persist({ ...current, ...fields, timestamps: { ...current.timestamps, updatedAt: logicalTime(current) } }, selected.source);
      activeFile = selected.source;
      if (fields.usbOwnership === 'released' && activeFile === recoveryFile) {
        try { fs.unlinkSync(acquisitionFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
      return record;
    },
    clear,
    get warning() { return warning; },
    get file() { return file; },
  });
}

module.exports = { JOURNAL_MAX_BYTES, JOURNAL_VERSION, createOperationJournal };
