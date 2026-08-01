import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPixelFrame } from './frameEngine.js';
import { compile } from './patterns.js';
import { normalizeProjectRenderStrips } from './renderGeometry.js';

const strip = {
  id: 'frame',
  pixelCount: 12,
  speed: 1,
  brightness: 1,
  hueShift: 0,
  pixels: Array.from({ length: 12 }, (_, index) => ({ x: index * 2, y: 7 })),
  kaleidoscope: { enabled: true, pointCount: 4, startLed: 0, offsets: [0, 0, 0, 0] },
};

test('normalizes project strips once without changing spatial coordinates', () => {
  const [renderStrip] = normalizeProjectRenderStrips([strip]);
  assert.equal(renderStrip.pts.length, 12);
  assert.deepEqual(renderStrip.pts.map(({ x, y }) => ({ x, y })), strip.pixels);
  assert.equal(renderStrip.pts[0].isReflectionPoint, true);
  assert.equal(renderStrip.pts[3].reflectionSegment, 1);
  assert.equal(renderStrip.pts[3].kaleidoscopeProgress, 1);
  assert.equal(renderStrip.pts[4].reflectionProgress, 1 / 3);
  assert.ok(Math.abs(renderStrip.pts[4].kaleidoscopeProgress - 2 / 3) < 1e-12);
  assert.equal(renderStrip.kaleidoscopeContext.points, renderStrip.pts[0].kaleidoscopePoints);
  assert.equal(renderStrip.kaleidoscopeContext.pixelContexts.length, 12);
});

test('missing or disabled data preserves ordinary source progress and hidden filtering', () => {
  const plain = { ...strip, id: 'plain', kaleidoscope: undefined };
  assert.deepEqual(normalizeProjectRenderStrips([plain], { hidden: { plain: true } }), []);
  const [included] = normalizeProjectRenderStrips([plain], { hidden: { plain: true }, includeHidden: true });
  assert.equal(included.hidden, true);
  assert.equal(included.pts[4].p, 4 / 11);
  assert.equal(included.pts[4].kaleidoscopeProgress, 4 / 11);
  assert.equal(included.pts[4].reflectionPoint, null);
});

test('authored patterns receive folded strip progress plus every reflection value', () => {
  const { fn, error } = compile(`
    return {
      r: stripProgress * 255,
      g: (reflectionProgress + reflectionDistance) * 64,
      b: isReflectionPoint ? (reflectionSegment + reflectionPoint + 1) * 20 : kaleidoscopeProgress * 100,
    };
  `);
  assert.equal(error, null);
  const normalized = normalizeProjectRenderStrips([strip]);
  const frame = renderPixelFrame({ strips: normalized, activeFn: fn, patternId: 'custom' });
  assert.equal(frame.pixels[3].r, 255);
  assert.equal(frame.pixels[3].b, 60);
  assert.equal(frame.pixels[4].r, 170);
  assert.equal(frame.pixels[4].b, 67);
});

test('Kaleidoscope folds only stripProgress while symmetry keeps the original evaluation index', () => {
  const eightPixels = {
    ...strip,
    pixelCount: 8,
    pixels: Array.from({ length: 8 }, (_, index) => ({ x: 4, y: index })),
    kaleidoscope: { enabled: true, pointCount: 4, startLed: 0, offsets: [0, 0, 0, 0] },
  };
  const { fn, error } = compile('return rgb(stripProgress, index / max(1, pixelCount - 1), 0);');
  assert.equal(error, null);
  const frame = renderPixelFrame({
    strips: normalizeProjectRenderStrips([eightPixels]),
    activeFn: fn,
    patternId: 'custom',
    symSettings: {
      enabled: true,
      type: 'guide-mirror',
      guide: { mode: 'fold', axis: { x1: 0, y1: 0, x2: 1, y2: 0 } },
    },
  });
  assert.deepEqual(frame.pixels.map(pixel => pixel.r), [0, 128, 255, 128, 0, 128, 255, 128]);
  assert.deepEqual(frame.pixels.map(pixel => pixel.g), [0, 36, 73, 109, 146, 182, 219, 255]);
});
