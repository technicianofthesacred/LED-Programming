import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildKaleidoscopeCalibrationFrame,
  createKaleidoscopeCalibrationSession,
} from './kaleidoscopeCalibration.js';

test('builds physical-order red frames across reverse, splits and inactive gaps', () => {
  const compiledWiring = {
    pixels: [
      { stripId: 'outer', sourceLed: 3 },
      { stripId: 'outer', sourceLed: 2 },
      { inactive: true, stripId: null, sourceLed: null },
      { stripId: 'inner', sourceLed: 0 },
      { stripId: 'outer', sourceLed: 0 },
      { stripId: 'outer', sourceLed: 1 },
    ],
  };
  assert.deepEqual(buildKaleidoscopeCalibrationFrame({
    compiledWiring,
    stripId: 'outer',
    pointIndices: [0, 2],
    selectedPointIndex: 1,
    pulse: 1,
  }), ['000000', 'ff0000', '000000', '000000', '800000', '000000']);
});

test('session restores after stop and yields safely to a newer stream owner', async () => {
  const calls = [];
  let health;
  const session = createKaleidoscopeCalibrationSession({
    host: 'card.local',
    readSnapshot: async () => ({ currentId: 'aurora' }),
    createStream: options => {
      health = options.onHealth;
      return {
        start: () => true,
        push: frame => { calls.push(['push', frame]); return true; },
        stop: async () => { calls.push('stop'); },
      };
    },
    restoreLook: async look => { calls.push(['restore', look]); },
    resetOutput: async () => { calls.push('reset'); },
  });
  await session.start(['800000']);
  await session.stop('cancel');
  assert.deepEqual(calls, [
    ['push', ['800000']],
    'stop',
    ['restore', { patternId: 'aurora', syncZones: true }],
  ]);

  const secondCalls = [];
  const second = createKaleidoscopeCalibrationSession({
    readSnapshot: async () => ({ currentId: 'ocean' }),
    createStream: options => {
      health = options.onHealth;
      return { start: () => true, push: () => true, stop: async () => secondCalls.push('stop') };
    },
    restoreLook: async () => secondCalls.push('restore'),
    resetOutput: async () => secondCalls.push('reset'),
  });
  await second.start();
  health({ delivered: false, reason: 'stream-superseded' });
  await second.whenSettled();
  assert.deepEqual(secondCalls, ['stop']);
  assert.equal(second.status().state, 'superseded');
});

test('delivery stays unconfirmed until stream health acknowledges a pushed frame', async () => {
  const states = [];
  let health;
  let acceptsPush = true;
  const session = createKaleidoscopeCalibrationSession({
    readSnapshot: async () => ({ currentId: 'calm' }),
    createStream: options => {
      health = options.onHealth;
      return { start: () => true, push: () => acceptsPush, stop: async () => {} };
    },
    restoreLook: async () => {},
    onStateChange: state => states.push(state),
  });
  await session.start(['800000']);
  assert.equal(states.at(-1).physicalDelivered, false);
  health({ delivered: true, active: true });
  assert.equal(states.at(-1).physicalDelivered, true);
  acceptsPush = false;
  assert.equal(session.push(['ff0000']), false);
  assert.equal(states.at(-1).physicalDelivered, false);
  assert.match(states.at(-1).error.message, /push/i);
  await session.stop();
});
