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
} from './wiringChase.js';

const compiled = {
  totalPixels: 8,
  outputs: [{ id: 'out1', name: 'Output A', pin: 16, start: 0, count: 8, runIds: ['run-a', 'run-b'] }],
  runs: [
    { id: 'run-a', type: 'strip', outputId: 'out1', start: 0, count: 4, physicalDirection: 'source-forward' },
    { id: 'run-b', type: 'strip', outputId: 'out1', start: 4, count: 4, physicalDirection: 'source-reverse' },
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

test('full-frame chase stays black off target, marks first pixel, and never exceeds ten percent', () => {
  const frame = buildWiringChaseFrame({ totalPixels: 8, step: buildWiringChaseSteps(compiled)[1] });
  assert.equal(frame.length, 8);
  assert.equal(frame[0], '1A0000');
  assert.ok(frame.slice(1, 4).every(pixel => pixel === '001A00'));
  assert.ok(frame.slice(4).every(pixel => pixel === '000000'));
  for (const pixel of frame) for (const channel of pixel.match(/../g).map(value => parseInt(value, 16))) assert.ok(channel <= CHASE_MAX_CHANNEL);
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
    createStream: options => { health = options.onHealth; assert.equal(options.fps, 4); return fakeStream; },
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
