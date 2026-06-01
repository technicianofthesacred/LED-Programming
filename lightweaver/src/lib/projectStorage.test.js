import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProjectLibraryRecord,
  deleteProjectLibraryRecord,
  duplicateProjectLibraryRecord,
  readActiveProjectLibraryRecordId,
  listProjectLibraryRecords,
  saveCurrentProjectToLibrary,
  saveProjectLibraryRecord,
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
