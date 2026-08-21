import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shapeSignatures,
  estimateCentre,
  scoreFold,
  detectArtworkSymmetry,
} from './artworkSymmetry.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so the random-scatter test is stable.
// ---------------------------------------------------------------------
function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------
// Geometry helpers for building synthetic motif layers. A "motif" is a
// small local polygon (roughly zero-mean); placing a copy rigidly rotates
// the whole polygon by the same angle used to position its anchor, so
// every copy is an exact congruent rotational duplicate — real area,
// length and shape, not just a repositioned point.
// ---------------------------------------------------------------------

function rotateXY(x, y, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: x * c - y * s, y: x * s + y * c };
}

function centerLocalPoints(pts) {
  const mx = pts.reduce((sum, [x]) => sum + x, 0) / pts.length;
  const my = pts.reduce((sum, [, y]) => sum + y, 0) / pts.length;
  return pts.map(([x, y]) => [x - mx, y - my]);
}

function scalePoints(pts, scale) {
  return pts.map(([x, y]) => [x * scale, y * scale]);
}

// A compact, roughly-circular irregular pentagon, zero-meaned. Used for
// the "bee" / "sun-ray" / "spot" motifs.
const UNIT_COMPACT = centerLocalPoints([
  [1.0, 0.3],
  [0.2, 1.0],
  [-1.0, 0.4],
  [-0.3, -1.0],
  [0.6, -0.5],
]);

// A deep many-point star: huge perimeter length relative to its area and
// footprint. Used for "lotus" — it needs to dominate scoreFold's
// length-weighted score without dominating estimateCentre's area-weighted
// centroid (area stays small and comparable to the compact motifs).
function makeSpikyUnit(points, outer, inner) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / (points * 2)) * TAU;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return centerLocalPoints(pts);
}
const UNIT_SPIKY = makeSpikyUnit(20, 1.0, 0.05);

/**
 * Builds one motif "layer" — a copy of `localPoints` (already at world
 * scale) anchored at `radius` from `centre`, at `baseAngle + copyAngle`,
 * rotated rigidly by that same angle. `.points` is consumed by
 * shapeSignatures' default sampler (no DOM needed).
 */
function makeMotifLayer(id, centre, radius, baseAngle, copyAngle, localPoints) {
  const angle = baseAngle + copyAngle;
  const anchor = {
    x: centre.x + radius * Math.cos(angle),
    y: centre.y + radius * Math.sin(angle),
  };
  const points = localPoints.map(([x, y]) => {
    const r = rotateXY(x, y, angle);
    return { x: r.x + anchor.x, y: r.y + anchor.y };
  });
  return { id, points };
}

// A ring of motifs: `copies` congruent rotational duplicates of one motif,
// spaced 2*PI/copies apart, around `centre`.
function makeRing(idPrefix, centre, radius, baseAngle, copies, unitLocalPoints, scale) {
  const localPoints = scalePoints(unitLocalPoints, scale);
  const layers = [];
  for (let k = 0; k < copies; k++) {
    const copyAngle = (k * TAU) / copies;
    layers.push(makeMotifLayer(`${idPrefix}-${k}`, centre, radius, baseAngle, copyAngle, localPoints));
  }
  return layers;
}

// Four motifs (lotus/bee/sun-ray/spot), each its own ring of `copies`
// congruent duplicates at a different radius, scale and base angle — a
// synthetic N-fold mandala.
//
// "lotus" is spiky and deliberately the dominant shape BY LENGTH (huge
// perimeter, modest area/radius) so deleting one lotus copy visibly drags
// scoreFold's length-weighted score down (see the "medium confidence"
// test below) without dragging estimateCentre's area-weighted centroid
// far enough off to blow past its 5x5-grid refinement capture range.
// "bee" is the largest-AREA motif, used by the phase test.
const LOTUS_BASE_ANGLE = 0.25;
const BEE_BASE_ANGLE = 1.1;

function makeMandala(centre, copies) {
  return [
    ...makeRing('lotus', centre, 35, LOTUS_BASE_ANGLE, copies, UNIT_SPIKY, 3),
    ...makeRing('bee', centre, 50, BEE_BASE_ANGLE, copies, UNIT_COMPACT, 3.4),
    ...makeRing('sun-ray', centre, 30, 2.0, copies, UNIT_COMPACT, 1.8),
    ...makeRing('spot', centre, 15, 0.7, copies, UNIT_COMPACT, 0.9),
  ];
}

function makeRandomScatterLayers(seed, count) {
  const rand = mulberry32(seed);
  const layers = [];
  for (let i = 0; i < count; i++) {
    const cx = (rand() - 0.5) * 400;
    const cy = (rand() - 0.5) * 400;
    const scale = 1 + rand() * 9;
    const rot = rand() * TAU;
    const sides = 3 + Math.floor(rand() * 3);
    const local = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * TAU + rand() * 0.3;
      const r = 0.7 + rand() * 0.6;
      local.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const localPoints = scalePoints(centerLocalPoints(local), scale);
    const points = localPoints.map(([x, y]) => {
      const r = rotateXY(x, y, rot);
      return { x: r.x + cx, y: r.y + cy };
    });
    layers.push({ id: `scatter-${i}`, points });
  }
  return layers;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------------------------------------------------------------------
// shapeSignatures — injectable sampler (headless, no DOM)
// ---------------------------------------------------------------------

test('shapeSignatures samples via an injected analytic sampler (no DOM)', () => {
  const circleSampler = (layer) => {
    const pts = [];
    const n = 48;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      pts.push({
        x: layer.centre.x + layer.radius * Math.cos(a),
        y: layer.centre.y + layer.radius * Math.sin(a),
      });
    }
    return pts;
  };

  const layers = [
    { id: 'ring-a', centre: { x: 10, y: -4 }, radius: 6 },
    { id: 'ring-b', centre: { x: -20, y: 30 }, radius: 3 },
  ];

  const sigs = shapeSignatures(layers, { sampleCount: 48, sampler: circleSampler });

  assert.equal(sigs.length, 2);
  assert.equal(sigs[0].id, 'ring-a');
  assert.ok(Math.abs(sigs[0].centroid.x - 10) < 0.05);
  assert.ok(Math.abs(sigs[0].centroid.y + 4) < 0.05);
  assert.ok(Math.abs(sigs[0].area - Math.PI * 6 * 6) / (Math.PI * 6 * 6) < 0.01);
  assert.ok(Math.abs(sigs[0].length - TAU * 6) / (TAU * 6) < 0.01);
  assert.ok(Math.abs(sigs[0].bboxRadius - 6) < 0.05);

  assert.ok(Math.abs(sigs[1].area - Math.PI * 3 * 3) / (Math.PI * 3 * 3) < 0.01);
});

test('shapeSignatures throws a clear error with no sampler, points, or sample()', () => {
  assert.throws(() => shapeSignatures([{ id: 'bare' }]), /sampler/);
});

// ---------------------------------------------------------------------
// detectArtworkSymmetry — synthetic mandalas
// ---------------------------------------------------------------------

test('detects a synthetic 6-fold mandala: correct n, centre, and phase', () => {
  const centre = { x: 0, y: 0 };
  const layers = makeMandala(centre, 6);

  const result = detectArtworkSymmetry(layers, {
    folds: [2, 3, 4, 5, 6, 8, 10, 12],
    tolerance: 0.02,
  });

  assert.equal(result.asymmetric, false);
  assert.ok(result.best, 'expected a best candidate');
  assert.equal(result.best.n, 6);
  assert.ok(result.best.score > 0.95, `expected near-perfect match, got ${result.best.score}`);

  assert.ok(dist(result.centre, centre) < 0.5, `centre drifted: ${JSON.stringify(result.centre)}`);

  // "bee" is the largest-area ring (lotus is spiky/long but small-area),
  // placed at BEE_BASE_ANGLE — phase should recover that, mod TAU/6.
  const base = TAU / 6;
  const expectedPhase = ((BEE_BASE_ANGLE % base) + base) % base;
  const phaseDelta = Math.min(
    Math.abs(result.best.phase - expectedPhase),
    base - Math.abs(result.best.phase - expectedPhase)
  );
  assert.ok(phaseDelta < 0.05, `phase off: got ${result.best.phase}, expected ~${expectedPhase}`);

  // every candidate is present and ranked, none silently dropped
  assert.equal(result.candidates.length, 8);
  assert.ok(result.candidates[0].score >= result.candidates[1].score);
});

test('still detects 6-fold with one shape deleted, at reduced (medium) confidence', () => {
  const centre = { x: 0, y: 0 };
  let layers = makeMandala(centre, 6);
  // Remove one lotus copy — lotus is the dominant-length ring, so this
  // measurably drags the length-weighted score down without destroying
  // the underlying 6-fold structure.
  layers = layers.filter((l) => l.id !== 'lotus-3');

  const result = detectArtworkSymmetry(layers, { tolerance: 0.02 });

  assert.equal(result.asymmetric, false);
  assert.ok(result.best);
  assert.equal(result.best.n, 6);
  assert.equal(
    result.best.confidence,
    'medium',
    `expected medium confidence, got ${result.best.confidence} (score ${result.best.score})`
  );
  assert.ok(result.best.score >= 0.7 && result.best.score < 0.9);
});

test('random scatter reports asymmetric:true with no best, but ranked candidates', () => {
  const layers = makeRandomScatterLayers(1234, 18);

  const result = detectArtworkSymmetry(layers, { tolerance: 0.02 });

  assert.equal(result.asymmetric, true);
  assert.equal(result.best, null);
  assert.ok(result.candidates.length > 0);
  // still ranked, never silently empty — the UI needs a "closest: n-fold"
  for (const c of result.candidates) {
    assert.ok(Number.isFinite(c.score));
    assert.ok(c.n > 0);
  }
});

test('a synthetic 12-fold mandala resolves to 12, not a smaller divisor', () => {
  const centre = { x: 0, y: 0 };
  const layers = makeRing('lotus', centre, 60, 0.4, 12, UNIT_COMPACT, 8);

  const result = detectArtworkSymmetry(layers, {
    folds: [2, 3, 4, 6, 12],
    tolerance: 0.02,
  });

  assert.equal(result.asymmetric, false);
  assert.ok(result.best);
  assert.equal(
    result.best.n,
    12,
    `expected 12, got ${result.best.n} (candidates: ${JSON.stringify(result.candidates.map((c) => [c.n, c.score]))})`
  );
});

test('centre offset by 40 units is recovered', () => {
  const centre = { x: 40, y: -25 };
  const layers = makeMandala(centre, 6);

  const result = detectArtworkSymmetry(layers, { tolerance: 0.02 });

  assert.equal(result.best && result.best.n, 6);
  assert.ok(dist(result.centre, centre) < 0.5, `centre not recovered: ${JSON.stringify(result.centre)}`);
});

// ---------------------------------------------------------------------
// estimateCentre / scoreFold — direct unit coverage
// ---------------------------------------------------------------------

test('estimateCentre on an empty signature list returns the origin, not a throw', () => {
  const centre = estimateCentre([]);
  assert.deepEqual(centre, { x: 0, y: 0 });
});

test('scoreFold returns 0 for an empty or zero-length signature set', () => {
  assert.equal(scoreFold([], { x: 0, y: 0 }, 6), 0);
  const zeroLenSig = [{ id: 'z', centroid: { x: 0, y: 0 }, area: 0, length: 0, bboxRadius: 0 }];
  assert.equal(scoreFold(zeroLenSig, { x: 0, y: 0 }, 6), 0);
});

test('scoreFold on a true rotational ring scores ~1', () => {
  const centre = { x: 0, y: 0 };
  const layers = makeRing('lotus', centre, 40, 0, 6, UNIT_COMPACT, 5);
  const sigs = shapeSignatures(layers);
  const score = scoreFold(sigs, centre, 6, 0.02);
  assert.ok(score > 0.98, `expected ~1, got ${score}`);
});
