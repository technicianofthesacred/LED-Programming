import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatternLabRecipe } from './patternLabRecipe.js';
import { PATTERN_LAB_DRAFTS_BACKUP_KEY, PATTERN_LAB_DRAFTS_KEY, deletePatternLabDraft, readPatternLabDrafts, savePatternLabDraft, writePatternLabDrafts } from './patternLabStorage.js';

function memoryStorage() {
  const data = new Map(), writes = [];
  return { writes, getItem: key => data.has(key) ? data.get(key) : null,
    setItem(key, value) { writes.push(key); data.set(key, String(value)); }, removeItem: key => data.delete(key) };
}

test('writes normalized drafts only to private primary and backup keys', () => {
  const storage = memoryStorage();
  const written = writePatternLabDrafts([createPatternLabRecipe({ id: 'private', evolution: { durationSeconds: 9999 } })], { storage });
  assert.equal(written[0].evolution.durationSeconds, 900);
  assert.deepEqual(storage.writes, [PATTERN_LAB_DRAFTS_KEY, PATTERN_LAB_DRAFTS_BACKUP_KEY]);
  assert.equal(PATTERN_LAB_DRAFTS_KEY, 'lw_pattern_lab_drafts_v1');
  assert.equal(PATTERN_LAB_DRAFTS_BACKUP_KEY, 'lw_pattern_lab_drafts_v1_backup');
  assert.deepEqual(readPatternLabDrafts({ storage }).map(x => x.id), ['private']);
});

test('recovers from backup after corrupt or unsupported primary data', () => {
  const storage = memoryStorage();
  writePatternLabDrafts([createPatternLabRecipe({ id: 'safe' })], { storage });
  storage.setItem(PATTERN_LAB_DRAFTS_KEY, '{broken');
  assert.deepEqual(readPatternLabDrafts({ storage }).map(x => x.id), ['safe']);
  storage.setItem(PATTERN_LAB_DRAFTS_KEY, JSON.stringify({ version: 1, drafts: [{ version: 2, id: 'future' }] }));
  assert.deepEqual(readPatternLabDrafts({ storage }).map(x => x.id), ['safe']);
});

test('rejects invalid writes before mutating either stored copy', () => {
  const storage = memoryStorage();
  writePatternLabDrafts([createPatternLabRecipe({ id: 'original' })], { storage });
  const primary = storage.getItem(PATTERN_LAB_DRAFTS_KEY), backup = storage.getItem(PATTERN_LAB_DRAFTS_BACKUP_KEY);
  assert.throws(() => writePatternLabDrafts([{ version: 2, id: 'future' }], { storage }), /unsupported pattern lab recipe version/i);
  assert.equal(storage.getItem(PATTERN_LAB_DRAFTS_KEY), primary);
  assert.equal(storage.getItem(PATTERN_LAB_DRAFTS_BACKUP_KEY), backup);
});

test('upserts normalized drafts by stable ID without mutating inputs', () => {
  const storage = memoryStorage();
  savePatternLabDraft(createPatternLabRecipe({ id: 'one', name: 'First' }), { storage });
  savePatternLabDraft(createPatternLabRecipe({ id: 'two', name: 'Second' }), { storage });
  const update = createPatternLabRecipe({ id: 'one', name: 'Revised', macros: { color: 2 } });
  const before = structuredClone(update), saved = savePatternLabDraft(update, { storage });
  assert.deepEqual(update, before);
  assert.equal(saved.macros.color, 1);
  assert.deepEqual(readPatternLabDrafts({ storage }).map(x => x.id), ['one', 'two']);
  assert.equal(readPatternLabDrafts({ storage })[0].name, 'Revised');
});

test('deletes one draft and tolerates unavailable or invalid storage', () => {
  const storage = memoryStorage();
  writePatternLabDrafts([createPatternLabRecipe({ id: 'keep' }), createPatternLabRecipe({ id: 'remove' })], { storage });
  assert.equal(deletePatternLabDraft('remove', { storage }), true);
  assert.deepEqual(readPatternLabDrafts({ storage }).map(x => x.id), ['keep']);
  assert.equal(deletePatternLabDraft('missing', { storage }), false);
  assert.deepEqual(readPatternLabDrafts({ storage: null }), []);
  assert.equal(writePatternLabDrafts([], { storage: null }), false);
  storage.setItem(PATTERN_LAB_DRAFTS_KEY, JSON.stringify({ version: 2, drafts: [] }));
  storage.setItem(PATTERN_LAB_DRAFTS_BACKUP_KEY, 'bad');
  assert.deepEqual(readPatternLabDrafts({ storage }), []);
});
