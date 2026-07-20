import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatternLabHandoff,
  createPatternLabHandoff,
} from './patternLabHandoff.js';

function recipe(overrides = {}) {
  return {
    version: 1,
    id: 'pattern-lab-aurora-journey',
    name: 'Aurora Journey',
    base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
    palette: ['#102040', '#f0a060'],
    macros: { color: 0.6, movement: 0.45, shape: 0.5, texture: 0.5, energy: 0.7 },
    evolution: { enabled: true, character: 'slow-bloom', durationSeconds: 600, change: 0.35 },
    seed: 17,
    layers: [],
    targets: [{ kind: 'whole-piece', id: 'all' }],
    requirements: [],
    provenance: [],
    ...overrides,
  };
}

test('creates a new normalized look handoff without changing the recipe', () => {
  const source = recipe();
  const before = JSON.stringify(source);
  const result = createPatternLabHandoff({
    recipe: source,
    compatibility: { classification: 'live-on-card', reasons: [] },
  });
  assert.equal(result.kind, 'look');
  assert.equal(result.look.label, 'Aurora Journey');
  assert.equal(result.look.defaultLook.patternId, 'aurora');
  assert.equal(JSON.stringify(source), before);
});

test('creates a sequence handoff only from a completed bake package and manifest', () => {
  const packageValue = { app: 'Lightweaver', format: 'standalone-controller-package', version: 1, files: {} };
  const manifest = { version: 1, recipeHash: 'a'.repeat(64), sequenceSha256: 'b'.repeat(64) };
  const result = createPatternLabHandoff({
    recipe: recipe({ base: { kind: 'particles', params: {} } }),
    compatibility: { classification: 'bake-to-card', reasons: [] },
    sequencePackage: packageValue,
    manifest,
  });
  assert.deepEqual(result, { kind: 'sequence', package: packageValue, manifest });
  assert.notEqual(result.package, packageValue);
  assert.notEqual(result.manifest, manifest);
});

test('invalid, canceled, unsupported, and failed handoffs are blocked and mutate nothing', () => {
  const controller = { looks: [{ id: 'kept', label: 'Kept' }], sequenceAssets: [{ id: 'kept-sequence' }] };
  const source = recipe();
  const beforeController = JSON.stringify(controller);
  const beforeRecipe = JSON.stringify(source);
  const cases = [
    createPatternLabHandoff({ recipe: source, compatibility: null }),
    createPatternLabHandoff({ recipe: source, compatibility: { classification: 'live-on-card' }, cancelled: true }),
    createPatternLabHandoff({ recipe: source, compatibility: { classification: 'studio-only', reasons: [{ code: 'unsupported', message: 'No card path' }] } }),
    createPatternLabHandoff({ recipe: source, compatibility: { classification: 'bake-to-card' }, exportError: new Error('bake failed') }),
  ];
  for (const result of cases) {
    assert.equal(result.kind, 'blocked');
    assert.deepEqual(applyPatternLabHandoff(controller, result), controller);
  }
  assert.equal(JSON.stringify(controller), beforeController);
  assert.equal(JSON.stringify(source), beforeRecipe);
});

test('applying a look never overwrites a built-in or existing saved look', () => {
  const controller = {
    defaultLook: { patternId: 'fire' },
    activeLookId: 'aurora-journey',
    looks: [{ id: 'aurora-journey', label: 'Older Journey', defaultLook: { patternId: 'fire' } }],
  };
  const result = createPatternLabHandoff({
    recipe: recipe({ id: 'aurora', name: 'Aurora Journey' }),
    compatibility: { classification: 'live-on-card', reasons: [] },
  });
  const next = applyPatternLabHandoff(controller, result);
  assert.equal(next.looks.length, 2);
  assert.equal(next.looks[0].id, 'aurora-journey-2');
  assert.equal(next.looks[1].label, 'Older Journey');
  assert.equal(controller.looks.length, 1);
});

test('applying a sequence creates a uniquely named project asset without mutating package bytes', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const controller = { sequenceAssets: [{ id: 'aurora-journey', label: 'Old', package: {} }] };
  const result = {
    kind: 'sequence',
    package: { files: { '/sequence.lwseq': bytes } },
    manifest: { name: 'Aurora Journey', recipeId: 'pattern-lab-aurora-journey' },
  };
  const next = applyPatternLabHandoff(controller, result);
  assert.equal(next.sequenceAssets[0].id, 'aurora-journey-2');
  assert.deepEqual([...next.sequenceAssets[0].package.files['/sequence.lwseq']], [1, 2, 3]);
  assert.deepEqual([...bytes], [1, 2, 3]);
});
