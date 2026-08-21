import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY_MATRIX,
  parseTransform,
  multiplyMatrix,
  accumulatedMatrix,
  isRigidMatrix,
  matrixScaleFactor,
  matrixRotationDeg,
  matrixDeterminant,
  absolutizePath,
  applyMatrixToPathData,
  arcToCubicBeziers,
  expandUses,
  flattenSvgDocument,
} from './svgFlatten.js';

import { makeElement, makeDocFromRoot } from './svgDomStub.js';

// ── test helpers ─────────────────────────────────────────────────────────────

function nums(d) {
  return (d.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
}

function commands(d) {
  return (d.match(/[a-zA-Z]/g) || []).join('');
}

function approxEqual(a, b, eps = 1e-3) {
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~= ${b} (eps ${eps})`);
}

function approxPoint(p, x, y, eps = 1e-3) {
  approxEqual(p.x, x, eps);
  approxEqual(p.y, y, eps);
}

function mapPointVia(m, x, y) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

// ── parseTransform ───────────────────────────────────────────────────────────

test('parseTransform: empty/garbage/null -> identity, never throws', () => {
  assert.deepEqual(parseTransform(''), IDENTITY_MATRIX);
  assert.deepEqual(parseTransform(null), IDENTITY_MATRIX);
  assert.deepEqual(parseTransform(undefined), IDENTITY_MATRIX);
  assert.deepEqual(parseTransform('not a transform at all'), IDENTITY_MATRIX);
  assert.deepEqual(parseTransform('rotate()'), IDENTITY_MATRIX);
  assert.deepEqual(parseTransform(42), IDENTITY_MATRIX);
});

test('parseTransform: matrix()', () => {
  const m = parseTransform('matrix(1,0,0,1,10,20)');
  assert.deepEqual(m, { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 });
});

test('parseTransform: translate() one and two args', () => {
  assert.deepEqual(parseTransform('translate(5)'), { a: 1, b: 0, c: 0, d: 1, e: 5, f: 0 });
  assert.deepEqual(parseTransform('translate(5,7)'), { a: 1, b: 0, c: 0, d: 1, e: 5, f: 7 });
  assert.deepEqual(parseTransform('translate(5 7)'), { a: 1, b: 0, c: 0, d: 1, e: 5, f: 7 });
});

test('parseTransform: scale() one and two args', () => {
  assert.deepEqual(parseTransform('scale(2)'), { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
  assert.deepEqual(parseTransform('scale(2,3)'), { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 });
});

test('parseTransform: rotate() about origin matches standard rotation matrix', () => {
  const m = parseTransform('rotate(90)');
  approxPoint(mapPointVia(m, 1, 0), 0, 1);
});

test('parseTransform: rotate(a, cx, cy) leaves the pivot fixed', () => {
  const m = parseTransform('rotate(37, 100, 50)');
  approxPoint(mapPointVia(m, 100, 50), 100, 50);
});

test('parseTransform: rotate(90, 10, 10) rotates a point about that pivot', () => {
  const m = parseTransform('rotate(90, 10, 10)');
  // (20,10) is 10 units to the right of the pivot; rotating 90 deg (SVG
  // convention, y-down) sends "right" to "down".
  approxPoint(mapPointVia(m, 20, 10), 10, 20);
});

test('parseTransform: skewX/skewY', () => {
  const skx = parseTransform('skewX(45)');
  approxPoint(mapPointVia(skx, 0, 10), 10, 10);
  const sky = parseTransform('skewY(45)');
  approxPoint(mapPointVia(sky, 10, 0), 10, 10);
});

test('parseTransform: composes multiple functions left-to-right (translate then rotate)', () => {
  // translate(10,0) rotate(90): rotate first (in local frame), then translate.
  const m = parseTransform('translate(10,0) rotate(90)');
  approxPoint(mapPointVia(m, 1, 0), 10, 1);
});

// ── multiplyMatrix ───────────────────────────────────────────────────────────

test('multiplyMatrix: identity is a no-op on either side', () => {
  const m = { a: 2, b: 0.5, c: -0.5, d: 3, e: 7, f: -4 };
  assert.deepEqual(multiplyMatrix(IDENTITY_MATRIX, m), m);
  assert.deepEqual(multiplyMatrix(m, IDENTITY_MATRIX), m);
});

test('multiplyMatrix: applies the right-hand matrix first', () => {
  const translate = parseTransform('translate(10,0)');
  const scale = parseTransform('scale(2)');
  const composite = multiplyMatrix(translate, scale);
  // scale(2) first: (1,0)->(2,0); then translate(10,0): (12,0)
  approxPoint(mapPointVia(composite, 1, 0), 12, 0);
});

// ── accumulatedMatrix (nested <g> composition) ──────────────────────────────

test('accumulatedMatrix: composes nested <g transform> in root-to-self order', () => {
  const path = makeElement('path', { d: 'M 1,0' });
  const g2 = makeElement('g', { transform: 'scale(2)' }, [path]);
  const g1 = makeElement('g', { transform: 'translate(10,0)' }, [g2]);
  makeElement('svg', {}, [g1]); // establishes parentElement chain up to a root

  const m = accumulatedMatrix(path);
  // scale(2) applied first (innermost), then translate(10,0) (outermost):
  // (1,0) -> (2,0) -> (12,0)
  approxPoint(mapPointVia(m, 1, 0), 12, 0);
});

test('accumulatedMatrix: rotate(60, cx, cy) on an ancestor group about a non-origin point', () => {
  const path = makeElement('path', { d: 'M 0,0' });
  const g = makeElement('g', { transform: 'rotate(60, 50, 50)' }, [path]);
  makeElement('svg', {}, [g]);

  const m = accumulatedMatrix(path);
  // A point 10 units right of the pivot (50,50) -> (60,50); rotating 60deg
  // about (50,50) should land at pivot + 10*(cos60, sin60).
  const rad = (60 * Math.PI) / 180;
  approxPoint(mapPointVia(m, 60, 50), 50 + 10 * Math.cos(rad), 50 + 10 * Math.sin(rad));
});

test('accumulatedMatrix: an element with no transformed ancestors is the identity', () => {
  const path = makeElement('path', { d: 'M 0,0' });
  makeElement('g', {}, [path]);
  const m = accumulatedMatrix(path);
  assert.deepEqual(m, IDENTITY_MATRIX);
});

// ── isRigidMatrix / matrixScaleFactor / matrixRotationDeg ───────────────────

test('isRigidMatrix: rotation + translation + uniform scale is rigid', () => {
  const m = multiplyMatrix(parseTransform('translate(5,5)'), multiplyMatrix(parseTransform('rotate(30)'), parseTransform('scale(2)')));
  assert.equal(isRigidMatrix(m), true);
  approxEqual(matrixScaleFactor(m), 2);
  approxEqual(matrixRotationDeg(m), 30);
});

test('isRigidMatrix: non-uniform scale is not rigid', () => {
  assert.equal(isRigidMatrix(parseTransform('scale(2,3)')), false);
});

test('isRigidMatrix: skew is not rigid', () => {
  assert.equal(isRigidMatrix(parseTransform('skewX(20)')), false);
});

test('matrixDeterminant: reflection has negative determinant', () => {
  assert.equal(matrixDeterminant(parseTransform('scale(-1,1)')) < 0, true);
  assert.equal(matrixDeterminant(parseTransform('rotate(45)')) > 0, true);
});

// ── absolutizePath ───────────────────────────────────────────────────────────

test('absolutizePath: relative commands become absolute', () => {
  const segs = absolutizePath('m 10,10 l 5,0 l 0,5 z');
  assert.deepEqual(segs.map(s => s.cmd), ['M', 'L', 'L', 'Z']);
  assert.deepEqual([segs[0].x, segs[0].y], [10, 10]);
  assert.deepEqual([segs[1].x, segs[1].y], [15, 10]);
  assert.deepEqual([segs[2].x, segs[2].y], [15, 15]);
});

test('absolutizePath: H/V become L', () => {
  const segs = absolutizePath('M 0,0 H 10 V 10');
  assert.deepEqual(segs.map(s => s.cmd), ['M', 'L', 'L']);
  assert.deepEqual([segs[1].x, segs[1].y], [10, 0]);
  assert.deepEqual([segs[2].x, segs[2].y], [10, 10]);
});

test('absolutizePath: S reflects the previous C control point', () => {
  const segs = absolutizePath('M 0,0 C 0,10 10,10 10,0 S 20,-10 20,0');
  const s = segs[2];
  assert.equal(s.cmd, 'C');
  // previous C's final control point was (10,10); reflected about (10,0) -> (10,-10)
  assert.deepEqual([s.x1, s.y1], [10, -10]);
});

test('absolutizePath: malformed tail is dropped, never throws', () => {
  assert.doesNotThrow(() => absolutizePath('M 0,0 L garbage'));
  const segs = absolutizePath('M 0,0 L garbage');
  assert.deepEqual(segs.map(s => s.cmd), ['M']);
});

// ── applyMatrixToPathData ────────────────────────────────────────────────────

test('applyMatrixToPathData: translation shifts every point', () => {
  const out = applyMatrixToPathData('M 0,0 L 10,0', parseTransform('translate(5,5)'));
  assert.deepEqual(nums(out), [5, 5, 15, 5]);
});

test('applyMatrixToPathData: rotation maps points as expected', () => {
  const out = applyMatrixToPathData('M 1,0', parseTransform('rotate(90)'));
  const [x, y] = nums(out);
  approxEqual(x, 0);
  approxEqual(y, 1);
});

test('applyMatrixToPathData: arc under a rigid rotation stays an arc, scaled and rotated', () => {
  // Quarter-circle arc from (10,0) to (0,10), radius 10.
  const d = 'M 10,0 A 10,10 0 0 1 0,10';
  const m = multiplyMatrix(parseTransform('rotate(90)'), parseTransform('scale(2)'));
  const out = applyMatrixToPathData(d, m);
  assert.equal(commands(out), 'MA');
  const tail = out.split('A')[1].trim();
  const parts = tail.split(/[\s,]+/).map(Number);
  const [radiusX, radiusY, xAxisRot, largeArc, sweep, endX, endY] = parts;
  approxEqual(radiusX, 20); // rx scaled by uniform scale factor 2
  approxEqual(radiusY, 20);
  approxEqual(xAxisRot, 90); // rotate(90) added to original x-axis-rotation of 0
  assert.equal(largeArc, 0);
  assert.equal(sweep, 1); // det > 0, sweep unchanged
  // endpoint (0,10) scaled by 2 -> (0,20), then rotated 90deg -> (-20,0)
  approxEqual(endX, -20);
  approxEqual(endY, 0);
});

test('applyMatrixToPathData: arc under a non-rigid (sheared) matrix is subdivided into cubic beziers', () => {
  const d = 'M 10,0 A 10,10 0 0 1 0,10';
  const m = parseTransform('scale(2,1)'); // non-uniform -> not rigid
  const out = applyMatrixToPathData(d, m);
  assert.equal(commands(out).includes('A'), false);
  assert.ok(commands(out).includes('C'), 'expected the arc to be subdivided into C segments');
});

test('applyMatrixToPathData: degenerate arc (rx or ry is 0) becomes a line, never crashes', () => {
  const out = applyMatrixToPathData('M 0,0 A 0,10 0 0 1 10,10', IDENTITY_MATRIX);
  assert.equal(commands(out), 'ML');
});

test('applyMatrixToPathData: identity matrix leaves points unchanged (within rounding)', () => {
  const out = applyMatrixToPathData('M 3,4 L 5,6', IDENTITY_MATRIX);
  assert.deepEqual(nums(out), [3, 4, 5, 6]);
});

// ── arcToCubicBeziers ────────────────────────────────────────────────────────

test('arcToCubicBeziers: quarter circle produces one segment ending at the true endpoint', () => {
  const segs = arcToCubicBeziers(10, 0, 10, 10, 0, 0, 1, 0, 10);
  assert.ok(segs && segs.length >= 1);
  const last = segs[segs.length - 1];
  approxPoint(last.end, 0, 10, 1e-6);
  // Kappa-scaled control points should be a plausible distance from the
  // endpoints (not degenerate / not wildly large) for a 90 deg, radius-10 arc.
  const kappa = 10 * 0.5522847498;
  approxEqual(Math.hypot(segs[0].cp1.x - 10, segs[0].cp1.y - 0), kappa, 1e-3);
});

test('arcToCubicBeziers: degenerate (rx or ry 0) returns null', () => {
  assert.equal(arcToCubicBeziers(0, 0, 0, 5, 0, 0, 1, 10, 10), null);
});

// ── expandUses ───────────────────────────────────────────────────────────────

test('expandUses: a single <use> is replaced by a <g> wrapping a clone of its target', () => {
  const dot = makeElement('circle', { id: 'dot', cx: '0', cy: '0', r: '5' });
  const use = makeElement('use', { href: '#dot', x: '10', y: '20' });
  const root = makeElement('svg', {}, [dot, use]);
  makeDocFromRoot(root);

  const result = expandUses(root);
  assert.equal(result.expansions, 1);
  assert.deepEqual(result.warnings, []);
  const useLeft = root.children.some(c => c.localName === 'use');
  assert.equal(useLeft, false);
  const wrapper = root.children.find(c => c.localName === 'g');
  assert.ok(wrapper, 'expected a <g> wrapper in place of the <use>');
  assert.equal(wrapper.getAttribute('transform'), 'translate(10 20)');
  const clonedCircle = wrapper.children.find(c => c.localName === 'circle');
  assert.ok(clonedCircle);
  assert.equal(clonedCircle.getAttribute('r'), '5');
  // The clone must be a distinct node from the original (mutating one must
  // not mutate the other) so multiple <use> instances don't alias.
  assert.notEqual(clonedCircle, dot);
});

test('expandUses: nested <use> (a used group that itself contains a <use>) fully expands', () => {
  const dot = makeElement('circle', { id: 'dot', cx: '0', cy: '0', r: '3' });
  const innerUse = makeElement('use', { href: '#dot' });
  const petal = makeElement('g', { id: 'petal' }, [innerUse]);
  const outerUse = makeElement('use', { href: '#petal', x: '5' });
  const root = makeElement('svg', {}, [dot, petal, outerUse]);
  makeDocFromRoot(root);

  const result = expandUses(root);
  assert.equal(result.expansions, 2); // innerUse -> dot clone (in place), then outerUse -> petal clone (carrying that resolved circle along)
  const allCircles = root.querySelectorAll('circle');
  // original dot, petal's own resolved clone, and outerUse's clone of the
  // (already-resolved) petal — which necessarily carries its circle too.
  assert.equal(allCircles.length, 3);
  const anyUseLeft = root.querySelectorAll('use').length;
  assert.equal(anyUseLeft, 0);
});

test('expandUses: mutual-reference cycle is caught and does not hang', () => {
  const a = makeElement('g', { id: 'a' });
  const b = makeElement('g', { id: 'b' });
  const useB = makeElement('use', { href: '#b' });
  a.appendChild(useB);
  const useA = makeElement('use', { href: '#a' });
  b.appendChild(useA);
  const rootUse = makeElement('use', { href: '#a' });
  const root = makeElement('svg', {}, [a, b, rootUse]);
  makeDocFromRoot(root);

  const start = Date.now();
  const result = expandUses(root, { maxDepth: 20, maxExpansions: 500 });
  assert.ok(Date.now() - start < 2000, 'cycle guard must terminate promptly');
  assert.ok(result.warnings.some(w => /cycle/i.test(w)), 'expected a cycle warning');
});

test('expandUses: self-referencing <use> is caught immediately', () => {
  const selfUse = makeElement('use', { id: 'loop', href: '#loop' });
  const root = makeElement('svg', {}, [selfUse]);
  makeDocFromRoot(root);
  const result = expandUses(root);
  assert.equal(result.expansions, 0);
  assert.ok(result.warnings.some(w => /cycle/i.test(w)));
});

test('expandUses: maxExpansions caps total clones and warns once', () => {
  const dot = makeElement('circle', { id: 'dot', r: '1' });
  const uses = Array.from({ length: 10 }, (_, i) => makeElement('use', { href: '#dot', x: String(i) }));
  const root = makeElement('svg', {}, [dot, ...uses]);
  makeDocFromRoot(root);

  const result = expandUses(root, { maxExpansions: 3 });
  assert.equal(result.expansions, 3);
  const cappedWarnings = result.warnings.filter(w => /maximum of 3/.test(w));
  assert.equal(cappedWarnings.length, 1, 'the cap warning should only be emitted once');
});

test('expandUses: missing target is dropped with a warning, not thrown', () => {
  const use = makeElement('use', { href: '#nope' });
  const root = makeElement('svg', {}, [use]);
  makeDocFromRoot(root);
  const result = expandUses(root);
  assert.equal(result.expansions, 0);
  assert.ok(result.warnings.some(w => /missing id/.test(w)));
});

// ── flattenSvgDocument ───────────────────────────────────────────────────────

test('flattenSvgDocument: reports failure gracefully when there is no <svg> root', () => {
  const root = makeElement('g', {});
  const doc = makeDocFromRoot(root);
  const result = flattenSvgDocument(doc);
  assert.equal(result.ok, false);
  assert.match(result.reason, /svg/i);
});

test('flattenSvgDocument: primitives convert to <path> with equivalent geometry', () => {
  const rect = makeElement('rect', { x: '0', y: '0', width: '10', height: '10' });
  const circle = makeElement('circle', { cx: '5', cy: '5', r: '5' });
  const layer = makeElement('g', { 'data-name': 'Layer 1' }, [rect, circle]);
  const root = makeElement('svg', {}, [layer]);
  const doc = makeDocFromRoot(root);

  const result = flattenSvgDocument(doc);
  assert.equal(result.ok, true);
  const shapeTags = layer.children.map(c => c.localName);
  assert.deepEqual(shapeTags, ['path', 'path']);
  // Untransformed rect at origin: first point of the resulting path is (0,0).
  const rectD = layer.children[0].getAttribute('d');
  assert.deepEqual(nums(rectD).slice(0, 2), [0, 0]);
});

test('flattenSvgDocument: a rotated <g> bakes its rotation into the child path (the actual bug)', () => {
  const path = makeElement('path', { d: 'M 10,0 L 20,0' });
  const g = makeElement('g', { transform: 'rotate(90)' }, [path]);
  const root = makeElement('svg', {}, [g]);
  const doc = makeDocFromRoot(root);

  const result = flattenSvgDocument(doc);
  assert.equal(result.ok, true);
  const d = g.children[0].getAttribute('d');
  const [x1, y1, x2, y2] = nums(d);
  // rotate(90): (10,0)->(0,10), (20,0)->(0,20)
  approxEqual(x1, 0); approxEqual(y1, 10);
  approxEqual(x2, 0); approxEqual(y2, 20);
  // The transform must be gone — the group no longer carries geometry the
  // measureLayers()/shapeToD() reader (which never looks at `transform`)
  // needs to know about.
  assert.equal(g.getAttribute('transform'), null);
});

test('flattenSvgDocument: a wedge + five rotated <use> clones becomes six real paths (the missing-wedges bug)', () => {
  const wedge = makeElement('path', { id: 'wedge', d: 'M 0,0 L 10,0' });
  const uses = [1, 2, 3, 4, 5].map(i => makeElement('use', {
    href: '#wedge', transform: `rotate(${i * 60})`,
  }));
  const root = makeElement('svg', {}, [wedge, ...uses]);
  const doc = makeDocFromRoot(root);

  const result = flattenSvgDocument(doc);
  assert.equal(result.ok, true);
  const paths = root.querySelectorAll('path');
  assert.equal(paths.length, 6, 'the original wedge plus five expanded clones');
  assert.equal(root.querySelectorAll('use').length, 0);

  // Each clone's endpoint should land at radius 10, at its own rotated angle.
  const endpoints = paths.map((p) => {
    const [, , x, y] = nums(p.getAttribute('d'));
    return { x, y };
  });
  for (const { x, y } of endpoints) {
    approxEqual(Math.hypot(x, y), 10, 1e-3);
  }
});

test('flattenSvgDocument: drops <image> with a warning and does not crash the rest of the walk', () => {
  const img = makeElement('image', { href: 'data:image/png;base64,AAAA' });
  const path = makeElement('path', { d: 'M 0,0 L 1,1' });
  const root = makeElement('svg', {}, [img, path]);
  const doc = makeDocFromRoot(root);

  const result = flattenSvgDocument(doc);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => /image/i.test(w)));
  assert.equal(root.querySelectorAll('image').length, 0);
  assert.equal(root.querySelectorAll('path').length, 1);
});

test('flattenSvgDocument: notes clip-path/mask are ignored rather than silently dropping geometry', () => {
  const path = makeElement('path', { d: 'M 0,0 L 5,5', 'clip-path': 'url(#c1)' });
  const root = makeElement('svg', {}, [path]);
  const doc = makeDocFromRoot(root);

  const result = flattenSvgDocument(doc);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(w => /clip-path/i.test(w)));
  // The shape itself is still preserved (unclipped), not deleted.
  assert.equal(root.querySelectorAll('path').length, 1);
});
