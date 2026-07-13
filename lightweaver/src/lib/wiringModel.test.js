import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WIRING_VERSION,
  makeDefaultWiring,
  migrateWiring,
  normalizeWiring,
  validateWiring,
  updateWiring,
  invalidatesVerifiedWiring,
  wiringFingerprint,
} from './wiringModel.js';

const strips = [
  { id: 'a', name: 'A', pixelCount: 3 },
  { id: 'b', name: 'B', pixelCount: 2 },
];

test('default wiring creates one ascending run per strip on one output', () => {
  const wiring = makeDefaultWiring(strips);
  assert.equal(wiring.version, WIRING_VERSION);
  assert.deepEqual(wiring.outputs[0].runIds, ['run-a', 'run-b']);
  assert.deepEqual(wiring.runs.map(run => run.source), [
    { stripId: 'a', from: 0, to: 2 },
    { stripId: 'b', from: 0, to: 1 },
  ]);
});

test('legacy descending chains migrate to ascending sources and physical reverse', () => {
  const wiring = migrateWiring(null, strips, {
    chains: [{ rowIds: ['pb', 'off', 'pa'] }],
    patches: [
      { id: 'pa', source: { type: 'strip', stripId: 'a', startLed: 0, endLed: 2 } },
      { id: 'pb', source: { type: 'strip', stripId: 'b', startLed: 1, endLed: 0 } },
      { id: 'off', source: { type: 'off', ledCount: 4 } },
    ],
  });
  assert.deepEqual(wiring.outputs[0].runIds, ['pb', 'off', 'pa']);
  assert.deepEqual(wiring.runs[0].source, { stripId: 'b', from: 0, to: 1 });
  assert.equal(wiring.runs[0].physicalDirection, 'source-reverse');
  assert.equal(wiring.runs[1].type, 'inactive');
  assert.equal(wiring.runs[1].count, 4);
});

test('validation rejects duplicate IDs and pins, missing runs, repeated runs, and invalid ranges', () => {
  const wiring = normalizeWiring({
    outputs: [
      { id: 'same', pin: 16, runIds: ['r', 'missing'] },
      { id: 'same', pin: 16, runIds: ['r'] },
    ],
    runs: [{ id: 'r', type: 'strip', source: { stripId: 'a', from: 2, to: 0 }, directionPolicy: 'nope' }],
  });
  const codes = validateWiring(wiring, strips).errors.map(error => error.code);
  for (const code of ['output-id-duplicate', 'output-pin-duplicate', 'run-missing', 'run-duplicate', 'source-range-descending', 'direction-policy-invalid']) {
    assert.ok(codes.includes(code), `missing ${code}`);
  }
});

test('validation rejects branches/cycles and non-positive inactive counts', () => {
  const wiring = normalizeWiring({
    outputs: [{ id: 'o', pin: 16, runIds: ['jump', 'off'] }],
    runs: [
      { id: 'jump', type: 'cable', nextRunIds: ['off', 'jump'] },
      { id: 'off', type: 'inactive', count: 0 },
    ],
  });
  const codes = validateWiring(wiring, strips).errors.map(error => error.code);
  assert.ok(codes.includes('run-branch'));
  assert.ok(codes.includes('run-cycle'));
  assert.ok(codes.includes('inactive-count-invalid'));
});

test('locked verified wiring mutations return structured errors without partial mutation', () => {
  const wiring = { ...makeDefaultWiring(strips), locked: true, verified: true };
  const before = wiringFingerprint(wiring);
  const result = updateWiring(wiring, draft => { draft.outputs[0].pin = 17; });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'wiring-locked');
  assert.equal(wiringFingerprint(wiring), before);

  const unlocked = updateWiring(wiring, draft => { draft.locked = false; });
  assert.equal(unlocked.ok, true);
  assert.equal(unlocked.wiring.locked, false);

  const smuggled = updateWiring(wiring, draft => { draft.locked = false; draft.outputs[0].pin = 17; });
  assert.equal(smuggled.ok, false);
});

test('single invalidation guard distinguishes physical edits from creative edits', () => {
  for (const kind of ['geometry', 'led-count', 'direction', 'route', 'output', 'seam', 'controller-anchor', 'gpio']) {
    assert.equal(invalidatesVerifiedWiring(kind), true, kind);
  }
  for (const kind of ['color', 'name', 'look']) assert.equal(invalidatesVerifiedWiring(kind), false, kind);
});

test('normalization preserves independent direction policy, direction, seam, and verification state', () => {
  const wiring = normalizeWiring({
    locked: true,
    verified: true,
    outputs: [{ id: 'o', pin: 16, runIds: ['r'] }],
    runs: [{ id: 'r', type: 'strip', source: { stripId: 'a', from: 0, to: 2 }, directionPolicy: 'fixed', physicalDirection: 'source-reverse', seamLed: 1 }],
  });
  assert.deepEqual(wiring.runs[0], {
    id: 'r', type: 'strip', source: { stripId: 'a', from: 0, to: 2 }, directionPolicy: 'fixed', physicalDirection: 'source-reverse', seamLed: 1,
  });
  assert.equal(wiring.locked, true);
  assert.equal(wiring.verified, true);
});
