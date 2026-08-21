import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatternLabRecipe } from './patternLabRecipe.js';
import {
  PATTERN_LAB_DRAFTS_KEY,
  deletePatternLabDraft,
  readPatternLabDrafts,
  savePatternLabDraft,
  writePatternLabDrafts,
} from './patternLabStorage.js';
import {
  createSavedCopy,
  describeSaveOptions,
  restoreDraftAtIndex,
  sanitizeDraftName,
  uniqueDraftName,
} from './patternLabDraftActions.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem(key, value) { data.set(key, String(value)); },
    removeItem: key => data.delete(key),
  };
}

test('a typed name is trimmed, collapsed and capped, and never becomes empty', () => {
  assert.equal(sanitizeDraftName('  Slow   Ember  '), 'Slow Ember');
  assert.equal(sanitizeDraftName('   '), 'Untitled design');
  assert.equal(sanitizeDraftName(null, 'Aurora'), 'Aurora');
  assert.equal(sanitizeDraftName('x'.repeat(200)).length, 60);
});

test('two experiments on one pattern do not both save under the pattern name', () => {
  const drafts = [createPatternLabRecipe({ id: 'a', name: 'Rainbow Flow' })];
  assert.equal(uniqueDraftName('Rainbow Flow', drafts), 'Rainbow Flow 2');
  const twice = [...drafts, createPatternLabRecipe({ id: 'b', name: 'Rainbow Flow 2' })];
  assert.equal(uniqueDraftName('Rainbow Flow', twice), 'Rainbow Flow 3');
  assert.equal(uniqueDraftName('Rainbow Flow 2', twice), 'Rainbow Flow 3');
  // A name nobody has used is left exactly as the owner typed it.
  assert.equal(uniqueDraftName('Rainbow Flow 2', drafts), 'Rainbow Flow 2');
  // Re-saving the same record over itself keeps its own name.
  assert.equal(uniqueDraftName('Rainbow Flow', drafts, { exceptId: 'a' }), 'Rainbow Flow');
});

test('the save row only offers Replace when there is something to replace', () => {
  const saved = createPatternLabRecipe({ id: 'a', name: 'Slow Ember' });
  assert.deepEqual(describeSaveOptions(createPatternLabRecipe({ id: 'new', name: 'Slow Ember' }), [saved]), {
    canReplace: false, savedName: null, replaceLabel: null, nameChanged: false,
  });
  const options = describeSaveOptions({ ...saved, name: 'Slow Ember, faster' }, [saved]);
  assert.equal(options.canReplace, true);
  assert.equal(options.savedName, 'Slow Ember');
  assert.equal(options.nameChanged, true);
  assert.match(options.replaceLabel, /Slow Ember/);
});

test('a saved copy takes a new id, so it cannot overwrite the version it came from', () => {
  const original = createPatternLabRecipe({ id: 'a', name: 'Slow Ember' });
  const copy = createSavedCopy({ ...original, playback: { ...original.playback, speed: 1.9 } }, [original]);
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.name, 'Slow Ember 2');
  assert.equal(copy.playback.speed, 1.9);
  assert.throws(() => createSavedCopy(original, [original], { id: 'a' }), /must not reuse/i);
});

// The headline regression this whole change exists to prevent: before it,
// every save went through savePatternLabDraft(draft) with the draft's own
// id, so a second save of a tweaked design silently replaced the first.
test('saving a tweaked design as new keeps BOTH versions in private storage', () => {
  const storage = memoryStorage();
  const first = savePatternLabDraft(
    createPatternLabRecipe({ id: 'a', name: 'Rainbow Flow', playback: { brightness: 0.5, speed: 1 } }),
    { storage },
  );

  const tweaked = { ...first, playback: { ...first.playback, speed: 1.8 } };
  const copy = createSavedCopy(tweaked, readPatternLabDrafts({ storage }));
  savePatternLabDraft(copy, { storage });

  const stored = readPatternLabDrafts({ storage });
  assert.equal(stored.length, 2);
  assert.deepEqual([...stored].map(item => item.name).sort(), ['Rainbow Flow', 'Rainbow Flow 2']);
  const originalStill = stored.find(item => item.id === 'a');
  assert.equal(originalStill.playback.speed, 1, 'the first version must survive the second save untouched');
  assert.equal(stored.find(item => item.id === copy.id).playback.speed, 1.8);

  // Replace is still available and still means replace — explicitly, by id.
  savePatternLabDraft({ ...originalStill, playback: { ...originalStill.playback, speed: 0.75 } }, { storage });
  const replaced = readPatternLabDrafts({ storage });
  assert.equal(replaced.length, 2);
  assert.equal(replaced.find(item => item.id === 'a').playback.speed, 0.75);
});

test('undoing a delete puts the draft back at its original position', () => {
  const storage = memoryStorage();
  const drafts = ['one', 'two', 'three'].map((name, index) => createPatternLabRecipe({ id: `d${index}`, name }));
  writePatternLabDrafts(drafts, { storage });

  const removedIndex = 1;
  const removed = readPatternLabDrafts({ storage })[removedIndex];
  assert.equal(deletePatternLabDraft(removed.id, { storage }), true);
  assert.deepEqual(readPatternLabDrafts({ storage }).map(item => item.name), ['one', 'three']);

  writePatternLabDrafts(restoreDraftAtIndex(readPatternLabDrafts({ storage }), removed, removedIndex), { storage });
  assert.deepEqual(readPatternLabDrafts({ storage }).map(item => item.name), ['one', 'two', 'three']);
  assert.equal(deletePatternLabDraft('nothing-here', { storage }), false);
});

test('an existing v1 draft with no name of its own still round-trips through the new save path', () => {
  const storage = memoryStorage();
  storage.setItem(PATTERN_LAB_DRAFTS_KEY, JSON.stringify({
    version: 1,
    drafts: [{ version: 1, id: 'legacy', macros: { color: 0.2, movement: 0.5, shape: 0.6, texture: 0.7, energy: 0.5 } }],
  }));
  const [legacy] = readPatternLabDrafts({ storage });
  assert.equal(legacy.name, 'Untitled evolution');
  const renamed = savePatternLabDraft({ ...legacy, name: sanitizeDraftName('  Wall piece  ') }, { storage });
  assert.equal(renamed.name, 'Wall piece');
  assert.deepEqual(readPatternLabDrafts({ storage }).map(item => item.id), ['legacy']);
});
