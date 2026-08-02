import test from 'node:test';
import assert from 'node:assert/strict';
import * as viewport from './layoutGeometry.js';

const SVG_UNITS_PER_MM = 3.7795;
const FIVE_METRES_MM = 5000;
const FIVE_METRES_SVG_UNITS = FIVE_METRES_MM * SVG_UNITS_PER_MM;

function helper(name) {
  assert.equal(typeof viewport[name], 'function', `${name} must be exported`);
  return viewport[name];
}

test('zoom can travel below the former 15% product cap', () => {
  const zoomBy = helper('zoomBy');
  assert.equal(zoomBy(0.15, 0.1), 0.015);
});

test('zoom can travel above the former 4000% product cap', () => {
  const zoomBy = helper('zoomBy');
  assert.equal(zoomBy(40, 2), 80);
});

test('trackpad wheel zoom responds gently to small pixel deltas', () => {
  const wheelZoomFactor = helper('wheelZoomFactor');
  const factor = wheelZoomFactor(-4);

  assert.ok(factor > 1, `expected zoom in, received ${factor}`);
  assert.ok(factor < 1.01, `expected a sub-1% step, received ${factor}`);
});

test('accelerated wheel zoom is capped to a gentle per-event step', () => {
  const wheelZoomFactor = helper('wheelZoomFactor');
  const accelerated = wheelZoomFactor(-600);

  assert.equal(accelerated, wheelZoomFactor(-60));
  assert.ok(accelerated < 1.06, `expected a step below 6%, received ${accelerated}`);
});

test('line and page wheel deltas share the same acceleration cap', () => {
  const wheelZoomFactor = helper('wheelZoomFactor');

  assert.equal(wheelZoomFactor(-4, 1), wheelZoomFactor(-60, 0));
  assert.equal(wheelZoomFactor(-1, 2), wheelZoomFactor(-60, 0));
});

test('wheel zoom keeps matching in and out deltas reciprocal', () => {
  const wheelZoomFactor = helper('wheelZoomFactor');
  assert.ok(Math.abs(wheelZoomFactor(-30) * wheelZoomFactor(30) - 1) < 1e-12);
});

test('fit all frames a five-metre strip extending beyond the artwork viewBox', () => {
  const fitViewToBounds = helper('fitViewToBounds');
  const layoutViewBox = helper('layoutViewBox');
  const baseViewBox = '0 0 640 400';
  const fit = fitViewToBounds(baseViewBox, {
    x: 0,
    y: 0,
    width: FIVE_METRES_SVG_UNITS,
    height: 400,
  });
  const visible = layoutViewBox(baseViewBox, fit);

  assert.ok(fit.zoom < 0.15, `expected fit below 15%, received ${fit.zoom}`);
  assert.ok(visible.x < 0, `expected left padding, received x=${visible.x}`);
  assert.ok(visible.y < 0, `expected top padding, received y=${visible.y}`);
  assert.ok(
    visible.x + visible.width > FIVE_METRES_SVG_UNITS,
    'expected the complete calibrated five-metre strip plus right padding',
  );
  assert.ok(visible.y + visible.height > 400, 'expected artwork plus bottom padding');
});
