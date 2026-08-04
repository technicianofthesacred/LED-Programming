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

test('rejects asynchronous and thenable browser recovery', async () => {
  for (const flushBrowserRecovery of [
    async () => true,
    () => ({ then() {} }),
  ]) {
    let authoritativeCalls = 0;
    const result = await runProjectSwitchSaveBarrier(validInputs({
      flushBrowserRecovery,
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

test('preserves typed authoritative rejection reasons without exposing error messages', async () => {
  const typedRejection = await runProjectSwitchSaveBarrier(validInputs({
    saveAuthoritative: async () => {
      throw { reason: 'offline' };
    },
  }));
  const errorRejection = await runProjectSwitchSaveBarrier(validInputs({
    saveAuthoritative: async () => {
      throw new Error('private backend detail');
    },
  }));

  assert.deepEqual(typedRejection, { ok: false, reason: 'offline' });
  assert.deepEqual(errorRejection, { ok: false, reason: 'authoritative-save-failed' });
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

test('rejects asynchronous and thenable currentness checks', async () => {
  for (const isSnapshotCurrent of [
    async () => true,
    () => ({ then() {} }),
  ]) {
    const result = await runProjectSwitchSaveBarrier(validInputs({ isSnapshotCurrent }));

    assert.deepEqual(result, { ok: false, reason: 'workspace-changed' });
  }
});

test('captures and deeply freezes the snapshot before callbacks run', async () => {
  const original = {
    project: { id: 'project-a', settings: { brightness: 80 } },
    marker: { generation: 7, revision: 12 },
    remoteId: 'remote-a',
  };
  const callbackSnapshots = [];
  let finishSave;

  const pending = runProjectSwitchSaveBarrier(validInputs({
    snapshot: original,
    flushBrowserRecovery: (captured) => {
      callbackSnapshots.push(captured);
      assert.throws(() => {
        captured.project.settings.brightness = 1;
      }, TypeError);
      return true;
    },
    saveAuthoritative: (captured) => {
      callbackSnapshots.push(captured);
      return new Promise((resolve) => {
        finishSave = () => resolve({ ok: true, destination: 'cloud' });
      });
    },
    isSnapshotCurrent: (captured) => {
      callbackSnapshots.push(captured);
      assert.equal(captured.project.id, 'project-a');
      assert.equal(captured.marker.revision, 12);
      return true;
    },
  }));

  original.project.id = 'project-b';
  original.marker.revision = 13;
  finishSave();
  const result = await pending;

  assert.equal(callbackSnapshots.length, 3);
  assert.equal(callbackSnapshots.every((value) => value === callbackSnapshots[0]), true);
  assert.notEqual(callbackSnapshots[0], original);
  assert.equal(Object.isFrozen(callbackSnapshots[0]), true);
  assert.equal(Object.isFrozen(callbackSnapshots[0].project.settings), true);
  assert.deepEqual(result, {
    ok: true,
    destination: 'cloud',
    snapshot: callbackSnapshots[0],
  });
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
  const uncloneableSnapshot = await runProjectSwitchSaveBarrier(validInputs({
    snapshot: {
      project: { id: 'project-a', transform() {} },
      marker: { generation: 7, revision: 12 },
    },
  }));

  assert.deepEqual(missingOptions, { ok: false, reason: 'snapshot-invalid' });
  assert.deepEqual(invalidSnapshot, { ok: false, reason: 'snapshot-invalid' });
  assert.deepEqual(missingProjectId, { ok: false, reason: 'snapshot-invalid' });
  assert.deepEqual(negativeMarker, { ok: false, reason: 'snapshot-invalid' });
  assert.deepEqual(fractionalMarker, { ok: false, reason: 'snapshot-invalid' });
  assert.deepEqual(invalidCallback, { ok: false, reason: 'invalid-input' });
  assert.deepEqual(uncloneableSnapshot, { ok: false, reason: 'snapshot-invalid' });
});
