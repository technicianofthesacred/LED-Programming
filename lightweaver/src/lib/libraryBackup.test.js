import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalProjectFileName } from './projectFiles.js';
import { createDefaultProject } from './projectModel.js';
import {
  LIBRARY_BACKUP_FORMAT,
  LIBRARY_BACKUP_VERSION,
  canonicalLibraryBackupFileName,
  isLibraryBackup,
} from './libraryBackup.js';

function completeBackup() {
  const project = createDefaultProject();
  return {
    format: LIBRARY_BACKUP_FORMAT,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt: '2026-08-01T00:00:00.000Z',
    projects: [{
      id: 'remote-one',
      title: 'Forest Halo',
      archived: false,
      currentRevision: 1,
      revisions: [{
        revision: 1,
        archived: false,
        createdAt: '2026-08-01T00:00:00.000Z',
        document: project,
      }],
    }],
    workspaceAssets: [{
      kind: 'custom-patterns',
      currentRevision: 1,
      revisions: [{
        revision: 1,
        createdAt: '2026-08-01T00:00:00.000Z',
        value: { patterns: [] },
      }],
    }],
  };
}

test('individual and master downloads use distinct canonical names', () => {
  assert.equal(canonicalProjectFileName('Forest Halo'), 'forest-halo.lw.json');
  assert.equal(
    canonicalLibraryBackupFileName(new Date('2026-08-01T23:59:59.000Z')),
    '2026-08-01-lightweaver-master.lw-library.json',
  );
});

test('recognizes only a complete current master envelope', () => {
  const backup = completeBackup();
  assert.equal(isLibraryBackup(backup), true);
  assert.equal(isLibraryBackup({ ...backup, projects: null }), false);
  assert.equal(isLibraryBackup({ ...backup, version: 2 }), false);
  assert.equal(isLibraryBackup({
    ...backup,
    projects: [{ ...backup.projects[0], currentRevision: 7 }],
  }), false);
  assert.equal(isLibraryBackup({
    ...backup,
    workspaceAssets: [{ ...backup.workspaceAssets[0], kind: 'unknown-assets' }],
  }), false);
});

test('a portable project can never be mistaken for a master backup', () => {
  const project = createDefaultProject();
  Object.assign(project, completeBackup());
  assert.equal(isLibraryBackup(project), false);
});

test('master backup names require a valid date', () => {
  assert.throws(() => canonicalLibraryBackupFileName('not-a-date'), /valid date/i);
});
