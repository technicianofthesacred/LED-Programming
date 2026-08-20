import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adoptBrowserRecordAssociation,
  adoptCloudProjectAssociation,
  adoptUnassociatedWorkspace,
  clearAllProjectAssociations,
  createImportAssociationCleanup,
  retryAssociationHandoff,
} from './projectAssociation.js';

// Recording io: every handle appends its call (name + argument) to `calls`,
// so each test asserts both the COMPLETE set of transitions and their ORDER.
function recordingIo(overrides = {}) {
  const calls = [];
  let activeRecordId = overrides.initialActiveRecordId ?? 'stale-record';
  const io = {
    writeActiveRecordId: id => {
      calls.push(['writeActiveRecordId', id]);
      if (overrides.writeFails) throw new Error('storage failed');
      activeRecordId = id;
    },
    readActiveRecordId: () => {
      calls.push(['readActiveRecordId']);
      return overrides.readbackLies ? 'ghost-record' : activeRecordId;
    },
    associateRecordGuarded: async snapshot => {
      calls.push(['associateRecordGuarded', snapshot.recordId]);
      return overrides.associateResult ?? {
        ok: true,
        associationSnapshot: snapshot,
        associationOwnershipToken: 'token-1',
      };
    },
    clearRecordAssociationGuarded: async ownership => {
      calls.push(['clearRecordAssociationGuarded', ownership.recordId, ownership.ownershipToken]);
      return { ok: true };
    },
    detachCloudProject: () => calls.push(['detachCloudProject']),
    setBrowserAssociationSnapshot: snapshot => calls.push(['setBrowserAssociationSnapshot', snapshot?.recordId ?? null]),
    setSaveBlocked: blocked => calls.push(['setSaveBlocked', blocked]),
    markProjectPersisted: () => calls.push(['markProjectPersisted']),
    markProjectEdited: () => calls.push(['markProjectEdited']),
  };
  return { io, calls };
}

const snapshot = recordId => ({ recordId, record: { id: recordId } });

test('cloud adoption clears the browser pointer, verifies it, then unblocks — in that order', () => {
  const { io, calls } = recordingIo();
  const result = adoptCloudProjectAssociation(io);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    ['setBrowserAssociationSnapshot', null],
    ['writeActiveRecordId', ''],
    ['readActiveRecordId'],
    ['setSaveBlocked', false],
  ]);
});

test('cloud adoption blocks saving when the pointer clear cannot be proven', () => {
  const { io, calls } = recordingIo({ readbackLies: true });
  const result = adoptCloudProjectAssociation(io);
  assert.deepEqual(result, { ok: false, reason: 'association-handoff-failed' });
  assert.deepEqual(calls.at(-1), ['setSaveBlocked', true]);
  assert.ok(!calls.some(call => call[0] === 'setSaveBlocked' && call[1] === false));
});

test('browser adoption detaches cloud first, then associates, records, marks, and unblocks', async () => {
  const { io, calls } = recordingIo();
  const result = await adoptBrowserRecordAssociation({
    recordId: 'record-1',
    recordSnapshot: snapshot('record-1'),
    io,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['detachCloudProject'],
    ['associateRecordGuarded', 'record-1'],
    ['setBrowserAssociationSnapshot', 'record-1'],
    ['markProjectPersisted'],
    ['setSaveBlocked', false],
  ]);
});

test('browser adoption fails closed on a failed association: cloud detached, snapshot cleared, edit marked, save blocked', async () => {
  const { io, calls } = recordingIo({ associateResult: { ok: false, reason: 'browser-conflict' } });
  const result = await adoptBrowserRecordAssociation({
    recordId: 'record-1',
    recordSnapshot: snapshot('record-1'),
    io,
  });
  assert.deepEqual(result, { ok: false, reason: 'association-handoff-failed' });
  assert.deepEqual(calls, [
    ['detachCloudProject'],
    ['associateRecordGuarded', 'record-1'],
    ['detachCloudProject'],
    ['setBrowserAssociationSnapshot', null],
    ['markProjectEdited'],
    ['setSaveBlocked', true],
  ]);
});

test('browser adoption releases a taken association when the lifecycle marker moved on', async () => {
  const { io, calls } = recordingIo();
  const result = await adoptBrowserRecordAssociation({
    recordId: 'record-1',
    recordSnapshot: snapshot('record-1'),
    isMarkerCurrent: () => false,
    io,
  });
  assert.deepEqual(result, { ok: false, reason: 'superseded' });
  assert.deepEqual(calls, [
    ['detachCloudProject'],
    ['associateRecordGuarded', 'record-1'],
    ['clearRecordAssociationGuarded', 'record-1', 'token-1'],
  ]);
  assert.ok(!calls.some(call => call[0] === 'setSaveBlocked'), 'a superseded adoption never touches the save block');
});

test('browser adoption rejects a mismatched record snapshot without touching the association', async () => {
  const { io, calls } = recordingIo();
  const result = await adoptBrowserRecordAssociation({
    recordId: 'record-1',
    recordSnapshot: snapshot('other-record'),
    io,
  });
  assert.deepEqual(result, { ok: false, reason: 'association-handoff-failed' });
  assert.ok(!calls.some(call => call[0] === 'associateRecordGuarded'));
  assert.deepEqual(calls.at(-1), ['setSaveBlocked', true]);
});

test('unassociated adoption detaches cloud, proves the pointer cleared, and unblocks', () => {
  const { io, calls } = recordingIo();
  const result = adoptUnassociatedWorkspace({ io });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    ['detachCloudProject'],
    ['writeActiveRecordId', ''],
    ['readActiveRecordId'],
    ['setBrowserAssociationSnapshot', null],
    ['setSaveBlocked', false],
  ]);
});

test('unassociated adoption fails closed when the pointer survives the clear', () => {
  const { io, calls } = recordingIo({ readbackLies: true });
  const result = adoptUnassociatedWorkspace({ io });
  assert.deepEqual(result, { ok: false, reason: 'association-handoff-failed' });
  assert.deepEqual(calls.at(-1), ['setSaveBlocked', true]);
});

test('unassociated adoption reports superseded without changing the block when the marker moved on', () => {
  const { io, calls } = recordingIo();
  const result = adoptUnassociatedWorkspace({ isMarkerCurrent: () => false, io });
  assert.deepEqual(result, { ok: false, reason: 'superseded' });
  assert.ok(!calls.some(call => call[0] === 'setSaveBlocked'));
});

test('new-project reset clears every store then unblocks, in order', () => {
  const { io, calls } = recordingIo();
  clearAllProjectAssociations(io);
  assert.deepEqual(calls, [
    ['setBrowserAssociationSnapshot', null],
    ['writeActiveRecordId', ''],
    ['detachCloudProject'],
    ['setSaveBlocked', false],
  ]);
});

test('import cleanup bundle exposes the three handles with complete per-handle behavior', () => {
  const { io, calls } = recordingIo();
  const cleanup = createImportAssociationCleanup(io);
  cleanup.clearBrowserAssociation();
  cleanup.detachCloudProject();
  cleanup.clearSaveBlock();
  assert.deepEqual(calls, [
    ['setBrowserAssociationSnapshot', null],
    ['writeActiveRecordId', ''],
    ['detachCloudProject'],
    ['setSaveBlocked', false],
  ]);
});

test('retry re-runs the cloud handoff when a cloud project is the destination', async () => {
  const { io, calls } = recordingIo();
  const result = await retryAssociationHandoff({ hasActiveCloudProject: true, io });
  assert.deepEqual(result, { ok: true });
  assert.ok(calls.some(call => call[0] === 'writeActiveRecordId' && call[1] === ''));
  assert.ok(!calls.some(call => call[0] === 'detachCloudProject'), 'a cloud retry never detaches the active cloud project');
  assert.deepEqual(calls.at(-1), ['setSaveBlocked', false]);
});

test('retry re-establishes an unassociated workspace when no cloud project is active', async () => {
  const { io, calls } = recordingIo();
  const result = await retryAssociationHandoff({ hasActiveCloudProject: false, io });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[0], ['detachCloudProject']);
  assert.deepEqual(calls.at(-1), ['setSaveBlocked', false]);
});

test('retry leaves the block set when the handoff still cannot be proven', async () => {
  const { io, calls } = recordingIo({ readbackLies: true });
  const result = await retryAssociationHandoff({ hasActiveCloudProject: false, io });
  assert.deepEqual(result, { ok: false, reason: 'association-handoff-failed' });
  assert.deepEqual(calls.at(-1), ['setSaveBlocked', true]);
});
