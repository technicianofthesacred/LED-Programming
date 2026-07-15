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
      transports.push(transport);
      return {
        loader: { id: 'loader', writeFlash() {} }, transport,
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
    async writeVerifiedFlash(_loader, options) {
      calls.push(['write', options]);
      options.reportProgress(0, 10, 100);
      options.reportProgress(0, 100, 100);
    },
    ...overrides.core,
  };
  const { createOperationRunner } = require('../src/operation-runner');
  const runner = createOperationRunner({
    runtime,
    core,
    now: () => now,
    randomBytes: () => Buffer.alloc(24, 0xab),
    loadRelease: overrides.loadRelease || (async () => { calls.push('load-release'); return release(); }),
    inspectionTtlMs: 60_000,
    confirmationTtlMs: 120_000,
  });
  return { runner, calls, transports, setNow(value) { now = value; } };
}

async function authorize(h, operation = 'install-current-release') {
  const inspected = await h.runner.inspect();
  const confirmation = await h.runner.prepare(operation);
  return { inspected, confirmation };
}

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
    const after = harness({ core: { async writeVerifiedFlash() { throw new Error(message); } } });
    const afterAuth = await authorize(after);
    await assert.rejects(() => after.runner.execute({ operation: 'install-current-release', cardId: afterAuth.inspected.cardId, token: afterAuth.confirmation.confirmationToken }), value => {
      assert.equal(value.outcome, 'needs-safe-recovery');
      assert.equal(value.code, message.startsWith('MD5') ? 'flash-verification-failed' : 'installation-interrupted');
      return true;
    });
    assert.equal(after.calls.includes('disconnect'), true);
  }
});

test('reset and USB release failures are bounded recovery outcomes and release is always attempted', async () => {
  const reset = harness({ runtime: { async reset() { throw new Error('reset failed /dev/cu.secret'); } } });
  const resetAuth = await authorize(reset);
  await assert.rejects(() => reset.runner.execute({ operation: 'install-current-release', cardId: resetAuth.inspected.cardId, token: resetAuth.confirmation.confirmationToken }), value => value.code === 'restart-failed' && !value.message.includes('/dev/'));
  assert.equal(reset.calls.includes('disconnect'), true);

  const releaseFail = harness({ runtime: { async connectForWrite() {
    return { loader: { writeFlash() {} }, identity: { cardId: 'lw-441bf681feb0', fingerprint: 'fp-one', chipName: 'ESP32-S3', flashSize: '16MB' }, transport: { async disconnect() { throw new Error('close /dev/ttyUSB1'); } } };
  } } });
  const releaseAuth = await authorize(releaseFail);
  await assert.rejects(() => releaseFail.runner.execute({ operation: 'install-current-release', cardId: releaseAuth.inspected.cardId, token: releaseAuth.confirmation.confirmationToken }), value => value.code === 'usb-release-failed' && value.outcome === 'needs-safe-recovery');
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
