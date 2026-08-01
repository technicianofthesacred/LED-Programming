import test from 'node:test';
import assert from 'node:assert/strict';

import { remapFrameToWiring } from './export.js';
import { compactPatternLabWorkerGeometry } from './patternLabWorkerProtocol.js';
import { recipeFromPattern, renderPatternLabRecipeFrame } from './patternLabPatternAdapter.js';
import { normalizeProjectRenderStrips } from './renderGeometry.js';
import { createConnectedSpatialTemplate } from './showSpatialTemplate.js';

const strip = {
  id: 'ring', pixelCount: 8, speed: 1, brightness: 1, hueShift: 0,
  pixels: Array.from({ length: 8 }, (_, index) => ({ x: index, y: index % 2 })),
  kaleidoscope: { enabled: true, pointCount: 4, startLed: 0, offsets: [0, 0, 0, 0] },
};

function contexts(points) {
  return points.map(point => ({
    reflectionProgress: point.reflectionProgress,
    kaleidoscopeProgress: point.kaleidoscopeProgress,
    reflectionDistance: point.reflectionDistance,
    reflectionSegment: point.reflectionSegment,
    reflectionPoint: point.reflectionPoint,
    isReflectionPoint: point.isReflectionPoint,
  }));
}

test('main, PatternPreview geometry, worker geometry, Show and physical remap share exact source-local semantics', () => {
  const [browser] = normalizeProjectRenderStrips([strip]);
  const expected = contexts(browser.pts);
  const worker = compactPatternLabWorkerGeometry({ strips: [strip] });
  const workerContexts = Array.from({ length: 8 }, (_, index) => ({
    reflectionProgress: worker.reflectionProgress[index],
    kaleidoscopeProgress: worker.kaleidoscopeProgress[index],
    reflectionDistance: worker.reflectionDistance[index],
    reflectionSegment: worker.reflectionSegment[index],
    reflectionPoint: worker.reflectionPoint[index] < 0 ? null : worker.reflectionPoint[index],
    isReflectionPoint: worker.reflectionFlags[index] === 1,
  }));
  assert.deepEqual(workerContexts, expected);

  const show = createConnectedSpatialTemplate({ strips: [strip] });
  assert.deepEqual(contexts(show), expected);
  assert.deepEqual(show.map(sample => sample.stripProgress), browser.pts.map(point => point.kaleidoscopeProgress));

  const frame = browser.pts.map((point, index) => ({ r: Math.round(point.kaleidoscopeProgress * 255), g: index, b: 0 }));
  const compiledWiring = { pixels: Array.from({ length: 8 }, (_, index) => ({ stripId: 'ring', sourceLed: 7 - index })) };
  assert.deepEqual(remapFrameToWiring(frame, compiledWiring, [strip]), [...frame].reverse());
});

test('Pattern Lab base and multiple layers receive the identical compiled reflection geometry', () => {
  const recipe = recipeFromPattern('meteor', { palette: ['#000000', '#ff0000'] });
  recipe.base.params = { speed: 1, tailLen: 0.8 };
  recipe.layers = [
    { generator: { kind: 'lightweaver-pattern', patternId: 'scanner', params: { width: 0.4, hue: 0.1 } }, opacity: 0.4, blendMode: 'screen', mask: { kind: 'none' } },
    { generator: { kind: 'lightweaver-pattern', patternId: 'neon', params: { rate: 3 } }, opacity: 0.3, blendMode: 'multiply', mask: { kind: 'none' } },
  ];
  const context = { t: 0.37, strips: [strip], bpm: 120 };
  const first = renderPatternLabRecipeFrame(recipe, context);
  const second = renderPatternLabRecipeFrame(recipe, context);
  assert.deepEqual(first, second);
  assert.equal(first.pixels.length, 8);
  assert.deepEqual(first.stripFrames[0].leds.map(led => led.x), strip.pixels.map(pixel => pixel.x));
});
