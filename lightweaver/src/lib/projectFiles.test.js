import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_PROJECT_EXTENSION,
  PROJECT_IMPORT_ACCEPT,
  canonicalProjectFileName,
  slugifyProjectName,
} from './projectFiles.js';

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
