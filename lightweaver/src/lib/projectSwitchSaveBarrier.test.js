import test from 'node:test';
import assert from 'node:assert/strict';

import { runProjectSwitchSaveBarrier } from './projectSwitchSaveBarrier.js';

const snapshot = {
  project: { id: 'project-a' },
  marker: { generation: 7, revision: 12 },
};

function validInputs(overrides = {}) {
  return {
    snapshot,
    flushBrowserRecovery: () => ({ ok: true }),
    saveAuthoritative: async () => ({ ok: true, destination: 'cloud' }),
    isSnapshotCurrent: () => true,
    ...overrides,
  };
}

test('flushes browser recovery before the authoritative save', async () => {
  const calls = [];

  const result = await runProjectSwitchSaveBarrier(validInputs({
    flushBrowserRecovery: () => {
      calls.push('recovery');
      return { ok: true };
    },
    saveAuthoritative: async () => {
      calls.push('authoritative');
      return { ok: true, destination: 'cloud' };
    },
  }));

  assert.deepEqual(calls, ['recovery', 'authoritative']);
  assert.equal(result.ok, true);
});

test('blocks authoritative save when browser recovery fails', async () => {
  let authoritativeCalls = 0;

  const result = await runProjectSwitchSaveBarrier(validInputs({
    flushBrowserRecovery: () => ({ ok: false }),
    saveAuthoritative: async () => {
      authoritativeCalls += 1;
      return { ok: true };
    },
  }));

  assert.deepEqual(result, { ok: false, reason: 'browser-recovery-failed' });
  assert.equal(authoritativeCalls, 0);
});

test('fails closed when browser recovery does not acknowledge success', async () => {
  for (const recoveryResult of [undefined, null, {}, 'saved']) {
    let authoritativeCalls = 0;
    const result = await runProjectSwitchSaveBarrier(validInputs({
      flushBrowserRecovery: () => recoveryResult,
      saveAuthoritative: async () => {
        authoritativeCalls += 1;
        return { ok: true, destination: 'cloud' };
      },
    }));

    assert.deepEqual(result, { ok: false, reason: 'browser-recovery-failed' });
    assert.equal(authoritativeCalls, 0);
  }
});

test('preserves an authoritative offline failure and blocks success', async () => {
  const result = await runProjectSwitchSaveBarrier(validInputs({
    saveAuthoritative: async () => ({ ok: false, reason: 'offline' }),
  }));

  assert.deepEqual(result, { ok: false, reason: 'offline' });
});

test('fails closed when authoritative save does not acknowledge object success', async () => {
  for (const authoritativeResult of [undefined, null, {}, true]) {
    const result = await runProjectSwitchSaveBarrier(validInputs({
      saveAuthoritative: async () => authoritativeResult,
    }));

    assert.deepEqual(result, { ok: false, reason: 'authoritative-save-failed' });
  }
});

test('rejects a switch when the snapshot changes during authoritative save', async () => {
  let current = true;

  const result = await runProjectSwitchSaveBarrier(validInputs({
    saveAuthoritative: async () => {
      current = false;
      return { ok: true, destination: 'cloud' };
    },
    isSnapshotCurrent: () => current,
  }));

  assert.deepEqual(result, { ok: false, reason: 'workspace-changed' });
});

test('returns success only after both saves and final currentness proof', async () => {
  const authoritativeResult = { ok: true, destination: 'cloud', revision: 12 };

  const result = await runProjectSwitchSaveBarrier(validInputs({
    saveAuthoritative: async () => authoritativeResult,
  }));

  assert.deepEqual(result, {
    ok: true,
    destination: 'cloud',
    snapshot,
  });
});

test('fails closed when the snapshot marker or callbacks are invalid', async () => {
  const missingOptions = await runProjectSwitchSaveBarrier(null);
  const invalidSnapshot = await runProjectSwitchSaveBarrier(validInputs({
    snapshot: { marker: { generation: 7 } },
  }));
  const missingProjectId = await runProjectSwitchSaveBarrier(validInputs({
    snapshot: { marker: { generation: 7, revision: 12 }, project: { id: '' } },
  }));
  const negativeMarker = await runProjectSwitchSaveBarrier(validInputs({
    snapshot: { marker: { generation: -1, revision: 12 }, project: { id: 'project-a' } },
  }));
  const fractionalMarker = await runProjectSwitchSaveBarrier(validInputs({
    snapshot: { marker: { generation: 7, revision: 1.5 }, project: { id: 'project-a' } },
  }));
  const invalidCallback = await runProjectSwitchSaveBarrier(validInputs({
    saveAuthoritative: null,
  }));

  assert.deepEqual(missingOptions, { ok: false, reason: 'invalid-input' });
  assert.deepEqual(invalidSnapshot, { ok: false, reason: 'invalid-input' });
  assert.deepEqual(missingProjectId, { ok: false, reason: 'invalid-input' });
  assert.deepEqual(negativeMarker, { ok: false, reason: 'invalid-input' });
  assert.deepEqual(fractionalMarker, { ok: false, reason: 'invalid-input' });
  assert.deepEqual(invalidCallback, { ok: false, reason: 'invalid-input' });
});
