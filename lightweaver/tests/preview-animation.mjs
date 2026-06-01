import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compilePattern, normalizePalette, renderPixelFrame } from '../src/lib/frameEngine.js';

const ring = Array.from({ length: 48 }, (_, i) => {
  const angle = (i / 48) * Math.PI * 2;
  return {
    x: Math.cos(angle) * 120 + 240,
    y: Math.sin(angle) * 120 + 240,
    p: i / 47,
    i,
  };
});

const strips = [{ id: 'outer', speed: 1, brightness: 1, hueShift: 0, pts: ring }];
const activeFn = compilePattern('fire');
assert.ok(activeFn, 'fire pattern should compile');

const frameA = renderPixelFrame({
  t: 0,
  strips,
  patternId: 'fire',
  activeFn,
  paletteNorm: normalizePalette(),
}).pixels;

const frameB = renderPixelFrame({
  t: 0.5,
  strips,
  patternId: 'fire',
  activeFn,
  paletteNorm: normalizePalette(),
}).pixels;

const delta = frameA.reduce((sum, pixel, index) => {
  const next = frameB[index] || {};
  return sum +
    Math.abs(pixel.r - (next.r || 0)) +
    Math.abs(pixel.g - (next.g || 0)) +
    Math.abs(pixel.b - (next.b || 0));
}, 0);

assert.ok(
  delta > 1200,
  `fire preview should visibly animate within half a second; color delta was ${delta}`,
);

const previewSource = readFileSync(resolve(import.meta.dirname, '../src/components/Preview.jsx'), 'utf8');
const patternsSource = readFileSync(resolve(import.meta.dirname, '../src/components/PatternsScreen.jsx'), 'utf8');

assert.match(
  previewSource,
  /targetFps = 60/,
  'LEDPreview should support a targetFps cap with a fast default for live tools',
);
assert.match(
  previewSource,
  /minFrameMs/,
  'LEDPreview should throttle expensive canvas redraws when targetFps is lower than RAF',
);
assert.match(
  patternsSource,
  /targetFps=\{30\}/,
  'Patterns screen preview should cap redraws to 30fps so the editor stays responsive',
);

console.log('preview-animation tests passed');
