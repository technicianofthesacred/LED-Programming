'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const IMAGE_SIZE = 600 * 1024;
const buildId = 'a'.repeat(40);

function release() {
  const bytes = new Uint8Array(IMAGE_SIZE);
  bytes[0] = 0xe9;
  bytes[0x8000] = 0xaa;
  bytes[0x8001] = 0x50;
  bytes[0x10000] = 0xe9;
  return {
    bytes,
    manifest: {
      firmwareVersion: '1.2.3', buildId, target: 'lightweaver-controller-esp32s3',
      image: { size: IMAGE_SIZE },
    },
  };
}

function harness(overrides = {}) {
  const calls = [];
  let now = 1_000;
  let inspectionIndex = 0;
  const inspections = overrides.inspections || [
    { cardId: 'lw-441bf681feb0', fingerprint: 'fp-one', chipName: 'ESP32-S3', flashSize: '16MB' },
    { cardId: 'lw-441bf681feb0', fingerprint: 'fp-one', chipName: 'ESP32-S3', flashSize: '16MB' },
  ];
  const transports = [];
  const loaders = [];
  const runtime = {
    async inspectOne() {
      calls.push('inspect');
      const value = inspections[Math.min(inspectionIndex++, inspections.length - 1)];
      if (value instanceof Error) throw value;
      return value;
    },
    async connectForWrite() {
      calls.push('connect-write');
      const transport = { async disconnect() { calls.push('disconnect'); } };
      const loader = overrides.createLoader
        ? overrides.createLoader(calls)
        : { id: 'loader', IS_STUB: false, writeFlash() {}, async flashDeflBegin() { calls.push('flash-defl-begin'); } };
      transports.push(transport);
      loaders.push(loader);
      return {
        loader, transport,
        identity: inspections[Math.min(inspectionIndex++, inspections.length - 1)],
      };
    },
    async reset() { calls.push('reset'); },
    ...overrides.runtime,
  };
  const core = {
    validateInstallHardware(value) {
      if (value.chipName !== 'ESP32-S3') throw new Error('wrong chip /dev/cu.secret');
      if (value.flashSize !== '16MB') throw new Error('wrong flash size /dev/cu.secret');
    },
    validateProductionInstallRelease() { calls.push('validate-release'); },
    async writeVerifiedFlash(loader, options) {
      calls.push(['write', options]);
      await loader.flashDeflBegin();
      options.reportProgress(0, 10, 100);
      options.reportProgress(0, 100, 100);
    },
    ...overrides.core,
  };
  const { createOperationRunner } = require('../src/operation-runner');
  const runner = createOperationRunner({
    runtime,
    core,
    journal: overrides.journal,
    now: () => now,
    randomBytes: () => Buffer.alloc(24, 0xab),
    loadRelease: overrides.loadRelease || (async () => { calls.push('load-release'); return release(); }),
    inspectionTtlMs: 60_000,
    confirmationTtlMs: 120_000,
  });
  return { runner, calls, transports, loaders, setNow(value) { now = value; } };
}

function memoryJournal(initial = null) {
  let record = initial;
  const calls = [];
  return {
    calls,
    load() { calls.push('journal-load'); return record; },
    begin(value) {
      calls.push(['journal-begin', value]);
      if (record) throw new Error('active journal');
      record = { ...value, mutationBoundary: 'before-mutation', flashVerification: 'not-verified', restartResult: 'not-attempted', usbOwnership: 'not-acquired', pendingResult: null };
      return record;
    },
    replaceForRecovery(value) {
      calls.push(['journal-replace', value]);
      record = { ...value, mutationBoundary: 'before-mutation', flashVerification: 'not-verified', restartResult: 'not-attempted', usbOwnership: 'not-acquired', pendingResult: null, completionCorrelation: null };
      return record;
    },
    markRecoveryAcquiring(value) { calls.push(['journal-recovery-acquiring', value]); record = { ...record, usbOwnership: 'uncertain' }; return true; },
    clearRecoveryAcquisition() { calls.push('journal-recovery-acquisition-clear'); return true; },
    update(value) { calls.push(['journal-update', value]); record = { ...record, ...value }; return record; },
    clear() { calls.push('journal-clear'); const present = Boolean(record); record = null; return present; },
    current() { return record; },
  };
}

async function authorize(h, operation = 'install-current-release') {
  const inspected = await h.runner.inspect();
  const confirmation = await h.runner.prepare(operation);
  return { inspected, confirmation };
}

test('maintenance operations use explicit safe runtime methods without loading or writing firmware', async () => {
  const h = harness({ runtime: {
    async restartOne() { h.calls.push('restart-one'); return { cardId: 'lw-441bf681feb0', fingerprint: 'fp', chipName: 'ESP32-S3', flashSize: '16MB' }; },
    async releaseUsb() { h.calls.push('release-usb'); return { released: true }; },
  } });
  const inspected = await h.runner.runMaintenance('inspect-compatible-card');
  const restarted = await h.runner.runMaintenance('restart-card');
  const released = await h.runner.runMaintenance('release-usb');
  assert.equal(inspected.cardId, 'lw-441bf681feb0');
  assert.equal(restarted.cardId, 'lw-441bf681feb0');
  assert.equal(released.released, true);
  assert.deepEqual(h.calls, ['inspect', 'restart-one', 'release-usb']);
});

test('maintenance identity and USB failures remain structured and pre-mutation', async () => {
  const wrong = harness({
    runtime: { async restartOne() { return { cardId: 'lw-441bf681feb0', fingerprint: 'fp', chipName: 'ESP32', flashSize: '4MB' }; } },
  });
  await assert.rejects(() => wrong.runner.runMaintenance('restart-card'), error => error.classification === 'recoverable-failure' && error.phase === 'inspection');
  const release = harness({ runtime: { async releaseUsb() { throw Object.assign(new Error('USB release failed'), { code: 'usb-release-failed' }); } } });
  await assert.rejects(() => release.runner.runMaintenance('release-usb'), error => error.classification === 'usb-ownership-uncertain');
});

test('successful install writes exactly one verified factory image and never confirms LEDs', async () => {
  const h = harness();
  const events = [];
  const inspected = await h.runner.inspect({ onEvent: event => events.push(event) });
  const confirmation = await h.runner.prepare('install-current-release', { onEvent: event => events.push(event) });
  const result = await h.runner.execute({
    operation: 'install-current-release', cardId: inspected.cardId,
    token: confirmation.confirmationToken, onEvent: event => events.push(event),
  });

  const write = h.calls.find(call => Array.isArray(call) && call[0] === 'write')[1];
  assert.deepEqual(Object.keys(write).sort(), ['compress', 'eraseAll', 'fileArray', 'flashFreq', 'flashMode', 'flashSize', 'reportProgress']);
  assert.equal(write.fileArray.length, 1);
  assert.equal(write.fileArray[0].address, 0);
  assert.equal(write.fileArray[0].data.byteLength, IMAGE_SIZE);
  assert.equal(write.fileArray[0].data[0], 0xe9);
  assert.equal(write.eraseAll, true);
  assert.equal(write.compress, true);
  assert.equal(result.state, 'awaiting-card-acknowledgement');
  assert.equal(result.pipelineComplete, false);
  assert.equal(result.verification, 'flash-verified');
  assert.equal(result.physicalOutput, 'unconfirmed');
  assert.equal(result.expectedCardId, inspected.cardId);
  assert.equal(result.nextCheckpoint, 'stable-card-identity-acknowledged');
  assert.equal('success' in result, false);
  assert.match(result.message, /reconnect.*confirm.*lights/i);
  assert.equal(JSON.stringify(result).includes('confirmed'), true);
  assert.deepEqual(events.filter(e => e.checkpoint).map(e => e.checkpoint), [
    'environment-selected', 'release-verified', 'compatible-card-identified',
    'destructive-action-confirmed', 'erase-started', 'write-completed',
    'flash-verification-completed', 'card-restarted', 'usb-released',
  ]);
});

test('durable journal advances before mutation and preserves the completed bounded result', async () => {
  const journal = memoryJournal();
  const h = harness({ journal });
  const auth = await authorize(h);
  const result = await h.runner.execute({ operation: 'install-current-release', cardId: auth.inspected.cardId, token: auth.confirmation.confirmationToken });
  const beginIndex = journal.calls.findIndex(value => Array.isArray(value) && value[0] === 'journal-begin');
  const mutationIndex = journal.calls.findIndex(value => Array.isArray(value) && value[1]?.mutationBoundary === 'erase-or-write-started');
  assert.ok(beginIndex >= 0 && mutationIndex > beginIndex);
  assert.equal(journal.current().flashVerification, 'flash-verified');
  assert.equal(journal.current().restartResult, 'restarted');
  assert.equal(journal.current().usbOwnership, 'released');
  assert.deepEqual(journal.current().pendingResult, result);
  assert.equal(journal.calls.includes('journal-clear'), false);
});

test('journal exists before USB write connection is acquired', async () => {
  const journal = memoryJournal();
  let observed;
  const h = harness({
    journal,
    runtime: { async connectForWrite() {
      observed = journal.current();
      const transport = { async disconnect() { h.calls.push('disconnect'); } };
      return {
        transport,
        loader: { IS_STUB: false, writeFlash() {}, async flashDeflBegin() { h.calls.push('flash-defl-begin'); } },
        identity: { cardId: 'lw-441bf681feb0', fingerprint: 'fp-one', chipName: 'ESP32-S3', flashSize: '16MB' },
      };
    } },
  });
  const auth = await authorize(h);
  await h.runner.execute({ operation: 'install-current-release', cardId: auth.inspected.cardId, token: auth.confirmation.confirmationToken });
  assert.equal(observed?.mutationBoundary, 'before-mutation');
  assert.equal(observed?.usbOwnership, 'acquiring-or-owned');
});

test('production MD5 boundary journals verified truth before writeFlash returns', async () => {
  const crypto = require('node:crypto');
  const journal = memoryJournal();
  let stateAtMd5Return;
  const h = harness({
    journal,
    createLoader: calls => ({
      IS_STUB: false, writeFlash() {}, async flashDeflBegin() { calls.push('flash-defl-begin'); },
      async flashMd5sum() { return crypto.createHash('md5').update(release().bytes).digest('hex'); },
    }),
    core: { async writeVerifiedFlash(loader) {
      await loader.flashDeflBegin();
      await loader.flashMd5sum(0, IMAGE_SIZE);
      stateAtMd5Return = journal.current().flashVerification;
    } },
  });
  const auth = await authorize(h);
  await h.runner.execute({ operation: 'install-current-release', cardId: auth.inspected.cardId, token: auth.confirmation.confirmationToken });
  assert.equal(stateAtMd5Return, 'flash-verified');
});

test('journal persistence failure before mutation prevents erase and retains prior evidence', async () => {
  const journal = memoryJournal();
  journal.update = value => {
    journal.calls.push(['journal-update', value]);
    if (value.mutationBoundary) throw new Error('journal fsync failed');
  };
  const h = harness({ journal });
  const auth = await authorize(h);
  await assert.rejects(() => h.runner.execute({ operation: 'install-current-release', cardId: auth.inspected.cardId, token: auth.confirmation.confirmationToken }), /journal fsync failed/i);
  assert.equal(h.calls.includes('flash-defl-begin'), false);
});

test('restart recovery never reflashes, preserves verified truth, and is idempotent', async () => {
  const saved = {
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'flash-verified', restartResult: 'not-attempted',
    usbOwnership: 'uncertain', pendingResult: { ...pendingResultForRunner() },
  };
  const journal = memoryJournal(saved);
  const h = harness({ journal });
  const first = await h.runner.recoverInterrupted();
  const second = await h.runner.recoverInterrupted();
  const expected = { ...saved.pendingResult, ...h.runner.recoveredResultContext() };
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.equal(h.calls.filter(value => value === 'inspect').length, 2);
  assert.equal(h.calls.includes('connect-write'), false);
  assert.equal(h.calls.some(value => Array.isArray(value) && value[0] === 'write'), false);
  assert.equal(journal.current().flashVerification, 'flash-verified');
  assert.equal(journal.current().restartResult, 'restarted');
  assert.equal(journal.current().usbOwnership, 'released');
});

test('restart recovery inspects the exact card before classifying unverified mutation', async () => {
  const journal = memoryJournal({
    operation: 'recover-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'not-verified', restartResult: 'unknown',
    usbOwnership: 'uncertain', pendingResult: null,
  });
  const wrong = harness({ journal, inspections: [{ cardId: 'lw-aaaaaaaaaaaa', fingerprint: 'other', chipName: 'ESP32-S3', flashSize: '16MB' }] });
  await assert.rejects(() => wrong.runner.recoverInterrupted(), error => error.code === 'recovery-card-mismatch' && error.classification === 'needs-safe-recovery');
  assert.equal(journal.current().usbOwnership, 'uncertain');
  assert.equal(journal.calls.includes('journal-clear'), false);
});

test('pre-mutation restart cancellation clears the journal after safe inspection without writing', async () => {
  const journal = memoryJournal({
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'before-mutation', flashVerification: 'not-verified', restartResult: 'not-attempted',
    usbOwnership: 'not-acquired', pendingResult: null,
  });
  const h = harness({ journal });
  assert.equal(await h.runner.recoverInterrupted(), null);
  assert.equal(journal.current(), null);
  assert.equal(h.calls.includes('connect-write'), false);
});

test('journal clears only after acknowledgement or explicit safe dismissal of a completed result', () => {
  const incomplete = memoryJournal({
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'not-verified', restartResult: 'unknown',
    usbOwnership: 'uncertain', pendingResult: null,
  });
  const incompleteRunner = harness({ journal: incomplete }).runner;
  assert.equal(incompleteRunner.acknowledgeResult(), false);
  assert.equal(incomplete.current().flashVerification, 'not-verified');

  const complete = memoryJournal({
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'flash-verified', restartResult: 'restarted',
    usbOwnership: 'uncertain', pendingResult: pendingResultForRunner(),
  });
  const runner = harness({ journal: complete }).runner;
  assert.equal(runner.dismissCompletedResult({ ...runner.recoveredResultContext(), confirmed: true }), true);
  assert.equal(complete.current(), null);
});

test('acknowledgement clears only the exact correlated Task10A result tuple', () => {
  const complete = memoryJournal({
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'flash-verified', restartResult: 'restarted',
    usbOwnership: 'released', pendingResult: pendingResultForRunner(), completionCorrelation: null,
  });
  const runner = harness({ journal: complete }).runner;
  const exact = {
    receiptHash: '1'.repeat(64), operation: 'install-current-release', cardId: 'lw-441bf681feb0',
    firmwareVersion: '1.2.3', buildId, target: 'lightweaver-controller-esp32s3', verification: 'flash-verified',
  };
  assert.equal(runner.bindCompletedResult(exact), true);
  assert.equal(runner.acknowledgeResult({ ...exact, receiptHash: '2'.repeat(64) }), false);
  assert.equal(runner.acknowledgeResult({ ...exact, operation: 'recover-current-release' }), false);
  assert.notEqual(complete.current(), null);
  assert.equal(runner.acknowledgeResult(exact), true);
  assert.equal(complete.current(), null);
});

test('receipt A cannot clear journal B with a different bounded result tuple', () => {
  const complete = memoryJournal({
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'flash-verified', restartResult: 'restarted',
    usbOwnership: 'released', pendingResult: pendingResultForRunner(),
    completionCorrelation: {
      receiptHash: 'b'.repeat(64), operation: 'install-current-release', cardId: 'lw-441bf681feb0',
      firmwareVersion: '1.2.3', buildId, target: 'lightweaver-controller-esp32s3', verification: 'flash-verified',
    },
  });
  const runner = harness({ journal: complete }).runner;
  assert.equal(runner.acknowledgeResult({
    receiptHash: 'a'.repeat(64), operation: 'install-current-release', cardId: 'lw-441bf681feb0',
    firmwareVersion: '1.2.3', buildId, target: 'lightweaver-controller-esp32s3', verification: 'flash-verified',
  }), false);
  assert.notEqual(complete.current(), null);
});

test('USB acquisition is conservatively journaled before connect and retained uncertain on connect failure', async () => {
  const journal = memoryJournal();
  let ownershipDuringConnect;
  const h = harness({ journal, runtime: { async connectForWrite() {
    ownershipDuringConnect = journal.current()?.usbOwnership;
    throw new Error('acquire failed');
  } } });
  const auth = await authorize(h);
  await assert.rejects(() => h.runner.execute({
    operation: 'install-current-release', cardId: auth.inspected.cardId, token: auth.confirmation.confirmationToken,
  }), error => error.classification === 'usb-ownership-uncertain');
  assert.equal(ownershipDuringConnect, 'acquiring-or-owned');
  assert.equal(journal.current().usbOwnership, 'uncertain');
  assert.equal(journal.calls.includes('journal-clear'), false);
});

test('recovery operation also retains uncertain ownership when reacquisition fails', async () => {
  const journal = memoryJournal({
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'not-verified', restartResult: 'unknown',
    usbOwnership: 'released', pendingResult: null, completionCorrelation: null,
  });
  const h = harness({ journal, runtime: { async connectForWrite() { throw new Error('recovery acquire failed'); } } });
  const auth = await authorize(h, 'recover-current-release');
  await assert.rejects(() => h.runner.execute({
    operation: 'recover-current-release', cardId: auth.inspected.cardId, token: auth.confirmation.confirmationToken,
  }), error => error.classification === 'usb-ownership-uncertain');
  assert.equal(journal.current().usbOwnership, 'uncertain');
  assert.ok(journal.calls.find(call => Array.isArray(call) && call[0] === 'journal-recovery-acquiring'));
  assert.equal(journal.calls.includes('journal-clear'), false);
});

test('failed recovery journal replacement retains prior post-mutation evidence and never clears it', async () => {
  const prior = {
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'not-verified', restartResult: 'unknown',
    usbOwnership: 'uncertain', pendingResult: null, completionCorrelation: null,
  };
  const journal = memoryJournal(prior);
  journal.replaceForRecovery = value => { journal.calls.push(['journal-replace', value]); throw new Error('rename failed'); };
  const h = harness({ journal });
  const auth = await authorize(h, 'recover-current-release');
  await assert.rejects(() => h.runner.execute({
    operation: 'recover-current-release', cardId: auth.inspected.cardId, token: auth.confirmation.confirmationToken,
  }), error => /rename failed/i.test(error.message) && error.classification === 'needs-safe-recovery'
    && error.phase === 'recovery-journal-activation');
  assert.deepEqual(journal.current(), prior);
  assert.equal(journal.calls.includes('journal-clear'), false);
});

test('recovery close failure retains the acquisition marker as uncertain evidence', async () => {
  const journal = memoryJournal({
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'not-verified', restartResult: 'unknown',
    usbOwnership: 'uncertain', pendingResult: null, completionCorrelation: null,
  });
  const h = harness({ journal, runtime: { async connectForWrite() {
    return {
      loader: { IS_STUB: false, writeFlash() {}, async flashDeflBegin() {} },
      identity: { cardId: 'lw-441bf681feb0', fingerprint: 'fp-one', chipName: 'ESP32-S3', flashSize: '16MB' },
      transport: { async disconnect() { throw new Error('recovery close failed'); } },
    };
  } } });
  const auth = await authorize(h, 'recover-current-release');
  await assert.rejects(() => h.runner.execute({
    operation: 'recover-current-release', cardId: auth.inspected.cardId, token: auth.confirmation.confirmationToken,
  }), error => error.classification === 'usb-ownership-uncertain');
  assert.equal(journal.current().usbOwnership, 'uncertain');
  assert.equal(journal.calls.includes('journal-recovery-acquisition-clear'), false);
});

test('explicit dismissal requires the exact displayed recovered-result identity and is one-shot', async () => {
  const journalA = memoryJournal({
    generationId: '1'.repeat(32),
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'flash-verified', restartResult: 'restarted',
    usbOwnership: 'released', pendingResult: pendingResultForRunner(), completionCorrelation: null,
  });
  const runnerA = harness({ journal: journalA }).runner;
  const displayedA = runnerA.recoveredResultContext();
  assert.equal(runnerA.dismissCompletedResult({ ...displayedA, resultIdentityHash: 'f'.repeat(64), confirmed: true }), false);
  assert.notEqual(journalA.current(), null);

  const journalB = memoryJournal({ ...journalA.current(), generationId: '2'.repeat(32) });
  const runnerB = harness({ journal: journalB }).runner;
  const displayedB = runnerB.recoveredResultContext();
  assert.equal(runnerB.dismissCompletedResult({ ...displayedA, confirmed: true }), false);
  assert.notEqual(journalB.current(), null);
  assert.equal(runnerB.dismissCompletedResult({ ...displayedB, confirmed: true }), true);
  assert.equal(runnerB.dismissCompletedResult({ ...displayedB, confirmed: true }), false);
});

test('failed journal clear preserves acknowledgement and dismissal retry authority', () => {
  const saved = {
    generationId: '3'.repeat(32), operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'flash-verified', restartResult: 'restarted',
    usbOwnership: 'released', pendingResult: pendingResultForRunner(),
    completionCorrelation: {
      receiptHash: '4'.repeat(64), operation: 'install-current-release', cardId: 'lw-441bf681feb0',
      firmwareVersion: '1.2.3', buildId, target: 'lightweaver-controller-esp32s3', verification: 'flash-verified',
    },
  };
  const journal = memoryJournal(saved);
  journal.clear = () => ({ cleared: false, remaining: ['operation-journal.json'] });
  const runner = harness({ journal }).runner;
  assert.equal(runner.acknowledgeResult(saved.completionCorrelation), false);
  assert.equal(runner.dismissCompletedResult({ ...runner.recoveredResultContext(), confirmed: true }), false);
  assert.notEqual(journal.current(), null);
});

test('a pending verified result blocks new preparation and cannot be cleared by another operation', async () => {
  const saved = {
    operation: 'install-current-release', expectedCardId: 'lw-441bf681feb0', expectedBuildId: buildId,
    mutationBoundary: 'erase-or-write-started', flashVerification: 'flash-verified', restartResult: 'restarted',
    usbOwnership: 'released', pendingResult: pendingResultForRunner(),
  };
  const journal = memoryJournal(saved);
  const h = harness({ journal });
  await h.runner.inspect();
  await assert.rejects(() => h.runner.prepare('install-current-release'), error => error.code === 'operation-result-pending');
  assert.deepEqual(journal.current(), saved);
  assert.equal(h.calls.includes('connect-write'), false);
});

function pendingResultForRunner() {
  return {
    state: 'awaiting-card-acknowledgement', pipelineComplete: false,
    cardId: 'lw-441bf681feb0', expectedCardId: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId,
    target: 'lightweaver-controller-esp32s3', verification: 'flash-verified', physicalOutput: 'unconfirmed',
    nextCheckpoint: 'stable-card-identity-acknowledged', message: 'Flash verified. Reconnect in Studio and confirm the physical lights.',
  };
}

test('missing write capability fails pre-mutation without erase checkpoint', async () => {
  const h = harness({ runtime: { async connectForWrite() {
    const transport = { async disconnect() { h.calls.push('disconnect'); } };
    return {
      loader: {}, transport,
      identity: { cardId: 'lw-441bf681feb0', fingerprint: 'fp-one', chipName: 'ESP32-S3', flashSize: '16MB' },
    };
  } } });
  const events = [];
  const auth = await authorize(h);
  await assert.rejects(() => h.runner.execute({
    operation: 'install-current-release', cardId: auth.inspected.cardId,
    token: auth.confirmation.confirmationToken, onEvent: event => events.push(event),
  }), error => {
    assert.equal(error.classification, 'recoverable-failure');
    assert.equal(error.phase, 'before-erase');
    assert.equal(error.mutation, 'none');
    return true;
  });
  assert.equal(events.some(event => event.checkpoint === 'erase-started'), false);
});

test('missing pinned mutation methods fail preflight without invoking writeFlash', async () => {
  for (const loader of [
    { IS_STUB: true, writeFlash() {}, async flashDeflBegin() {} },
    { IS_STUB: false, writeFlash() {} },
  ]) {
    let writeInvoked = false;
    const events = [];
    const h = harness({
      createLoader: () => loader,
      core: { async writeVerifiedFlash() { writeInvoked = true; } },
    });
    const auth = await authorize(h);
    await assert.rejects(() => h.runner.execute({
      operation: 'install-current-release', cardId: auth.inspected.cardId,
      token: auth.confirmation.confirmationToken, onEvent: event => events.push(event),
    }), error => error.code === 'write-capability-missing' && error.classification === 'recoverable-failure');
    assert.equal(writeInvoked, false);
    assert.equal(events.some(event => event.checkpoint === 'erase-started'), false);
  }
});

test('stub eraseAll marks mutation at eraseFlash exactly once and restores wrapped methods', async () => {
  const originals = {};
  const h = harness({
    createLoader(calls) {
      const loader = {
        IS_STUB: true,
        writeFlash() {},
        async eraseFlash() { calls.push('real-erase'); },
        async flashDeflBegin() { calls.push('real-defl-begin'); },
        async flashBegin() { calls.push('real-flash-begin'); },
      };
      Object.assign(originals, {
        eraseFlash: loader.eraseFlash,
        flashDeflBegin: loader.flashDeflBegin,
        flashBegin: loader.flashBegin,
      });
      return loader;
    },
    core: {
      async writeVerifiedFlash(loader) {
        h.calls.push('preprocess-complete');
        await loader.eraseFlash();
        await loader.flashDeflBegin();
      },
    },
  });
  const events = [];
  const auth = await authorize(h);
  await h.runner.execute({
    operation: 'install-current-release', cardId: auth.inspected.cardId,
    token: auth.confirmation.confirmationToken, onEvent: event => events.push(event),
  });
  assert.equal(events.filter(event => event.checkpoint === 'erase-started').length, 1);
  assert.ok(h.calls.indexOf('preprocess-complete') < h.calls.indexOf('real-erase'));
  assert.strictEqual(h.loaders[0].eraseFlash, originals.eraseFlash);
  assert.strictEqual(h.loaders[0].flashDeflBegin, originals.flashDeflBegin);
  assert.strictEqual(h.loaders[0].flashBegin, originals.flashBegin);
});

test('non-stub mutation begins immediately before flashDeflBegin', async () => {
  const order = [];
  const h = harness({
    createLoader() {
      return {
        IS_STUB: false,
        writeFlash() {},
        async flashDeflBegin() { order.push('real-flash-defl-begin'); },
        async flashBegin() {},
      };
    },
    core: {
      async writeVerifiedFlash(loader) {
        order.push('image-params');
        order.push('md5');
        order.push('compression');
        await loader.flashDeflBegin();
      },
    },
  });
  const auth = await authorize(h);
  await h.runner.execute({
    operation: 'install-current-release', cardId: auth.inspected.cardId,
    token: auth.confirmation.confirmationToken,
    onEvent: event => { if (event.checkpoint === 'erase-started') order.push('erase-started'); },
  });
  assert.deepEqual(order, ['image-params', 'md5', 'compression', 'erase-started', 'real-flash-defl-begin']);
});

test('image parameter, MD5, and compression preprocessing failures remain pre-mutation', async () => {
  for (const stage of ['image parameters', 'MD5 calculation', 'compression']) {
    const events = [];
    const h = harness({ core: { async writeVerifiedFlash() { throw new Error(`${stage} failed`); } } });
    const auth = await authorize(h);
    await assert.rejects(() => h.runner.execute({
      operation: 'install-current-release', cardId: auth.inspected.cardId,
      token: auth.confirmation.confirmationToken, onEvent: event => events.push(event),
    }), error => error.classification === 'recoverable-failure' && error.phase === 'before-erase' && error.mutation === 'none');
    assert.equal(events.some(event => event.checkpoint === 'erase-started'), false);
  }
});

test('a flash operation that returns without a mutating loader call cannot report completion', async () => {
  const events = [];
  const h = harness({ core: { async writeVerifiedFlash() {} } });
  const auth = await authorize(h);
  await assert.rejects(() => h.runner.execute({
    operation: 'install-current-release', cardId: auth.inspected.cardId,
    token: auth.confirmation.confirmationToken, onEvent: event => events.push(event),
  }), error => error.code === 'write-not-started' && error.classification === 'recoverable-failure');
  assert.equal(events.some(event => event.checkpoint === 'erase-started'), false);
  assert.equal(events.some(event => event.checkpoint === 'write-completed'), false);
});

test('a mutating loader method throw requires safe recovery and restores the wrapper', async () => {
  let original;
  const h = harness({
    createLoader() {
      original = async function flashDeflBegin() { throw new Error('command failed'); };
      return { IS_STUB: false, writeFlash() {}, flashDeflBegin: original };
    },
  });
  const events = [];
  const auth = await authorize(h);
  await assert.rejects(() => h.runner.execute({
    operation: 'install-current-release', cardId: auth.inspected.cardId,
    token: auth.confirmation.confirmationToken, onEvent: event => events.push(event),
  }), error => error.classification === 'needs-safe-recovery' && error.phase === 'after-erase');
  assert.equal(events.filter(event => event.checkpoint === 'erase-started').length, 1);
  assert.strictEqual(h.loaders[0].flashDeflBegin, original);
});

test('inspection validates chip and flash, emits bounded identity, and releases USB internally', async () => {
  for (const [field, value, message] of [['chipName', 'ESP32-C3', /wrong chip/i], ['flashSize', '8MB', /flash size/i]]) {
    const card = { cardId: 'lw-441bf681feb0', fingerprint: 'fp', chipName: 'ESP32-S3', flashSize: '16MB', [field]: value };
    const h = harness({ inspections: [card] });
    await assert.rejects(() => h.runner.inspect(), message);
    assert.equal(h.runner.hasInspection(), false);
  }
  const h = harness();
  const result = await h.runner.inspect();
  assert.deepEqual(result, { compatible: true, cardId: 'lw-441bf681feb0', productName: 'Lightweaver ESP32-S3 card' });
  assert.equal(JSON.stringify(result).includes('fingerprint'), false);
});

test('inspection restoration failure remains structured and cannot authorize an install', async () => {
  const failure = Object.assign(new Error('Card restoration failed'), {
    code: 'card-restoration-failed', phase: 'inspection-restoration',
  });
  const h = harness({ runtime: { async inspectOne() { throw failure; } } });
  await assert.rejects(() => h.runner.inspect(), error => {
    assert.equal(error.code, 'card-restoration-failed');
    assert.equal(error.phase, 'inspection-restoration');
    assert.equal(error.classification, 'recoverable-failure');
    assert.equal(error.nextAction, 'unplug-replug-card');
    return true;
  });
  assert.equal(h.runner.hasInspection(), false);
});

test('zero and multiple candidates remain distinct recoverable pre-erase failures', async () => {
  for (const [error, code] of [[new Error('No compatible candidate'), 'no-compatible-card'], [new Error('Multiple compatible candidates'), 'multiple-compatible-cards']]) {
    const h = harness({ runtime: { async inspectOne() { throw error; } } });
    await assert.rejects(() => h.runner.inspect(), value => value.code === code && value.mutation === 'none');
  }
});

test('signed release failure occurs before confirmation and before any write connection', async () => {
  const h = harness({ loadRelease: async () => { throw new Error('signature failed /dev/cu.secret'); } });
  await h.runner.inspect();
  await assert.rejects(() => h.runner.prepare('install-current-release'), value => {
    assert.equal(value.code, 'release-verification-failed');
    assert.equal(value.message.includes('/dev/'), false);
    return true;
  });
  assert.equal(h.calls.includes('connect-write'), false);
  assert.equal(h.calls.some(Array.isArray), false);
});

test('swapped card, stale inspection, expired and reused tokens cannot erase', async () => {
  const swapped = harness({ inspections: [
    { cardId: 'lw-441bf681feb0', fingerprint: 'fp-one', chipName: 'ESP32-S3', flashSize: '16MB' },
    { cardId: 'lw-001122334455', fingerprint: 'fp-two', chipName: 'ESP32-S3', flashSize: '16MB' },
  ] });
  const swapAuth = await authorize(swapped);
  await assert.rejects(() => swapped.runner.execute({ operation: 'install-current-release', cardId: swapAuth.inspected.cardId, token: swapAuth.confirmation.confirmationToken }), /changed|swapped/i);
  assert.equal(swapped.calls.some(Array.isArray), false);

  const expired = harness();
  const auth = await authorize(expired);
  expired.setNow(122_001);
  await assert.rejects(() => expired.runner.execute({ operation: 'install-current-release', cardId: auth.inspected.cardId, token: auth.confirmation.confirmationToken }), /expired/i);
  assert.equal(expired.calls.includes('connect-write'), false);

  const reused = harness();
  const reuseAuth = await authorize(reused);
  await reused.runner.execute({ operation: 'install-current-release', cardId: reuseAuth.inspected.cardId, token: reuseAuth.confirmation.confirmationToken });
  await assert.rejects(() => reused.runner.execute({ operation: 'install-current-release', cardId: reuseAuth.inspected.cardId, token: reuseAuth.confirmation.confirmationToken }), /used|match/i);
});

test('disconnect before erase is recoverable; write/MD5 failures after erase require recovery and cleanup', async () => {
  const before = harness({ runtime: { async connectForWrite() { throw new Error('device disconnected /dev/ttyUSB0'); } } });
  const beforeAuth = await authorize(before);
  await assert.rejects(() => before.runner.execute({ operation: 'install-current-release', cardId: beforeAuth.inspected.cardId, token: beforeAuth.confirmation.confirmationToken }), value => value.mutation === 'none' && value.code === 'card-disconnected');

  for (const message of ['write disconnected', 'MD5 of file does not match data in flash']) {
    const after = harness({ core: { async writeVerifiedFlash(loader) {
      await loader.flashDeflBegin();
      throw new Error(message);
    } } });
    const afterAuth = await authorize(after);
    await assert.rejects(() => after.runner.execute({ operation: 'install-current-release', cardId: afterAuth.inspected.cardId, token: afterAuth.confirmation.confirmationToken }), value => {
      assert.equal(value.outcome, 'needs-safe-recovery');
      assert.equal(value.code, message.startsWith('MD5') ? 'flash-verification-failed' : 'installation-interrupted');
      return true;
    });
    assert.equal(after.calls.includes('disconnect'), true);
  }
});

test('reset failure remains safe recovery and release is always attempted', async () => {
  const reset = harness({ runtime: { async reset() { throw new Error('reset failed /dev/cu.secret'); } } });
  const resetAuth = await authorize(reset);
  await assert.rejects(() => reset.runner.execute({ operation: 'install-current-release', cardId: resetAuth.inspected.cardId, token: resetAuth.confirmation.confirmationToken }), value => value.code === 'restart-failed' && !value.message.includes('/dev/'));
  assert.equal(reset.calls.includes('disconnect'), true);

});

test('USB close failure preserves verified flash after restart without requesting reflash', async () => {
  const releaseFail = harness({ runtime: { async connectForWrite() {
    return { loader: { IS_STUB: false, writeFlash() {}, async flashDeflBegin() {} }, identity: { cardId: 'lw-441bf681feb0', fingerprint: 'fp-one', chipName: 'ESP32-S3', flashSize: '16MB' }, transport: { async disconnect() { throw new Error('close /dev/ttyUSB1'); } } };
  } } });
  const releaseAuth = await authorize(releaseFail);
  await assert.rejects(() => releaseFail.runner.execute({ operation: 'install-current-release', cardId: releaseAuth.inspected.cardId, token: releaseAuth.confirmation.confirmationToken }), error => {
    assert.equal(error.code, 'usb-release-failed');
    assert.equal(error.classification, 'usb-ownership-uncertain');
    assert.equal(error.verification, 'flash-verified');
    assert.equal(error.physicalOutput, 'unconfirmed');
    assert.equal(error.pipelineComplete, false);
    assert.equal(error.expectedCardId, releaseAuth.inspected.cardId);
    assert.match(error.nextAction, /restart.*unplug/i);
    assert.doesNotMatch(error.nextAction, /recover|flash/i);
    return true;
  });
});

test('USB close failure keeps safe recovery when write or restart outcome is uncertain', async () => {
  for (const failure of ['write', 'reset']) {
    const h = harness({
      runtime: {
        async connectForWrite() {
          return {
            loader: { IS_STUB: false, writeFlash() {}, async flashDeflBegin() {} },
            identity: { cardId: 'lw-441bf681feb0', fingerprint: 'fp-one', chipName: 'ESP32-S3', flashSize: '16MB' },
            transport: { async disconnect() { throw new Error('close failed'); } },
          };
        },
        ...(failure === 'reset' ? { async reset() { throw new Error('reset failed'); } } : {}),
      },
      ...(failure === 'write' ? { core: { async writeVerifiedFlash(loader) {
        await loader.flashDeflBegin();
        throw new Error('write failed');
      } } } : {}),
    });
    const auth = await authorize(h);
    await assert.rejects(() => h.runner.execute({
      operation: 'install-current-release', cardId: auth.inspected.cardId,
      token: auth.confirmation.confirmationToken,
    }), error => error.classification === 'needs-safe-recovery' && error.nextAction === 'recover-current-release');
  }
});

test('closed vocabulary and concurrency are rejected before hardware/network', async () => {
  const h = harness();
  for (const operation of ['install-firmware', 'arbitrary', '']) await assert.rejects(() => h.runner.prepare(operation), /unsupported/i);
  for (const operation of ['inspect-compatible-card', 'release-usb', 'restart-card']) await assert.rejects(() => h.runner.prepare(operation), /unsupported/i);
  assert.deepEqual(h.calls, []);

  let resolveInspect;
  const concurrent = harness({ runtime: { inspectOne: () => new Promise(resolve => { resolveInspect = resolve; }) } });
  const pending = concurrent.runner.inspect();
  await assert.rejects(() => concurrent.runner.inspect(), /already active/i);
  resolveInspect({ cardId: 'lw-441bf681feb0', fingerprint: 'fp', chipName: 'ESP32-S3', flashSize: '16MB' });
  await pending;
});
