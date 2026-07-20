import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PATTERN_LAB_EVOLUTION_CHARACTERS,
  PATTERN_LAB_EVOLUTION_PRESETS,
  sampleEvolution,
} from './patternLabEvolution.js';

const REQUIRED_CHARACTERS = [
  'slow-bloom',
  'wandering',
  'tidal',
  'breathing',
  'gather-release',
  'rare-surprises',
];

function recipe(character, overrides = {}) {
  return {
    seed: 424242,
    evolution: { enabled: true, character, durationSeconds: 600, change: 0.65 },
    limits: { brightnessCeiling: 0.78 },
    ...overrides,
  };
}

test('exports exactly the six approved Long Evolution characters', () => {
  assert.deepEqual(PATTERN_LAB_EVOLUTION_CHARACTERS, REQUIRED_CHARACTERS);
  assert.deepEqual(Object.keys(PATTERN_LAB_EVOLUTION_PRESETS), REQUIRED_CHARACTERS);
});

test('exported safety ranges cannot be mutated by a caller', () => {
  assert.throws(() => { PATTERN_LAB_EVOLUTION_PRESETS['slow-bloom'].brightness[1] = 2; }, TypeError);
  assert.equal(PATTERN_LAB_EVOLUTION_PRESETS['slow-bloom'].brightness[1], 0.78);
});

for (const character of REQUIRED_CHARACTERS) {
  test(`${character} is deterministic for a fixed recipe, seed, and time`, () => {
    const source = recipe(character);
    assert.deepEqual(sampleEvolution(source, 237.125), sampleEvolution(source, 237.125));
  });

  test(`${character} does not reset all clocks before its full duration`, () => {
    for (const durationSeconds of [300, 600, 900]) {
      const source = recipe(character, {
        evolution: { enabled: true, character, durationSeconds, change: 0.65 },
      });
      const initial = sampleEvolution(source, 0);
      for (let second = 1; second < durationSeconds; second += 1) {
        const sample = sampleEvolution(source, second);
        const allReset = ['arc', 'spatial', 'texture', 'rare']
          .every(key => Math.abs(sample[key] - initial[key]) < 1e-12);
        assert.equal(allReset, false, `all clocks reset at ${second}s of ${durationSeconds}s`);
      }
    }
  });

  test(`${character} stays inside its preset ranges and brightness ceiling`, () => {
    const source = recipe(character);
    const ranges = PATTERN_LAB_EVOLUTION_PRESETS[character];
    for (let second = 0; second <= source.evolution.durationSeconds; second += 7) {
      const { destinations } = sampleEvolution(source, second);
      for (const [key, [minimum, maximum]] of Object.entries(ranges)) {
        assert.ok(destinations[key] >= minimum - 1e-12, `${key} below ${minimum}`);
        assert.ok(destinations[key] <= maximum + 1e-12, `${key} above ${maximum}`);
      }
      assert.ok(destinations.brightness <= source.limits.brightnessCeiling);
    }
  });
}

test('different seeds produce different spatial and texture clocks', () => {
  const first = sampleEvolution(recipe('wandering', { seed: 10 }), 91.5);
  const second = sampleEvolution(recipe('wandering', { seed: 11 }), 91.5);
  assert.notDeepEqual([first.spatial, first.texture], [second.spatial, second.texture]);
});

test('an installation brightness ceiling below a preset range is never exceeded', () => {
  const source = recipe('rare-surprises', { limits: { brightnessCeiling: 0.2 } });
  for (let second = 0; second <= 600; second += 5) {
    assert.ok(sampleEvolution(source, second).destinations.brightness <= 0.2);
  }
});

test('sampling uses neither Math.random nor wall-clock time', () => {
  const random = Math.random;
  const now = Date.now;
  Math.random = () => { throw new Error('Math.random is forbidden'); };
  Date.now = () => { throw new Error('Date.now is forbidden'); };
  try {
    assert.doesNotThrow(() => sampleEvolution(recipe('tidal'), 123.5));
  } finally {
    Math.random = random;
    Date.now = now;
  }
});

test('unknown evolution characters fail explicitly', () => {
  assert.throws(() => sampleEvolution(recipe('not-a-character'), 10), /unknown evolution character/i);
});
