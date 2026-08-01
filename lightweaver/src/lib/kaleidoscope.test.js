import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileKaleidoscopePixelContext,
  createDefaultKaleidoscope,
  deriveReflectionPixelContext,
  deriveReflectionPointIndices,
  normalizeKaleidoscope,
  nudgeKaleidoscopePoint,
  nudgeKaleidoscopeStart,
  reprojectKaleidoscope,
  reprojectStripKaleidoscope,
  reverseKaleidoscope,
  setKaleidoscopePointCount,
  validateKaleidoscope,
} from './kaleidoscope.js';

test('derives exact evenly and unevenly divided point sets', () => {
  assert.deepEqual(deriveReflectionPointIndices(createDefaultKaleidoscope(400), 400), [0, 100, 200, 300]);
  assert.deepEqual(deriveReflectionPointIndices(setKaleidoscopePointCount(createDefaultKaleidoscope(400), 400, 6), 400), [0, 67, 133, 200, 267, 333]);
  assert.deepEqual(deriveReflectionPointIndices(setKaleidoscopePointCount(createDefaultKaleidoscope(400), 400, 8), 400), [0, 50, 100, 150, 200, 250, 300, 350]);
});

test('strip count changes reproject metadata while geometry-only edits leave points alone', () => {
  const strip = {
    id: 'strip-1',
    pixelCount: 400,
    x: 5,
    kaleidoscope: createDefaultKaleidoscope(400),
  };
  const unchanged = reprojectStripKaleidoscope(strip, 400);
  assert.equal(unchanged.strip, strip);
  assert.deepEqual(unchanged.resetPointIndices, []);

  const resized = reprojectStripKaleidoscope(strip, 453);
  assert.equal(resized.strip.pixelCount, 453);
  assert.deepEqual(deriveReflectionPointIndices(resized.strip.kaleidoscope, 453), [0, 113, 227, 340]);
  assert.deepEqual(resized.resetPointIndices, []);
  assert.equal(resized.strip.x, 5);
});

test('wraps and rotates every automatic point without changing offsets', () => {
  const mapping = { enabled: true, pointCount: 4, startLed: 11, offsets: [0, 1, 0, -1] };
  const moved = nudgeKaleidoscopeStart(mapping, 12, 2);
  assert.deepEqual(moved, { enabled: true, pointCount: 4, startLed: 1, offsets: [0, 1, 0, -1] });
  assert.deepEqual(deriveReflectionPointIndices(moved, 12), [1, 5, 7, 9]);
});

test('fine tuning changes one point and rejects collision or crossing', () => {
  const mapping = createDefaultKaleidoscope(12);
  const moved = nudgeKaleidoscopePoint(mapping, 12, 1, 1);
  assert.equal(moved.ok, true);
  assert.deepEqual(deriveReflectionPointIndices(moved.value, 12), [0, 4, 6, 9]);
  const collision = nudgeKaleidoscopePoint(mapping, 12, 1, -3);
  assert.equal(collision.ok, false);
  assert.match(collision.error.message, /neighbor/i);
  assert.deepEqual(mapping.offsets, [0, 0, 0, 0]);
});

test('validates exact compact data and disables malformed enabled data', () => {
  assert.equal(validateKaleidoscope(null, 12).ok, true);
  assert.equal(validateKaleidoscope({ enabled: false }, 12).value, null);
  for (const value of [
    { enabled: true, pointCount: 1, startLed: 0, offsets: [0] },
    { enabled: true, pointCount: 4.5, startLed: 0, offsets: [0, 0, 0, 0] },
    { enabled: true, pointCount: 4, startLed: 12, offsets: [0, 0, 0, 0] },
    { enabled: true, pointCount: 4, startLed: 0, offsets: [0, 0, 0] },
    { enabled: true, pointCount: 4, startLed: 0, offsets: [0, 3, -3, 0] },
  ]) assert.equal(normalizeKaleidoscope(value, 12).enabled, false);
  assert.throws(() => createDefaultKaleidoscope(1), /at least 2/i);
});

test('reverse and count reprojection preserve calibrated physical point identity', () => {
  const mapping = { enabled: true, pointCount: 4, startLed: 1, offsets: [0, 0, 1, -1] };
  const oldPoints = deriveReflectionPointIndices(mapping, 12);
  const reversed = reverseKaleidoscope(mapping, 12);
  assert.equal(reversed.startLed, 10);
  assert.deepEqual(
    [...deriveReflectionPointIndices(reversed, 12)].sort((a, b) => a - b),
    oldPoints.map(index => 11 - index).sort((a, b) => a - b),
  );
  const projected = reprojectKaleidoscope(createDefaultKaleidoscope(400, 100), 400, 453);
  assert.equal(projected.value.startLed, 113);
  assert.equal(deriveReflectionPointIndices(projected.value, 453).length, 4);
  assert.deepEqual(projected.resetPointIndices, []);
});

test('reprojection preserves reconcilable offsets and resets only rounded collisions', () => {
  const preserved = { enabled: true, pointCount: 4, startLed: 0, offsets: [0, 1, 0, 0] };
  const grown = reprojectKaleidoscope(preserved, 12, 13);
  assert.deepEqual(grown.resetPointIndices, []);
  assert.deepEqual(grown.value.offsets, [0, 1, 0, 0]);

  const colliding = { enabled: true, pointCount: 4, startLed: 0, offsets: [0, -2, 0, 0] };
  const shrunk = reprojectKaleidoscope(colliding, 12, 4);
  assert.deepEqual(shrunk.resetPointIndices, [1]);
  assert.deepEqual(shrunk.value.offsets, [0, 0, 0, 0]);
});

test('compiled context builds a direct pixel lookup once for every source LED', () => {
  const compiled = compileKaleidoscopePixelContext(createDefaultKaleidoscope(8), 8);
  assert.equal(compiled.pixelContexts.length, 8);
  assert.deepEqual(compiled.pixelContexts[3], deriveReflectionPixelContext(compiled, 3));
  assert.equal(compiled.pixelContexts[3], deriveReflectionPixelContext(compiled, 3));
});

test('derives deterministic folded progress, proximity, intervals, and boundary ties', () => {
  const normalized = normalizeKaleidoscope(createDefaultKaleidoscope(12), 12);
  const context = { pixelCount: 12, points: normalized.points };
  assert.deepEqual(deriveReflectionPixelContext(context, 0), {
    reflectionProgress: 0,
    kaleidoscopeProgress: 0,
    reflectionDistance: 0,
    reflectionSegment: 0,
    reflectionPoint: 0,
    isReflectionPoint: true,
  });
  assert.deepEqual(deriveReflectionPixelContext(context, 3), {
    reflectionProgress: 0,
    kaleidoscopeProgress: 1,
    reflectionDistance: 0,
    reflectionSegment: 1,
    reflectionPoint: 1,
    isReflectionPoint: true,
  });
  const middle = deriveReflectionPixelContext(context, 1);
  assert.equal(middle.reflectionSegment, 0);
  assert.equal(middle.reflectionProgress, 1 / 3);
  assert.equal(middle.kaleidoscopeProgress, 1 / 3);
  assert.equal(middle.reflectionPoint, 0);
  assert.equal(middle.isReflectionPoint, false);
});
