import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalProjectFileName } from './projectFiles.js';
import {
  LIBRARY_BACKUP_FORMAT,
  LIBRARY_BACKUP_VERSION,
  canonicalLibraryBackupFileName,
  isLibraryBackup,
} from './libraryBackup.js';

test('individual and master downloads use distinct canonical names', () => {
  assert.equal(canonicalProjectFileName('Forest Halo'), 'forest-halo.lw.json');
  assert.equal(
    canonicalLibraryBackupFileName(new Date('2026-08-01T23:59:59.000Z')),
    '2026-08-01-lightweaver-master.lw-library.json',
  );
});

test('recognizes only a complete current master envelope', () => {
  const backup = {
    format: LIBRARY_BACKUP_FORMAT,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt: '2026-08-01T00:00:00.000Z',
    projects: [],
    workspaceAssets: [],
  };
  assert.equal(isLibraryBackup(backup), true);
  assert.equal(isLibraryBackup({ ...backup, projects: null }), false);
  assert.equal(isLibraryBackup({ ...backup, version: 2 }), false);
});

test('a portable project can never be mistaken for a master backup', () => {
  const project = {
    version: 1,
    id: 'lightweaver.library-backup',
    name: 'Looks suggestive but is still a project',
    projects: [],
    workspaceAssets: [],
  };
  assert.equal(isLibraryBackup(project), false);
});

test('master backup names require a valid date', () => {
  assert.throws(() => canonicalLibraryBackupFileName('not-a-date'), /valid date/i);
});
