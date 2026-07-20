import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PATTERN_LAB_BLEND_MODES,
  blendPatternLabColors,
  compositePatternLabLayers,
} from './patternLabCompositor.js';

const BACKDROP = { r: 100, g: 150, b: 200 };
const SOURCE = { r: 200, g: 100, b: 50 };

test('compositor exposes exactly the six approved blend modes', () => {
  assert.deepEqual(PATTERN_LAB_BLEND_MODES, ['normal', 'add', 'screen', 'multiply', 'lighten', 'mask']);
});

test('normal, add, screen, multiply, and lighten use clamped RGB channel math', () => {
  assert.deepEqual(blendPatternLabColors(BACKDROP, SOURCE, 'normal'), { r: 200, g: 100, b: 50 });
  assert.deepEqual(blendPatternLabColors(BACKDROP, SOURCE, 'add'), { r: 255, g: 250, b: 250 });
  assert.deepEqual(blendPatternLabColors(BACKDROP, SOURCE, 'screen'), { r: 222, g: 191, b: 211 });
  assert.deepEqual(blendPatternLabColors(BACKDROP, SOURCE, 'multiply'), { r: 78, g: 59, b: 39 });
  assert.deepEqual(blendPatternLabColors(BACKDROP, SOURCE, 'lighten'), { r: 200, g: 150, b: 200 });
  assert.deepEqual(
    blendPatternLabColors({ r: -20, g: 400, b: 40 }, { r: 300, g: -10, b: 500 }, 'add'),
    { r: 255, g: 255, b: 255 },
  );
});

test('mask multiplies the backdrop by clamped source luminance', () => {
  assert.deepEqual(blendPatternLabColors(BACKDROP, SOURCE, 'mask'), { r: 46, g: 69, b: 92 });
  assert.deepEqual(blendPatternLabColors(BACKDROP, { r: 255, g: 255, b: 255 }, 'mask'), BACKDROP);
  assert.deepEqual(blendPatternLabColors(BACKDROP, { r: 0, g: 0, b: 0 }, 'mask'), { r: 0, g: 0, b: 0 });
});

test('opacity is clamped and mixes the backdrop with the selected blend result', () => {
  assert.deepEqual(blendPatternLabColors(BACKDROP, SOURCE, 'normal', 0.5), { r: 150, g: 125, b: 125 });
  assert.deepEqual(blendPatternLabColors(BACKDROP, SOURCE, 'normal', -2), BACKDROP);
  assert.deepEqual(blendPatternLabColors(BACKDROP, SOURCE, 'normal', 8), SOURCE);
});

test('ordered layers composite without mutating their source records', () => {
  const layers = [
    { id: 'base', color: { r: 100, g: 20, b: 0 }, blendMode: 'normal', opacity: 1 },
    { id: 'glow', color: { r: 20, g: 40, b: 60 }, blendMode: 'add', opacity: 0.5 },
  ];
  const snapshot = structuredClone(layers);

  assert.deepEqual(compositePatternLabLayers(layers), { r: 110, g: 40, b: 30 });
  assert.deepEqual(layers, snapshot);
});

test('the compositor rejects a fourth layer instead of silently dropping it', () => {
  const layers = Array.from({ length: 4 }, (_, index) => ({
    id: `layer-${index}`,
    color: { r: index, g: index, b: index },
  }));
  assert.throws(
    () => compositePatternLabLayers(layers),
    { name: 'RangeError', message: 'Pattern Lab supports at most 3 layers' },
  );
});

test('unknown blend modes are rejected rather than substituted', () => {
  assert.throws(
    () => blendPatternLabColors(BACKDROP, SOURCE, 'overlay'),
    { name: 'RangeError', message: 'Unsupported Pattern Lab blend mode: overlay' },
  );
});
