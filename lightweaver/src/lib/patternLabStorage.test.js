import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatternLabRecipe } from './patternLabRecipe.js';
import { PATTERN_LAB_DRAFTS_BACKUP_KEY, PATTERN_LAB_DRAFTS_KEY, deletePatternLabDraft, readPatternLabDraftState, readPatternLabDrafts, savePatternLabDraft, writePatternLabDrafts } from './patternLabStorage.js';

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

test('save refuses to overwrite stored copies when neither copy can be recovered', () => {
  const storage = memoryStorage();
  storage.setItem(PATTERN_LAB_DRAFTS_KEY, '{truncated-primary');
  storage.setItem(PATTERN_LAB_DRAFTS_BACKUP_KEY, JSON.stringify({ version: 1, drafts: [{ version: 9, id: 'future-draft' }] }));
  const primary = storage.getItem(PATTERN_LAB_DRAFTS_KEY);
  const backup = storage.getItem(PATTERN_LAB_DRAFTS_BACKUP_KEY);

  assert.throws(
    () => savePatternLabDraft(createPatternLabRecipe({ id: 'must-not-replace' }), { storage }),
    /cannot save.*recover/i,
  );
  assert.equal(storage.getItem(PATTERN_LAB_DRAFTS_KEY), primary);
  assert.equal(storage.getItem(PATTERN_LAB_DRAFTS_BACKUP_KEY), backup);
});

test('safe unknown fields survive a storage round trip unchanged', () => {
  const storage = memoryStorage();
  const draft = createPatternLabRecipe({
    id: 'extension-round-trip',
    futureTop: { flag: true, nested: ['alpha', 4, null, { beta: false }] },
    layers: [{ id: 'layer-one', futureLayer: { values: [0.1, 0.2] } }],
  });

  writePatternLabDrafts([draft], { storage });
  const [restored] = readPatternLabDrafts({ storage });
  assert.deepEqual(restored.futureTop, draft.futureTop);
  assert.deepEqual(restored.layers[0].futureLayer, draft.layers[0].futureLayer);
});

test('JSON-unsafe unknown fields are rejected before either stored copy changes', async t => {
  const unsafeValues = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['function', () => true],
    ['symbol', Symbol('unsafe')],
    ['bigint', 1n],
    ['non-plain object', new Date('2026-07-20T00:00:00.000Z')],
    ['sparse array', [, 'value']],
  ];
  for (const [label, value] of unsafeValues) {
    await t.test(label, () => {
      const storage = memoryStorage();
      writePatternLabDrafts([createPatternLabRecipe({ id: 'original' })], { storage });
      const primary = storage.getItem(PATTERN_LAB_DRAFTS_KEY);
      const backup = storage.getItem(PATTERN_LAB_DRAFTS_BACKUP_KEY);
      const draft = createPatternLabRecipe({ id: `unsafe-${label}` });
      draft.futureValue = value;
      assert.throws(() => writePatternLabDrafts([draft], { storage }), /json-safe/i);
      assert.equal(storage.getItem(PATTERN_LAB_DRAFTS_KEY), primary);
      assert.equal(storage.getItem(PATTERN_LAB_DRAFTS_BACKUP_KEY), backup);
    });
  }

  await t.test('cycle', () => {
    const storage = memoryStorage();
    writePatternLabDrafts([createPatternLabRecipe({ id: 'original' })], { storage });
    const primary = storage.getItem(PATTERN_LAB_DRAFTS_KEY);
    const backup = storage.getItem(PATTERN_LAB_DRAFTS_BACKUP_KEY);
    const draft = createPatternLabRecipe({ id: 'cyclic' });
    draft.futureValue = draft;
    assert.throws(() => writePatternLabDrafts([draft], { storage }), /json-safe/i);
    assert.equal(storage.getItem(PATTERN_LAB_DRAFTS_KEY), primary);
    assert.equal(storage.getItem(PATTERN_LAB_DRAFTS_BACKUP_KEY), backup);
  });
});

test('default storage acquisition safely handles a throwing browser getter', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    get() { throw new DOMException('Storage blocked', 'SecurityError'); },
  });
  try {
    assert.deepEqual(readPatternLabDrafts(), []);
    assert.equal(writePatternLabDrafts([]), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete globalThis.window;
  }
});

test('exposes unavailable and unrecoverable read states', () => {
  assert.deepEqual(readPatternLabDraftState({ storage: null }), { status: 'unavailable', drafts: [] });
  assert.deepEqual(readPatternLabDraftState({ storage: { getItem() { throw new DOMException('blocked', 'SecurityError'); } } }), { status: 'unavailable', drafts: [] });

  const storage = memoryStorage();
  storage.setItem(PATTERN_LAB_DRAFTS_KEY, '{bad-primary');
  storage.setItem(PATTERN_LAB_DRAFTS_BACKUP_KEY, '{bad-backup');
  assert.deepEqual(readPatternLabDraftState({ storage }), { status: 'unrecoverable', drafts: [] });
});

test('save reports unavailable and failed primary writes instead of returning success', () => {
  assert.throws(
    () => savePatternLabDraft(createPatternLabRecipe({ id: 'unavailable' }), { storage: null }),
    /storage.*unavailable/i,
  );

  const data = new Map();
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem() { throw new DOMException('Private write blocked', 'QuotaExceededError'); },
  };
  assert.throws(
    () => savePatternLabDraft(createPatternLabRecipe({ id: 'write-failure' }), { storage }),
    /private write blocked/i,
  );
  assert.equal(data.size, 0);
});
