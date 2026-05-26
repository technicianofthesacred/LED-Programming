import assert from 'node:assert/strict';
import { stripOverrideIdsToClearForGlobalSelection } from '../src/lib/patternTargeting.js';

assert.deepEqual(
  stripOverrideIdsToClearForGlobalSelection([{ id: 'strip-1', patternId: 'heartbeat' }]),
  ['strip-1'],
);

assert.deepEqual(
  stripOverrideIdsToClearForGlobalSelection([{ id: 'strip-1', patternId: null }]),
  [],
);

assert.deepEqual(
  stripOverrideIdsToClearForGlobalSelection([
    { id: 'strip-1', patternId: 'heartbeat' },
    { id: 'strip-2', patternId: 'candle' },
  ]),
  [],
);

assert.deepEqual(stripOverrideIdsToClearForGlobalSelection(null), []);

console.log('pattern-targeting tests passed');
