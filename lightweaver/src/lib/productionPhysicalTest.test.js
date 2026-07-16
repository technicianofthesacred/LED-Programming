import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCTION_DIAGNOSTIC_MAX_CHANNEL,
  buildProductionBoundaryCandidate,
  buildProductionBoundaryFrame,
  buildProductionPhysicalResults,
  buildProductionDiagnosticFrame,
  classifyProductionPhysicalObservation,
  createProductionKnownGood,
  createProductionPhysicalState,
  assertProductionFinalWiringStatus,
  productionDiagnosticCurrentEstimate,
  productionPhysicalReducer,
} from './productionPhysicalTest.js';

test('final pass assertion requires exact known-good identity and one-to-one physical wiring truth', () => {
  const wiringDigest = 'b'.repeat(64);
  const job = {
    jobId: 'moon-7', digest: 'd'.repeat(64),
    firmware: { version: '1.0.0', buildId: 'f'.repeat(40) },
    project: { revision: 12, fingerprint: 'a'.repeat(16), restoreSnapshot: { layout: {
      strips: [{ id: 'outer-strip', name: 'Outer' }, { id: 'inner-strip', name: 'Inner' }],
      wiring: { runs: [{ id: 'outer-run', type: 'strip', source: { stripId: 'outer-strip' } }, { id: 'inner-run', type: 'strip', source: { stripId: 'inner-strip' } }] },
    } } },
    configuration: { config: { wiringRevision: 2, wiringDigest, controls: {}, led: { pixels: 8, colorOrder: 'GRB', maxMilliamps: 1500, outputs: [{ id: 'out1', name: 'Rings', pin: 16, pixels: 8, direction: 'mixed', segments: [{ id: 'outer-run', count: 5, direction: 'forward' }, { id: 'inner-run', count: 3, direction: 'reverse' }] }] }, zones: [] } },
  };
  const physicalResults = [
    { boundaryId: 'outer-run', result: 'correct', count: 5, pin: 16, direction: 'forward', colorOrder: 'GRB', wiringRevision: 2, wiringDigest },
    { boundaryId: 'inner-run', result: 'correct', count: 3, pin: 16, direction: 'reverse', colorOrder: 'GRB', wiringRevision: 2, wiringDigest },
  ];
  const status = {
    state: 'known-good', activationId: '', cardId: 'lw-aabbccddeeff', firmwareVersion: '1.0.0', buildId: 'f'.repeat(40),
    projectRevision: 12, projectFingerprint: 'a'.repeat(16), productionJobId: 'moon-7', productionJobDigest: 'd'.repeat(64),
    maxMilliamps: 1500, wiringRevision: 2, wiringDigest, colorOrder: 'GRB', outputs: job.configuration.config.led.outputs,
  };
  const args = { status, job, cardId: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId, physicalResults };
  assert.equal(assertProductionFinalWiringStatus(args), true);
  for (const changed of [
    { ...status, state: 'testing', activationId: 'candidate-1' },
    { ...status, wiringRevision: 3 },
    { ...status, wiringDigest: 'c'.repeat(64) },
    { ...status, colorOrder: 'RGB' },
    { ...status, maxMilliamps: 1600 },
    { ...status, outputs: [{ ...status.outputs[0], pin: 17 }] },
    { ...status, outputs: [{ ...status.outputs[0], segments: [{ ...status.outputs[0].segments[0], count: 6 }, status.outputs[0].segments[1]] }] },
  ]) assert.throws(() => assertProductionFinalWiringStatus({ ...args, status: changed }), /Final wiring read-back/);
  assert.throws(() => assertProductionFinalWiringStatus({ ...args, physicalResults: physicalResults.slice(0, 1) }), /coverage/);
});

const outputs = [
  { id: 'outer', label: 'Outer', pin: 16, pixels: 5, direction: 'forward', colorOrder: 'GRB' },
  { id: 'inner', label: 'Inner', pin: 17, pixels: 4, direction: 'forward', colorOrder: 'GRB' },
];

test('diagnostic frame lights only one output with blue first, red final, dim middle and dark outside', () => {
  const frame = buildProductionDiagnosticFrame({ outputs, outputId: 'inner' });
  assert.equal(frame.length, 9);
  assert.deepEqual(frame.slice(0, 5), Array(5).fill('000000'));
  assert.equal(frame[5], '000020');
  assert.equal(frame[8], '200000');
  assert.deepEqual(frame.slice(6, 8), ['020202', '020202']);
  for (const pixel of frame) {
    for (const channel of pixel.match(/../g).map(value => parseInt(value, 16))) assert.ok(channel <= PRODUCTION_DIAGNOSTIC_MAX_CHANNEL);
  }
});

test('1024-pixel bounded diagnostic channel ceiling cannot bypass the aggregate current limiter', () => {
  const frame = Array(1024).fill('202020');
  const estimate = productionDiagnosticCurrentEstimate(frame, 1500);
  assert.ok(estimate.uncappedMilliamps > 5000);
  assert.equal(estimate.cappedMilliamps, 1500);
  assert.equal(estimate.maxMilliamps, 1500);
  assert.throws(() => productionDiagnosticCurrentEstimate(frame, 0), /current limit/i);
});

test('reverse diagnostic swaps physical start and end markers without activating another output', () => {
  const frame = buildProductionDiagnosticFrame({ outputs, outputId: 'outer', direction: 'reverse' });
  assert.equal(frame[0], '200000');
  assert.equal(frame[4], '000020');
  assert.deepEqual(frame.slice(5), Array(4).fill('000000'));
});

test('transport acknowledgement never completes an output without worker observation', () => {
  let state = createProductionPhysicalState(outputs);
  state = productionPhysicalReducer(state, { type: 'delivery-started', outputId: 'outer', generation: 1 });
  state = productionPhysicalReducer(state, { type: 'delivered', outputId: 'outer', generation: 1 });
  assert.equal(state.results.outer, undefined);
  assert.equal(state.canComplete, false);
  state = productionPhysicalReducer(state, { type: 'observe', outputId: 'outer', observation: 'correct' });
  assert.equal(state.results.outer.observation, 'correct');
  assert.equal(state.canComplete, false);
  state = productionPhysicalReducer(state, { type: 'select', outputId: 'inner' });
  state = productionPhysicalReducer(state, { type: 'delivery-started', outputId: 'inner', generation: 2 });
  state = productionPhysicalReducer(state, { type: 'delivered', outputId: 'inner', generation: 2 });
  state = productionPhysicalReducer(state, { type: 'observe', outputId: 'inner', observation: 'correct' });
  assert.equal(state.canComplete, true);
});

test('stale, failed, and late delivery acknowledgements can never authorize an observation', () => {
  let state = createProductionPhysicalState(outputs);
  state = productionPhysicalReducer(state, { type: 'delivery-started', outputId: 'outer', generation: 7 });
  state = productionPhysicalReducer(state, { type: 'observe', outputId: 'outer', observation: 'correct' });
  assert.equal(state.results.outer, undefined);
  state = productionPhysicalReducer(state, { type: 'delivered', outputId: 'outer', generation: 6 });
  assert.equal(state.delivery, 'starting');
  state = productionPhysicalReducer(state, { type: 'select', outputId: 'inner' });
  state = productionPhysicalReducer(state, { type: 'delivery-started', outputId: 'inner', generation: 8 });
  state = productionPhysicalReducer(state, { type: 'delivered', outputId: 'outer', generation: 7 });
  assert.equal(state.delivery, 'starting');
  state = productionPhysicalReducer(state, { type: 'delivery-failed', outputId: 'inner', generation: 8 });
  state = productionPhysicalReducer(state, { type: 'observe', outputId: 'inner', observation: 'correct' });
  assert.equal(state.results.inner, undefined);
  state = productionPhysicalReducer(state, { type: 'delivered', outputId: 'inner', generation: 8 });
  state = productionPhysicalReducer(state, { type: 'observe', outputId: 'inner', observation: 'correct' });
  assert.equal(state.results.inner.observation, 'correct');
});

test('all observations have one evidence-based next action', () => {
  const expected = {
    'nothing-lit': 'inspect-power-data',
    'wrong-color': 'test-color-order',
    'wrong-start-end': 'test-direction',
    'wrong-count': 'adjust-count',
    'wrong-output': 'test-gpio-output',
    'flashing-or-frozen': 'release-restart-stream',
    correct: 'confirm-output',
  };
  for (const [observation, action] of Object.entries(expected)) {
    assert.equal(classifyProductionPhysicalObservation(observation).action, action);
  }
  assert.equal(classifyProductionPhysicalObservation('nothing-lit', { cardIdentityMatches: false }).action, 'restore-project');
  assert.equal(classifyProductionPhysicalObservation('flashing-or-frozen', { firmwareTrusted: false }).action, 'signed-firmware-recovery');
});

test('run boundaries isolate outer/inner seams and sequential candidates retain earlier confirmed fixes', () => {
  const job = {
    jobId: 'moon-7', digest: 'd'.repeat(64), project: { revision: 12, fingerprint: 'a'.repeat(16), restoreSnapshot: { layout: { strips: [{ id: 'outer-strip', name: 'Outer' }, { id: 'inner-strip', name: 'Inner' }], wiring: { runs: [{ id: 'outer-run', type: 'strip', source: { stripId: 'outer-strip' } }, { id: 'inner-run', type: 'strip', source: { stripId: 'inner-strip' } }] } } } },
    expectedOutputs: outputs,
    configuration: { config: { projectRevision: 12, projectFingerprint: 'a'.repeat(16), productionJobId: 'moon-7', productionJobDigest: 'd'.repeat(64), controls: {}, led: { pixels: 9, colorOrder: 'GRB', outputs: [{ id: 'outer', name: 'Both', pin: 16, pixels: 9, direction: 'mixed', segments: [{ id: 'outer-run', count: 5, direction: 'forward' }, { id: 'inner-run', count: 4, direction: 'reverse' }] }] }, zones: [{ ranges: [{ start: 0, count: 5 }] }, { ranges: [{ start: 5, count: 4 }] }] } },
  };
  const knownGood = createProductionKnownGood(job);
  assert.deepEqual(knownGood.boundaries.map(boundary => [boundary.id, boundary.start, boundary.count, boundary.direction]), [['outer-run', 0, 5, 'forward'], ['inner-run', 5, 4, 'reverse']]);
  assert.deepEqual(buildProductionBoundaryFrame({ snapshot: knownGood, boundaryId: 'outer-run' }).slice(5), Array(4).fill('000000'));
  assert.deepEqual(buildProductionBoundaryFrame({ snapshot: knownGood, boundaryId: 'inner-run' }).slice(0, 5), Array(5).fill('000000'));
  const count = buildProductionBoundaryCandidate(knownGood, 'outer-run', { kind: 'pixel-count', delta: 1 });
  assert.equal(count.config.led.outputs[0].segments[0].count, 6);
  assert.equal(count.config.led.pixels, 10);
  assert.equal(count.snapshot.boundaries.find(boundary => boundary.id === 'inner-run').start, 6);
  const gpio = buildProductionBoundaryCandidate(count.snapshot, 'inner-run', { kind: 'gpio', pin: 18 });
  assert.equal(gpio.config.led.outputs[0].pin, 18);
  assert.equal(gpio.config.led.outputs[0].segments[0].count, 6, 'later correction must retain confirmed count');
  const order = buildProductionBoundaryCandidate(gpio.snapshot, 'inner-run', { kind: 'color-order', colorOrder: 'RGB' });
  assert.equal(order.config.led.colorOrder, 'RGB');
  const direction = buildProductionBoundaryCandidate(order.snapshot, 'outer-run', { kind: 'direction', direction: 'reverse' });
  assert.equal(direction.config.led.outputs[0].segments[0].direction, 'reverse');
  for (const candidate of [count, gpio, order, direction]) {
    assert.equal(candidate.config.projectRevision, 12);
    assert.equal(candidate.config.productionJobDigest, 'd'.repeat(64));
    assert.equal(candidate.rollbackAfterMs, 90_000);
  }
  assert.throws(() => buildProductionBoundaryCandidate(knownGood, 'outer-run', { kind: 'pixel-count', delta: 20_000 }), /bounded/);
  assert.throws(() => buildProductionBoundaryCandidate(knownGood, 'outer-run', { kind: 'gpio', pin: 16 }), /already assigned/);
});

test('pixel count correction remaps aggregate, crossing, overlapping, and downstream zone intervals', () => {
  const snapshot = {
    config: {
      led: { pixels: 8, colorOrder: 'GRB', outputs: [{ id: 'one', name: 'One', pin: 16, pixels: 8, direction: 'forward', segments: [{ id: 'outer', count: 5, direction: 'forward' }, { id: 'inner', count: 3, direction: 'forward' }] }] },
      zones: [
        { id: 'all', ranges: [{ start: 0, count: 8 }] },
        { id: 'outer', ranges: [{ start: 0, count: 5 }] },
        { id: 'crossing', ranges: [{ start: 3, count: 4 }] },
        { id: 'downstream', ranges: [{ start: 5, count: 3 }] },
      ],
    },
    boundaries: [
      { id: 'outer', outputId: 'one', start: 0, count: 5, direction: 'forward', pin: 16, label: 'Outer' },
      { id: 'inner', outputId: 'one', start: 5, count: 3, direction: 'forward', pin: 16, label: 'Inner' },
    ],
    testableIds: ['outer', 'inner'],
  };
  const grown = buildProductionBoundaryCandidate(snapshot, 'outer', { kind: 'pixel-count', delta: 1 });
  assert.deepEqual(grown.config.zones.map(zone => zone.ranges[0]), [
    { start: 0, count: 9 },
    { start: 0, count: 6 },
    { start: 3, count: 5 },
    { start: 6, count: 3 },
  ]);
  assert.equal(grown.config.zones.every(zone => zone.ranges.every(range => range.start >= 0 && range.count >= 1 && range.start + range.count <= 9)), true);
  const shrunk = buildProductionBoundaryCandidate(grown.snapshot, 'outer', { kind: 'pixel-count', delta: -1 });
  assert.deepEqual(shrunk.config.zones.map(zone => zone.ranges[0]), snapshot.config.zones.map(zone => zone.ranges[0]));
});

test('verification exposes only physical strip runs while preserving inactive spacer offsets', () => {
  const job = {
    jobId: 'spaced', digest: 'e'.repeat(64),
    project: { restoreSnapshot: { layout: {
      strips: [{ id: 'outer-strip', name: 'Outer' }, { id: 'inner-strip', name: 'Inner' }],
      wiring: { runs: [
        { id: 'outer-run', type: 'strip', source: { stripId: 'outer-strip' } },
        { id: 'spacer', type: 'inactive', count: 2 },
        { id: 'inner-run', type: 'strip', source: { stripId: 'inner-strip' } },
      ] },
    } } },
    configuration: { config: { controls: {}, led: { pixels: 11, colorOrder: 'GRB', outputs: [{
      id: 'rings', name: 'Rings', pin: 16, pixels: 11, direction: 'mixed', segments: [
        { id: 'outer-run', count: 5, direction: 'forward' },
        { id: 'spacer', count: 2, direction: 'forward' },
        { id: 'inner-run', count: 4, direction: 'reverse' },
      ],
    }] }, zones: [] } },
  };
  const knownGood = createProductionKnownGood(job);
  assert.deepEqual(knownGood.boundaries.map(boundary => boundary.id), ['outer-run', 'inner-run']);
  assert.equal(knownGood.boundaries[1].start, 7);
  const candidate = buildProductionBoundaryCandidate(knownGood, 'outer-run', { kind: 'direction', direction: 'reverse' });
  assert.deepEqual(candidate.snapshot.boundaries.map(boundary => boundary.id), ['outer-run', 'inner-run']);
  assert.equal(candidate.snapshot.boundaries[1].start, 7);
});

test('confirmed corrections invalidate every observation affected by the new known-good mapping', () => {
  const boundaries = [
    { id: 'a', outputId: 'one', start: 0, count: 4 },
    { id: 'b', outputId: 'one', start: 4, count: 3 },
    { id: 'c', outputId: 'two', start: 7, count: 2 },
  ];
  let state = createProductionPhysicalState({ boundaries });
  for (const boundary of boundaries) {
    state = productionPhysicalReducer(state, { type: 'select', boundaryId: boundary.id });
    state = productionPhysicalReducer(state, { type: 'delivery-started', boundaryId: boundary.id, generation: boundaries.indexOf(boundary) + 1 });
    state = productionPhysicalReducer(state, { type: 'delivered', boundaryId: boundary.id, generation: boundaries.indexOf(boundary) + 1 });
    state = productionPhysicalReducer(state, { type: 'observe', boundaryId: boundary.id, observation: 'correct' });
  }
  assert.equal(state.canComplete, true);

  const invalidated = (correction, boundaryId = 'a') => productionPhysicalReducer(state, {
    type: 'candidate-confirmed', boundaryIds: correction, boundaryId,
  });
  assert.deepEqual(Object.keys(invalidated(['a']).results), ['b', 'c'], 'direction invalidates only its boundary');
  assert.deepEqual(Object.keys(invalidated(['a', 'b']).results), ['c'], 'count or GPIO invalidates affected output boundaries');
  assert.deepEqual(Object.keys(invalidated(['a', 'b', 'c']).results), [], 'color order invalidates every boundary');
  assert.equal(invalidated(['a']).canComplete, false);
});

test('final physical results bind each correct boundary to confirmed count, GPIO, direction, and color order', () => {
  const snapshot = {
    config: { led: { colorOrder: 'RGB' } },
    boundaries: [
      { id: 'outer-run', count: 6, pin: 18, direction: 'reverse' },
      { id: 'inner-run', count: 3, pin: 18, direction: 'forward' },
    ],
  };
  const results = buildProductionPhysicalResults(snapshot, {
    'outer-run': { observation: 'correct', workerConfirmed: true, activationId: 'candidate-1' },
    'inner-run': { observation: 'correct', workerConfirmed: true },
  });
  assert.deepEqual(results, [
    { boundaryId: 'outer-run', result: 'correct', activationId: 'candidate-1', count: 6, pin: 18, direction: 'reverse', colorOrder: 'RGB' },
    { boundaryId: 'inner-run', result: 'correct', count: 3, pin: 18, direction: 'forward', colorOrder: 'RGB' },
  ]);
  assert.throws(() => buildProductionPhysicalResults(snapshot, { 'outer-run': { observation: 'correct', workerConfirmed: true } }), /every boundary/i);
});
