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
