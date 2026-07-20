import test from 'node:test';
import assert from 'node:assert/strict';

import { compilePattern, normalizePalette, renderPixelFrame } from './frameEngine.js';
import { recipeFromPattern, renderPatternLabRecipeFrame } from './patternLabPatternAdapter.js';
import { parseParamsFromCode } from './patternParams.js';
import { getPatternById } from './patternRegistry.js';

const FIXED_TIME = 137.25;
const FIXED_SEED = 424242;
const FIXED_PALETTE = ['#16002f', '#2962ff', '#00d7b7', '#ffe266'];
const FIXED_LAYOUT = [
  {
    id: 'inner',
    brightness: 0.82,
    speed: 0.75,
    hueShift: 7,
    spacing: 4,
    pts: [
      { x: 20, y: 15, p: 0 },
      { x: 42, y: 9, p: 0.33 },
      { x: 55, y: 32, p: 0.66 },
      { x: 28, y: 44, p: 1 },
    ],
  },
  {
    id: 'outer',
    brightness: 0.64,
    speed: 1.3,
    hueShift: -11,
    spacing: 6,
    pts: [
      { x: 0, y: 0, p: 0 },
      { x: 70, y: 3, p: 0.25 },
      { x: 83, y: 57, p: 0.5 },
      { x: 8, y: 72, p: 0.75 },
      { x: 0, y: 0, p: 1 },
    ],
  },
];

function defaultParams(patternId) {
  const pattern = getPatternById(patternId);
  return Object.fromEntries(parseParamsFromCode(pattern.code).map(param => [param.name, param.value]));
}

function directFrame(patternId, context = {}) {
  return renderPixelFrame({
    t: FIXED_TIME,
    strips: FIXED_LAYOUT,
    patternId,
    params: defaultParams(patternId),
    paletteNorm: normalizePalette(FIXED_PALETTE),
    bpm: 93,
    audioBands: { bass: 0.73, mid: 0.41, hi: 0.19 },
    ...context,
  });
}

function wrappedFrame(patternId, context = {}, params = defaultParams(patternId)) {
  const recipe = recipeFromPattern(patternId, { palette: FIXED_PALETTE });
  recipe.seed = FIXED_SEED;
  recipe.base.params = params;
  return renderPatternLabRecipeFrame(recipe, {
    t: FIXED_TIME,
    strips: FIXED_LAYOUT,
    bpm: 93,
    audioBands: { bass: 0.73, mid: 0.41, hi: 0.19 },
    ...context,
  });
}

function assertLossless(patternId, context = {}, params = defaultParams(patternId)) {
  assert.deepEqual(
    wrappedFrame(patternId, context, params),
    directFrame(patternId, { ...context, params }),
  );
}

test('adapter exports the recipe and frame wrappers', () => {
  assert.equal(typeof recipeFromPattern, 'function');
  assert.equal(typeof renderPatternLabRecipeFrame, 'function');
});

test('recipeFromPattern creates a private recipe with source defaults and provenance', () => {
  const palette = ['#123456', '#abcdef'];
  const source = getPatternById('fire');
  const recipe = recipeFromPattern('fire', { palette });

  assert.notEqual(recipe.id, source.id);
  assert.equal(recipe.name, source.name);
  assert.deepEqual(recipe.base, {
    kind: 'lightweaver-pattern',
    patternId: 'fire',
    params: { scale: 3, rise: 1.5 },
  });
  assert.deepEqual(recipe.palette, palette);
  assert.deepEqual(recipe.provenance, [{ source: 'lightweaver', patternId: 'fire' }]);
  assert.deepEqual(parseParamsFromCode(source.code).map(param => param.value), [3, 1.5]);
});

test('recipeFromPattern rejects unknown source patterns', () => {
  assert.throws(
    () => recipeFromPattern('does-not-exist'),
    { name: 'RangeError', message: 'Unknown pattern: does-not-exist' },
  );
});

test('palette-aware pattern keeps every representative pixel unchanged', () => {
  assertLossless('gradient');
});

test('fixed-color pattern keeps every representative pixel unchanged', () => {
  assertLossless('candle');
});

test('spatial polar pattern keeps every representative pixel unchanged', () => {
  assertLossless('ripple');
});

test('beat-dependent pattern keeps every representative pixel unchanged', () => {
  assertLossless('heartbeat');
});

test('audio-dependent pattern keeps every representative pixel unchanged', () => {
  assertLossless('spectrum');
});

test('per-section pattern assignments and per-strip controls remain unchanged', () => {
  const strips = FIXED_LAYOUT.map((strip, index) => ({
    ...strip,
    patternId: index === 0 ? 'gradient' : 'ripple',
  }));
  const perStripFns = new Map([
    ['gradient', compilePattern('gradient')],
    ['ripple', compilePattern('ripple')],
  ]);
  const patternParamsById = {
    gradient: {},
    ripple: { speed: 2.25, freq: 11 },
  };

  assertLossless('aurora', { strips, perStripFns, patternParamsById });
});

test('custom parameter values keep every representative pixel unchanged', () => {
  assertLossless('fire', {}, { scale: 7.25, rise: 0.85 });
});
