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

  const loaded = createOperationJournal({ userDataPath: directory, now: () => 999 }).load();
  assert.deepEqual(loaded, {
    version: 1, operation: 'install-current-release', expectedCardId: cardId,
    expectedBuildId: buildId, mutationBoundary: 'erase-or-write-started',
    flashVerification: 'flash-verified', restartResult: 'restarted', usbOwnership: 'released',
    pendingResult: pendingResult(), timestamps: { createdAt: 100, updatedAt: 102 },
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
    assert.throws(() => journal.load(), /journal.*invalid|too large|version/i);
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
  assert.equal(journal.clear(), false);
  journal.begin({ operation: 'install-current-release', expectedCardId: cardId, expectedBuildId: buildId });
  assert.equal(journal.clear(), true);
  assert.equal(journal.clear(), false);
  assert.equal(journal.load(), null);
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
