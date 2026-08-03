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

test('artwork fit still unions the artboard and lands at the padded default zoom', () => {
  const fitViewToBounds = helper('fitViewToBounds');
  // Content well inside the artboard: union with the base viewBox must win,
  // so fit stays at 1 / 1.16 exactly as before the content-only fit existed.
  const fit = fitViewToBounds('0 0 640 400', { x: 200, y: 150, width: 100, height: 60 });

  assert.ok(Math.abs(fit.zoom - 1 / 1.16) < 1e-12, `expected 1/1.16, received ${fit.zoom}`);
  assert.equal(fit.panX, 0);
  assert.equal(fit.panY, 0);
});

test('content-only fit zooms in on a small strip instead of framing the artboard', () => {
  const fitViewToContent = helper('fitViewToContent');
  const layoutViewBox = helper('layoutViewBox');
  const bounds = { x: 400, y: 250, width: 200, height: 120 };
  const fit = fitViewToContent('0 0 640 400', bounds);
  const visible = layoutViewBox('0 0 640 400', fit);

  // 640 / (200 * 1.5) = 2.133… — the strip fills ~67% of the viewport width.
  assert.ok(Math.abs(fit.zoom - 640 / 300) < 1e-12, `expected 640/300, received ${fit.zoom}`);
  // View centres on the content, and the whole strip stays inside the view.
  assert.ok(Math.abs((visible.x + visible.width / 2) - 500) < 1e-9, 'expected horizontal centring');
  assert.ok(Math.abs((visible.y + visible.height / 2) - 310) < 1e-9, 'expected vertical centring');
  assert.ok(visible.x < bounds.x && visible.x + visible.width > bounds.x + bounds.width, 'expected side padding');
  assert.ok(visible.y < bounds.y && visible.y + visible.height > bounds.y + bounds.height, 'expected vertical padding');
  const fillRatio = (bounds.width * fit.zoom) / 640;
  assert.ok(fillRatio > 0.6 && fillRatio < 0.7, `expected ~60-70% fill, received ${fillRatio}`);
});

test('content-only fit caps zoom so a tiny strip never fills the screen', () => {
  const fitViewToContent = helper('fitViewToContent');
  const fit = fitViewToContent('0 0 640 400', { x: 100, y: 100, width: 5, height: 2 });

  // Uncapped this would be 640 / 7.5 ≈ 85×; the fit cap holds it at 400%.
  assert.equal(fit.zoom, 4);
});

test('stripContentBounds unions pixels across strips and applies drag offsets', () => {
  const stripContentBounds = helper('stripContentBounds');
  const bounds = stripContentBounds([
    { x: 10, y: -5, pixels: [{ x: 0, y: 0 }, { x: 90, y: 30 }] },
    { pixels: [{ x: 300, y: 200 }] },
    { pixels: [] },                       // strip with no pixels is ignored
    { pixels: [{ x: NaN, y: 4 }] },       // non-finite coords are ignored
  ]);

  assert.deepEqual(bounds, { x: 10, y: -5, width: 290, height: 205 });
});

test('stripContentBounds returns null when there is nothing to measure', () => {
  const stripContentBounds = helper('stripContentBounds');
  assert.equal(stripContentBounds([]), null);
  assert.equal(stripContentBounds(null), null);
  assert.equal(stripContentBounds([{ pixels: [] }, { pixels: [{ x: NaN, y: NaN }] }]), null);
});

test('empty content falls back to the artboard fit', () => {
  const fitViewToBounds = helper('fitViewToBounds');
  // The hook falls back to fitViewToBounds with a null getBBox result when
  // stripContentBounds finds nothing — that must still frame the artboard.
  const fit = fitViewToBounds('0 0 640 400', null);

  assert.ok(Math.abs(fit.zoom - 1 / 1.16) < 1e-12, `expected 1/1.16, received ${fit.zoom}`);
  assert.equal(fit.panX, 0);
  assert.equal(fit.panY, 0);
});
