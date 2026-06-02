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

// The shipped Patterns screen is the verbatim v3 mockup (src/v3/lw-pattern.jsx).
// Its preview is DOM/SVG-based (a bounded LedRow + a glowing Strand) with live
// state pushed to the card, not a canvas/RAF redraw loop — so the v3 perf
// contract is about throttling card pushes and bounding the on-screen render,
// not capping canvas FPS. Assert that real contract.
const patternsSource = readFileSync(resolve(import.meta.dirname, '../src/v3/lw-pattern.jsx'), 'utf8');

assert.match(
  patternsSource,
  /clearTimeout\(livePreviewTimer\.current\)/,
  'Patterns live preview should debounce by cancelling a pending card push before scheduling the next',
);
assert.match(
  patternsSource,
  /livePreviewTimer\.current = setTimeout\(/,
  'Patterns live preview should debounce card pushes through a timer rather than pushing on every change',
);
assert.match(
  patternsSource,
  /sequence === livePreviewSeq\.current/,
  'Patterns live preview should guard against stale async responses with a sequence counter',
);
assert.match(
  patternsSource,
  /function LedRow\(/,
  'Patterns screen should render a bounded DOM LedRow preview rather than one node per hardware pixel',
);

console.log('preview-animation tests passed');
