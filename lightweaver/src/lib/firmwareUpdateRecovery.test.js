import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverFirmwareUpdate } from './firmwareUpdateRecovery.js';

const CARD_ID = 'lw-b0fe81f61b44';
const OLD_BOOT = 'boot-old';
const PROJECT_HEAD = 'a'.repeat(64);
const PROJECT_FINGERPRINT = 'b'.repeat(64);
const TARGET_BUILD = 'c'.repeat(40);

const session = Object.freeze({
  version: 1,
  cardId: CARD_ID,
  previousBootId: OLD_BOOT,
  expectedProjectHead: PROJECT_HEAD,
  expectedProjectFingerprint: PROJECT_FINGERPRINT,
  targetFirmwareVersion: '1.2.0',
  targetBuildId: TARGET_BUILD,
  targetBuildNumber: 1300,
  ticketSha256: 'd'.repeat(64),
  phase: 'restarting',
  acknowledgedBytes: 8,
});

const idleKnownGood = Object.freeze({
  cardId: CARD_ID,
  bootId: 'boot-new',
  firmwareVersion: '1.2.0',
  buildId: TARGET_BUILD,
  buildNumber: 1300,
  projectHead: PROJECT_HEAD,
  projectFingerprint: PROJECT_FINGERPRINT,
  runtimePhase: 'ready',
  knownGoodProject: true,
  commandReady: true,
  outputReady: true,
  playbackReady: true,
  capabilities: { firmwareUpdate: { version: 1, network: true } },
});

function clock(start = 0) {
  let value = start;
  const waits = [];
  return {
    waits,
    now: () => value,
    wait: async milliseconds => {
      waits.push(milliseconds);
      value += milliseconds;
    },
  };
}

async function settlesWithin(promise, milliseconds = 100) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('recovery remained pending past its deadline')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('recovery retries the expected card and finishes on exact known-good evidence', async () => {
  const attempts = [];
  const states = [];
  const time = clock();
  const snapshot = { readiness: idleKnownGood, updateStatus: { phase: 'idle' } };

  const result = await settlesWithin(recoverFirmwareUpdate({
    session,
    hosts: ['lightweaver.local'],
    connect: async (host, { expectedCardId, signal }) => {
      attempts.push({ host, expectedCardId, signal });
    },
    readSnapshot: async () => attempts.length === 1 ? null : snapshot,
    wait: time.wait,
    now: time.now,
    timeoutMs: 1000,
    onState: state => states.push(state),
  }));

  assert.deepEqual(result, {
    state: 'reconnected',
    correlation: {
      ok: true, terminal: true, phase: 'valid', reason: '', evidence: 'runtime-known-good',
    },
    snapshot,
  });
  assert.deepEqual(attempts.map(({ host, expectedCardId }) => ({ host, expectedCardId })), [
    { host: 'lightweaver.local', expectedCardId: CARD_ID },
    { host: 'lightweaver.local', expectedCardId: CARD_ID },
  ]);
  assert.ok(attempts.every(attempt => attempt.signal instanceof AbortSignal));
  assert.deepEqual(states, [
    { state: 'reconnecting', host: 'lightweaver.local', attempt: 1 },
    { state: 'reconnecting', host: 'lightweaver.local', attempt: 2 },
  ]);
  assert.deepEqual(time.waits, [400]);
});

test('wrong-card evidence blocks recovery and cannot be retried into success', async () => {
  let attempts = 0;
  const result = await recoverFirmwareUpdate({
    session,
    hosts: ['lightweaver.local', '192.168.4.1'],
    connect: async (_host, { expectedCardId, signal }) => {
      attempts += 1;
      assert.equal(expectedCardId, CARD_ID);
      assert.ok(signal instanceof AbortSignal);
    },
    readSnapshot: async () => ({
      readiness: { ...idleKnownGood, cardId: 'lw-wrong-card' },
      updateStatus: { phase: 'idle' },
    }),
    wait: async () => assert.fail('terminal wrong-card evidence must not wait'),
    now: () => 0,
    timeoutMs: 1000,
  });

  assert.deepEqual(result, {
    state: 'blocked',
    reason: 'wrong-card',
    correlation: { ok: false, terminal: false, phase: '', reason: 'wrong-card' },
  });
  assert.equal(attempts, 1);
});

test('reported rollback is terminal and preserves restored-build evidence', async () => {
  const snapshot = {
    readiness: {
      ...idleKnownGood,
      firmwareVersion: '1.1.1',
      buildId: 'e'.repeat(40),
      buildNumber: 1198,
    },
    updateStatus: {
      phase: 'rolled-back',
      rollbackReason: 'boot-health-failed',
      restoredBuildNumber: 1201,
    },
  };
  const result = await recoverFirmwareUpdate({
    session,
    hosts: ['lightweaver.local'],
    connect: async () => {},
    readSnapshot: async () => snapshot,
    wait: async () => assert.fail('terminal rollback evidence must not wait'),
    now: () => 0,
    timeoutMs: 1000,
  });

  assert.deepEqual(result, {
    state: 'rolled-back',
    correlation: {
      ok: false,
      terminal: true,
      phase: 'rolled-back',
      reason: 'boot-health-failed',
      restoredBuildNumber: 1201,
    },
    snapshot,
  });
});

test('timeout uses bounded exponential retries and does not mutate the session', async () => {
  const attempts = [];
  const time = clock();
  const originalSession = structuredClone(session);

  const result = await recoverFirmwareUpdate({
    session,
    hosts: ['lightweaver.local'],
    connect: async host => { attempts.push(host); throw new Error('offline'); },
    readSnapshot: async () => { throw new Error('unreachable'); },
    wait: time.wait,
    now: time.now,
    timeoutMs: 4001,
  });

  assert.deepEqual(result, { state: 'timeout', reason: 'reconnect-timeout' });
  assert.deepEqual(time.waits, [400, 800, 1600, 1201]);
  assert.equal(attempts.length, 4);
  assert.deepEqual(session, originalSession);
});

test('host candidates are normalized, local-only, deduplicated, and rotated', async () => {
  const attempts = [];
  const time = clock();

  await recoverFirmwareUpdate({
    session,
    hosts: [
      ' HTTP://LIGHTWEAVER.LOCAL/studio ',
      'lightweaver',
      'https://example.com/card',
      '192.168.4.1/path',
      '192.168.4.1',
    ],
    connect: async (host, { expectedCardId, signal }) => {
      attempts.push({ host, expectedCardId, signal });
      throw new Error('offline');
    },
    readSnapshot: async () => null,
    wait: time.wait,
    now: time.now,
    timeoutMs: 1200,
  });

  assert.deepEqual(attempts.map(({ host, expectedCardId }) => ({ host, expectedCardId })), [
    { host: 'lightweaver.local', expectedCardId: CARD_ID },
    { host: '192.168.4.1', expectedCardId: CARD_ID },
  ]);
  assert.ok(attempts.every(attempt => attempt.signal instanceof AbortSignal));
});

test('a hung connect is aborted at the deadline and cannot hold recovery open', async () => {
  let value = 0;
  let connectCancelled = false;
  const deadlineWaits = [];

  const result = await settlesWithin(recoverFirmwareUpdate({
    session,
    hosts: ['lightweaver.local'],
    connect: (_host, { expectedCardId, signal }) => {
      assert.equal(expectedCardId, CARD_ID);
      return new Promise(resolve => {
        signal.addEventListener('abort', () => {
          connectCancelled = true;
          resolve();
        }, { once: true });
      });
    },
    readSnapshot: async () => assert.fail('snapshot must not start after connect exhausts the deadline'),
    wait: async (milliseconds, { signal } = {}) => {
      deadlineWaits.push({ milliseconds, signal });
      value += milliseconds;
    },
    now: () => value,
    timeoutMs: 1000,
  }));

  assert.deepEqual(result, { state: 'timeout', reason: 'reconnect-timeout' });
  assert.equal(connectCancelled, true);
  assert.deepEqual(deadlineWaits.map(entry => entry.milliseconds), [1000]);
  assert.ok(deadlineWaits[0].signal instanceof AbortSignal);
});

test('a hung snapshot read is aborted at the deadline', async () => {
  let value = 0;
  let snapshotCancelled = false;

  const result = await settlesWithin(recoverFirmwareUpdate({
    session,
    hosts: ['lightweaver.local'],
    connect: async () => {},
    readSnapshot: (_host, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => {
        snapshotCancelled = true;
        resolve(null);
      }, { once: true });
    }),
    wait: async milliseconds => { value += milliseconds; },
    now: () => value,
    timeoutMs: 750,
  }));

  assert.deepEqual(result, { state: 'timeout', reason: 'reconnect-timeout' });
  assert.equal(snapshotCancelled, true);
});

test('a completed operation cancels its pending deadline timer without aborting the operation', async () => {
  let releaseConnect;
  let cancelledTimers = 0;
  let connectSignal;

  const result = await settlesWithin(recoverFirmwareUpdate({
    session,
    hosts: ['lightweaver.local'],
    connect: (_host, { signal }) => {
      connectSignal = signal;
      return new Promise(resolve => { releaseConnect = resolve; });
    },
    readSnapshot: async () => ({ readiness: idleKnownGood, updateStatus: { phase: 'idle' } }),
    wait: (_milliseconds, { signal } = {}) => new Promise(resolve => {
      signal.addEventListener('abort', () => {
        cancelledTimers += 1;
        resolve();
      }, { once: true });
      queueMicrotask(releaseConnect);
    }),
    now: () => 0,
    timeoutMs: 1000,
  }));

  assert.equal(result.state, 'reconnected');
  assert.equal(cancelledTimers, 1);
  assert.equal(connectSignal.aborted, false);
});

test('invalid recovery inputs are rejected before connection', async () => {
  let connections = 0;
  const valid = {
    session,
    hosts: ['lightweaver.local'],
    connect: async () => { connections += 1; },
    readSnapshot: async () => null,
  };

  await assert.rejects(() => recoverFirmwareUpdate(), /exact firmware recovery inputs/i);
  await assert.rejects(
    () => recoverFirmwareUpdate({ ...valid, session: { ...session, cardId: '' } }),
    /exact firmware recovery inputs/i,
  );
  await assert.rejects(
    () => recoverFirmwareUpdate({
      ...valid,
      timeoutMs: 0,
      session: Object.freeze({ version: 1, cardId: CARD_ID, phase: 'restarting' }),
    }),
    /exact firmware recovery inputs/i,
  );
  await assert.rejects(
    () => recoverFirmwareUpdate({
      ...valid,
      timeoutMs: 0,
      session: Object.freeze({ ...session, version: 2 }),
    }),
    /exact firmware recovery inputs/i,
  );
  await assert.rejects(
    () => recoverFirmwareUpdate({
      ...valid,
      timeoutMs: 0,
      session: Object.freeze({ ...session, targetFirmwareVersion: '' }),
    }),
    /exact firmware recovery inputs/i,
  );
  await assert.rejects(
    () => recoverFirmwareUpdate({
      ...valid,
      timeoutMs: 0,
      session: Object.freeze({ ...session, targetFirmwareVersion: ' 1.2.0 ' }),
    }),
    /exact firmware recovery inputs/i,
  );
  await assert.rejects(
    () => recoverFirmwareUpdate({
      ...valid,
      timeoutMs: 0,
      session: Object.freeze({ ...session, targetFirmwareVersion: 'v'.repeat(49) }),
    }),
    /exact firmware recovery inputs/i,
  );
  await assert.rejects(
    () => recoverFirmwareUpdate({ ...valid, connect: null }),
    /exact firmware recovery inputs/i,
  );
  await assert.rejects(
    () => recoverFirmwareUpdate({ ...valid, readSnapshot: null }),
    /exact firmware recovery inputs/i,
  );
  await assert.rejects(
    () => recoverFirmwareUpdate({ ...valid, hosts: ['https://example.com/card'] }),
    /at least one local recovery host/i,
  );
  await assert.rejects(
    () => recoverFirmwareUpdate({ ...valid, hosts: [] }),
    /at least one local recovery host/i,
  );
  assert.equal(connections, 0);
});
