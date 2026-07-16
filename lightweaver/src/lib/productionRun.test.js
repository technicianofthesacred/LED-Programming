import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCTION_RUN_STATES,
  PRODUCTION_RUN_COMMIT_A_KEY,
  PRODUCTION_RUN_COMMIT_B_KEY,
  PRODUCTION_RUN_COMMIT_KEY,
  PRODUCTION_RUN_SLOT_A_KEY,
  PRODUCTION_RUN_SLOT_B_KEY,
  PRODUCTION_RUN_TTL_MS,
  createProductionRun,
  inspectProductionRun,
  readProductionRun,
  transitionProductionRun,
  updateProductionRunAtomically,
} from './productionRun.js';

const digest = 'a'.repeat(64);
const ids = { runId: 'run_1234567890abcdef', flowId: 'flow_1234567890abcdef' };
const correlation = (run, overrides = {}) => ({
  runId: run.runId, flowId: run.flowId, jobDigest: run.jobDigest,
  expectedCardId: run.expectedCardId, operationId: run.operationId, ...overrides,
});

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

function committedMarkers(storage) {
  return [PRODUCTION_RUN_COMMIT_A_KEY, PRODUCTION_RUN_COMMIT_B_KEY]
    .map(key => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } })
    .filter(Boolean)
    .sort((left, right) => right.generation - left.generation);
}

test('models the exact production states and binds run, flow, job, and expected card', () => {
  assert.deepEqual(PRODUCTION_RUN_STATES, ['select-job', 'connect-card', 'inspect', 'install', 'reconnect', 'restore', 'verify-card', 'check-lights', 'record', 'complete', 'recovery']);
  let run = createProductionRun({ ...ids, jobDigest: digest, now: 10 });
  run = transitionProductionRun(run, 'connect-card', { correlation: correlation(run), now: 11 });
  run = transitionProductionRun(run, 'inspect', { correlation: correlation(run), expectedCardId: 'lw-aabbccddeeff', now: 12 });
  assert.equal(run.expectedCardId, 'lw-aabbccddeeff');
  assert.throws(() => transitionProductionRun(run, 'install', { correlation: correlation(run, { flowId: 'flow_other_123456' }), now: 13 }), /correlation/i);
  assert.throws(() => transitionProductionRun(run, 'install', { correlation: correlation(run, { expectedCardId: 'lw-wrong' }), now: 13 }), /expected card/i);
  assert.throws(() => transitionProductionRun(run, 'install', { correlation: correlation(run, { operationId: 'op_stale_1234567890' }), now: 13 }), /operation/i);
});

test('requires card identity at inspect before install and preserves it thereafter', () => {
  let run = createProductionRun({ ...ids, jobDigest: digest, now: 10 });
  run = transitionProductionRun(run, 'connect-card', { correlation: correlation(run), now: 11 });
  const cardlessInspect = transitionProductionRun(run, 'inspect', { correlation: correlation(run), now: 12 });
  assert.throws(() => transitionProductionRun(cardlessInspect, 'install', { correlation: correlation(cardlessInspect), now: 13 }), /expected card/i);
  assert.throws(() => transitionProductionRun(cardlessInspect, 'install', { correlation: correlation(cardlessInspect), expectedCardId: 'lw-aabbccddeeff', now: 13 }), /during inspect/i);
  const identifiedInspect = transitionProductionRun(run, 'inspect', { correlation: correlation(run), expectedCardId: 'lw-aabbccddeeff', now: 12 });
  const install = transitionProductionRun(identifiedInspect, 'install', { correlation: correlation(identifiedInspect), now: 13 });
  assert.equal(install.expectedCardId, 'lw-aabbccddeeff');
  assert.throws(() => transitionProductionRun(install, 'reconnect', { correlation: correlation(install), expectedCardId: 'lw-other-card', now: 14 }), /cannot change/i);
});

test('creates independent cryptographically random run and flow identities by default', () => {
  const first = createProductionRun({ jobDigest: digest });
  const second = createProductionRun({ jobDigest: digest });
  assert.match(first.runId, /^run_[a-f0-9]{32}$/);
  assert.match(first.flowId, /^flow_[a-f0-9]{32}$/);
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.flowId, second.flowId);
});

test('enforces the workflow graph and recovery source evidence', () => {
  const run = createProductionRun({ ...ids, jobDigest: digest });
  assert.throws(() => transitionProductionRun(run, 'restore', { correlation: correlation(run) }), /transition|expected card/i);
  assert.throws(() => transitionProductionRun(run, 'recovery', { correlation: correlation(run), recoveryAction: 'signed-firmware-recovery' }), /not valid from select-job/i);
  const connected = transitionProductionRun(run, 'connect-card', { correlation: correlation(run) });
  assert.throws(() => transitionProductionRun(connected, 'recovery', { correlation: correlation(connected), recoveryAction: 'restore-project' }), /not valid from connect-card/i);
  const recovery = transitionProductionRun(connected, 'recovery', { correlation: correlation(connected), recoveryAction: 'inspect-card', supportCode: 'LW-JOB-001' });
  assert.equal(recovery.state, 'recovery');
  assert.throws(() => transitionProductionRun(recovery, 'restore', { correlation: correlation(recovery) }), /recovery|expected card/i);
  assert.equal(transitionProductionRun(recovery, 'connect-card', { correlation: correlation(recovery) }).state, 'connect-card');
});

test('persists only bounded non-secret resumable state with primary/backup recovery', async () => {
  const now = Date.now();
  const storage = new MemoryStorage();
  const lock = { request: async (_name, callback) => callback() };
  const initial = createProductionRun({ ...ids, jobDigest: digest, now });
  await updateProductionRunAtomically(() => initial, { storage, lockManager: lock });
  await updateProductionRunAtomically(run => transitionProductionRun(run, 'connect-card', { correlation: correlation(run), now: now + 10 }), { storage, lockManager: lock });
  const resumed = readProductionRun({ storage });
  assert.equal(resumed.state, 'connect-card');
  assert.equal(resumed.generation, 2);
  const serialized = [...storage.values.values()].join('\n');
  assert.doesNotMatch(serialized, /wifi|password|serialPath|serialNumber|firmwareBytes|raw error|project payload/i);

  const commit = committedMarkers(storage)[0];
  storage.setItem(commit.slot === 'a' ? PRODUCTION_RUN_SLOT_A_KEY : PRODUCTION_RUN_SLOT_B_KEY, '{crash');
  assert.equal(readProductionRun({ storage }).state, 'select-job');
});

test('double-buffer recovery never rotates corrupt data over the last valid generation', async () => {
  const now = Date.now();
  const storage = new MemoryStorage();
  const lock = { request: async (_name, callback) => callback() };
  await updateProductionRunAtomically(() => createProductionRun({ ...ids, jobDigest: digest, now }), { storage, lockManager: lock });
  await updateProductionRunAtomically(run => ({ ...run, supportCode: 'LW-A' }), { storage, lockManager: lock });
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const commit = committedMarkers(storage)[0];
    storage.setItem(commit.slot === 'a' ? PRODUCTION_RUN_SLOT_A_KEY : PRODUCTION_RUN_SLOT_B_KEY, '{corrupt');
    const recovered = inspectProductionRun({ storage });
    assert.equal(recovered.run.generation, 1);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.committedGeneration, 2);
    await updateProductionRunAtomically(run => ({ ...run, cardChanged: true }), { storage, lockManager: lock });
  }
  assert.equal(readProductionRun({ storage }).generation, 2);
});

test('never selects an uncommitted slot and falls back only through durable markers', async () => {
  const storage = new MemoryStorage();
  const lock = { request: async (_name, callback) => callback() };
  await updateProductionRunAtomically(() => createProductionRun({ ...ids, jobDigest: digest }), { storage, lockManager: lock });
  await updateProductionRunAtomically(run => ({ ...run, supportCode: 'LW-COMMITTED' }), { storage, lockManager: lock });
  const latest = committedMarkers(storage)[0];
  const latestMarkerKey = latest.slot === 'a' ? PRODUCTION_RUN_COMMIT_A_KEY : PRODUCTION_RUN_COMMIT_B_KEY;
  storage.setItem(latestMarkerKey, '{corrupt');
  assert.equal(inspectProductionRun({ storage }).run.generation, 1);

  const uncommittedSlotKey = latest.slot === 'a' ? PRODUCTION_RUN_SLOT_A_KEY : PRODUCTION_RUN_SLOT_B_KEY;
  storage.setItem(uncommittedSlotKey, storage.getItem(latest.slot === 'a' ? PRODUCTION_RUN_SLOT_B_KEY : PRODUCTION_RUN_SLOT_A_KEY));
  assert.equal(readProductionRun({ storage }).generation, 1);
});

test('poisons an uncommitted slot when the commit marker write fails', async () => {
  class MarkerQuotaStorage extends MemoryStorage {
    failMarker = false;
    setItem(key, value) {
      if (this.failMarker && [PRODUCTION_RUN_COMMIT_A_KEY, PRODUCTION_RUN_COMMIT_B_KEY].includes(key)) throw new Error('quota exceeded');
      super.setItem(key, value);
    }
  }
  const storage = new MarkerQuotaStorage();
  const lock = { request: async (_name, callback) => callback() };
  await updateProductionRunAtomically(() => createProductionRun({ ...ids, jobDigest: digest }), { storage, lockManager: lock });
  storage.failMarker = true;
  await assert.rejects(updateProductionRunAtomically(run => ({ ...run, supportCode: 'LW-LOST' }), { storage, lockManager: lock }), /quota/i);
  assert.equal(readProductionRun({ storage }).generation, 1);
  assert.equal(storage.getItem(PRODUCTION_RUN_SLOT_B_KEY), null);
});

test('expired runs and cardless restore/check/record states fail closed', () => {
  const run = createProductionRun({ ...ids, jobDigest: digest, now: 10 });
  assert.equal(readProductionRun({ storage: new MemoryStorage(), now: 10 }), null);
  assert.throws(() => transitionProductionRun({ ...run, state: 'reconnect' }, 'restore', { correlation: correlation({ ...run, state: 'reconnect' }), now: 11 }), /expected card/i);
  assert.throws(() => transitionProductionRun(run, 'connect-card', { correlation: correlation(run), now: run.expiresAt + 1 }), /expired/i);
  const storage = new MemoryStorage();
  const envelopeRun = { ...run, generation: 1, updatedAt: 10 };
  // Public writes are used to seed a valid envelope; expiry is then evaluated independently.
  return updateProductionRunAtomically(() => envelopeRun, { storage, lockManager: { request: async (_n, cb) => cb() } })
    .then(() => assert.equal(readProductionRun({ storage, now: 10 + 8 * 24 * 60 * 60 * 1000 }), null));
});

test('an expired higher generation cannot shadow a fresh run lineage', async () => {
  const storage = new MemoryStorage();
  const lock = { request: async (_name, callback) => callback() };
  await updateProductionRunAtomically(() => createProductionRun({ ...ids, jobDigest: digest, now: 10 }), { storage, lockManager: lock });
  await updateProductionRunAtomically(run => ({ ...run, supportCode: 'LW-OLD' }), { storage, lockManager: lock, now: 11 });
  const freshNow = 10 + PRODUCTION_RUN_TTL_MS + 1;
  assert.equal(readProductionRun({ storage, now: freshNow }), null);
  const fresh = createProductionRun({ runId: 'run_fresh_123456789', flowId: 'flow_fresh_12345678', jobDigest: 'b'.repeat(64), now: freshNow });
  await updateProductionRunAtomically(() => fresh, { storage, lockManager: lock, now: freshNow });
  assert.equal(readProductionRun({ storage, now: freshNow }).runId, fresh.runId);
  await updateProductionRunAtomically(run => ({ ...run, supportCode: 'LW-FRESH' }), { storage, lockManager: lock, now: freshNow + 1 });
  const resumed = readProductionRun({ storage, now: freshNow + 1 });
  assert.equal(resumed.runId, fresh.runId);
  assert.equal(resumed.generation, 2);
  assert.equal(resumed.supportCode, 'LW-FRESH');
});

test('rejects secret, device-enumerating, binary, and raw-error persistence', async () => {
  const storage = new MemoryStorage();
  const lock = { request: async (_name, callback) => callback() };
  for (const extra of [
    { wifiPassword: 'secret' },
    { serialPath: '/dev/cu.usbmodem1' },
    { serialNumber: '1234' },
    { firmwareBytes: new Uint8Array([1, 2]) },
    { rawError: 'stack trace' },
    { supportCode: 'raw error: USB stack exploded' },
  ]) {
    await assert.rejects(updateProductionRunAtomically(() => ({ ...createProductionRun({ ...ids, jobDigest: digest }), ...extra }), { storage, lockManager: lock }), /not persistable|unsupported/i);
  }
});

test('serializes cross-tab updates under one atomic lock and prevents lost generations', async () => {
  const storage = new MemoryStorage();
  let queue = Promise.resolve();
  const lock = { request(_name, callback) { const next = queue.then(callback); queue = next.catch(() => {}); return next; } };
  await updateProductionRunAtomically(() => createProductionRun({ ...ids, jobDigest: digest }), { storage, lockManager: lock });
  await Promise.all([
    updateProductionRunAtomically(run => ({ ...run, supportCode: 'LW-A' }), { storage, lockManager: lock }),
    updateProductionRunAtomically(run => ({ ...run, cardChanged: true }), { storage, lockManager: lock }),
  ]);
  const result = readProductionRun({ storage });
  assert.equal(result.generation, 3);
  assert.equal(result.supportCode, 'LW-A');
  assert.equal(result.cardChanged, true);
});

test('browser persistence fails closed without a cross-tab coordinator', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    await assert.rejects(updateProductionRunAtomically(() => createProductionRun({ ...ids, jobDigest: digest }), {
      storage: new MemoryStorage(), lockManager: null, indexedDB: null,
    }), /atomic.*unavailable/i);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('IndexedDB coordinator rejects blocked opens instead of hanging', async () => {
  const indexedDB = { open() {
    const request = {};
    queueMicrotask(() => request.onblocked());
    return request;
  } };
  await assert.rejects(updateProductionRunAtomically(() => createProductionRun({ ...ids, jobDigest: digest }), {
    storage: new MemoryStorage(), lockManager: null, indexedDB,
  }), /blocked/i);
});
