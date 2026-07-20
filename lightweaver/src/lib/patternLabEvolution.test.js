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

  test(`${character} produces varied destination samples across its full duration`, () => {
    for (const durationSeconds of [300, 600, 900]) {
      const source = recipe(character, {
        evolution: { enabled: true, character, durationSeconds, change: 0.65 },
      });
      const times = Array.from({ length: 37 }, (_, index) => (
        (index * 73.137 + index * index * 0.619 + 0.137) % (durationSeconds - 0.5)
      ));
      const samples = times.map(time => sampleEvolution(source, time).destinations);
      const signatures = samples.map(destinations => Object.values(destinations).map(value => value.toFixed(10)).join(':'));
      assert.ok(new Set(signatures).size >= 35, `too many repeated sampled destinations for ${durationSeconds}s`);
      for (const key of Object.keys(PATTERN_LAB_EVOLUTION_PRESETS[character])) {
        const values = samples.map(sample => sample[key]);
        assert.ok(Math.max(...values) - Math.min(...values) > 1e-4, `${key} did not vary for ${durationSeconds}s`);
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

test('false-like enabled values return one explicit stable disabled result', () => {
  for (const enabled of [false, 0, null, '']) {
    const source = recipe('tidal', {
      evolution: { enabled, character: 'tidal', durationSeconds: 600, change: 0.65 },
    });
    const initial = sampleEvolution(source, 0);
    assert.equal(initial.enabled, false);
    assert.equal(initial.destinations, null);
    for (const time of [0.125, 17, 137.25, 599.9, 1200]) {
      assert.deepEqual(sampleEvolution(source, time), initial);
    }
  }
});

test('raw missing and non-finite evolution values use recipe defaults', () => {
  const missing = sampleEvolution({ seed: 3 }, 11);
  const invalid = sampleEvolution({
    seed: 3,
    evolution: { character: 'slow-bloom', durationSeconds: Number.NaN, change: Number.POSITIVE_INFINITY },
  }, 11);
  for (const sample of [missing, invalid]) {
    assert.equal(sample.enabled, true);
    assert.equal(sample.durationSeconds, 600);
    assert.equal(sample.change, 0.35);
  }
});

test('seed parsing preserves zero and normalizes finite uint32 edges', () => {
  const cases = [
    [0, 0], ['0', 0], [1, 1], [-1, 0xffffffff],
    [0x100000000, 0], [0x100000001, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], [undefined, 1],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sampleEvolution(recipe('wandering', { seed: input }), 19.25).seed, expected);
  }
  const zero = sampleEvolution(recipe('wandering', { seed: 0 }), 19.25);
  const one = sampleEvolution(recipe('wandering', { seed: 1 }), 19.25);
  assert.notDeepEqual([zero.spatial, zero.texture], [one.spatial, one.texture]);
});

test('effective brightness range exposes ceiling conflicts without claiming the preset minimum', () => {
  const source = recipe('rare-surprises', { limits: { brightnessCeiling: 0.2 } });
  for (let second = 0; second <= 600; second += 5) {
    const sample = sampleEvolution(source, second);
    assert.deepEqual(sample.effectiveBrightnessRange, [0.2, 0.2]);
    assert.equal(sample.destinations.brightness, 0.2);
  }
  const intersected = sampleEvolution(recipe('rare-surprises', { limits: { brightnessCeiling: 0.5 } }), 80);
  assert.deepEqual(intersected.effectiveBrightnessRange, [0.3, 0.5]);
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
