import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PATTERN_LAB_WORKER_BUDGETS,
  PATTERN_LAB_WORKER_REPLY_TYPES,
  PATTERN_LAB_WORKER_REQUEST_TYPES,
  clampPatternLabWorkerSampleCount,
  createPatternLabWorkerReply,
  createPatternLabWorkerRequestSequencer,
  quantizePatternLabWorkerTime,
  shouldAcceptPatternLabWorkerReply,
  validatePatternLabWorkerRenderRequest,
} from './patternLabWorkerProtocol.js';

test('protocol exposes the exact request and reply vocabulary', () => {
  assert.deepEqual(PATTERN_LAB_WORKER_REQUEST_TYPES, ['initialize', 'render', 'cancel', 'dispose']);
  assert.deepEqual(PATTERN_LAB_WORKER_REPLY_TYPES, ['ready', 'frame', 'warning', 'error', 'stats']);
  assert.ok(Object.isFrozen(PATTERN_LAB_WORKER_REQUEST_TYPES));
  assert.ok(Object.isFrozen(PATTERN_LAB_WORKER_REPLY_TYPES));
});

test('request sequencer emits strictly increasing IDs for every request type', () => {
  const requests = createPatternLabWorkerRequestSequencer(7);
  assert.deepEqual(requests.next('initialize', { session: 'a' }), {
    type: 'initialize', requestId: 8, payload: { session: 'a' },
  });
  assert.deepEqual(requests.next('render'), { type: 'render', requestId: 9, payload: {} });
  assert.deepEqual(requests.next('cancel', { targetRequestId: 9 }), {
    type: 'cancel', requestId: 10, payload: { targetRequestId: 9 },
  });
  assert.deepEqual(requests.next('dispose'), { type: 'dispose', requestId: 11, payload: {} });
  assert.equal(requests.current(), 11);
});

test('request sequencer rejects unknown messages and unsafe starting IDs', () => {
  assert.throws(() => createPatternLabWorkerRequestSequencer(-1), RangeError);
  assert.throws(() => createPatternLabWorkerRequestSequencer(Number.MAX_SAFE_INTEGER), RangeError);
  assert.throws(() => createPatternLabWorkerRequestSequencer().next('unknown'), RangeError);
});

test('reply creation validates vocabulary and request identity', () => {
  assert.deepEqual(createPatternLabWorkerReply('ready', 3, { initialized: true }), {
    type: 'ready', requestId: 3, payload: { initialized: true },
  });
  assert.throws(() => createPatternLabWorkerReply('unknown', 3), RangeError);
  assert.throws(() => createPatternLabWorkerReply('frame', 0), RangeError);
});

test('stale and malformed worker replies are ignored', () => {
  assert.equal(shouldAcceptPatternLabWorkerReply({ type: 'frame', requestId: 12 }, 12), true);
  assert.equal(shouldAcceptPatternLabWorkerReply({ type: 'warning', requestId: 11 }, 12), false);
  assert.equal(shouldAcceptPatternLabWorkerReply({ type: 'unknown', requestId: 12 }, 12), false);
  assert.equal(shouldAcceptPatternLabWorkerReply(null, 12), false);
});

test('worker budgets encode the bounded Task 7 limits', () => {
  assert.deepEqual(PATTERN_LAB_WORKER_BUDGETS, {
    maxLayers: 3,
    previewSamples: 384,
    finalSamples: 1024,
    previewFps: 24,
    maxFrameBytes: 3072,
    maxAllocationBytes: 4 * 1024 * 1024,
    renderWarningMs: 40,
    exportWarningMs: 250,
  });
  assert.ok(Object.isFrozen(PATTERN_LAB_WORKER_BUDGETS));
});

test('sample counts clamp by preview or final render mode', () => {
  assert.equal(clampPatternLabWorkerSampleCount(900, 'preview'), 384);
  assert.equal(clampPatternLabWorkerSampleCount(900, 'final'), 900);
  assert.equal(clampPatternLabWorkerSampleCount(5000, 'export'), 1024);
  assert.equal(clampPatternLabWorkerSampleCount(0, 'preview'), 1);
});

test('preview time is quantized to the 24 fps budget while final and export times stay exact', () => {
  assert.equal(quantizePatternLabWorkerTime(1.039, 'preview'), 1);
  assert.equal(quantizePatternLabWorkerTime(1.05, 'preview'), 25 / 24);
  assert.equal(quantizePatternLabWorkerTime(1.049, 'final'), 1.049);
  assert.equal(quantizePatternLabWorkerTime(1.049, 'export'), 1.049);
});

test('render validation rejects layer and typed-allocation overflow', () => {
  assert.deepEqual(validatePatternLabWorkerRenderRequest({
    mode: 'preview', sampleCount: 300, layerCount: 3, allocationBytes: 4096,
  }), { mode: 'preview', sampleCount: 300, layerCount: 3, allocationBytes: 4096 });
  assert.throws(
    () => validatePatternLabWorkerRenderRequest({ mode: 'preview', sampleCount: 10, layerCount: 4 }),
    { name: 'RangeError', message: 'Pattern Lab worker supports at most 3 layers' },
  );
  assert.throws(
    () => validatePatternLabWorkerRenderRequest({
      mode: 'final', sampleCount: 10, layerCount: 0, allocationBytes: 4 * 1024 * 1024 + 1,
    }),
    { name: 'RangeError', message: 'Pattern Lab worker allocation exceeds 4194304 bytes' },
  );
});
