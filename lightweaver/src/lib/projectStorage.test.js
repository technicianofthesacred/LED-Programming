import test from 'node:test';
import assert from 'node:assert/strict';
import * as projectStorageApi from './projectStorage.js';

import {
  AUTOSAVE_QUARANTINE_STORAGE_KEY,
  PROJECT_LIFECYCLE_STORAGE_KEY,
  clearAutosaveQuarantine,
  createProjectLibraryRecord,
  deleteProjectLibraryRecord,
  duplicateProjectLibraryRecord,
  isProjectLibrarySaveBlocked,
  PROJECT_LIBRARY_BACKUP_STORAGE_KEY,
  PROJECT_LIBRARY_STORAGE_KEY,
  quarantineAutosavePayload,
  readActiveProjectLibraryRecordId,
  readAutosaveQuarantine,
  readProjectLifecycleRecord,
  readRestorableProjectJson,
  listProjectLibraryRecords,
  readStorageJsonWithBackup,
  saveCurrentProjectToLibrary,
  saveProjectLibraryRecord,
  setProjectLibrarySaveBlocked,
  writeProjectLifecycleRecord,
  writeStorageJsonWithBackup,
  writeActiveProjectLibraryRecordId,
} from './projectStorage.js';
import { createDefaultProject, migrateProject, resolveStartupProject } from './projectModel.js';
import { normalizePatchBoard } from './patchBoard.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

function controlledLockManager() {
  const queue = [];
  return {
    request(name, options, callback) {
      assert.equal(name, 'lightweaver-project-library-save-v1');
      assert.deepEqual(options, { mode: 'exclusive' });
      return new Promise((resolve, reject) => {
        queue.push({ callback, name, options, reject, resolve });
      });
    },
    pending() {
      return queue.length;
    },
    async runNext() {
      const entry = queue.shift();
      assert.ok(entry, 'expected a queued lock request');
      try {
        entry.resolve(await entry.callback());
      } catch (error) {
        entry.reject(error);
      }
      await Promise.resolve();
    },
  };
}

test('saves project snapshots and lists them newest first', () => {
  const storage = memoryStorage();
  const first = createProjectLibraryRecord({ ...createDefaultProject(), name: 'First' }, { id: 'a', now: 1000 });
  const second = createProjectLibraryRecord({ ...createDefaultProject(), name: 'Second' }, { id: 'b', now: 2000 });

  saveProjectLibraryRecord(first, { storage });
  saveProjectLibraryRecord(second, { storage });

  assert.deepEqual(listProjectLibraryRecords({ storage }).map(record => record.name), ['Second', 'First']);
});

test('updates an existing saved project without changing createdAt', () => {
  const storage = memoryStorage();
  const first = createProjectLibraryRecord({ ...createDefaultProject(), name: 'Original' }, { id: 'a', now: 1000 });
  saveProjectLibraryRecord(first, { storage });

  saveProjectLibraryRecord({ ...first, name: 'Renamed', project: { ...first.project, name: 'Renamed' } }, { storage, now: 3000 });

  const [record] = listProjectLibraryRecords({ storage });
  assert.equal(record.name, 'Renamed');
  assert.equal(record.createdAt, 1000);
  assert.equal(record.updatedAt, 3000);
});

test('duplicates and deletes saved project records', () => {
  const storage = memoryStorage();
  const first = createProjectLibraryRecord({ ...createDefaultProject(), name: 'Original' }, { id: 'a', now: 1000 });
  saveProjectLibraryRecord(first, { storage });

  const copy = duplicateProjectLibraryRecord('a', { storage, id: 'b', now: 2000 });
  assert.equal(copy.name, 'Original copy');
  assert.notEqual(copy.project.id, first.project.id);
  assert.match(copy.project.id, /^lwproj-/);
  assert.deepEqual(listProjectLibraryRecords({ storage }).map(record => record.id), ['b', 'a']);

  deleteProjectLibraryRecord('a', { storage });
  assert.deepEqual(listProjectLibraryRecords({ storage }).map(record => record.id), ['b']);
});

test('renameProjectLibraryRecordGuarded renames record and project under the save lock with readback', async () => {
  const storage = memoryStorage();
  const lockManager = controlledLockManager();
  const first = createProjectLibraryRecord({ ...createDefaultProject(), name: 'Original' }, { id: 'a', now: 1000 });
  saveProjectLibraryRecord(first, { storage });

  const pending = projectStorageApi.renameProjectLibraryRecordGuarded('a', '  Renamed Piece  ', { storage, lockManager, now: 2000 });
  assert.equal(lockManager.pending(), 1);
  await lockManager.runNext();
  const result = await pending;

  assert.equal(result.ok, true);
  const [record] = listProjectLibraryRecords({ storage });
  assert.equal(record.name, 'Renamed Piece');
  assert.equal(record.project.name, 'Renamed Piece');
  assert.equal(record.project.id, first.project.id);
  assert.equal(record.createdAt, 1000);
  assert.equal(record.updatedAt, 2000);
});

test('renameProjectLibraryRecordGuarded refuses empty names and missing records', async () => {
  const storage = memoryStorage();
  const lockManager = controlledLockManager();

  assert.deepEqual(
    await projectStorageApi.renameProjectLibraryRecordGuarded('a', '   ', { storage, lockManager }),
    { ok: false, reason: 'invalid-name' },
  );
  assert.equal(lockManager.pending(), 0);

  const pending = projectStorageApi.renameProjectLibraryRecordGuarded('missing', 'New name', { storage, lockManager });
  await lockManager.runNext();
  assert.deepEqual(await pending, { ok: false, reason: 'record-missing' });
});

test('fails instead of reporting a save when browser storage is unavailable', () => {
  const record = createProjectLibraryRecord(createDefaultProject(), { id: 'a', now: 1000 });

  assert.throws(
    () => saveProjectLibraryRecord(record, { storage: null }),
    /storage is unavailable/,
  );
});

test('saveCurrentProjectToLibrary updates the active project record', () => {
  const storage = memoryStorage();
  const activeProject = { ...createDefaultProject(), name: 'Active' };
  const first = saveCurrentProjectToLibrary(activeProject, {
    storage,
    id: 'active-record',
    now: 1000,
  });

  assert.equal(readActiveProjectLibraryRecordId({ storage }), 'active-record');
  assert.equal(first.name, 'Active');

  const updated = saveCurrentProjectToLibrary({ ...activeProject, name: 'Active revised' }, {
    storage,
    now: 2000,
  });

  assert.equal(updated.id, 'active-record');
  assert.equal(updated.createdAt, 1000);
  assert.equal(updated.updatedAt, 2000);
  assert.deepEqual(listProjectLibraryRecords({ storage }).map(record => record.name), ['Active revised']);

  writeActiveProjectLibraryRecordId('', { storage });
  const fresh = saveCurrentProjectToLibrary({ ...createDefaultProject(), name: 'Fresh' }, {
    storage,
    id: 'fresh-record',
    now: 3000,
  });
  assert.equal(fresh.id, 'fresh-record');
  assert.deepEqual(listProjectLibraryRecords({ storage }).map(record => record.name), ['Fresh', 'Active revised']);
});

test('a stale active record can never be overwritten by a different project id', () => {
  const storage = memoryStorage();
  const previous = { ...createDefaultProject(), id: 'previous-project', name: 'Previous project' };
  const next = { ...createDefaultProject(), id: 'next-project', name: 'Next project' };
  const previousRecord = saveCurrentProjectToLibrary(previous, {
    storage,
    id: 'previous-record',
    now: 1000,
  });

  const nextRecord = saveCurrentProjectToLibrary(next, { storage, now: 2000 });

  assert.equal(previousRecord.id, 'previous-record');
  assert.notEqual(nextRecord.id, previousRecord.id);
  assert.equal(readActiveProjectLibraryRecordId({ storage }), nextRecord.id);
  assert.deepEqual(
    listProjectLibraryRecords({ storage }).map(record => [record.project.id, record.name]),
    [['next-project', 'Next project'], ['previous-project', 'Previous project']],
  );
});

test('a global safety block stops every current-project browser library save', () => {
  const storage = memoryStorage();
  setProjectLibrarySaveBlocked(true);
  try {
    assert.equal(isProjectLibrarySaveBlocked(), true);
    assert.throws(
      () => saveCurrentProjectToLibrary(createDefaultProject(), { storage }),
      /blocked until a safe project destination is established/,
    );
    assert.deepEqual(listProjectLibraryRecords({ storage }), []);
  } finally {
    setProjectLibrarySaveBlocked(false);
  }
  assert.equal(isProjectLibrarySaveBlocked(), false);
});

test('guarded concurrent saves serialize and preserve both distinct project records', async () => {
  assert.equal(typeof projectStorageApi.saveCurrentProjectToLibraryGuarded, 'function');
  const storage = memoryStorage();
  const lockManager = controlledLockManager();
  const firstProject = { ...createDefaultProject(), id: 'project-a', name: 'Project A' };
  const secondProject = { ...createDefaultProject(), id: 'project-b', name: 'Project B' };

  const firstSave = projectStorageApi.saveCurrentProjectToLibraryGuarded(firstProject, {
    storage, lockManager, id: 'record-a', now: 1000,
  });
  const secondSave = projectStorageApi.saveCurrentProjectToLibraryGuarded(secondProject, {
    storage, lockManager, id: 'record-b', now: 2000,
  });

  assert.equal(lockManager.pending(), 2);
  await lockManager.runNext();
  await lockManager.runNext();
  assert.equal((await firstSave).ok, true);
  assert.equal((await secondSave).ok, true);
  assert.deepEqual(
    listProjectLibraryRecords({ storage }).map(record => record.project.id).sort(),
    ['project-a', 'project-b'],
  );
});

test('guarded save rejects a stale same-project record without overwriting newer content', async () => {
  assert.equal(typeof projectStorageApi.saveCurrentProjectToLibraryGuarded, 'function');
  const storage = memoryStorage();
  const lockManager = controlledLockManager();
  const original = { ...createDefaultProject(), id: 'shared-project', name: 'Original' };
  saveCurrentProjectToLibrary(original, { storage, id: 'shared-record', now: 1000 });

  const pending = projectStorageApi.saveCurrentProjectToLibraryGuarded(
    { ...original, name: 'Tab A edit' },
    { storage, lockManager, adoptCurrentAssociation: true, now: 3000 },
  );
  saveProjectLibraryRecord(createProjectLibraryRecord(
    { ...original, name: 'Tab B edit' },
    { id: 'shared-record', now: 2000 },
  ), { storage, now: 2000 });

  await lockManager.runNext();
  assert.deepEqual(await pending, { ok: false, reason: 'browser-conflict' });
  assert.equal(listProjectLibraryRecords({ storage })[0].name, 'Tab B edit');
});

test('guarded save rejects a caller-held association after another tab already saved a newer revision', async () => {
  const storage = memoryStorage();
  const project = { ...createDefaultProject(), id: 'sequential-project', name: 'Original' };
  saveCurrentProjectToLibrary(project, { storage, id: 'sequential-record', now: 1000 });
  const tabAAssociation = projectStorageApi.readProjectLibraryRecordSnapshot('sequential-record', { storage });
  saveCurrentProjectToLibrary({ ...project, name: 'Tab B newer save' }, { storage, now: 2000 });
  const lockManager = controlledLockManager();

  const pending = projectStorageApi.saveCurrentProjectToLibraryGuarded(
    { ...project, name: 'Tab A stale save' },
    { storage, lockManager, expectedAssociationSnapshot: tabAAssociation, now: 3000 },
  );
  await lockManager.runNext();

  assert.deepEqual(await pending, { ok: false, reason: 'browser-conflict' });
  assert.equal(listProjectLibraryRecords({ storage })[0].name, 'Tab B newer save');
});

test('guarded save rejects a caller-held association whose record was deleted', async () => {
  const storage = memoryStorage();
  const project = { ...createDefaultProject(), id: 'deleted-project', name: 'Before deletion' };
  saveCurrentProjectToLibrary(project, { storage, id: 'deleted-record', now: 1000 });
  const expectedAssociationSnapshot = projectStorageApi.readProjectLibraryRecordSnapshot('deleted-record', { storage });
  deleteProjectLibraryRecord('deleted-record', { storage });
  const lockManager = controlledLockManager();

  const pending = projectStorageApi.saveCurrentProjectToLibraryGuarded(project, {
    storage, lockManager, expectedAssociationSnapshot, now: 2000,
  });
  await lockManager.runNext();

  assert.deepEqual(await pending, { ok: false, reason: 'browser-conflict' });
  assert.deepEqual(listProjectLibraryRecords({ storage }), []);
});

test('guarded save rejects an association token whose record ID does not match its record', async () => {
  const storage = memoryStorage();
  const project = { ...createDefaultProject(), id: 'mismatched-project', name: 'Original' };
  saveCurrentProjectToLibrary(project, { storage, id: 'mismatched-record', now: 1000 });
  const valid = projectStorageApi.readProjectLibraryRecordSnapshot('mismatched-record', { storage });
  const expectedAssociationSnapshot = { ...valid, recordId: 'different-record' };
  const lockManager = controlledLockManager();

  const pending = projectStorageApi.saveCurrentProjectToLibraryGuarded(
    { ...project, name: 'Must not save' },
    { storage, lockManager, expectedAssociationSnapshot, now: 2000 },
  );
  await lockManager.runNext();

  assert.deepEqual(await pending, { ok: false, reason: 'browser-conflict' });
  assert.equal(listProjectLibraryRecords({ storage })[0].name, 'Original');
});

test('guarded save without an association token creates a distinct record instead of adopting an existing same-project pointer', async () => {
  const storage = memoryStorage();
  const project = { ...createDefaultProject(), id: 'unadopted-project', name: 'Existing revision' };
  const existing = saveCurrentProjectToLibrary(project, { storage, id: 'unadopted-record', now: 1000 });
  const lockManager = controlledLockManager();

  const pending = projectStorageApi.saveCurrentProjectToLibraryGuarded(
    { ...project, name: 'Independent save' },
    { storage, lockManager, now: 2000 },
  );
  await lockManager.runNext();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.notEqual(result.record.id, existing.id);
  assert.deepEqual(
    listProjectLibraryRecords({ storage }).map(record => record.name).sort(),
    ['Existing revision', 'Independent save'],
  );
});

test('guarded save captures an immutable project snapshot before waiting for the lock', async () => {
  assert.equal(typeof projectStorageApi.saveCurrentProjectToLibraryGuarded, 'function');
  const storage = memoryStorage();
  const lockManager = controlledLockManager();
  const project = { ...createDefaultProject(), id: 'immutable-project', name: 'Captured name' };

  const pending = projectStorageApi.saveCurrentProjectToLibraryGuarded(project, {
    storage, lockManager, id: 'immutable-record', now: 1000,
  });
  project.name = 'Mutated after capture';
  await lockManager.runNext();

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.record.name, 'Captured name');
  assert.equal(Object.isFrozen(result.projectSnapshot), true);
  assert.equal(
    projectStorageApi.sameProjectLibraryRecordSnapshot(
      result.associationSnapshot,
      projectStorageApi.readProjectLibraryRecordSnapshot(result.record.id, { storage }),
    ),
    true,
  );
});

test('guarded save fails closed when safe browser locking is unavailable', async () => {
  assert.equal(typeof projectStorageApi.saveCurrentProjectToLibraryGuarded, 'function');
  const storage = memoryStorage();

  const result = await projectStorageApi.saveCurrentProjectToLibraryGuarded(createDefaultProject(), {
    storage,
    lockManager: {},
  });

  assert.deepEqual(result, { ok: false, reason: 'locking-unavailable' });
  assert.deepEqual(listProjectLibraryRecords({ storage }), []);
});

test('guarded save verifies exact storage readback before acknowledging success', async () => {
  assert.equal(typeof projectStorageApi.saveCurrentProjectToLibraryGuarded, 'function');
  const base = memoryStorage();
  const storage = {
    ...base,
    setItem(key, value) {
      if (key === PROJECT_LIBRARY_STORAGE_KEY || key === PROJECT_LIBRARY_BACKUP_STORAGE_KEY) return;
      base.setItem(key, value);
    },
  };
  const lockManager = controlledLockManager();
  const pending = projectStorageApi.saveCurrentProjectToLibraryGuarded(createDefaultProject(), {
    storage, lockManager, id: 'unacknowledged-record', now: 1000,
  });

  await lockManager.runNext();
  assert.deepEqual(await pending, { ok: false, reason: 'browser-readback-failed' });
});

test('guarded association stores only the exact caller-held record revision', async () => {
  assert.equal(typeof projectStorageApi.associateProjectLibraryRecordGuarded, 'function');
  const storage = memoryStorage();
  const project = { ...createDefaultProject(), id: 'association-project', name: 'Association target' };
  saveCurrentProjectToLibrary(project, { storage, id: 'association-record', now: 1000 });
  writeActiveProjectLibraryRecordId('', { storage });
  const expectedAssociationSnapshot = projectStorageApi.readProjectLibraryRecordSnapshot(
    'association-record',
    { storage },
  );
  const lockManager = controlledLockManager();

  const pending = projectStorageApi.associateProjectLibraryRecordGuarded(
    expectedAssociationSnapshot,
    { storage, lockManager },
  );
  await lockManager.runNext();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(readActiveProjectLibraryRecordId({ storage }), 'association-record');
  assert.equal(
    projectStorageApi.sameProjectLibraryRecordSnapshot(
      result.associationSnapshot,
      expectedAssociationSnapshot,
    ),
    true,
  );
});

test('stale tab cleanup cannot clear a newer guarded association to the same record', async () => {
  const storage = memoryStorage();
  const project = { ...createDefaultProject(), id: 'shared-association-project', name: 'Shared target' };
  saveCurrentProjectToLibrary(project, { storage, id: 'shared-association-record', now: 1000 });
  writeActiveProjectLibraryRecordId('', { storage });
  const expectedAssociationSnapshot = projectStorageApi.readProjectLibraryRecordSnapshot(
    'shared-association-record',
    { storage },
  );
  const lockManager = controlledLockManager();

  const firstPending = projectStorageApi.associateProjectLibraryRecordGuarded(
    expectedAssociationSnapshot,
    { storage, lockManager },
  );
  await lockManager.runNext();
  const first = await firstPending;

  const secondPending = projectStorageApi.associateProjectLibraryRecordGuarded(
    expectedAssociationSnapshot,
    { storage, lockManager },
  );
  await lockManager.runNext();
  const second = await secondPending;
  assert.equal(second.ok, true);
  assert.notEqual(second.associationOwnershipToken, first.associationOwnershipToken);

  const staleCleanup = projectStorageApi.clearProjectLibraryAssociationGuarded({
    recordId: first.associationSnapshot.recordId,
    ownershipToken: first.associationOwnershipToken,
  }, { storage, lockManager });
  await lockManager.runNext();

  assert.deepEqual(await staleCleanup, { ok: false, reason: 'ownership-changed' });
  assert.equal(readActiveProjectLibraryRecordId({ storage }), 'shared-association-record');
});

test('guarded association rejects a record changed while its lock request is queued', async () => {
  const storage = memoryStorage();
  const project = { ...createDefaultProject(), id: 'queued-association-project', name: 'Before queue' };
  saveCurrentProjectToLibrary(project, { storage, id: 'queued-association-record', now: 1000 });
  writeActiveProjectLibraryRecordId('', { storage });
  const expectedAssociationSnapshot = projectStorageApi.readProjectLibraryRecordSnapshot(
    'queued-association-record',
    { storage },
  );
  const lockManager = controlledLockManager();
  const pending = projectStorageApi.associateProjectLibraryRecordGuarded(
    expectedAssociationSnapshot,
    { storage, lockManager },
  );
  saveProjectLibraryRecord(createProjectLibraryRecord(
    { ...project, name: 'Changed before lock' },
    { id: 'queued-association-record', now: 2000 },
  ), { storage, now: 2000 });

  await lockManager.runNext();

  assert.deepEqual(await pending, { ok: false, reason: 'browser-conflict' });
  assert.equal(readActiveProjectLibraryRecordId({ storage }), '');
});

test('guarded association rejects a record deleted while its lock request is queued', async () => {
  const storage = memoryStorage();
  const project = { ...createDefaultProject(), id: 'deleted-association-project' };
  saveCurrentProjectToLibrary(project, { storage, id: 'deleted-association-record', now: 1000 });
  writeActiveProjectLibraryRecordId('', { storage });
  const expectedAssociationSnapshot = projectStorageApi.readProjectLibraryRecordSnapshot(
    'deleted-association-record',
    { storage },
  );
  const lockManager = controlledLockManager();
  const pending = projectStorageApi.associateProjectLibraryRecordGuarded(
    expectedAssociationSnapshot,
    { storage, lockManager },
  );
  deleteProjectLibraryRecord('deleted-association-record', { storage });

  await lockManager.runNext();

  assert.deepEqual(await pending, { ok: false, reason: 'browser-conflict' });
  assert.equal(readActiveProjectLibraryRecordId({ storage }), '');
});

test('guarded association detects deletion during the active-pointer write', async () => {
  const base = memoryStorage();
  let deleteDuringAssociation = false;
  const storage = {
    ...base,
    setItem(key, value) {
      base.setItem(key, value);
      if (key === projectStorageApi.PROJECT_ACTIVE_RECORD_STORAGE_KEY && deleteDuringAssociation) {
        deleteDuringAssociation = false;
        deleteProjectLibraryRecord('interleaved-association-record', { storage: base });
      }
    },
  };
  const project = { ...createDefaultProject(), id: 'interleaved-association-project' };
  saveCurrentProjectToLibrary(project, { storage, id: 'interleaved-association-record', now: 1000 });
  writeActiveProjectLibraryRecordId('', { storage });
  const expectedAssociationSnapshot = projectStorageApi.readProjectLibraryRecordSnapshot(
    'interleaved-association-record',
    { storage },
  );
  const lockManager = controlledLockManager();
  deleteDuringAssociation = true;

  const pending = projectStorageApi.associateProjectLibraryRecordGuarded(
    expectedAssociationSnapshot,
    { storage, lockManager },
  );
  await lockManager.runNext();

  assert.deepEqual(await pending, { ok: false, reason: 'browser-conflict' });
  assert.equal(readActiveProjectLibraryRecordId({ storage }), '');
});

test('guarded association reports a failed active-pointer readback', async () => {
  const base = memoryStorage();
  const storage = {
    ...base,
    setItem(key, value) {
      if (key !== projectStorageApi.PROJECT_ACTIVE_RECORD_STORAGE_KEY) base.setItem(key, value);
    },
  };
  const project = { ...createDefaultProject(), id: 'unacknowledged-association-project' };
  saveCurrentProjectToLibrary(project, { storage, id: 'unacknowledged-association-record', now: 1000 });
  const expectedAssociationSnapshot = projectStorageApi.readProjectLibraryRecordSnapshot(
    'unacknowledged-association-record',
    { storage },
  );
  const lockManager = controlledLockManager();
  const pending = projectStorageApi.associateProjectLibraryRecordGuarded(
    expectedAssociationSnapshot,
    { storage, lockManager },
  );

  await lockManager.runNext();

  assert.deepEqual(await pending, { ok: false, reason: 'browser-readback-failed' });
});

test('guarded association fails closed when safe browser locking is unavailable', async () => {
  const storage = memoryStorage();
  const project = { ...createDefaultProject(), id: 'unlocked-association-project' };
  saveCurrentProjectToLibrary(project, { storage, id: 'unlocked-association-record', now: 1000 });
  const expectedAssociationSnapshot = projectStorageApi.readProjectLibraryRecordSnapshot(
    'unlocked-association-record',
    { storage },
  );

  assert.deepEqual(
    await projectStorageApi.associateProjectLibraryRecordGuarded(expectedAssociationSnapshot, {
      storage,
      lockManager: {},
    }),
    { ok: false, reason: 'locking-unavailable' },
  );
});

test('record snapshot helpers compare exact frozen record revision and content', () => {
  assert.equal(typeof projectStorageApi.readProjectLibraryRecordSnapshot, 'function');
  assert.equal(typeof projectStorageApi.sameProjectLibraryRecordSnapshot, 'function');
  const storage = memoryStorage();
  const project = { ...createDefaultProject(), id: 'snapshot-project', name: 'First revision' };
  saveCurrentProjectToLibrary(project, { storage, id: 'snapshot-record', now: 1000 });
  const first = projectStorageApi.readProjectLibraryRecordSnapshot('snapshot-record', { storage });
  const same = projectStorageApi.readProjectLibraryRecordSnapshot('snapshot-record', { storage });
  saveCurrentProjectToLibrary({ ...project, name: 'Second revision' }, { storage, now: 2000 });
  const changed = projectStorageApi.readProjectLibraryRecordSnapshot('snapshot-record', { storage });

  assert.equal(first.recordId, 'snapshot-record');
  assert.equal(first.record.updatedAt, 1000);
  assert.equal(Object.isFrozen(first.record.project), true);
  assert.equal(projectStorageApi.sameProjectLibraryRecordSnapshot(first, same), true);
  assert.equal(projectStorageApi.sameProjectLibraryRecordSnapshot(first, changed), false);
});

test('project library reads the backup copy when the primary entry is corrupt', () => {
  const storage = memoryStorage();
  const record = createProjectLibraryRecord({ ...createDefaultProject(), name: 'Recoverable' }, {
    id: 'recoverable-record',
    now: 1000,
  });

  saveProjectLibraryRecord(record, { storage });
  storage.setItem(PROJECT_LIBRARY_STORAGE_KEY, '{"records":');

  const recovered = listProjectLibraryRecords({ storage });
  assert.deepEqual(recovered.map(item => item.id), ['recoverable-record']);
  assert.ok(storage.getItem(PROJECT_LIBRARY_BACKUP_STORAGE_KEY), 'save should maintain a project library backup');
});

test('readRestorableProjectJson restores the primary copy without a failure', () => {
  const storage = memoryStorage();
  const project = createDefaultProject();
  writeStorageJsonWithBackup('lw_autosave_v3', 'lw_autosave_v3_backup', project, { storage });

  const result = readRestorableProjectJson('lw_autosave_v3', 'lw_autosave_v3_backup', { storage });
  assert.equal(result.restoredFrom, 'primary');
  assert.equal(result.payload.id, project.id);
  assert.equal(result.failure, null);
});

test('readRestorableProjectJson falls back to the backup with no failure when the primary is corrupt', () => {
  const storage = memoryStorage();
  const project = createDefaultProject();
  writeStorageJsonWithBackup('lw_autosave_v3', 'lw_autosave_v3_backup', project, { storage });
  storage.setItem('lw_autosave_v3', '{broken json');

  const result = readRestorableProjectJson('lw_autosave_v3', 'lw_autosave_v3_backup', { storage });
  assert.equal(result.restoredFrom, 'backup');
  assert.equal(result.payload.id, project.id);
  assert.equal(result.failure, null, 'a restoring backup means no quarantine');
});

test('readRestorableProjectJson also restores a healthy backup behind a forward-version primary', () => {
  const storage = memoryStorage();
  const project = createDefaultProject();
  writeStorageJsonWithBackup('lw_autosave_v3', 'lw_autosave_v3_backup', project, { storage });
  storage.setItem('lw_autosave_v3', JSON.stringify({ version: 99, name: 'From the future' }));

  const result = readRestorableProjectJson('lw_autosave_v3', 'lw_autosave_v3_backup', { storage });
  assert.equal(result.restoredFrom, 'backup');
  assert.equal(result.failure, null);
});

test('readRestorableProjectJson reports a parse-error failure with the raw payload', () => {
  const storage = memoryStorage();
  storage.setItem('lw_autosave_v3', '{"version":3,"SENTINEL-TRUNCATED');
  storage.setItem('lw_autosave_v3_backup', '{also broken');

  const result = readRestorableProjectJson('lw_autosave_v3', 'lw_autosave_v3_backup', { storage });
  assert.equal(result.payload, null);
  assert.equal(result.restoredFrom, null);
  assert.equal(result.failure.reason, 'parse-error');
  assert.ok(result.failure.raw.includes('SENTINEL-TRUNCATED'), 'raw payload preserved verbatim');
});

test('readRestorableProjectJson classifies forward versions and invalid shapes', () => {
  const storage = memoryStorage();
  storage.setItem('lw_autosave_v3', JSON.stringify({ version: 99, sentinel: 'FUTURE' }));
  const forward = readRestorableProjectJson('lw_autosave_v3', 'lw_autosave_v3_backup', { storage });
  assert.equal(forward.failure.reason, 'unsupported-version');
  assert.ok(forward.failure.raw.includes('FUTURE'));

  storage.setItem('lw_autosave_v3', JSON.stringify({ hello: 'world' }));
  const invalid = readRestorableProjectJson('lw_autosave_v3', 'lw_autosave_v3_backup', { storage });
  assert.equal(invalid.failure.reason, 'invalid');
});

test('readRestorableProjectJson returns nothing at all for empty storage', () => {
  const storage = memoryStorage();
  assert.deepEqual(
    readRestorableProjectJson('lw_autosave_v3', 'lw_autosave_v3_backup', { storage }),
    { payload: null, restoredFrom: null, failure: null },
  );
});

test('quarantine stores one raw payload record and preserves the first until dismissed', () => {
  const storage = memoryStorage();
  const first = quarantineAutosavePayload('{"version":99,"sentinel":"FIRST-LOSS"', {
    reason: 'parse-error',
    now: 1000,
    storage,
  });
  assert.deepEqual(first, { at: 1000, reason: 'parse-error', payload: '{"version":99,"sentinel":"FIRST-LOSS"' });
  assert.deepEqual(readAutosaveQuarantine({ storage }), first);

  // A later failure must not overwrite the earlier (likely-real) user data.
  const second = quarantineAutosavePayload('junk', { reason: 'invalid', now: 2000, storage });
  assert.deepEqual(second, first, 'existing quarantine record wins');
  assert.equal(readAutosaveQuarantine({ storage }).payload.includes('FIRST-LOSS'), true);

  clearAutosaveQuarantine({ storage });
  assert.equal(readAutosaveQuarantine({ storage }), null);
  assert.equal(storage.getItem(AUTOSAVE_QUARANTINE_STORAGE_KEY), null);

  const third = quarantineAutosavePayload('junk', { reason: 'invalid', now: 3000, storage });
  assert.equal(third.reason, 'invalid');
  assert.equal(third.at, 3000);
});

test('quarantine tolerates missing storage and empty payloads', () => {
  assert.equal(quarantineAutosavePayload('data', { storage: null }), null);
  const storage = memoryStorage();
  assert.equal(quarantineAutosavePayload('', { storage }), null);
  assert.equal(quarantineAutosavePayload(undefined, { storage }), null);
  assert.equal(readAutosaveQuarantine({ storage }), null);
  storage.setItem(AUTOSAVE_QUARANTINE_STORAGE_KEY, '{corrupt');
  assert.equal(readAutosaveQuarantine({ storage }), null);
});

test('project lifecycle record round-trips and clears', () => {
  const storage = memoryStorage();
  assert.equal(readProjectLifecycleRecord({ storage }), null);

  const record = { version: 1, dirty: false, persistedDestination: 'browser', installed: false };
  assert.equal(writeProjectLifecycleRecord(record, { storage }), true);
  assert.deepEqual(readProjectLifecycleRecord({ storage }), record);

  assert.equal(writeProjectLifecycleRecord(null, { storage }), true);
  assert.equal(readProjectLifecycleRecord({ storage }), null);
  assert.equal(storage.getItem(PROJECT_LIFECYCLE_STORAGE_KEY), null);

  storage.setItem(PROJECT_LIFECYCLE_STORAGE_KEY, 'not-json');
  assert.equal(readProjectLifecycleRecord({ storage }), null);
});

test('generic JSON storage helpers recover from a corrupt primary snapshot', () => {
  const storage = memoryStorage();
  writeStorageJsonWithBackup('primary-json', 'backup-json', { ok: true, value: 42 }, { storage });
  storage.setItem('primary-json', '{broken');

  assert.deepEqual(readStorageJsonWithBackup('primary-json', 'backup-json', { storage }), {
    ok: true,
    value: 42,
  });
});

// ── Autosave round-trip: physical data-wire review flag ─────────────────────
// The autosave flush serializes `normalizePatchBoard(patchBoard, strips)` into
// the v3 keys; boot reads it back through readRestorableProjectJson and
// resolveStartupProject. Current-version projects must come back with the
// "Older project — confirm each strip's GPIO" flag exactly as saved.

const autosavePayloadFor = project => ({
  ...project,
  layout: {
    ...project.layout,
    patchBoard: normalizePatchBoard(project.layout.patchBoard, project.layout.strips),
  },
});

test('current-version autosave round-trip keeps the GPIO review flag clear', () => {
  const storage = memoryStorage();
  const project = createDefaultProject();
  assert.equal(project.layout.patchBoard.dataWireCountNeedsReview, false);

  writeStorageJsonWithBackup('lw_autosave_v3', 'lw_autosave_v3_backup', autosavePayloadFor(project), { storage });
  const { payload, restoredFrom } = readRestorableProjectJson('lw_autosave_v3', 'lw_autosave_v3_backup', { storage });
  assert.equal(restoredFrom, 'primary');
  const booted = resolveStartupProject({ savedProject: payload });

  assert.equal(booted.layout.patchBoard.dataWireCountNeedsReview, false);
  assert.equal(booted.layout.patchBoard.dataWireCount, 1);
});

test('a dismissed GPIO review flag stays dismissed across autosave reloads', () => {
  const storage = memoryStorage();

  // Legacy-shaped save: no explicit data-wire count, no wiring, no configured
  // outputs — the one case migration legitimately flags for review.
  const legacyShaped = createDefaultProject();
  delete legacyShaped.layout.patchBoard.dataWireCount;
  delete legacyShaped.layout.patchBoard.dataWireCountNeedsReview;
  legacyShaped.layout.wiring = null;
  legacyShaped.devices.standaloneController.outputs =
    legacyShaped.devices.standaloneController.outputs.map(output => ({ ...output, pixels: 0 }));

  const firstBoot = migrateProject(JSON.parse(JSON.stringify(legacyShaped)));
  assert.equal(firstBoot.layout.patchBoard.dataWireCountNeedsReview, true);

  // "Looks right" dismissal, then the normal autosave flush + reload.
  firstBoot.layout.patchBoard = { ...firstBoot.layout.patchBoard, dataWireCountNeedsReview: false };
  writeStorageJsonWithBackup('lw_autosave_v3', 'lw_autosave_v3_backup', autosavePayloadFor(firstBoot), { storage });
  const { payload } = readRestorableProjectJson('lw_autosave_v3', 'lw_autosave_v3_backup', { storage });
  const secondBoot = resolveStartupProject({ savedProject: payload });

  assert.equal(secondBoot.layout.patchBoard.dataWireCountNeedsReview, false);

  // And it must remain dismissed on every later reload as well.
  writeStorageJsonWithBackup('lw_autosave_v3', 'lw_autosave_v3_backup', autosavePayloadFor(secondBoot), { storage });
  const third = readRestorableProjectJson('lw_autosave_v3', 'lw_autosave_v3_backup', { storage });
  const thirdBoot = resolveStartupProject({ savedProject: third.payload });
  assert.equal(thirdBoot.layout.patchBoard.dataWireCountNeedsReview, false);
});
