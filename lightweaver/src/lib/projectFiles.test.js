import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_PROJECT_EXTENSION,
  PROJECT_IMPORT_ACCEPT,
  COMPLETE_EDITABLE_PROJECT_LABEL,
  INSTALLED_CONFIGURATION_LABEL,
  canonicalProjectFileName,
  parseProjectFile,
  serializeProjectFile,
  slugifyProjectName,
} from './projectFiles.js';
import { createDefaultProject } from './projectModel.js';
import { createProjectEnvelope } from './projectRepository.js';

test('canonical extension and import accept list stay stable', () => {
  assert.equal(CANONICAL_PROJECT_EXTENSION, '.lw.json');
  assert.equal(PROJECT_IMPORT_ACCEPT, '.lw.json,.lwproj.json,.json');
  // The canonical extension must always be importable.
  assert.ok(PROJECT_IMPORT_ACCEPT.split(',').includes(CANONICAL_PROJECT_EXTENSION));
});

test('project names slugify into canonical file names', () => {
  assert.equal(canonicalProjectFileName('My Piece'), 'my-piece.lw.json');
  assert.equal(canonicalProjectFileName('  Adrian’s   Mandala #3  '), 'adrians-mandala-3.lw.json');
  assert.equal(canonicalProjectFileName('Üntitled---Projéct'), 'ntitled-proj-ct.lw.json');
});

test('empty or symbol-only names fall back to lightweaver.lw.json', () => {
  assert.equal(canonicalProjectFileName(''), 'lightweaver.lw.json');
  assert.equal(canonicalProjectFileName(null), 'lightweaver.lw.json');
  assert.equal(canonicalProjectFileName(undefined), 'lightweaver.lw.json');
  assert.equal(canonicalProjectFileName('###'), 'lightweaver.lw.json');
});

test('slugify collapses runs and trims edge separators', () => {
  assert.equal(slugifyProjectName('--A  b--'), 'a-b');
  assert.equal(slugifyProjectName(42), '42');
});

test('project files round-trip envelope metadata and distinguish installed configuration', () => {
  const envelope = createProjectEnvelope({ ...createDefaultProject(), id: 'file-p1' });
  assert.deepEqual(parseProjectFile(serializeProjectFile(envelope)), envelope);
  assert.equal(COMPLETE_EDITABLE_PROJECT_LABEL, 'Complete editable project');
  assert.equal(INSTALLED_CONFIGURATION_LABEL, 'Installed configuration');
  assert.notEqual(COMPLETE_EDITABLE_PROJECT_LABEL, INSTALLED_CONFIGURATION_LABEL);
});
