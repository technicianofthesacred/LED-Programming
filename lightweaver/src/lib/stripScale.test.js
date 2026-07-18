import test from 'node:test';
import assert from 'node:assert/strict';

import { scalePathData, scaleStripGeometry, pathDataCenter } from './stripScale.js';
import { createPrimitiveStripDefinition } from './layoutPrimitives.js';

// These tests run under `node --test` with no DOM, so path lengths are checked
// analytically per shape instead of via measurePathLen (which needs an SVG
// element). For the generated primitives the analytic value IS the value
// measurePathLen returns (line: endpoint distance; square: perimeter;
// circle: 2πr), so "svgLength matches measured length within 1%" holds.

const nums = d => (String(d).match(/[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);

// Absolute anchor endpoints of a path (supports M/L/H/V/C/S/Q/T/A/Z, both
// cases) — a tiny independent evaluator so the tests do not trust the
// implementation's own parser for verification.
function evalAnchors(d) {
  const tokens = String(d).match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi) || [];
  const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
  const pts = [];
  let i = 0, cmd = '', cur = { x: 0, y: 0 }, start = { x: 0, y: 0 }, first = true;
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    const upper = cmd.toUpperCase();
    if (upper === 'Z') { cur = { ...start }; cmd = ''; continue; }
    const count = counts[upper];
    if (!count) break;
    while (i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i])) {
      const group = tokens.slice(i, i + count).map(Number);
      if (group.length < count || group.some(Number.isNaN)) return pts;
      const abs = cmd === upper;
      if (upper === 'H') cur = { x: abs ? group[0] : cur.x + group[0], y: cur.y };
      else if (upper === 'V') cur = { x: cur.x, y: abs ? group[0] : cur.y + group[0] };
      else {
        const ex = group[count - 2], ey = group[count - 1];
        cur = abs || (first && upper === 'M')
          ? { x: abs ? ex : cur.x + ex, y: abs ? ey : cur.y + ey }
          : { x: cur.x + ex, y: cur.y + ey };
      }
      if (upper === 'M') start = { ...cur };
      pts.push({ ...cur });
      first = false;
      i += count;
      if (upper === 'M') cmd = cmd === 'M' ? 'L' : 'l';
    }
  }
  return pts;
}

const bboxCenter = pts => {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
};

const closeTo = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('line primitive scales: endpoint distance and svgLength both × factor (within 1%)', () => {
  const line = createPrimitiveStripDefinition({ type: 'line', viewBox: '0 0 640 400' });
  const factor = 1.5;
  const scaled = scaleStripGeometry(line, factor);

  const [a, b] = evalAnchors(scaled.pathData);
  const measured = Math.hypot(b.x - a.x, b.y - a.y); // analytic length of a line
  closeTo(scaled.svgLength, line.svgLength * factor, 1e-6, 'svgLength scales');
  assert.ok(Math.abs(measured - scaled.svgLength) / scaled.svgLength < 0.01,
    `svgLength ${scaled.svgLength} within 1% of measured ${measured}`);
});

test('square primitive scales: perimeter matches svgLength within 1%', () => {
  const square = createPrimitiveStripDefinition({ type: 'square', viewBox: '0 0 640 400' });
  const factor = 0.75;
  const scaled = scaleStripGeometry(square, factor);

  const anchors = evalAnchors(scaled.pathData);
  const xs = anchors.map(p => p.x), ys = anchors.map(p => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const measured = 2 * (w + h); // analytic perimeter (H/V edges)
  closeTo(scaled.svgLength, square.svgLength * factor, 1e-6, 'svgLength scales');
  assert.ok(Math.abs(measured - scaled.svgLength) / scaled.svgLength < 0.01,
    `svgLength ${scaled.svgLength} within 1% of measured ${measured}`);
});

test('circle primitive scales: radius, circumference, and arc flags survive', () => {
  const circle = createPrimitiveStripDefinition({ type: 'circle', viewBox: '0 0 640 400' });
  const factor = 2;
  const scaled = scaleStripGeometry(circle, factor);

  // Path is M .. A rx ry rot laf sf x y A .. Z — pull the first arc's params.
  const values = nums(scaled.pathData);
  const [, , rx, ry, rot, laf, sf] = values;
  const originalRx = nums(circle.pathData)[2];
  closeTo(rx, originalRx * factor, 0.01, 'rx scales');
  closeTo(ry, originalRx * factor, 0.01, 'ry scales');
  assert.equal(rot, 0, 'rotation kept');
  assert.equal(laf, 1, 'large-arc flag kept');
  assert.equal(sf, 0, 'sweep flag kept');
  const measured = 2 * Math.PI * rx; // analytic circumference
  closeTo(scaled.svgLength, circle.svgLength * factor, 1e-6, 'svgLength scales');
  assert.ok(Math.abs(measured - scaled.svgLength) / scaled.svgLength < 0.01,
    `svgLength ${scaled.svgLength} within 1% of measured ${measured}`);
});

test('relative-command path: every anchor maps c\' = center + (c − center)·factor', () => {
  const d = 'M 100 50 l 40 0 q 20 20 40 0 c 10 -10 30 -10 40 0 t 40 0 h 20 v 30 a 10 10 0 0 1 -10 10 z';
  const factor = 2;
  const center = pathDataCenter(d);
  const scaled = scalePathData(d, factor, center);

  const before = evalAnchors(d);
  const after = evalAnchors(scaled);
  assert.equal(after.length, before.length, 'same number of anchors');
  before.forEach((p, i) => {
    closeTo(after[i].x, center.x + (p.x - center.x) * factor, 0.02, `anchor ${i} x`);
    closeTo(after[i].y, center.y + (p.y - center.y) * factor, 0.02, `anchor ${i} y`);
  });
});

test('leading relative moveto is treated as absolute (SVG spec)', () => {
  const d = 'm 10 10 l 20 0';
  const center = { x: 20, y: 10 };
  const scaled = scalePathData(d, 2, center);
  const [a, b] = evalAnchors(scaled);
  // Original anchors: (10,10) and (30,10); mapped about (20,10) by ×2.
  closeTo(a.x, 0, 0.01, 'start x'); closeTo(a.y, 10, 0.01, 'start y');
  closeTo(b.x, 40, 0.01, 'end x'); closeTo(b.y, 10, 0.01, 'end y');
});

test('arc path: rx/ry scale, rotation and flags kept, endpoints map like coords', () => {
  const d = 'M 300 200 A 50 25 15 1 0 400 200';
  const center = { x: 350, y: 200 };
  const scaled = scalePathData(d, 2, center);
  const v = nums(scaled);
  assert.deepEqual(v.slice(0, 2), [250, 200], 'moveto maps about center');
  assert.equal(v[2], 100, 'rx doubles');
  assert.equal(v[3], 50, 'ry doubles');
  assert.equal(v[4], 15, 'rotation kept verbatim');
  assert.equal(v[5], 1, 'large-arc flag kept');
  assert.equal(v[6], 0, 'sweep flag kept');
  assert.deepEqual(v.slice(7), [450, 200], 'endpoint maps about center');

  // Relative arc: deltas and radii scale, flags survive.
  const rel = scalePathData('M 0 0 a 10 20 30 1 1 40 50', 0.5, { x: 0, y: 0 });
  assert.deepEqual(nums(rel), [0, 0, 5, 10, 30, 1, 1, 20, 25]);
});

test('scale(2) then scale(0.5) about the same center is the identity (within rounding)', () => {
  const d = 'M 100 50 L 200 80 C 210 90 230 90 240 80 A 12 12 0 0 1 252 92 Z';
  const center = pathDataCenter(d);
  const roundTrip = scalePathData(scalePathData(d, 2, center), 0.5, center);
  const original = nums(d);
  const back = nums(roundTrip);
  assert.equal(back.length, original.length);
  original.forEach((v, i) => closeTo(back[i], v, 0.02, `token ${i}`));

  // And through scaleStripGeometry (center recomputed from the scaled path —
  // it must land on the same point since anchors map about it).
  const strip = createPrimitiveStripDefinition({ type: 'square', viewBox: '0 0 640 400' });
  const there = scaleStripGeometry(strip, 2);
  const backStrip = scaleStripGeometry(there, 0.5);
  closeTo(backStrip.svgLength, strip.svgLength, 1e-6, 'svgLength round-trips');
  const a = nums(strip.pathData);
  const b = nums(backStrip.pathData);
  a.forEach((v, i) => closeTo(b[i], v, 0.02, `square token ${i}`));
});

test('on-screen center stays fixed: sampled endpoints with x/y offsets applied', () => {
  // The strip's on-screen pixels are path points + (x, y). Prove the on-screen
  // center is invariant under scaling for offset strips.
  const line = {
    ...createPrimitiveStripDefinition({ type: 'line', viewBox: '0 0 640 400' }),
    x: 37, y: -12,
  };
  const onScreen = strip => evalAnchors(strip.pathData)
    .map(p => ({ x: p.x + (strip.x || 0), y: p.y + (strip.y || 0) }));

  const beforeCenter = bboxCenter(onScreen(line));
  const scaled = scaleStripGeometry(line, 1.4);
  const afterCenter = bboxCenter(onScreen(scaled));
  closeTo(afterCenter.x, beforeCenter.x, 0.01, 'center x invariant');
  closeTo(afterCenter.y, beforeCenter.y, 0.01, 'center y invariant');
  assert.equal(scaled.x, 37, 'x offset untouched');
  assert.equal(scaled.y, -12, 'y offset untouched');

  // Same for a closed square with offsets, shrinking.
  const square = {
    ...createPrimitiveStripDefinition({ type: 'square', viewBox: '0 0 640 400' }),
    x: -20, y: 55,
  };
  const b = bboxCenter(onScreen(square));
  const a = bboxCenter(onScreen(scaleStripGeometry(square, 0.6)));
  closeTo(a.x, b.x, 0.01, 'square center x invariant');
  closeTo(a.y, b.y, 0.01, 'square center y invariant');
});

test('degenerate and empty input is safe', () => {
  assert.equal(scalePathData('', 2, { x: 0, y: 0 }), '');
  assert.equal(scalePathData(null, 2), '');
  assert.equal(scalePathData(undefined, 2), '');
  assert.equal(scalePathData('   ', 2), '   ');
  assert.equal(scalePathData('M 1 2 L 3 4', NaN), 'M 1 2 L 3 4');
  assert.equal(scalePathData('M 1 2 L 3 4', 0), 'M 1 2 L 3 4');
  assert.equal(scalePathData('M 1 2 L 3 4', -1), 'M 1 2 L 3 4');
  assert.deepEqual(pathDataCenter(''), { x: 0, y: 0 });
  assert.deepEqual(pathDataCenter('garbage'), { x: 0, y: 0 });
  assert.equal(scaleStripGeometry(null, 2), null);
  assert.equal(scaleStripGeometry(undefined, 2), undefined);
  const noPath = { id: 'strip-1' };
  assert.equal(scaleStripGeometry(noPath, 2), noPath, 'strip without pathData returned as-is');
  const strip = { pathData: 'M 0 0 L 10 0', svgLength: 10 };
  assert.equal(scaleStripGeometry(strip, 1), strip, 'factor 1 is a no-op');
  assert.equal(scaleStripGeometry(strip, Infinity), strip, 'non-finite factor is a no-op');
  // Garbage path data must not throw.
  assert.doesNotThrow(() => scalePathData('M 1 2 X 9 9', 2, { x: 0, y: 0 }));
});
