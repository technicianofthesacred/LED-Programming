import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adjustPaletteStops,
  applyIncandescentCooling,
  applyPatternLabTransform,
  migratePaletteStops,
  reorderPaletteStops,
  resolvePatternLabCoordinate,
  rotatePaletteStops,
  samplePaletteStops,
  samplePatternLabMask,
} from './patternLabTransforms.js';

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

function closePoint(actual, expected, epsilon = 1e-9) {
  closeTo(actual.x, expected.x, epsilon);
  closeTo(actual.y, expected.y, epsilon);
}

function rgbSaturation({ r, g, b }) {
  const channels = [r, g, b].map(channel => channel / 255);
  const maximum = Math.max(...channels);
  const minimum = Math.min(...channels);
  const lightness = (maximum + minimum) / 2;
  if (maximum === minimum) return 0;
  return (maximum - minimum) / (lightness > 0.5 ? 2 - maximum - minimum : maximum + minimum);
}

const STOPS = [
  { id: 'coal', position: 0, color: '#000000' },
  { id: 'ember', position: 0.3, color: '#ff0000' },
  { id: 'white', position: 1, color: '#ffffff' },
];

test('transform module exposes the complete bounded helper surface', () => {
  for (const helper of [
    adjustPaletteStops,
    applyIncandescentCooling,
    applyPatternLabTransform,
    migratePaletteStops,
    reorderPaletteStops,
    resolvePatternLabCoordinate,
    rotatePaletteStops,
    samplePaletteStops,
    samplePatternLabMask,
  ]) assert.equal(typeof helper, 'function');
});

test('mirror folds coordinates across horizontal, vertical, or both center axes', () => {
  closePoint(applyPatternLabTransform({ x: 0.8, y: 0.7 }, { kind: 'mirror', axis: 'x' }), { x: 0.2, y: 0.7 });
  closePoint(applyPatternLabTransform({ x: 0.8, y: 0.7 }, { kind: 'mirror', axis: 'y' }), { x: 0.8, y: 0.3 });
  closePoint(applyPatternLabTransform({ x: 0.8, y: 0.7 }, { kind: 'mirror', axis: 'both' }), { x: 0.2, y: 0.3 });
  closePoint(
    applyPatternLabTransform(
      { x: 0.7, y: 0.8 },
      { kind: 'mirror', axis: 'both', center: { x: 0.4, y: 0.6 } },
    ),
    { x: 0.1, y: 0.4 },
  );
});

test('repeat and fold produce deterministic tiled coordinates', () => {
  closePoint(
    applyPatternLabTransform({ x: 0.4, y: 0.7 }, { kind: 'repeat', axis: 'x', count: 3, phase: 0.1 }),
    { x: 0.3, y: 0.7 },
  );
  closePoint(
    applyPatternLabTransform({ x: 0.75, y: 0.4 }, { kind: 'fold', axis: 'x', count: 1 }),
    { x: 0.5, y: 0.4 },
  );
});

test('rotate and radius-weighted twist pivot around a normalized center', () => {
  closePoint(
    applyPatternLabTransform({ x: 0.75, y: 0.5 }, { kind: 'rotate', degrees: 90 }),
    { x: 0.5, y: 0.75 },
  );
  closePoint(
    applyPatternLabTransform({ x: 1, y: 0.5 }, { kind: 'twist', turns: 1 }),
    { x: 0, y: 0.5 },
  );
});

test('kaleidoscope mirrors every angular sector into the first half-wedge', () => {
  const radius = 0.25;
  const point = {
    x: 0.5 + Math.cos(3 * Math.PI / 4) * radius,
    y: 0.5 + Math.sin(3 * Math.PI / 4) * radius,
  };
  const expected = {
    x: 0.5 + Math.cos(Math.PI / 4) * radius,
    y: 0.5 + Math.sin(Math.PI / 4) * radius,
  };
  closePoint(applyPatternLabTransform(point, { kind: 'kaleidoscope', slices: 4 }), expected);
});

test('coordinate resolver covers strip, global, and polar spaces with direction and phase', () => {
  const point = { x: 1, y: 1, stripProgress: 0.2 };
  closeTo(resolvePatternLabCoordinate(point, { space: 'strip-progress', direction: 'reverse', phase: 0.1 }), 0.9);
  closeTo(resolvePatternLabCoordinate(point, { space: 'x' }), 1);
  closeTo(resolvePatternLabCoordinate(point, { space: 'y', direction: -1, phase: 0.1 }), 0.1);
  closeTo(resolvePatternLabCoordinate(point, { space: 'radius' }), 1);
  closeTo(resolvePatternLabCoordinate({ x: 0.5, y: 1 }, { space: 'angle' }), 0.25);
});

test('linear and radial masks have bounded hard cores and soft edges', () => {
  assert.equal(samplePatternLabMask(
    { kind: 'linear', angle: 0, offset: 0.5, width: 0.25, softness: 0.1 },
    { x: 0.5, y: 0.2 },
  ), 1);
  assert.equal(samplePatternLabMask(
    { kind: 'linear', angle: 0, offset: 0.5, width: 0.25, softness: 0.1 },
    { x: 0.75, y: 0.2 },
  ), 0);
  assert.equal(samplePatternLabMask(
    { kind: 'radial', center: { x: 0.5, y: 0.5 }, radius: 0.4, softness: 0.1 },
    { x: 0.5, y: 0.5 },
  ), 1);
  assert.equal(samplePatternLabMask(
    { kind: 'radial', center: { x: 0.5, y: 0.5 }, radius: 0.4, softness: 0.1 },
    { x: 0.9, y: 0.5 },
  ), 0);
});

test('anchor and path masks resolve named anchors and shortest segment distance', () => {
  const anchorMask = { kind: 'anchor', anchorId: 'focus', radius: 0.2, softness: 0.05 };
  const coordinates = { x: 0.25, y: 0.25, anchors: { focus: { x: 0.25, y: 0.25 } } };
  assert.equal(samplePatternLabMask(anchorMask, coordinates), 1);

  const pathMask = {
    kind: 'path',
    path: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    width: 0.1,
    softness: 0.05,
  };
  assert.equal(samplePatternLabMask(pathMask, { x: 0.5, y: 0 }), 1);
  assert.equal(samplePatternLabMask(pathMask, { x: 0.5, y: 0.1 }), 0);
});

test('palette stops reorder without mutation and retain their position slots', () => {
  const reordered = reorderPaletteStops(STOPS, 0, 2);
  assert.deepEqual(reordered.map(stop => stop.id), ['ember', 'white', 'coal']);
  assert.deepEqual(reordered.map(stop => stop.position), [0, 0.3, 1]);
  assert.deepEqual(STOPS.map(stop => stop.id), ['coal', 'ember', 'white']);
});

test('palette sampling supports smooth, stepped, and quantized banded interpolation', () => {
  const ramp = [{ position: 0, color: '#000000' }, { position: 1, color: '#ffffff' }];
  assert.deepEqual(samplePaletteStops(ramp, 0.25, { interpolation: 'smooth' }), { r: 64, g: 64, b: 64 });
  assert.deepEqual(samplePaletteStops(ramp, 0.75, { interpolation: 'stepped' }), { r: 0, g: 0, b: 0 });
  assert.deepEqual(samplePaletteStops(ramp, 0.49, { interpolation: 'banded', bands: 4 }), { r: 85, g: 85, b: 85 });
});

test('palette rotation and migration preserve positions while moving color order', () => {
  const rotated = rotatePaletteStops(STOPS, 1);
  assert.deepEqual(rotated.map(stop => stop.id), ['white', 'coal', 'ember']);
  assert.deepEqual(rotated.map(stop => stop.position), [0, 0.3, 1]);

  const migrated = migratePaletteStops(STOPS, 0.5);
  assert.deepEqual(migrated.map(stop => stop.color), [
    { r: 128, g: 0, b: 0 },
    { r: 255, g: 128, b: 128 },
    { r: 128, g: 128, b: 128 },
  ]);
  assert.deepEqual(migrated.map(stop => stop.position), [0, 0.3, 1]);
});

test('warmth and saturation adjustment stays inside declared and RGB bounds', () => {
  const adjusted = adjustPaletteStops(
    [{ position: 0, color: '#3366ff' }],
    { warmth: 99, saturation: 99, saturationBounds: [0.2, 0.7] },
  );
  const [{ color }] = adjusted;
  for (const channel of Object.values(color)) assert.ok(channel >= 0 && channel <= 255);
  assert.ok(rgbSaturation(color) >= 0.2 && rgbSaturation(color) <= 0.7);
  assert.ok(color.r > 0);
  assert.ok(color.b < 255);
});

test('incandescent cooling preserves full intensity and warms lower intensities', () => {
  assert.deepEqual(applyIncandescentCooling({ r: 255, g: 255, b: 255 }, 1), { r: 255, g: 255, b: 255 });
  assert.deepEqual(applyIncandescentCooling({ r: 255, g: 255, b: 255 }, 0.5), { r: 128, g: 99, b: 77 });
  assert.deepEqual(applyIncandescentCooling({ r: 255, g: 255, b: 255 }, 0), { r: 0, g: 0, b: 0 });
});
