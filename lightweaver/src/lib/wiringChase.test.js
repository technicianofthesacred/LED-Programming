import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHASE_ACK_TIMEOUT_MS,
  CHASE_FPS,
  CHASE_MAX_CHANNEL,
  buildWiringChaseFrame,
  buildWiringChaseSteps,
  createWiringChaseSession,
  createWiringChaseState,
  wiringChaseReducer,
  planAdjacentStripBoundary,
  planOutputPixelCountAdjustment,
  planStripPixelCountAdjustment,
} from './wiringChase.js';

const compiled = {
  totalPixels: 8,
  outputs: [{ id: 'out1', name: 'Output A', pin: 16, start: 0, count: 8, runIds: ['run-a', 'run-b'] }],
  runs: [
    { id: 'run-a', type: 'strip', outputId: 'out1', start: 0, count: 4, physicalDirection: 'source-forward' },
    { id: 'run-b', type: 'strip', outputId: 'out1', start: 4, count: 4, physicalDirection: 'source-reverse' },
  ],
};

const compiledWithEveryPhysicalRow = {
  ...compiled,
  totalPixels: 10,
  outputs: [{ ...compiled.outputs[0], count: 10, runIds: ['run-a', 'jump-a', 'reserved-a', 'run-b'] }],
  runs: [
    compiled.runs[0],
    { id: 'jump-a', type: 'cable', outputId: 'out1', start: 4, count: 0 },
    { id: 'reserved-a', type: 'inactive', outputId: 'out1', start: 4, count: 2 },
    { ...compiled.runs[1], start: 6 },
  ],
};

test('chase steps cover output, run, first pixel, and physical direction in compiler order', () => {
  const steps = buildWiringChaseSteps(compiled);
  assert.deepEqual(steps.map(step => `${step.kind}:${step.outputId}:${step.runId || ''}`), [
    'output:out1:', 'run:out1:run-a', 'run:out1:run-b',
  ]);
  assert.equal(CHASE_FPS, 4);
  assert.equal(CHASE_ACK_TIMEOUT_MS, 1500);
});

test('chase steps preserve cable jumps and reserved-unlit rows in compiler order', () => {
  const steps = buildWiringChaseSteps(compiledWithEveryPhysicalRow);
  assert.deepEqual(steps.map(step => `${step.kind}:${step.runId || ''}`), [
    'output:', 'run:run-a', 'cable:jump-a', 'inactive:reserved-a', 'run:run-b',
  ]);
});

test('completion requires explicit confirmation of cable and reserved-unlit rows', () => {
  let state = createWiringChaseState(compiledWithEveryPhysicalRow);
  const deliver = () => { state = wiringChaseReducer(state, { type: 'delivery', requestId: state.requestId, response: { ok: true } }); };
  deliver();
  state = wiringChaseReducer(state, { type: 'confirm-output' });
  deliver();
  state = wiringChaseReducer(state, { type: 'confirm-first-pixel' });
  state = wiringChaseReducer(state, { type: 'confirm-direction' });
  assert.equal(state.steps[state.stepIndex].kind, 'cable');
  assert.equal(state.canComplete, false);
  deliver();
  state = wiringChaseReducer(state, { type: 'confirm-cable' });
  assert.equal(state.steps[state.stepIndex].kind, 'inactive');
  assert.equal(state.canComplete, false);
  deliver();
  state = wiringChaseReducer(state, { type: 'confirm-inactive' });
  deliver();
  state = wiringChaseReducer(state, { type: 'confirm-first-pixel' });
  state = wiringChaseReducer(state, { type: 'confirm-direction' });
  assert.equal(state.canComplete, true);
  assert.deepEqual(Object.keys(state.confirmedRuns).sort(), ['jump-a', 'reserved-a', 'run-a', 'run-b']);
});

test('full-frame chase stays black off target, marks blue first and red last, and never exceeds ten percent', () => {
  const frame = buildWiringChaseFrame({ totalPixels: 8, step: buildWiringChaseSteps(compiled)[1] });
  assert.equal(frame.length, 8);
  assert.equal(frame[0], '00001A');
  assert.ok(frame.slice(1, 3).every(pixel => pixel === '001A00'));
  assert.equal(frame[3], '1A0000');
  assert.ok(frame.slice(4).every(pixel => pixel === '000000'));
  for (const pixel of frame) for (const channel of pixel.match(/../g).map(value => parseInt(value, 16))) assert.ok(channel <= CHASE_MAX_CHANNEL);
  const reservedFrame = buildWiringChaseFrame({ totalPixels: 10, step: { ...compiledWithEveryPhysicalRow.runs[2], kind: 'inactive' } });
  assert.ok(reservedFrame.every(pixel => pixel === '000000'));
});

test('second boundary frame blacks the entire first run and lights only the second run blue through red', () => {
  const secondStep = { ...buildWiringChaseSteps(compiled)[2], physicalDirection: 'source-forward' };
  const frame = buildWiringChaseFrame({ totalPixels: compiled.totalPixels, step: secondStep });
  assert.deepEqual(frame.slice(0, 4), ['000000', '000000', '000000', '000000']);
  assert.deepEqual(frame.slice(4), ['00001A', '001A00', '001A00', '1A0000']);
});

test('a single-pixel chase marker is magenta because it is both first and last', () => {
  const frame = buildWiringChaseFrame({ totalPixels: 3, step: { kind: 'run', start: 1, count: 1 } });
  assert.deepEqual(frame, ['000000', '1A001A', '000000']);
});

test('reverse-mapped run keeps logical markers fixed so firmware swaps physical endpoints once', () => {
  const forward = buildWiringChaseFrame({ totalPixels: 6, step: { kind: 'run', start: 1, count: 4, physicalDirection: 'source-forward' } });
  const reverse = buildWiringChaseFrame({ totalPixels: 6, step: { kind: 'run', start: 1, count: 4, physicalDirection: 'source-reverse' } });
  const output = buildWiringChaseFrame({ totalPixels: 6, step: { kind: 'output', start: 1, count: 4, physicalDirection: 'source-reverse' } });
  assert.equal(forward[1], '00001A');
  assert.equal(forward[4], '1A0000');
  assert.equal(reverse[1], '00001A');
  assert.equal(reverse[4], '1A0000');
  assert.equal(output[1], '00001A');
  assert.equal(output[4], '1A0000');
});

test('adjacent boundary adjustment plans valid counts for distinct strips without changing total', () => {
  const wiring = {
    outputs: [{ id: 'out1', runIds: ['outer', 'inner'] }],
    runs: [
      { id: 'outer', type: 'strip', source: { stripId: 'outer-strip', from: 0, to: 21 } },
      { id: 'inner', type: 'strip', source: { stripId: 'inner-strip', from: 0, to: 21 } },
    ],
  };
  let stripCounts = { 'outer-strip': 22, 'inner-strip': 22 };
  let counts;
  for (let index = 0; index < 4; index += 1) {
    counts = planAdjacentStripBoundary(wiring, stripCounts, { outputId: 'out1', runId: 'outer', delta: 1 });
    stripCounts = Object.fromEntries(counts.map(item => [item.stripId, item.count]));
  }
  assert.deepEqual(counts, [
    { runId: 'outer', stripId: 'outer-strip', count: 26 },
    { runId: 'inner', stripId: 'inner-strip', count: 18 },
  ]);
  assert.equal(wiring.runs[0].source.to, 21);
  assert.equal(wiring.runs[1].source.to, 21);
  assert.equal(counts.reduce((sum, item) => sum + item.count, 0), 44);
});

test('adjacent boundary adjustment refuses to reduce either strip below one pixel', () => {
  const wiring = {
    outputs: [{ id: 'out1', runIds: ['a', 'b'] }],
    runs: [
      { id: 'a', type: 'strip', source: { stripId: 'a', from: 0, to: 0 } },
      { id: 'b', type: 'strip', source: { stripId: 'b', from: 0, to: 3 } },
    ],
  };
  assert.throws(() => planAdjacentStripBoundary(wiring, { a: 1, b: 4 }, { outputId: 'out1', runId: 'a', delta: -1 }), /at least one pixel/i);
  assert.equal(wiring.runs[0].source.to, 0);
  assert.equal(wiring.runs[1].source.to, 3);
});

test('the last strip adjusts against its previous neighbor', () => {
  const wiring = {
    outputs: [{ id: 'out1', runIds: ['outer', 'inner'] }],
    runs: [
      { id: 'outer', type: 'strip', source: { stripId: 'outer', from: 0, to: 25 } },
      { id: 'inner', type: 'strip', source: { stripId: 'inner', from: 0, to: 17 } },
    ],
  };
  assert.deepEqual(planAdjacentStripBoundary(wiring, { outer: 26, inner: 18 }, { outputId: 'out1', runId: 'inner', delta: 1 }), [
    { runId: 'inner', stripId: 'inner', count: 19 },
    { runId: 'outer', stripId: 'outer', count: 25 },
  ]);
});

test('output count adjustment resizes its final strip and ignores a trailing cable', () => {
  const wiring = {
    outputs: [
      { id: 'out1', runIds: ['outer', 'inner', 'jump'] },
      { id: 'out2', runIds: ['other'] },
    ],
    runs: [
      { id: 'outer', type: 'strip', source: { stripId: 'outer', from: 0, to: 25 } },
      { id: 'inner', type: 'strip', source: { stripId: 'inner', from: 0, to: 17 } },
      { id: 'jump', type: 'cable' },
      { id: 'other', type: 'strip', source: { stripId: 'other', from: 0, to: 9 } },
    ],
  };
  assert.deepEqual(planOutputPixelCountAdjustment(wiring, { outer: 26, inner: 18, other: 10 }, { outputId: 'out1', delta: -1 }), {
    runId: 'inner', stripId: 'inner', count: 17,
  });
  assert.deepEqual(planOutputPixelCountAdjustment(wiring, { outer: 26, inner: 18, other: 10 }, { outputId: 'out2', delta: 1 }), {
    runId: 'other', stripId: 'other', count: 11,
  });
});

test('output count adjustment refuses an output without a strip and keeps one pixel minimum', () => {
  const wiring = {
    outputs: [{ id: 'out1', runIds: ['reserved', 'jump'] }],
    runs: [{ id: 'reserved', type: 'inactive', count: 3 }, { id: 'jump', type: 'cable' }],
  };
  assert.throws(() => planOutputPixelCountAdjustment(wiring, {}, { outputId: 'out1', delta: 1 }), /no adjustable strip/i);
  const one = {
    outputs: [{ id: 'out1', runIds: ['only'] }],
    runs: [{ id: 'only', type: 'strip', source: { stripId: 'only', from: 0, to: 0 } }],
  };
  assert.throws(() => planOutputPixelCountAdjustment(one, { only: 1 }, { outputId: 'out1', delta: -1 }), /at least one pixel/i);
});

test('inline strip count adjustment targets that exact strip and keeps one pixel minimum', () => {
  const wiring = {
    outputs: [{ id: 'out1', runIds: ['outer', 'inner'] }],
    runs: [
      { id: 'outer', type: 'strip', source: { stripId: 'outer-strip', from: 0, to: 25 } },
      { id: 'inner', type: 'strip', source: { stripId: 'inner-strip', from: 0, to: 17 } },
    ],
  };
  assert.deepEqual(planStripPixelCountAdjustment(wiring, { 'outer-strip': 26, 'inner-strip': 18 }, { runId: 'outer', delta: -1 }), {
    runId: 'outer', stripId: 'outer-strip', count: 25,
  });
  assert.deepEqual(planStripPixelCountAdjustment(wiring, { 'outer-strip': 26, 'inner-strip': 18 }, { runId: 'inner', delta: 1 }), {
    runId: 'inner', stripId: 'inner-strip', count: 19,
  });
  assert.throws(() => planStripPixelCountAdjustment(wiring, { 'outer-strip': 26, 'inner-strip': 1 }, { runId: 'inner', delta: -1 }), /at least one pixel/i);
});

test('syncing compiled wiring keeps the current run active and resends its resized frame', () => {
  let state = createWiringChaseState(compiled);
  state = wiringChaseReducer(state, { type: 'next' });
  const requestId = state.requestId;
  const resized = {
    ...compiled,
    outputs: [{ ...compiled.outputs[0], count: 8 }],
    runs: [{ ...compiled.runs[0], count: 5 }, { ...compiled.runs[1], start: 5, count: 3 }],
  };
  state = wiringChaseReducer(state, { type: 'sync-compiled', compiled: resized });
  assert.equal(state.steps[state.stepIndex].runId, 'run-a');
  assert.equal(state.steps[state.stepIndex].count, 5);
  assert.equal(state.delivery, 'idle');
  assert.equal(state.requestId, requestId + 1);
});

test('state cannot confirm without delivery and requires every output/run fact before completion', () => {
  let state = createWiringChaseState(compiled);
  state = wiringChaseReducer(state, { type: 'confirm-output' });
  assert.equal(state.stepIndex, 0);
  state = wiringChaseReducer(state, { type: 'delivery', response: { ok: true, wsOpen: false } });
  assert.equal(state.delivery, 'failed');
  state = wiringChaseReducer(state, { type: 'retry' });
  state = wiringChaseReducer(state, { type: 'delivery', response: { ok: true, wsOpen: true } });
  state = wiringChaseReducer(state, { type: 'confirm-output' });
  assert.equal(state.stepIndex, 1);
  state = wiringChaseReducer(state, { type: 'delivery', response: { ok: true } });
  state = wiringChaseReducer(state, { type: 'confirm-first-pixel' });
  state = wiringChaseReducer(state, { type: 'confirm-direction' });
  assert.equal(state.stepIndex, 2);
  state = wiringChaseReducer(state, { type: 'previous' });
  assert.equal(state.stepIndex, 1);
  state = wiringChaseReducer(state, { type: 'next' });
  assert.equal(state.stepIndex, 2);
  state = wiringChaseReducer(state, { type: 'delivery', response: { ok: true } });
  state = wiringChaseReducer(state, { type: 'reverse-direction' });
  assert.deepEqual(state.corrections, [{ runId: 'run-b', physicalDirection: 'source-forward' }]);
  assert.equal(state.delivery, 'idle');
  state = wiringChaseReducer(state, { type: 'delivery', response: { ok: true } });
  state = wiringChaseReducer(state, { type: 'confirm-first-pixel' });
  state = wiringChaseReducer(state, { type: 'confirm-direction' });
  assert.equal(state.canComplete, true);
  state = wiringChaseReducer(state, { type: 'complete' });
  assert.equal(state.status, 'complete');
});

test('failed and stale acknowledgements preserve the visible step and verification truth', () => {
  let state = createWiringChaseState(compiled);
  const requestId = state.requestId;
  state = wiringChaseReducer(state, { type: 'delivery', requestId: requestId + 1, response: { ok: true } });
  assert.equal(state.delivery, 'idle');
  state = wiringChaseReducer(state, { type: 'delivery', requestId, response: { ok: false, reason: 'timeout' } });
  assert.equal(state.delivery, 'failed');
  assert.equal(state.stepIndex, 0);
  assert.equal(state.canComplete, false);
  state = wiringChaseReducer(state, { type: 'confirm-output' });
  assert.equal(state.stepIndex, 0);
});

test('direction correction invalidates that run and every downstream confirmation', () => {
  let state = createWiringChaseState(compiled);
  state = wiringChaseReducer(state, { type: 'delivery', requestId: state.requestId, response: { ok: true } });
  state = wiringChaseReducer(state, { type: 'confirm-output' });
  state = wiringChaseReducer(state, { type: 'delivery', requestId: state.requestId, response: { ok: true } });
  state = wiringChaseReducer(state, { type: 'confirm-first-pixel' });
  state = wiringChaseReducer(state, { type: 'confirm-direction' });
  state = wiringChaseReducer(state, { type: 'delivery', requestId: state.requestId, response: { ok: true } });
  state = wiringChaseReducer(state, { type: 'confirm-first-pixel' });
  state = wiringChaseReducer(state, { type: 'confirm-direction' });
  assert.equal(state.canComplete, true);
  state = wiringChaseReducer(state, { type: 'reverse-direction', stepIndex: 1 });
  assert.equal(state.stepIndex, 1);
  assert.deepEqual(state.confirmedRuns, {});
  assert.equal(state.canComplete, false);
  assert.equal(state.delivery, 'idle');
});

test('session acknowledges real delivery, times out, and restores in cancel-then-look order', async () => {
  const order = [];
  let health = null;
  const fakeStream = {
    start() { order.push('start'); },
    push() { order.push('frame'); },
    async stop() { order.push('cancelStream'); },
  };
  const session = createWiringChaseSession({
    host: '192.168.18.70',
    createStream: options => { health = options.onHealth; assert.equal(options.fps, 4); assert.equal(options.host, '192.168.18.70'); return fakeStream; },
    priorLook: { patternId: 'fire' },
    restoreLook: async look => order.push(`restore:${look.patternId}`),
  });
  const delivered = session.show(['1A0000']);
  health({ delivered: true, consecutiveFailures: 0 });
  assert.deepEqual(await delivered, { ok: true });
  await session.stop();
  assert.deepEqual(order, ['start', 'frame', 'cancelStream', 'restore:fire']);

  let timeoutCallback = null;
  const timeoutSession = createWiringChaseSession({
    createStream: () => fakeStream,
    setTimeoutImpl: callback => { timeoutCallback = callback; return 1; },
    clearTimeoutImpl() {},
  });
  const timedOut = timeoutSession.show(['1A0000']);
  timeoutCallback();
  await assert.rejects(timedOut, /1.5 seconds/);
});

test('failure and completion cancel before restore; no confirmed look cancels only', async () => {
  const order = [];
  let health;
  const stream = { start() { order.push('start'); }, push() { order.push('frame'); }, async stop() { order.push('cancelStream'); } };
  const session = createWiringChaseSession({
    createStream: options => { health = options.onHealth; return stream; },
    priorLook: { patternId: 'fire' },
    restoreLook: async look => order.push(`restore:${look.patternId}`),
  });
  const failed = session.show(['1A0000']);
  health({ delivered: false, consecutiveFailures: 1, reason: 'relay-socket-closed' });
  await assert.rejects(failed, /closed|delivery/i);
  assert.deepEqual(order, ['start', 'frame', 'cancelStream', 'restore:fire']);

  order.length = 0;
  let completionHealth;
  const completion = createWiringChaseSession({
    createStream: options => { completionHealth = options.onHealth; return stream; },
    priorLook: { patternId: 'fire' }, restoreLook: async look => order.push(`restore:${look.patternId}`),
  });
  const shown = completion.show(['1A0000']);
  completionHealth({ delivered: true, consecutiveFailures: 0 });
  await shown;
  await completion.complete();
  assert.deepEqual(order, ['start', 'frame', 'cancelStream', 'restore:fire']);

  order.length = 0;
  const bare = createWiringChaseSession({ createStream: () => stream });
  await bare.stop();
  assert.deepEqual(order, ['start', 'cancelStream']);
});

test('session republishes the visible full frame at four frames per second', async () => {
  const frames = [];
  let repeat;
  const session = createWiringChaseSession({
    createStream: () => ({ start() {}, push(frame) { frames.push(frame); }, async stop() {} }),
    setIntervalImpl(callback, delay) { assert.equal(delay, 250); repeat = callback; return 7; },
    clearIntervalImpl() {},
  });
  void session.show(['1A0000']).catch(() => {});
  repeat(); repeat();
  assert.equal(frames.length, 3);
  assert.ok(frames.every(frame => frame.length === 1 && frame[0] === '1A0000'));
  await session.stop();
});

test('session treats wsOpen false as undelivered even when a relay claims delivery', async () => {
  let health;
  const order = [];
  const session = createWiringChaseSession({
    createStream: options => { health = options.onHealth; return { start() {}, push() {}, async stop() { order.push('cancelStream'); } }; },
    priorLook: { patternId: 'fire' }, restoreLook: async () => order.push('restore'),
  });
  const result = session.show(['1A0000']);
  health({ ok: true, delivered: true, wsOpen: false, consecutiveFailures: 0 });
  await assert.rejects(result, /closed/i);
  assert.deepEqual(order, ['cancelStream', 'restore']);
});

test('session fails a pending physical check clearly when another tab takes frame ownership', async () => {
  let health;
  const order = [];
  const session = createWiringChaseSession({
    createStream: options => {
      health = options.onHealth;
      return { start() {}, push() {}, async stop() { order.push('stop-yielded'); } };
    },
    priorLook: { patternId: 'fire' },
    restoreLook: async () => order.push('restore-old-look'),
  });
  const pending = session.show(['00001A', '1A0000']);
  health({ delivered: false, consecutiveFailures: 1, reason: 'stream-superseded' });
  await assert.rejects(pending, /another tab.*took control/i);
  assert.deepEqual(order, ['stop-yielded'], 'superseded session does not overwrite the new owner by restoring its old look');
});

test('Recover lights reclaim ends a pending physical check without restoring its old look', async () => {
  let health;
  const order = [];
  const session = createWiringChaseSession({
    createStream: options => {
      health = options.onHealth;
      return { start() {}, push() {}, async stop() { order.push('stop-reclaimed'); } };
    },
    priorLook: { patternId: 'fire' },
    restoreLook: async () => order.push('restore-old-look'),
  });
  const pending = session.show(['00001A', '1A0000']);
  health({ delivered: false, consecutiveFailures: 1, reason: 'stream-reclaimed' });
  await assert.rejects(pending, /Recover lights/i);
  assert.deepEqual(order, ['stop-reclaimed']);
});
