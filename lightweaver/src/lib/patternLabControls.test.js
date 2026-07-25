import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePatternLabControls } from './patternLabControls.js';
import { createPatternLabRecipe } from './patternLabRecipe.js';

function recipe(overrides = {}) {
  return createPatternLabRecipe({
    id: 'controls',
    seed: 424242,
    evolution: {
      enabled: true,
      character: 'wandering',
      durationSeconds: 900,
      change: .65,
      dynamics: { dynamicRange: .55, rareEventStrength: .4 },
    },
    ...overrides,
  });
}

test('movement resolves exact Drift, Flow, Pulse, and Surge anchors', () => {
  const cases = [
    [0, { drift: 1, flow: 0, pulse: 0, surge: 0 }],
    [.33, { drift: 0, flow: 1, pulse: 0, surge: 0 }],
    [.67, { drift: 0, flow: 0, pulse: 1, surge: 0 }],
    [1, { drift: 0, flow: 0, pulse: 0, surge: 1 }],
  ];
  for (const [movement, expected] of cases) {
    const result = resolvePatternLabControls(recipe({
      macros: { color: .5, movement, shape: .5, texture: .5 },
    }), 120);
    assert.deepEqual(result.motionWeights, expected);
  }
});

test('movement weights interpolate piecewise linearly and always sum to one', () => {
  for (const movement of [0, .165, .33, .5, .67, .835, 1]) {
    const { motionWeights } = resolvePatternLabControls(recipe({
      macros: { color: .5, movement, shape: .5, texture: .5 },
    }), 120);
    assert.ok(Object.values(motionWeights).every(weight => weight >= 0 && weight <= 1));
    assert.ok(Math.abs(Object.values(motionWeights).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-12);
    assert.ok(Object.values(motionWeights).filter(Boolean).length <= 2);
  }
});

test('movement changes only spatial motion weights without changing the authoritative clock', () => {
  const samples = [0, .33, .67, 1].map(movement => resolvePatternLabControls(recipe({
    macros: { color: .5, movement, shape: .5, texture: .5 },
    playback: { brightness: .6, speed: 1.4 },
  }), 237.125));
  assert.deepEqual(new Set(samples.map(sample => sample.masterSpeed)), new Set([1.4]));
  assert.equal(new Set(samples.map(sample => sample.effectiveSpeed)).size, 1);
  assert.equal(new Set(samples.map(sample => sample.renderTime.toFixed(9))).size, 1);
  assert.equal(new Set(samples.map(sample => JSON.stringify(sample.motionWeights))).size, 4);
});

test('brightness is direct, monotonic, and zero produces zero', () => {
  const samples = [0, .25, .5, .75, 1].map(brightness => resolvePatternLabControls(recipe({
    playback: { brightness, speed: 1.125 },
  }), 237));
  assert.deepEqual(samples.map(sample => sample.masterBrightness), [0, .25, .5, .75, 1]);
  assert.equal(samples[0].effectiveBrightness, 0);
  assert.ok(samples.every((sample, index) => (
    index === 0 || sample.effectiveBrightness >= samples[index - 1].effectiveBrightness
  )));
  assert.equal(new Set(samples.map(sample => sample.evolutionBrightnessFactor)).size, 1);
});

test('zero evolution change leaves brightness and rate neutral', () => {
  const result = resolvePatternLabControls(recipe({
    playback: { brightness: .42, speed: 1.3 },
    evolution: {
      enabled: true,
      character: 'tidal',
      durationSeconds: 900,
      change: 0,
      dynamics: { dynamicRange: 1, rareEventStrength: .8 },
    },
  }), 237);
  assert.equal(result.masterBrightness, .42);
  assert.equal(result.evolutionBrightnessFactor, 1);
  assert.equal(result.effectiveBrightness, .42);
  assert.equal(result.masterSpeed, 1.3);
  assert.equal(result.evolutionRateFactor, 1);
  assert.equal(result.effectiveSpeed, 1.3);
});

test('speed changes the direct and effective pace without changing other controls', () => {
  const slow = resolvePatternLabControls(recipe({
    playback: { brightness: .6, speed: .25 },
  }), 237);
  const fast = resolvePatternLabControls(recipe({
    playback: { brightness: .6, speed: 2 },
  }), 237);
  assert.equal(slow.masterSpeed, .25);
  assert.equal(fast.masterSpeed, 2);
  assert.ok(fast.effectiveSpeed > slow.effectiveSpeed);
  assert.equal(slow.evolutionRateFactor, fast.evolutionRateFactor);
  assert.equal(slow.evolutionBrightnessFactor, fast.evolutionBrightnessFactor);
  assert.deepEqual(slow.motionWeights, fast.motionWeights);
  assert.deepEqual(slow.technical, fast.technical);
  assert.equal(slow.masterBrightness, fast.masterBrightness);
  assert.equal(slow.masterSaturation, fast.masterSaturation);
  assert.equal(slow.masterHueShift, fast.masterHueShift);
  assert.equal(slow.shapeScale, fast.shapeScale);
  assert.equal(slow.texture, fast.texture);
  assert.notEqual(slow.renderTime, fast.renderTime);
});

test('render time applies direct speed exactly once while retaining evolution rate variation', () => {
  const source = {
    macros: { color: .5, movement: .67, shape: .5, texture: .5 },
    evolution: {
      enabled: true,
      character: 'wandering',
      durationSeconds: 900,
      change: 1,
      dynamics: { dynamicRange: 1, rareEventStrength: .8 },
    },
  };
  const half = resolvePatternLabControls(recipe({
    ...source,
    playback: { brightness: .6, speed: .5 },
  }), 237);
  const one = resolvePatternLabControls(recipe({
    ...source,
    playback: { brightness: .6, speed: 1 },
  }), 237);
  const two = resolvePatternLabControls(recipe({
    ...source,
    playback: { brightness: .6, speed: 2 },
  }), 237);
  const neutral = resolvePatternLabControls(recipe({
    ...source,
    playback: { brightness: .6, speed: 1 },
    evolution: { ...source.evolution, change: 0 },
  }), 237);

  assert.notEqual(one.evolutionRateFactor, 1);
  assert.notEqual(one.renderTime, neutral.renderTime);
  assert.ok(Math.abs(half.renderTime * 2 - one.renderTime) < 1e-12);
  assert.ok(Math.abs(two.renderTime - one.renderTime * 2) < 1e-12);
  assert.notEqual(two.renderTime, one.renderTime * 4);
});

test('returns bounded evolution factors and effective controls', () => {
  for (let elapsedSeconds = 0; elapsedSeconds <= 1800; elapsedSeconds += 17) {
    const result = resolvePatternLabControls(recipe({
      playback: { brightness: 1, speed: 2 },
      evolution: {
        enabled: true,
        character: 'rare-surprises',
        durationSeconds: 900,
        change: 1,
        dynamics: { dynamicRange: 1, rareEventStrength: .8 },
      },
    }), elapsedSeconds);
    assert.ok(result.evolutionBrightnessFactor >= 0 && result.evolutionBrightnessFactor <= 1);
    assert.ok(result.evolutionRateFactor >= .5 && result.evolutionRateFactor <= 1.5);
    assert.ok(result.effectiveBrightness >= 0 && result.effectiveBrightness <= 1);
    assert.ok(result.effectiveSpeed >= .1 && result.effectiveSpeed <= 3);
  }
});

test('exposes the technical creative values and final render inputs', () => {
  const result = resolvePatternLabControls(recipe({
    macros: { color: .2, movement: .3, shape: .4, texture: .6 },
    playback: { brightness: .7, speed: 1.2 },
    evolution: { enabled: false },
  }), 10);
  assert.deepEqual(Object.keys(result.technical), ['color', 'movement', 'shape', 'texture']);
  assert.deepEqual(result.technical.movement, { driftToPulse: .3, modulationDepth: .26 });
  assert.equal(result.masterBrightness, .7);
  assert.equal(result.masterSpeed, 1.2);
  assert.equal(result.evolutionBrightnessFactor, 1);
  assert.equal(result.evolutionRateFactor, 1);
  assert.equal(result.effectiveBrightness, .7);
  assert.equal(result.effectiveSpeed, 1.2);
  assert.equal(result.masterSaturation, result.technical.color.saturation);
  assert.equal(result.masterHueShift, result.technical.color.warmth * 18);
  assert.equal(result.shapeScale, result.technical.shape.spatialScale);
  assert.equal(result.texture, result.technical.texture.crispness);
});

test('long evolution and motion warp are deterministic without a shared duration reset', () => {
  const source = recipe();
  const times = [0, 450, 900, 1350];
  const first = times.map(time => resolvePatternLabControls(source, time));
  const second = times.map(time => resolvePatternLabControls(source, time));
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((sample, index) => [
    sample.evolutionBrightnessFactor,
    sample.evolutionRateFactor,
    sample.renderTime - sample.masterSpeed * times[index],
  ].map(value => value.toFixed(9)).join(':'))).size, times.length);
});

test('render time advances monotonically across sampled evolution timelines', () => {
  const characters = ['slow-bloom', 'wandering', 'tidal', 'breathing', 'gather-release', 'rare-surprises'];
  for (const character of characters) {
    for (const movement of [0, .33, .67, 1]) {
      for (const speed of [.25, 2]) {
        const source = recipe({
          macros: { color: .5, movement, shape: .5, texture: .5 },
          playback: { brightness: .6, speed },
          evolution: {
            enabled: true,
            character,
            durationSeconds: 900,
            change: 1,
            dynamics: { dynamicRange: 1, rareEventStrength: .8 },
          },
        });
        let previous = resolvePatternLabControls(source, 0).renderTime;
        for (let elapsedSeconds = 2.5; elapsedSeconds <= 1800; elapsedSeconds += 2.5) {
          const current = resolvePatternLabControls(source, elapsedSeconds).renderTime;
          assert.ok(current > previous, `${character}/${movement}/${speed} reversed at ${elapsedSeconds}s`);
          previous = current;
        }
      }
    }
  }
});

test('normalizes v1 input without mutating it', () => {
  const source = {
    version: 1,
    id: 'legacy-controls',
    macros: { color: .2, movement: .5, shape: .6, texture: .7, energy: .5 },
  };
  const before = structuredClone(source);
  const result = resolvePatternLabControls(source, 12);
  assert.deepEqual(source, before);
  assert.equal(result.masterBrightness, .575);
  assert.equal(result.masterSpeed, 1.125);
  assert.equal(Object.hasOwn(result.technical, 'energy'), false);
});
