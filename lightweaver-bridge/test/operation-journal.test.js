'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { JOURNAL_MAX_BYTES, createOperationJournal } = require('../src/operation-journal');

const cardId = 'lw-441bf681feb0';
const buildId = 'a'.repeat(40);

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-journal-'));
}

function pendingResult() {
  return {
    state: 'awaiting-card-acknowledgement', pipelineComplete: false, cardId,
    expectedCardId: cardId, firmwareVersion: '1.2.3', buildId,
    target: 'lightweaver-controller-esp32s3', verification: 'flash-verified',
    physicalOutput: 'unconfirmed', nextCheckpoint: 'stable-card-identity-acknowledged',
    message: 'Flash verified. Reconnect in Studio and confirm the physical lights.',
  };
}

test('journal atomically persists one strict versioned operation and survives restart', () => {
  const directory = temporaryDirectory();
  let now = 100;
  const journal = createOperationJournal({ userDataPath: directory, now: () => now });
  journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  now = 101;
  journal.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'owned' });
  now = 102;
  journal.update({ flashVerification: 'flash-verified', restartResult: 'restarted', usbOwnership: 'released', pendingResult: pendingResult() });
  now = 103;
  const completionCorrelation = {
    receiptHash: 'c'.repeat(64), operation: 'install-current-release', cardId,
    firmwareVersion: '1.2.3', buildId, target: 'lightweaver-controller-esp32s3', verification: 'flash-verified',
  };
  journal.update({ completionCorrelation });

  const loaded = createOperationJournal({ userDataPath: directory, now: () => 999 }).load();
  assert.match(loaded.generationId, /^[a-f0-9]{32}$/);
  const generationId = loaded.generationId;
  assert.deepEqual(loaded, {
    version: 1, generationId, operation: 'install-current-release', expectedCardId: cardId,
    expectedBuildId: buildId, mutationBoundary: 'erase-or-write-started',
    flashVerification: 'flash-verified', restartResult: 'restarted', usbOwnership: 'released',
    pendingResult: pendingResult(), completionCorrelation, timestamps: { createdAt: 100, updatedAt: 103 },
  });
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(fs.statSync(path.join(directory, 'operation-journal.json')).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});

test('journal schema rejects extra fields, incompatible values, multiple begin, and secret-shaped data', () => {
  const directory = temporaryDirectory();
  const journal = createOperationJournal({ userDataPath: directory, now: () => 1 });
  journal.begin({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  assert.throws(() => journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId }), /active/i);
  assert.throws(() => journal.update({ serialPath: '/dev/ttyUSB0' }), /field|invalid/i);
  assert.throws(() => journal.update({ mutationBoundary: 'anything' }), /invalid/i);
  assert.throws(() => journal.update({ pendingResult: { ...pendingResult(), nonce: 'secret' } }), /invalid/i);
  const messageJournal = createOperationJournal({ userDataPath: temporaryDirectory(), now: () => 1 });
  messageJournal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  messageJournal.update({ mutationBoundary: 'erase-or-write-started', flashVerification: 'flash-verified' });
  assert.throws(() => messageJournal.update({ pendingResult: { ...pendingResult(), message: 'failed at /dev/ttyUSB0 password=hunter2' } }), /invalid/i);

  const text = fs.readFileSync(path.join(directory, 'operation-journal.json'), 'utf8');
  for (const secret of ['/dev/', 'ttyUSB', 'serialNumber', 'nonce', 'password', 'ssid', 'https://', 'firmwareBytes']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('corrupt, partial, oversized, stale-version, and semantically incompatible journals fail closed without deletion', () => {
  for (const contents of [
    '{"version":1',
    'x'.repeat(JOURNAL_MAX_BYTES + 1),
    JSON.stringify({ version: 2 }),
    JSON.stringify({
      version: 1, operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId,
      mutationBoundary: 'before-mutation', flashVerification: 'flash-verified', restartResult: 'not-attempted',
      usbOwnership: 'not-acquired', pendingResult: null, timestamps: { createdAt: 1, updatedAt: 1 },
    }),
  ]) {
    const directory = temporaryDirectory();
    const file = path.join(directory, 'operation-journal.json');
    fs.writeFileSync(file, contents);
    const journal = createOperationJournal({ userDataPath: directory });
    assert.throws(() => journal.load(), /journal.*(?:invalid|corrupt)|too large|version/i);
    assert.equal(fs.existsSync(file), true);
  }
});

test('write, fsync, and rename failures are surfaced and do not silently advance the journal', () => {
  for (const failedMethod of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const directory = temporaryDirectory();
    const real = fs;
    let calls = 0;
    const failingFs = Object.create(real);
    failingFs[failedMethod] = (...args) => {
      calls += 1;
      if (failedMethod !== 'fsyncSync' || calls === 1) throw new Error(`${failedMethod} failed`);
      return real[failedMethod](...args);
    };
    const journal = createOperationJournal({ userDataPath: directory, fs: failingFs, now: () => 1 });
    assert.throws(() => journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId }), new RegExp(failedMethod));
    assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  }
});

test('clear is idempotent and only removes the single active record', () => {
  const directory = temporaryDirectory();
  const journal = createOperationJournal({ userDataPath: directory, now: () => 1 });
  assert.deepEqual(journal.clear(), { cleared: true, remaining: [] });
  journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  assert.deepEqual(journal.clear(), { cleared: true, remaining: [] });
  assert.deepEqual(journal.clear(), { cleared: true, remaining: [] });
  assert.equal(journal.load(), null);
});

test('Windows durable writes fsync a write-capable temp handle and skip unsupported directory fsync', () => {
  const directory = temporaryDirectory();
  const opened = [];
  const windowsFs = Object.create(fs);
  windowsFs.openSync = (candidate, flags, mode) => {
    opened.push([candidate, flags]);
    if (candidate === directory) throw new Error('Windows directory handles are unsupported');
    return fs.openSync(candidate, flags, mode);
  };
  const journal = createOperationJournal({ userDataPath: directory, fs: windowsFs, platform: 'win32', now: () => 1 });
  assert.doesNotThrow(() => journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId }));
  assert.ok(opened.some(([candidate, flags]) => candidate.endsWith('.tmp') && flags === 'wx'));
  assert.equal(opened.some(([candidate]) => candidate === directory), false);
});

test('corrupt slots are isolated, safest valid evidence survives, and warnings are bounded', () => {
  const directory = temporaryDirectory();
  const journal = createOperationJournal({ userDataPath: directory, now: () => 1 });
  journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  journal.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'uncertain', restartResult: 'unknown' });
  journal.replaceForRecovery({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: 'b'.repeat(40) });
  const canonical = path.join(directory, 'operation-journal.json');
  const recovery = path.join(directory, 'operation-journal.recovery.json');
  const canonicalBytes = fs.readFileSync(canonical);
  const recoveryBytes = fs.readFileSync(recovery);

  fs.writeFileSync(canonical, '{broken');
  let restarted = createOperationJournal({ userDataPath: directory });
  assert.throws(() => restarted.load(), error => error.classification === 'needs-safe-recovery'
    && error.code === 'operation-journal-corrupt');
  assert.match(restarted.warning, /canonical/i);
  assert.ok(restarted.warning.length <= 160);

  fs.writeFileSync(canonical, canonicalBytes);
  journal.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'uncertain', restartResult: 'unknown' });
  fs.writeFileSync(canonical, '{broken');
  restarted = createOperationJournal({ userDataPath: directory });
  assert.equal(restarted.load().operation, 'recover-current-release');
  assert.equal(restarted.load().mutationBoundary, 'erase-or-write-started');

  fs.writeFileSync(canonical, canonicalBytes);
  fs.writeFileSync(recovery, '{broken');
  restarted = createOperationJournal({ userDataPath: directory });
  assert.equal(restarted.load().operation, 'install-current-release');
  assert.match(restarted.warning, /recovery/i);

  fs.writeFileSync(recovery, recoveryBytes);
  fs.writeFileSync(path.join(directory, 'operation-journal.acquisition.json'), '{broken');
  restarted = createOperationJournal({ userDataPath: directory });
  assert.equal(restarted.load().usbOwnership, 'uncertain');
  assert.match(restarted.warning, /acquisition/i);

  fs.writeFileSync(canonical, '{broken');
  fs.writeFileSync(recovery, '{broken');
  assert.throws(() => createOperationJournal({ userDataPath: directory }).load(), error =>
    error.classification === 'needs-safe-recovery' && error.code === 'operation-journal-corrupt'
      && error.nextAction === 'recover-current-release');
});

test('logical journal timestamps remain monotonic across clock rollback and restart', () => {
  const directory = temporaryDirectory();
  let now = 100;
  let journal = createOperationJournal({ userDataPath: directory, now: () => now });
  journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  now = 50;
  assert.equal(journal.update({ usbOwnership: 'acquiring-or-owned' }).timestamps.updatedAt, 100);
  journal = createOperationJournal({ userDataPath: directory, now: () => 25 });
  assert.equal(journal.update({ usbOwnership: 'uncertain' }).timestamps.updatedAt, 100);
});

test('clear attempts every slot, verifies removal, and retains explicit retry authority on partial failure', () => {
  for (const failedName of ['operation-journal.json', 'operation-journal.recovery.json', 'operation-journal.acquisition.json']) {
    const directory = temporaryDirectory();
    const original = createOperationJournal({ userDataPath: directory, now: () => 1 });
    original.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
    original.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'uncertain', restartResult: 'unknown' });
    original.markRecoveryAcquiring({ expectedCardId: cardId });
    original.replaceForRecovery({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: 'b'.repeat(40) });
    const failingFs = Object.create(fs);
    failingFs.unlinkSync = candidate => {
      if (path.basename(candidate) === failedName) throw new Error('unlink blocked');
      return fs.unlinkSync(candidate);
    };
    const result = createOperationJournal({ userDataPath: directory, fs: failingFs }).clear();
    assert.equal(result.cleared, false);
    assert.ok(result.remaining.includes(failedName));
    assert.equal(fs.existsSync(path.join(directory, failedName)), true);
    assert.ok(result.remaining.some(name => name === 'operation-journal.json' || name === 'operation-journal.recovery.json'));
    assert.deepEqual(createOperationJournal({ userDataPath: directory }).clear(), { cleared: true, remaining: [] });
  }
});

test('safe recovery atomically replaces only matching uncertain mutation evidence', () => {
  const directory = temporaryDirectory();
  let now = 1;
  const journal = createOperationJournal({ userDataPath: directory, now: () => now });
  journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  journal.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'uncertain', restartResult: 'unknown' });
  now = 2;
  journal.replaceForRecovery({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: 'b'.repeat(40) });
  const replaced = journal.load();
  assert.equal(replaced.operation, 'recover-current-release');
  assert.equal(replaced.expectedBuildId, 'b'.repeat(40));
  assert.equal(replaced.mutationBoundary, 'before-mutation');
  assert.deepEqual(replaced.timestamps, { createdAt: 2, updatedAt: 2 });

  assert.throws(() => journal.replaceForRecovery({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId }), /cannot be replaced/i);
});

test('verified flash may retain its pending result before restart outcome is known', () => {
  const directory = temporaryDirectory();
  const journal = createOperationJournal({ userDataPath: directory, now: () => 1 });
  journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  journal.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'owned' });
  assert.doesNotThrow(() => journal.update({ flashVerification: 'flash-verified', pendingResult: pendingResult() }));
  assert.equal(journal.load().restartResult, 'not-attempted');
});

test('recovery replacement failure retains prior journal bytes even after rename before directory fsync', () => {
  const directory = temporaryDirectory();
  const original = createOperationJournal({ userDataPath: directory, now: () => 1 });
  original.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  original.update({ mutationBoundary: 'erase-or-write-started', restartResult: 'unknown', usbOwnership: 'uncertain' });
  const file = path.join(directory, 'operation-journal.json');
  const before = fs.readFileSync(file);
  let fsyncCalls = 0;
  const failingFs = Object.create(fs);
  failingFs.fsyncSync = descriptor => {
    fsyncCalls += 1;
    if (fsyncCalls >= 2) throw new Error('directory fsync failed persistently');
    return fs.fsyncSync(descriptor);
  };
  const journal = createOperationJournal({ userDataPath: directory, fs: failingFs, now: () => 2 });
  assert.throws(() => journal.replaceForRecovery({
    operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: 'b'.repeat(40),
  }), /directory fsync failed persistently/);
  assert.deepEqual(fs.readFileSync(file), before);
  const restarted = createOperationJournal({ userDataPath: directory }).load();
  assert.equal(restarted.operation, 'install-current-release');
  assert.equal(restarted.mutationBoundary, 'erase-or-write-started');
  assert.equal(restarted.usbOwnership, 'uncertain');
});

test('every recovery generation persistence boundary leaves restart on old conservative evidence', () => {
  for (const boundary of ['write', 'file-fsync', 'rename', 'directory-fsync']) {
    const directory = temporaryDirectory();
    const original = createOperationJournal({ userDataPath: directory, now: () => 1 });
    original.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
    original.update({ mutationBoundary: 'erase-or-write-started', restartResult: 'unknown', usbOwnership: 'uncertain' });
    const canonical = path.join(directory, 'operation-journal.json');
    const before = fs.readFileSync(canonical);
    const failingFs = Object.create(fs);
    let fsyncCalls = 0;
    if (boundary === 'write') failingFs.writeFileSync = () => { throw new Error('recovery write failed'); };
    if (boundary === 'file-fsync' || boundary === 'directory-fsync') {
      failingFs.fsyncSync = descriptor => {
        fsyncCalls += 1;
        if (boundary === 'file-fsync' || fsyncCalls >= 2) throw new Error(`recovery ${boundary} failed persistently`);
        return fs.fsyncSync(descriptor);
      };
    }
    if (boundary === 'rename') failingFs.renameSync = () => { throw new Error('recovery rename failed'); };
    const journal = createOperationJournal({ userDataPath: directory, fs: failingFs, now: () => 2 });
    assert.throws(() => journal.replaceForRecovery({
      operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: 'b'.repeat(40),
    }), /failed/);
    assert.deepEqual(fs.readFileSync(canonical), before);
    const restarted = createOperationJournal({ userDataPath: directory }).load();
    assert.equal(restarted.operation, 'install-current-release', boundary);
    assert.equal(restarted.mutationBoundary, 'erase-or-write-started', boundary);
  }
});

test('recovery acquisition sidecar preserves mutation evidence and makes restart ownership uncertain', () => {
  const directory = temporaryDirectory();
  const journal = createOperationJournal({ userDataPath: directory, now: () => 1 });
  journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  journal.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'released', restartResult: 'unknown' });
  const canonical = path.join(directory, 'operation-journal.json');
  const before = fs.readFileSync(canonical);
  journal.markRecoveryAcquiring({ expectedCardId: cardId });
  assert.deepEqual(fs.readFileSync(canonical), before);
  const restarted = createOperationJournal({ userDataPath: directory }).load();
  assert.equal(restarted.mutationBoundary, 'erase-or-write-started');
  assert.equal(restarted.usbOwnership, 'uncertain');
});

test('identical new journals receive distinct bounded generation identities', () => {
  const directory = temporaryDirectory();
  const journal = createOperationJournal({ userDataPath: directory, now: () => 1 });
  const first = journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId }).generationId;
  journal.clear();
  const second = journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId }).generationId;
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.match(second, /^[a-f0-9]{32}$/);
  assert.notEqual(first, second);
});

test('corrupt recovery transaction marker keeps authority across quarantine and replacement failures', () => {
  for (const failure of ['marker-write', 'marker-file-fsync', 'marker-rename', 'marker-directory-fsync',
    'quarantine-rename', 'recovery-write', 'recovery-file-fsync', 'recovery-rename', 'recovery-directory-fsync']) {
    for (const markerState of ['as-left', 'missing', 'corrupt']) {
    const directory = temporaryDirectory();
    const original = createOperationJournal({ userDataPath: directory, now: () => 1 });
    original.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
    original.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'uncertain', restartResult: 'unknown' });
    original.replaceForRecovery({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId });
    fs.writeFileSync(path.join(directory, 'operation-journal.json'), '{broken-canonical');
    fs.writeFileSync(path.join(directory, 'operation-journal.recovery.json'), '{broken-recovery');

    const failingFs = Object.create(fs);
    const descriptors = new Map();
    let markerPublished = false;
    let recoveryPublished = false;
    failingFs.openSync = (candidate, flags, mode) => {
      const descriptor = fs.openSync(candidate, flags, mode);
      descriptors.set(descriptor, candidate);
      return descriptor;
    };
    failingFs.closeSync = descriptor => { descriptors.delete(descriptor); return fs.closeSync(descriptor); };
    failingFs.writeFileSync = (target, ...args) => {
      const candidate = typeof target === 'number' ? descriptors.get(target) : target;
      if ((failure === 'marker-write' && candidate?.includes('corrupt-recovery.json') && candidate.endsWith('.tmp'))
        || (failure === 'recovery-write' && candidate?.includes('operation-journal.recovery.json') && candidate.endsWith('.tmp'))) {
        throw new Error(`${failure} failed`);
      }
      return fs.writeFileSync(target, ...args);
    };
    failingFs.fsyncSync = descriptor => {
      const candidate = descriptors.get(descriptor);
      if ((failure === 'marker-file-fsync' && candidate?.includes('corrupt-recovery.json') && candidate.endsWith('.tmp'))
        || (failure === 'recovery-file-fsync' && candidate?.includes('operation-journal.recovery.json') && candidate.endsWith('.tmp'))
        || (failure === 'marker-directory-fsync' && candidate === directory && markerPublished && !recoveryPublished)
        || (failure === 'recovery-directory-fsync' && candidate === directory && recoveryPublished)) {
        throw new Error(`${failure} failed`);
      }
      return fs.fsyncSync(descriptor);
    };
    failingFs.renameSync = (source, destination) => {
      if ((failure === 'marker-rename' && destination.endsWith('operation-journal.corrupt-recovery.json'))
        || (failure === 'quarantine-rename' && source.endsWith('operation-journal.json'))
        || (failure === 'recovery-rename' && destination.endsWith('operation-journal.recovery.json'))) {
        throw new Error(`${failure} failed`);
      }
      const result = fs.renameSync(source, destination);
      if (destination.endsWith('operation-journal.corrupt-recovery.json')) markerPublished = true;
      if (destination.endsWith('operation-journal.recovery.json')) recoveryPublished = true;
      return result;
    };
    const journal = createOperationJournal({ userDataPath: directory, fs: failingFs, now: () => 2 });
    assert.throws(() => journal.beginCorruptRecovery({
      operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId,
    }), /failed/);
    const marker = path.join(directory, 'operation-journal.corrupt-recovery.json');
    if (markerState === 'missing') fs.rmSync(marker, { force: true });
    if (markerState === 'corrupt') fs.writeFileSync(marker, '{broken-marker');
    const restarted = createOperationJournal({ userDataPath: directory });
    assert.throws(() => restarted.load(), error => error.classification === 'needs-safe-recovery', `${failure}:${markerState}`);
    const quarantines = fs.readdirSync(directory).filter(name => name.includes('.quarantine.'));
    assert.ok(quarantines.length <= 3, `${failure}:${markerState}`);
    assert.ok(quarantines.every(name => fs.statSync(path.join(directory, name)).size <= JOURNAL_MAX_BYTES), `${failure}:${markerState}`);
    }
  }
});

test('corrupt recovery cleanup failure preserves completed authority for acknowledgement retry', () => {
  const directory = temporaryDirectory();
  const original = createOperationJournal({ userDataPath: directory, now: () => 1 });
  original.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  original.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'uncertain', restartResult: 'unknown' });
  original.replaceForRecovery({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  fs.writeFileSync(path.join(directory, 'operation-journal.json'), '{broken-canonical');
  fs.writeFileSync(path.join(directory, 'operation-journal.recovery.json'), '{broken-recovery');

  const journal = createOperationJournal({ userDataPath: directory, now: () => 2 });
  journal.beginCorruptRecovery({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  journal.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'owned' });
  journal.update({ flashVerification: 'flash-verified', pendingResult: pendingResult() });
  journal.update({ restartResult: 'restarted', usbOwnership: 'released' });

  const failingFs = Object.create(fs);
  failingFs.unlinkSync = candidate => {
    if (candidate.endsWith('operation-journal.quarantine.canonical')) throw new Error('cleanup blocked');
    return fs.unlinkSync(candidate);
  };
  const restarted = createOperationJournal({ userDataPath: directory, fs: failingFs });
  const cleanup = restarted.completeCorruptRecovery();
  assert.equal(cleanup.cleared, false);
  assert.deepEqual(cleanup.remaining, ['operation-journal.quarantine.canonical']);
  assert.equal(restarted.load().flashVerification, 'flash-verified');
  const acknowledgement = restarted.clear();
  assert.equal(acknowledgement.cleared, false);
  assert.equal(fs.existsSync(path.join(directory, 'operation-journal.recovery.json')), true);
  assert.deepEqual(createOperationJournal({ userDataPath: directory }).clear(), { cleared: true, remaining: [] });
});

test('valid post-mutation recovery outranks a corrupt transaction marker and remains cleanable', () => {
  const directory = temporaryDirectory();
  const original = createOperationJournal({ userDataPath: directory, now: () => 1 });
  original.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  original.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'uncertain', restartResult: 'unknown' });
  original.replaceForRecovery({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  fs.writeFileSync(path.join(directory, 'operation-journal.json'), '{broken-canonical');
  fs.writeFileSync(path.join(directory, 'operation-journal.recovery.json'), '{broken-recovery');
  const journal = createOperationJournal({ userDataPath: directory, now: () => 2 });
  journal.beginCorruptRecovery({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  journal.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'owned' });
  fs.writeFileSync(path.join(directory, 'operation-journal.corrupt-recovery.json'), '{broken-marker');

  const restarted = createOperationJournal({ userDataPath: directory });
  const loaded = restarted.load();
  assert.equal(loaded.operation, 'recover-current-release');
  assert.equal(loaded.mutationBoundary, 'erase-or-write-started');
  assert.match(restarted.warning, /corrupt-recovery-marker/);
  restarted.update({ flashVerification: 'flash-verified', pendingResult: pendingResult() });
  restarted.update({ restartResult: 'restarted', usbOwnership: 'released' });
  assert.deepEqual(restarted.completeCorruptRecovery(), { cleared: true, remaining: [] });
  assert.equal(fs.readdirSync(directory).some(name => name.includes('.quarantine.')), false);
});

test('every exact owned quarantine presence is fail-closed without reading or trusting its contents', () => {
  for (const name of ['operation-journal.quarantine.canonical', 'operation-journal.quarantine.recovery',
    'operation-journal.quarantine.acquisition']) {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, name), '{partial-malformed-evidence');
    const guardedFs = Object.create(fs);
    guardedFs.readFileSync = (candidate, ...args) => {
      if (candidate === path.join(directory, name)) throw new Error('quarantine content must not be read');
      return fs.readFileSync(candidate, ...args);
    };
    const journal = createOperationJournal({ userDataPath: directory, fs: guardedFs });
    assert.throws(() => journal.load(), error => (
      error.code === 'operation-journal-corrupt' && error.classification === 'needs-safe-recovery'
    ), name);
    assert.throws(() => journal.begin({
      operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId,
    }), error => error.classification === 'needs-safe-recovery', name);
  }

  for (const [name, contents] of [['operation-journal.quarantine.attacker', 'bounded'],
    ['operation-journal.quarantine.canonical.extra', 'bounded']]) {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, name), contents);
    assert.equal(createOperationJournal({ userDataPath: directory }).load(), null, name);
  }

  for (const kind of ['oversized', 'directory', 'symlink']) {
    const directory = temporaryDirectory();
    const candidate = path.join(directory, 'operation-journal.quarantine.canonical');
    if (kind === 'oversized') fs.writeFileSync(candidate, 'x'.repeat(JOURNAL_MAX_BYTES + 1));
    if (kind === 'directory') fs.mkdirSync(candidate);
    if (kind === 'symlink') {
      const target = path.join(directory, 'untrusted-target');
      fs.writeFileSync(target, 'untrusted');
      fs.symlinkSync(target, candidate);
    }
    assert.throws(() => createOperationJournal({ userDataPath: directory }).load(), error => (
      error.code === 'operation-journal-corrupt' && error.classification === 'needs-safe-recovery'
    ), kind);
  }
  assert.equal(createOperationJournal({ userDataPath: temporaryDirectory() }).load(), null, 'clean ENOENT');
});

test('inconclusive quarantine metadata is fail-closed and only ENOENT proves absence', () => {
  for (const code of ['EIO', 'EACCES']) {
    const directory = temporaryDirectory();
    const failingFs = Object.create(fs);
    failingFs.lstatSync = candidate => {
      if (candidate.endsWith('operation-journal.quarantine.canonical')) {
        throw Object.assign(new Error(`${code} probing quarantine`), { code });
      }
      return fs.lstatSync(candidate);
    };
    assert.throws(() => createOperationJournal({ userDataPath: directory, fs: failingFs }).load(), error => (
      error.code === 'operation-journal-corrupt' && error.classification === 'needs-safe-recovery'
    ), code);
  }
  const directory = temporaryDirectory();
  const absentFs = Object.create(fs);
  absentFs.lstatSync = candidate => {
    if (candidate.includes('operation-journal.quarantine.')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return fs.lstatSync(candidate);
  };
  assert.equal(createOperationJournal({ userDataPath: directory, fs: absentFs }).load(), null);
});

test('invalid quarantine stays presence-only and bounded through explicit recovery cleanup', () => {
  const directory = temporaryDirectory();
  const quarantine = path.join(directory, 'operation-journal.quarantine.canonical');
  fs.writeFileSync(quarantine, 'x'.repeat(JOURNAL_MAX_BYTES + 1));
  const originalSize = fs.statSync(quarantine).size;
  const guardedFs = Object.create(fs);
  guardedFs.readFileSync = (candidate, ...args) => {
    if (candidate === quarantine) throw new Error('quarantine content must not be read');
    return fs.readFileSync(candidate, ...args);
  };
  const journal = createOperationJournal({ userDataPath: directory, fs: guardedFs, now: () => 1 });
  assert.throws(() => journal.load(), error => error.classification === 'needs-safe-recovery');
  journal.beginCorruptRecovery({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  assert.equal(fs.statSync(quarantine).size, originalSize);
  assert.ok(fs.statSync(path.join(directory, 'operation-journal.corrupt-recovery.json')).size <= JOURNAL_MAX_BYTES);
  assert.ok(fs.statSync(path.join(directory, 'operation-journal.recovery.json')).size <= JOURNAL_MAX_BYTES);
  journal.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'owned' });
  journal.update({ flashVerification: 'flash-verified', pendingResult: pendingResult() });
  journal.update({ restartResult: 'restarted', usbOwnership: 'released' });
  assert.deepEqual(journal.completeCorruptRecovery(), { cleared: true, remaining: [] });
});

test('lost or corrupt marker after quarantine publication remains actionable through explicit corrupt recovery', () => {
  for (const markerState of ['missing', 'corrupt']) {
    const directory = temporaryDirectory();
    const original = createOperationJournal({ userDataPath: directory, now: () => 1 });
    original.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
    original.update({ mutationBoundary: 'erase-or-write-started', usbOwnership: 'uncertain', restartResult: 'unknown' });
    original.replaceForRecovery({ operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId });
    fs.writeFileSync(path.join(directory, 'operation-journal.json'), '{broken-canonical');
    fs.writeFileSync(path.join(directory, 'operation-journal.recovery.json'), '{broken-recovery');

    const failingFs = Object.create(fs);
    const descriptors = new Map();
    failingFs.openSync = (candidate, flags, mode) => {
      const descriptor = fs.openSync(candidate, flags, mode);
      descriptors.set(descriptor, candidate);
      return descriptor;
    };
    failingFs.closeSync = descriptor => { descriptors.delete(descriptor); return fs.closeSync(descriptor); };
    failingFs.writeFileSync = (target, ...args) => {
      const candidate = typeof target === 'number' ? descriptors.get(target) : target;
      if (candidate?.includes('operation-journal.recovery.json') && candidate.endsWith('.tmp')) {
        throw new Error('replacement write failed');
      }
      return fs.writeFileSync(target, ...args);
    };
    const failed = createOperationJournal({ userDataPath: directory, fs: failingFs, now: () => 2 });
    assert.throws(() => failed.beginCorruptRecovery({
      operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId,
    }), /replacement write failed/);
    const marker = path.join(directory, 'operation-journal.corrupt-recovery.json');
    if (markerState === 'missing') fs.rmSync(marker, { force: true });
    else fs.writeFileSync(marker, '{broken-marker');

    const restarted = createOperationJournal({ userDataPath: directory, now: () => 3 });
    assert.throws(() => restarted.load(), error => error.classification === 'needs-safe-recovery');
    assert.doesNotThrow(() => restarted.beginCorruptRecovery({
      operation: 'recover-current-release', expectedCardId: cardId, expectedBuildId: buildId,
    }));
    assert.equal(restarted.load().mutationBoundary, 'before-mutation');
  }
});
