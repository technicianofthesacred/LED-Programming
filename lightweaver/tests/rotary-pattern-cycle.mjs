import assert from 'node:assert/strict';
import {
  adjustRotaryBrightness,
  getNextRotaryCyclePatternId,
  insertPatternInCycle,
  makeDefaultRotaryCycleIds,
  normalizeRotaryPatternCycle,
} from '../src/lib/rotaryPatternCycle.js';

const knownPatternIds = new Set(['candle', 'breathe', 'aurora', 'fire', 'ocean']);

assert.deepEqual(
  normalizeRotaryPatternCycle(['candle', 'unknown', 'aurora', 'candle', '', null], knownPatternIds),
  ['candle', 'aurora'],
);

assert.deepEqual(
  makeDefaultRotaryCycleIds({
    activePatternId: 'fire',
    showClips: [
      { patternId: 'candle' },
      { patternId: 'unknown' },
      { patternId: 'fire' },
      { patternId: 'aurora' },
    ],
    knownPatternIds,
  }),
  ['fire', 'candle', 'aurora'],
);

assert.deepEqual(
  insertPatternInCycle(['candle', 'aurora'], 'breathe', 1, knownPatternIds),
  ['candle', 'breathe', 'aurora'],
);

assert.deepEqual(
  insertPatternInCycle(['candle', 'breathe', 'aurora'], 'candle', 2, knownPatternIds),
  ['breathe', 'aurora', 'candle'],
);

assert.deepEqual(
  insertPatternInCycle(['candle', 'aurora'], 'unknown', 1, knownPatternIds),
  ['candle', 'aurora'],
);

assert.equal(
  getNextRotaryCyclePatternId(['candle', 'breathe', 'aurora'], 'candle', knownPatternIds),
  'breathe',
);

assert.equal(
  getNextRotaryCyclePatternId(['candle', 'breathe', 'aurora'], 'aurora', knownPatternIds),
  'candle',
);

assert.equal(
  getNextRotaryCyclePatternId(['candle', 'breathe'], 'fire', knownPatternIds),
  'candle',
);

assert.equal(
  adjustRotaryBrightness({
    currentBrightness: 0.5,
    rotateDirection: 'clockwise-dimmer',
    turn: 'clockwise',
    step: 0.1,
  }),
  0.4,
);

assert.equal(
  adjustRotaryBrightness({
    currentBrightness: 0.5,
    rotateDirection: 'clockwise-dimmer',
    turn: 'counterclockwise',
    step: 0.1,
  }),
  0.6,
);

assert.equal(
  adjustRotaryBrightness({
    currentBrightness: 0.98,
    rotateDirection: 'clockwise-brighter',
    turn: 'clockwise',
    step: 0.1,
  }),
  1,
);

console.log('rotary-pattern-cycle passed');
