import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  PATTERN_LAB_GENERATOR_BUDGETS,
  PATTERN_LAB_GENERATOR_CONTROLS,
  PATTERN_LAB_GENERATOR_IDS,
  estimatePatternLabGeneratorBudgets,
  getPatternLabGenerator,
  measurePatternLabGeneratorStateBytes,
  resolvePatternLabGeneratorInputs,
} from './patternLabGenerators.js';

const COORDINATES = Object.freeze({ x: 0.37, y: 0.61, stripProgress: 0.43 });

function typedArrays(state) {
  return Object.values(state).filter(ArrayBuffer.isView);
}

function snapshot(generator, seed = 17) {
  const state = generator.initialize({ sampleCount: 96, seed });
  const inputs = resolvePatternLabGeneratorInputs(generator.id, {
    macros: { color: 0.4, movement: 0.7, shape: 0.3, texture: 0.65, energy: 0.8 },
  });
  for (let index = 0; index < 24; index += 1) generator.update(1 / 24, state, inputs);
  return {
    arrays: typedArrays(state).map(array => [...array]),
    colors: [0, 19, 47, 95].map(pixel => generator.render(pixel, {
      ...COORDINATES,
      index: pixel,
      stripProgress: pixel / 95,
    }, state)),
  };
}

test('the first stateful pack exposes the exact bounded lifecycle contract', () => {
  assert.deepEqual(PATTERN_LAB_GENERATOR_IDS, [
    'particles',
    'ripple',
    'random-walkers',
    'cellular-field',
    'gray-scott-1d',
  ]);
  assert.ok(Object.isFrozen(PATTERN_LAB_GENERATOR_IDS));
  for (const id of PATTERN_LAB_GENERATOR_IDS) {
    const generator = getPatternLabGenerator(id);
    assert.equal(generator.id, id);
    for (const method of ['initialize', 'update', 'render', 'dispose']) {
      assert.equal(typeof generator[method], 'function', `${id}.${method}`);
    }
    assert.ok(Object.isFrozen(generator));
    assert.ok(PATTERN_LAB_GENERATOR_CONTROLS[id].artistic.length >= 3);
    assert.ok(PATTERN_LAB_GENERATOR_CONTROLS[id].advanced.length >= 2);
  }
  assert.throws(() => getPatternLabGenerator('not-a-generator'), /unknown.*generator/i);
});

test('initialization is deterministic, seed-sensitive, typed, and bounded by preview resolution', () => {
  for (const id of PATTERN_LAB_GENERATOR_IDS) {
    const generator = getPatternLabGenerator(id);
    const first = snapshot(generator, 33);
    const second = snapshot(generator, 33);
    const different = snapshot(generator, 34);
    assert.deepEqual(first, second, `${id} must reproduce the same seeded state and colors`);
    assert.notDeepEqual(first, different, `${id} must respond to its seed`);

    const state = generator.initialize({ sampleCount: 384, seed: 1 });
    assert.equal(state.sampleCount, 384);
    assert.ok(typedArrays(state).length > 0, `${id} must own typed state`);
    assert.ok(typedArrays(state).every(array => array.length <= 384 * 4));
    assert.equal(measurePatternLabGeneratorStateBytes(state), typedArrays(state)
      .reduce((total, array) => total + array.byteLength, 0));
    assert.ok(measurePatternLabGeneratorStateBytes(state) <= PATTERN_LAB_GENERATOR_BUDGETS.maxStateBytes);
  }
  assert.throws(() => getPatternLabGenerator('particles').initialize({ sampleCount: 0, seed: 1 }), /sample/i);
  assert.throws(
    () => getPatternLabGenerator('particles').initialize({
      sampleCount: PATTERN_LAB_GENERATOR_BUDGETS.maxSamples + 1,
      seed: 1,
    }),
    /sample|1024/i,
  );
});

test('artistic macros lead and advanced technical values are finite and clamped', () => {
  const calm = resolvePatternLabGeneratorInputs('particles', {
    macros: { color: 0, movement: 0, shape: 0, texture: 0, energy: 0 },
    base: { params: { advanced: { particleCount: 9999, drag: -4 } } },
  });
  const alive = resolvePatternLabGeneratorInputs('particles', {
    macros: { color: 1, movement: 1, shape: 1, texture: 1, energy: 1 },
  });
  assert.deepEqual(Object.keys(calm), ['artistic', 'advanced']);
  assert.ok(calm.artistic.speed < alive.artistic.speed);
  assert.ok(calm.artistic.intensity < alive.artistic.intensity);
  assert.equal(calm.advanced.particleCount, 96);
  assert.equal(calm.advanced.drag, 0);

  for (const id of PATTERN_LAB_GENERATOR_IDS) {
    const resolved = resolvePatternLabGeneratorInputs(id, {
      macros: { color: Number.NaN, movement: -10, shape: 20, texture: 0.5, energy: Infinity },
      base: { params: { advanced: { unknown: 123 } } },
    });
    assert.ok(Object.values(resolved.artistic).every(Number.isFinite));
    assert.ok(Object.values(resolved.advanced).every(Number.isFinite));
    assert.ok(Object.isFrozen(resolved));
    assert.ok(Object.isFrozen(resolved.artistic));
    assert.ok(Object.isFrozen(resolved.advanced));
  }
});

test('every stateful generator produces visible evolution over one second', () => {
  for (const id of PATTERN_LAB_GENERATOR_IDS) {
    const generator = getPatternLabGenerator(id);
    const state = generator.initialize({ sampleCount: 96, seed: 41 });
    const inputs = resolvePatternLabGeneratorInputs(id, {
      macros: { color: 0.62, movement: 0.58, shape: 0.44, texture: 0.71, energy: 0.73 },
    });
    generator.update(0, state, inputs);
    const before = Array.from({ length: 96 }, (_, pixel) => generator.render(
      pixel,
      { index: pixel, stripProgress: pixel / 95, x: pixel / 95, y: 0.5 },
      state,
    ));
    generator.update(1, state, inputs);
    const after = Array.from({ length: 96 }, (_, pixel) => generator.render(
      pixel,
      { index: pixel, stripProgress: pixel / 95, x: pixel / 95, y: 0.5 },
      state,
    ));
    assert.notDeepEqual(after, before, `${id} did not evolve`);
  }
});

test('fifteen accelerated minutes stay finite without reallocating generator state', () => {
  for (const id of PATTERN_LAB_GENERATOR_IDS) {
    const generator = getPatternLabGenerator(id);
    const state = generator.initialize({ sampleCount: 96, seed: 0x12345678 });
    const inputs = resolvePatternLabGeneratorInputs(id, {
      macros: { color: 0.55, movement: 0.6, shape: 0.45, texture: 0.7, energy: 0.65 },
    });
    const buffers = typedArrays(state).map(array => array.buffer);
    const bytes = measurePatternLabGeneratorStateBytes(state);
    for (let second = 0; second < 900; second += 1) {
      generator.update(1, state, inputs);
      const color = generator.render(second % 96, {
        x: (second % 31) / 30,
        y: (second % 47) / 46,
        stripProgress: (second % 96) / 95,
        index: second % 96,
      }, state);
      assert.ok(Object.values(color).every(value => Number.isFinite(value) && value >= 0 && value <= 255), id);
    }
    assert.ok(Math.abs(state.elapsedSeconds - 900) < 1e-6, id);
    assert.equal(measurePatternLabGeneratorStateBytes(state), bytes, id);
    assert.ok(
      typedArrays(state).every((array, index) => array.buffer === buffers[index]),
      `${id} reallocated during the soak`,
    );
    assert.ok(typedArrays(state).every(array => [...array].every(Number.isFinite)), id);
  }
});

test('dispose clears typed state and prevents later updates', () => {
  for (const id of PATTERN_LAB_GENERATOR_IDS) {
    const generator = getPatternLabGenerator(id);
    const state = generator.initialize({ sampleCount: 32, seed: 9 });
    generator.update(1, state, resolvePatternLabGeneratorInputs(id));
    generator.dispose(state);
    assert.equal(state.disposed, true);
    assert.ok(typedArrays(state).every(array => [...array].every(value => value === 0)), id);
    assert.throws(() => generator.update(1, state, resolvePatternLabGeneratorInputs(id)), /disposed/i);
  }
});

test('generator logic has no browser-global dependency', async () => {
  const source = await readFile(new URL('./patternLabGenerators.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:window|document|navigator|performance|requestAnimationFrame|cancelAnimationFrame)\b/);
});

test('exposes conservative finite compatibility budgets without retaining generator state', () => {
  for (const id of PATTERN_LAB_GENERATOR_IDS) {
    const estimate = estimatePatternLabGeneratorBudgets(id, { sampleCount: 1024, seed: 7 });
    assert.equal(estimate.sampleCount, 1024);
    assert.ok(Number.isSafeInteger(estimate.stateBytes) && estimate.stateBytes > 0, id);
    assert.ok(Number.isSafeInteger(estimate.operationsPerFrame) && estimate.operationsPerFrame > 0, id);
    assert.ok(Object.isFrozen(estimate));
  }
});
