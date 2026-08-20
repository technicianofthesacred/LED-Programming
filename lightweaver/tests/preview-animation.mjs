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

// ── Speed is a rate, not a multiplier on elapsed time ───────────────────────
// `stripT = t * speed` teleports the pattern by `t * delta` the instant Speed
// changes, and the jump grows with how long the tab has been open: measured on
// aurora, one 0.01 notch after ten minutes moved the strip 158x as far as an
// ordinary frame does. Feeding an accumulated phase keeps the pattern where it
// is and only changes how fast it travels from that moment on.
{
  const pattern = 'aurora';
  const paletteNorm = normalizePalette();
  const fn = compilePattern(pattern);
  const frame = (t, speed, stripPhases) => renderPixelFrame({
    t,
    strips: [{ id: 'outer', speed, brightness: 1, hueShift: 0, pts: ring }],
    patternId: pattern,
    activeFn: fn,
    paletteNorm,
    stripPhases,
  }).pixels;
  const drift = (a, b) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += Math.abs(a[i].r - b[i].r) + Math.abs(a[i].g - b[i].g) + Math.abs(a[i].b - b[i].b);
    }
    return sum / (a.length * 3);
  };

  const dt = 1 / 60;
  const openSeconds = 600;
  const phases = new Map();
  let clock = 0;
  for (let i = 0; i < openSeconds * 60; i++) {
    clock += dt;
    phases.set('outer', (phases.get('outer') ?? clock) + dt * 1);
  }

  const held = frame(clock, 1, phases);
  const oneOrdinaryFrame = drift(held, frame(clock + dt, 1, new Map([['outer', phases.get('outer') + dt]])));
  const afterSpeedChange = drift(held, frame(clock + dt, 1.01, new Map([['outer', phases.get('outer') + dt * 1.01]])));
  assert.ok(
    afterSpeedChange <= oneOrdinaryFrame * 6,
    `a 0.01 speed notch after ${openSeconds}s moved ${afterSpeedChange} against an ordinary frame's ${oneOrdinaryFrame}`,
  );

  // The old product is still the fallback for callers that render at one fixed
  // speed (sequence baking, offline frame audits), and it still scrubs — which
  // is exactly why the accumulated phase has to win when it is supplied.
  const withoutPhases = drift(frame(clock, 1, null), frame(clock, 1.01, null));
  assert.ok(
    withoutPhases > oneOrdinaryFrame * 20,
    'the no-phase fallback is the scrubbing path this guard exists to keep out of the live preview',
  );
}

console.log('preview-animation tests passed');
