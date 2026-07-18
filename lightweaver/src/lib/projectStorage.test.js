import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOSAVE_QUARANTINE_STORAGE_KEY,
  PROJECT_LIFECYCLE_STORAGE_KEY,
  clearAutosaveQuarantine,
  createProjectLibraryRecord,
  deleteProjectLibraryRecord,
  duplicateProjectLibraryRecord,
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
  writeProjectLifecycleRecord,
  writeStorageJsonWithBackup,
  writeActiveProjectLibraryRecordId,
} from './projectStorage.js';
import { createDefaultProject } from './projectModel.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
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

test('fails instead of reporting a save when browser storage is unavailable', () => {
  const record = createProjectLibraryRecord(createDefaultProject(), { id: 'a', now: 1000 });

  assert.throws(
    () => saveProjectLibraryRecord(record, { storage: null }),
    /storage is unavailable/,
  );
});

test('saveCurrentProjectToLibrary updates the active project record', () => {
  const storage = memoryStorage();
  const first = saveCurrentProjectToLibrary({ ...createDefaultProject(), name: 'Active' }, {
    storage,
    id: 'active-record',
    now: 1000,
  });

  assert.equal(readActiveProjectLibraryRecordId({ storage }), 'active-record');
  assert.equal(first.name, 'Active');

  const updated = saveCurrentProjectToLibrary({ ...createDefaultProject(), name: 'Active revised' }, {
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
