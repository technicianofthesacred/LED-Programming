import test from 'node:test';
import assert from 'node:assert/strict';
import { PATTERN_LAB_MAX_LAYERS, PATTERN_LAB_RECIPE_VERSION, createPatternLabRecipe, normalizePatternLabRecipe } from './patternLabRecipe.js';

test('creates the complete v1 recipe contract with a stable caller-supplied ID', () => {
  const recipe = createPatternLabRecipe({ id: 'dawn-tide', name: 'Dawn Tide' });
  assert.equal(PATTERN_LAB_RECIPE_VERSION, 1);
  assert.equal(PATTERN_LAB_MAX_LAYERS, 3);
  assert.equal(recipe.version, 1);
  assert.equal(recipe.id, 'dawn-tide');
  assert.equal(recipe.name, 'Dawn Tide');
  assert.deepEqual(recipe.base, { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} });
  assert.equal(recipe.palette.length, 4);
  assert.deepEqual(recipe.macros, { color: .5, movement: .5, shape: .5, texture: .5, energy: .5 });
  assert.deepEqual(recipe.evolution, { enabled: true, character: 'slow-bloom', durationSeconds: 600, change: .35 });
  assert.equal(recipe.seed, 1);
  assert.deepEqual(recipe.layers, []);
  assert.deepEqual(recipe.targets, [{ kind: 'whole-piece', id: 'all' }]);
  assert.deepEqual(recipe.requirements, []);
  assert.deepEqual(recipe.provenance, []);
});

test('generates a non-empty ID that remains stable through normalization', () => {
  const recipe = createPatternLabRecipe();
  assert.match(recipe.id, /^pattern-lab-/);
  assert.equal(normalizePatternLabRecipe(recipe).id, recipe.id);
});

test('bounds creative values and does not mutate the source', () => {
  const source = { version: 1, id: 'bounded', name: 'Bounded', palette: ['#111111'],
    macros: { color: -2, movement: 2, shape: .25, texture: Number.NaN, energy: .75 },
    evolution: { enabled: true, character: 'tidal', durationSeconds: 1200, change: -1 },
    layers: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] };
  const before = structuredClone(source);
  const recipe = normalizePatternLabRecipe(source);
  assert.deepEqual(source, before);
  assert.deepEqual(recipe.palette, ['#111111', '#111111']);
  assert.deepEqual(recipe.macros, { color: 0, movement: 1, shape: .25, texture: .5, energy: .75 });
  assert.equal(recipe.evolution.durationSeconds, 900);
  assert.equal(recipe.evolution.change, 0);
  assert.deepEqual(recipe.layers.map(layer => layer.id), [1, 2, 3]);
});

test('applies lower bounds, truncates palettes, and fills nested defaults', () => {
  const palette = Array.from({ length: 10 }, (_, i) => `#00000${i}`);
  const recipe = normalizePatternLabRecipe({ version: 1, id: 'minimums', name: 'Minimums', base: { patternId: 'ocean' }, palette, evolution: { durationSeconds: 2 } });
  assert.deepEqual(recipe.base, { kind: 'lightweaver-pattern', patternId: 'ocean', params: {} });
  assert.equal(recipe.palette.length, 8);
  assert.equal(recipe.evolution.durationSeconds, 300);
  assert.equal(recipe.evolution.character, 'slow-bloom');
});

test('preserves unknown top-level and nested fields', () => {
  const recipe = normalizePatternLabRecipe({ version: 1, id: 'future', name: 'Future', futureTop: { enabled: true },
    base: { kind: 'field', patternId: 'custom', params: {}, futureBase: 'kept' },
    macros: { futureMacro: .9 }, evolution: { futureClock: { period: 37 } },
    layers: [{ id: 'one', futureLayer: true }], targets: [{ kind: 'section', id: 'outer', futureTarget: true }],
    requirements: [{ capability: 'noise-v2', futureRequirement: 2 }], provenance: [{ source: 'fastled', futureProvenance: 'commit' }] });
  assert.deepEqual(recipe.futureTop, { enabled: true });
  assert.equal(recipe.base.futureBase, 'kept');
  assert.equal(recipe.macros.futureMacro, .9);
  assert.deepEqual(recipe.evolution.futureClock, { period: 37 });
  assert.equal(recipe.layers[0].futureLayer, true);
  assert.equal(recipe.targets[0].futureTarget, true);
  assert.equal(recipe.requirements[0].futureRequirement, 2);
  assert.equal(recipe.provenance[0].futureProvenance, 'commit');
});

test('rejects unsupported major versions', () => {
  assert.throws(() => normalizePatternLabRecipe({ version: 2, id: 'future' }), /unsupported pattern lab recipe version/i);
  assert.throws(() => normalizePatternLabRecipe({ version: '3.1', id: 'future' }), /unsupported pattern lab recipe version/i);
});

test('normalizes scalar and array fields to safe defaults', () => {
  const recipe = normalizePatternLabRecipe({ version: 1, id: ' stable-id ', name: ' Quiet Bloom ', palette: null, seed: -1, targets: null, requirements: 'bad', provenance: null });
  assert.equal(recipe.id, 'stable-id');
  assert.equal(recipe.name, 'Quiet Bloom');
  assert.equal(recipe.seed, 0xffffffff);
  assert.equal(recipe.palette.length, 4);
  assert.deepEqual(recipe.targets, [{ kind: 'whole-piece', id: 'all' }]);
  assert.deepEqual(recipe.requirements, []);
  assert.deepEqual(recipe.provenance, []);
});
