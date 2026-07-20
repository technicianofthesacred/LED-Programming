import test from 'node:test';
import assert from 'node:assert/strict';

import { createPatternLabPreviewSession } from './patternLabPreviewSession.js';

function harness({ snapshot = { syncZones: false, zones: [{ id: 'outer', patternId: 'ocean', brightness: 0.4, driftHueMin: 9, driftHueMax: 177 }] }, snapshotError = null } = {}) {
  const calls = [];
  let health = null;
  let active = false;
  const stream = {
    start() { calls.push('stream:start'); active = true; return true; },
    push(frame) { calls.push(['stream:push', frame]); return active; },
    async stop() { calls.push('stream:stop'); active = false; },
    isActive() { return active; },
  };
  const session = createPatternLabPreviewSession({
    fallbackLook: { patternId: 'warm-white', brightness: 0.5 },
    readSnapshot: async () => {
      calls.push('snapshot');
      if (snapshotError) throw snapshotError;
      return snapshot;
    },
    createStream: options => { health = options.onHealth; calls.push('stream:create'); return stream; },
    restoreLook: async look => { calls.push(['restore:look', look]); },
    resetOutput: async look => { calls.push(['restore:fallback', look]); },
  });
  return { calls, session, emitHealth(value) { health?.(value); } };
}

test('does not touch hardware until explicitly started', () => {
  const { calls, session } = harness();
  assert.equal(session.status().state, 'idle');
  assert.deepEqual(calls, []);
});

test('snapshots first, starts the shared stream, and accepts RGB frames', async () => {
  const { calls, session } = harness();
  await session.start(['010203']);
  session.push(['AABBCC']);
  assert.deepEqual(calls, [
    'snapshot',
    'stream:create',
    'stream:start',
    ['stream:push', ['010203']],
    ['stream:push', ['AABBCC']],
  ]);
  assert.equal(session.status().state, 'live');
});

test('stop cancels streaming before restoring every snapshotted zone', async () => {
  const { calls, session } = harness();
  await session.start(['010203']);
  await session.stop('user');
  const stopIndex = calls.indexOf('stream:stop');
  const restoreIndex = calls.findIndex(call => Array.isArray(call) && call[0] === 'restore:look');
  assert.ok(stopIndex >= 0 && restoreIndex > stopIndex);
  assert.deepEqual(calls[restoreIndex][1], {
    patternId: 'ocean', brightness: 0.4, driftHueMin: 9, driftHueMax: 177,
    zone: 'outer', syncZones: false,
  });
  assert.equal(session.status().state, 'restored');
});

test('missing snapshots use the safe project fallback after stream cancellation', async () => {
  const { calls, session } = harness({ snapshotError: new Error('offline') });
  await session.start(['010203']);
  await session.stop('unmount');
  assert.deepEqual(calls.slice(-2), [
    'stream:stop',
    ['restore:fallback', { patternId: 'warm-white', brightness: 0.5 }],
  ]);
});

test('generic stream failures trigger exactly one rollback even without a reason code', async () => {
  const { calls, session, emitHealth } = harness();
  await session.start(['010203']);
  emitHealth({ active: true, delivered: false, lastError: new Error('wire failed') });
  emitHealth({ active: true, delivered: false, lastError: new Error('wire failed') });
  await session.whenSettled();
  assert.equal(calls.filter(call => call === 'stream:stop').length, 1);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'restore:look').length, 1);
  assert.equal(session.status().state, 'restored');
});

test('ownership transfers yield without sending a restore that would cancel the new owner', async () => {
  for (const reason of ['stream-superseded', 'stream-reclaimed']) {
    const { calls, session, emitHealth } = harness();
    await session.start(['010203']);
    emitHealth({ active: false, delivered: false, reason });
    await session.whenSettled();
    assert.equal(calls.filter(call => call === 'stream:stop').length, 1, reason);
    assert.equal(calls.filter(call => Array.isArray(call) && call[0].startsWith('restore:')).length, 0, reason);
    assert.equal(session.status().state, 'superseded', reason);
  }
});

test('a synchronized snapshot restores one broadcast look with the original sync state', async () => {
  const { calls, session } = harness({ snapshot: {
    syncZones: true,
    zones: [
      { id: 'outer', patternId: 'aurora', brightness: 0.6 },
      { id: 'inner', patternId: 'aurora', brightness: 0.6 },
    ],
  } });
  await session.start(['010203']);
  await session.stop();
  const restores = calls.filter(call => Array.isArray(call) && call[0] === 'restore:look');
  assert.deepEqual(restores, [['restore:look', { patternId: 'aurora', brightness: 0.6, syncZones: true }]]);
});

test('start failure rolls back and rejects without leaving a live session', async () => {
  const calls = [];
  const session = createPatternLabPreviewSession({
    readSnapshot: async () => ({ currentId: 'aurora', zones: [] }),
    createStream: () => ({
      start() { throw new Error('cannot start'); },
      push() {},
      async stop() { calls.push('stop'); },
    }),
    restoreLook: async look => { calls.push(['restore', look]); },
    resetOutput: async () => { calls.push('fallback'); },
  });
  await assert.rejects(session.start(['010203']), /cannot start/);
  assert.deepEqual(calls, ['stop', ['restore', { patternId: 'aurora', syncZones: true }]]);
  assert.equal(session.status().state, 'error');
  assert.equal(session.status().restored, true);
});

test('reports restoration failure without claiming that the prior look was restored', async () => {
  const session = createPatternLabPreviewSession({
    readSnapshot: async () => ({ syncZones: false, zones: [{ id: 'all', patternId: 'aurora' }] }),
    createStream: () => ({ start: () => true, push() {}, async stop() {} }),
    restoreLook: async () => { throw new Error('restore rejected'); },
  });
  await session.start(['010203']);
  await assert.rejects(session.stop(), /restore rejected/);
  assert.equal(session.status().state, 'error');
  assert.equal(session.status().restored, false);
});

test('concurrent stop requests share one cancellation and restore transaction', async () => {
  const { calls, session } = harness();
  await session.start(['010203']);
  await Promise.all([session.stop('user'), session.stop('unmount'), session.stop('user')]);
  assert.equal(calls.filter(call => call === 'stream:stop').length, 1);
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] === 'restore:look').length, 1);
});
