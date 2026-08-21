/**
 * artworkSymmetry.js — detects rotational symmetry (fold count, centre,
 * phase) directly from vector artwork geometry.
 *
 * Pure ESM. No DOM/React/audio. Every sampling step goes through an
 * injectable sampler so the whole module is unit-testable headless (no
 * SVGPathElement, no browser) — see `shapeSignatures`'s `opts.sampler`.
 *
 * This is a detection-only module: it never reads or writes an audio band,
 * and nothing here should ever be handed one. Its output (a candidate list
 * + a `phase` offset) is meant to seed a `symmetryFields.js` Field's
 * `centre`/`rotationOffset`/`fold` at authoring time — a one-shot detect,
 * not a per-frame call. Wiring for that hand-off belongs in whatever
 * screen owns the Field editor; nothing here should be imported by
 * `src/v3/lw-show.jsx`.
 *
 * ## Algorithm
 * 1. `shapeSignatures` samples each sub-path/layer into `sampleCount`
 *    points and reduces it to a per-shape signature: centroid, area
 *    (shoelace over the samples), perimeter length, and bboxRadius (max
 *    sample distance from the shape's own centroid).
 * 2. `estimateCentre` guesses the rotation centre from an area-weighted
 *    centroid of the longest 60% of shapes (by path length — this keeps a
 *    signature path or mounting holes from dragging the centre off), then
 *    refines it over two passes of a 5x5 grid search at +/-2% of the
 *    bounding radius, picking whichever grid point makes SOME fold score
 *    best (the true centre is the one under which some rotation explains
 *    the most weighted-by-length material).
 * 3. `scoreFold` tests one candidate fold count `n`: rotate every shape's
 *    centroid by `2*PI/n` about the centre and nearest-neighbour match it
 *    to another shape. A match counts only when centroid distance, radius
 *    delta, length delta, and area delta are all within tolerance. The
 *    score is the total length of matched shapes over total length — big
 *    shapes count more than dust.
 * 4. `detectArtworkSymmetry` scores every requested fold and prefers the
 *    LARGEST fold within 0.02 of the best score (an n-fold pattern is
 *    always also (n/2)-fold, (n/3)-fold, etc., so smaller divisors score
 *    well too; without this rule detection reports the smallest divisor,
 *    e.g. 2, instead of the real fold count).
 */

const TAU_INTERNAL = Math.PI * 2;
const EPS = 1e-9;

const DEFAULT_SAMPLE_COUNT = 64;
const DEFAULT_FOLDS = [2, 3, 4, 5, 6, 8, 10, 12];
const DEFAULT_TOLERANCE = 0.02;

const LENGTH_TOLERANCE = 0.05;
const AREA_TOLERANCE = 0.08;

const ASYMMETRIC_SCORE_THRESHOLD = 0.5;
const NEAR_MAX_WINDOW = 0.02;

const CENTRE_TOP_FRACTION = 0.6;
const CENTRE_SEARCH_GRID_RADIUS = 2; // -> a 5x5 grid, -2..2 steps each axis
const CENTRE_SEARCH_SPAN_FRACTION = 0.02; // +/-2% of bounding radius
const CENTRE_SEARCH_PASSES = 2;

const HIGH_CONFIDENCE = 0.9;
const MEDIUM_CONFIDENCE = 0.7;

function wrapTau(a) {
  let r = a % TAU_INTERNAL;
  if (r < 0) r += TAU_INTERNAL;
  return r;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function meanPoint(points) {
  let sx = 0, sy = 0;
  const n = points.length || 1;
  for (const p of points) { sx += p.x; sy += p.y; }
  return { x: sx / n, y: sy / n };
}

function shoelaceArea(points) {
  const n = points.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function perimeterLength(points) {
  const n = points.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    sum += dist(a, b);
  }
  return sum;
}

// Resample a closed polyline into `count` evenly arc-length-spaced points.
function resampleClosedPolyline(points, count) {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return new Array(count).fill(points[0]);
  const segLens = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = dist(points[i], points[(i + 1) % n]);
    segLens.push(d);
    total += d;
  }
  if (total < EPS) return new Array(count).fill(points[0]);
  const out = [];
  const step = total / count;
  let segIndex = 0;
  let segAccum = 0;
  for (let i = 0; i < count; i++) {
    const target = i * step;
    while (segIndex < n - 1 && segAccum + segLens[segIndex] < target) {
      segAccum += segLens[segIndex];
      segIndex++;
    }
    const a = points[segIndex];
    const b = points[(segIndex + 1) % n];
    const segLen = segLens[segIndex] || EPS;
    const t = Math.min(1, Math.max(0, (target - segAccum) / segLen));
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

function sampleSvgPathElement(layer, count) {
  const total = layer.getTotalLength();
  const pts = [];
  for (let i = 0; i < count; i++) {
    const p = layer.getPointAtLength((i / count) * total);
    pts.push({ x: p.x, y: p.y });
  }
  return pts;
}

function defaultSampler(layer, count) {
  if (layer && typeof layer.sample === 'function') return layer.sample(count);
  if (layer && Array.isArray(layer.points)) {
    const pts = layer.points.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
    return resampleClosedPolyline(pts, count);
  }
  if (layer && typeof layer.getTotalLength === 'function' && typeof layer.getPointAtLength === 'function') {
    return sampleSvgPathElement(layer, count);
  }
  throw new Error(
    `shapeSignatures: layer "${layer && layer.id}" has no .sample()/.points/getPointAtLength — ` +
      'pass opts.sampler to sample it headlessly.'
  );
}

/**
 * Per-sub-path signature: sampled points, centroid, shoelace area,
 * perimeter length, and bboxRadius (max sample distance from its own
 * centroid). `opts.sampler(layer, sampleCount) => [{x,y}, ...]` is the
 * injection point that makes this headless-testable — pass an analytic
 * sampler in tests instead of relying on the DOM-backed default.
 */
export function shapeSignatures(layers, opts = {}) {
  const sampleCount = opts.sampleCount || DEFAULT_SAMPLE_COUNT;
  const sampler = opts.sampler || defaultSampler;
  return (layers || []).map((layer, index) => {
    const points = sampler(layer, sampleCount) || [];
    const centroid = meanPoint(points);
    const area = shoelaceArea(points);
    const length = perimeterLength(points);
    let bboxRadius = 0;
    for (const p of points) bboxRadius = Math.max(bboxRadius, dist(p, centroid));
    return {
      id: layer && layer.id != null ? layer.id : `shape-${index}`,
      points,
      centroid,
      area,
      length,
      bboxRadius,
    };
  });
}

function radiusAngleAbout(sig, centre) {
  const dx = sig.centroid.x - centre.x;
  const dy = sig.centroid.y - centre.y;
  return { radius: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
}

/**
 * Scores one candidate fold count `n` about `centre`: rotate every
 * signature's centroid by 2*PI/n and nearest-neighbour match it against
 * the others. Returns the matched fraction, weighted by path length.
 */
export function scoreFold(sigs, centre, n, tol = DEFAULT_TOLERANCE) {
  if (!sigs || sigs.length === 0) return 0;
  const totalLength = sigs.reduce((sum, s) => sum + s.length, 0);
  if (totalLength < EPS) return 0;

  const rotation = TAU_INTERNAL / n;
  let matchedLength = 0;

  for (const s of sigs) {
    const { radius, angle } = radiusAngleAbout(s, centre);
    const targetAngle = angle + rotation;
    const target = {
      x: centre.x + radius * Math.cos(targetAngle),
      y: centre.y + radius * Math.sin(targetAngle),
    };

    let best = null;
    let bestDist = Infinity;
    for (const t of sigs) {
      if (t === s) continue;
      const d = dist(t.centroid, target);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    if (!best) continue;

    const radiusRef = Math.max(radius, EPS);
    const bestRadius = radiusAngleAbout(best, centre).radius;
    const dRadius = Math.abs(radius - bestRadius) / radiusRef;
    const dLength = Math.abs(s.length - best.length) / Math.max(s.length, EPS);
    const dArea = Math.abs(s.area - best.area) / Math.max(s.area, EPS);

    if (
      bestDist < tol * radiusRef &&
      dRadius < tol &&
      dLength < LENGTH_TOLERANCE &&
      dArea < AREA_TOLERANCE
    ) {
      matchedLength += s.length;
    }
  }

  return matchedLength / totalLength;
}

function bestFoldFitness(sigs, centre, folds, tol) {
  let best = 0;
  for (const n of folds) {
    const score = scoreFold(sigs, centre, n, tol);
    if (score > best) best = score;
  }
  return best;
}

/**
 * Estimates the rotation centre from the longest 60% of signatures (by
 * path length), then refines it over two passes of a 5x5 grid search at
 * +/-2% of the bounding radius — picking whichever nearby point makes the
 * best-scoring fold score best.
 */
export function estimateCentre(sigs) {
  if (!sigs || sigs.length === 0) return { x: 0, y: 0 };

  const sorted = [...sigs].sort((a, b) => b.length - a.length);
  const topCount = Math.max(1, Math.ceil(sorted.length * CENTRE_TOP_FRACTION));
  const top = sorted.slice(0, topCount);

  let weightSum = 0;
  let sx = 0;
  let sy = 0;
  for (const s of top) {
    const w = Math.max(s.area, EPS);
    weightSum += w;
    sx += s.centroid.x * w;
    sy += s.centroid.y * w;
  }
  let centre = weightSum > EPS
    ? { x: sx / weightSum, y: sy / weightSum }
    : meanPoint(top.map((s) => s.centroid));

  let boundingRadius = 0;
  for (const s of top) {
    boundingRadius = Math.max(boundingRadius, dist(s.centroid, centre) + s.bboxRadius);
  }
  if (boundingRadius < EPS) boundingRadius = 1;

  for (let pass = 0; pass < CENTRE_SEARCH_PASSES; pass++) {
    const span = CENTRE_SEARCH_SPAN_FRACTION * boundingRadius;
    const step = span / CENTRE_SEARCH_GRID_RADIUS;
    let bestCentre = centre;
    let bestFit = bestFoldFitness(top, centre, DEFAULT_FOLDS, DEFAULT_TOLERANCE);

    for (let gx = -CENTRE_SEARCH_GRID_RADIUS; gx <= CENTRE_SEARCH_GRID_RADIUS; gx++) {
      for (let gy = -CENTRE_SEARCH_GRID_RADIUS; gy <= CENTRE_SEARCH_GRID_RADIUS; gy++) {
        if (gx === 0 && gy === 0) continue;
        const candidate = { x: centre.x + gx * step, y: centre.y + gy * step };
        const fit = bestFoldFitness(top, candidate, DEFAULT_FOLDS, DEFAULT_TOLERANCE);
        if (fit > bestFit) {
          bestFit = fit;
          bestCentre = candidate;
        }
      }
    }
    centre = bestCentre;
  }

  return centre;
}

function confidenceFor(score) {
  if (score >= HIGH_CONFIDENCE) return 'high';
  if (score >= MEDIUM_CONFIDENCE) return 'medium';
  return 'low';
}

// phase = angle of the largest-area signature's centroid, mod 2*PI/n —
// wedge 0's rotation offset. First-encountered max wins so the result is
// deterministic for exactly-tied areas (true rotational copies).
function phaseForFold(sigs, centre, n) {
  if (!sigs || sigs.length === 0) return 0;
  let largest = sigs[0];
  for (const s of sigs) {
    if (s.area > largest.area) largest = s;
  }
  const { angle } = radiusAngleAbout(largest, centre);
  const base = TAU_INTERNAL / n;
  return wrapTau(angle) % base;
}

/**
 * Detects rotational symmetry in a set of artwork layers/sub-paths.
 * Always returns every requested fold, ranked, even when nothing matches
 * well — never silently picks a fold; the caller decides how to present
 * "closest: n-fold, x% matched" when `asymmetric` is true.
 */
export function detectArtworkSymmetry(layers, opts = {}) {
  const {
    folds = DEFAULT_FOLDS,
    tolerance = DEFAULT_TOLERANCE,
    centreSearch = true,
    sampleCount = DEFAULT_SAMPLE_COUNT,
    sampler,
  } = opts;

  const sigs = shapeSignatures(layers, { sampleCount, sampler });
  const centre = sigs.length === 0
    ? { x: 0, y: 0 }
    : centreSearch
      ? estimateCentre(sigs)
      : meanPoint(sigs.map((s) => s.centroid));

  const candidates = folds
    .map((n) => {
      const score = scoreFold(sigs, centre, n, tolerance);
      return {
        n,
        score,
        confidence: confidenceFor(score),
        centre,
        phase: phaseForFold(sigs, centre, n),
        matchedFraction: score,
      };
    })
    .sort((a, b) => (b.score - a.score) || (a.n - b.n));

  const maxScore = candidates.reduce((m, c) => Math.max(m, c.score), 0);
  const asymmetric = candidates.length === 0 || maxScore < ASYMMETRIC_SCORE_THRESHOLD;

  let best = null;
  if (!asymmetric) {
    for (const c of candidates) {
      if (c.score >= maxScore - NEAR_MAX_WINDOW) {
        if (!best || c.n > best.n) best = c;
      }
    }
  }

  return { candidates, best, centre, asymmetric };
}
