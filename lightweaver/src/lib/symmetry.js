/**
 * symmetry.js — coordinate transforms for mirror, radial, and kaleidoscope effects.
 * All functions take normalized (x, y) in 0–1 space and return transformed (x, y).
 */

function polarFromCenter(x, y, cx = 0.5, cy = 0.5) {
  const dx = x - cx, dy = y - cy;
  return { r: Math.sqrt(dx * dx + dy * dy), a: Math.atan2(dy, dx) };
}

function fromPolar(r, a, cx = 0.5, cy = 0.5) {
  return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
}

const TAU = Math.PI * 2;
const EPS = 1e-6;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function maxDistanceToUnitSquare(axis, nx, ny) {
  const corners = [
    [0, 0], [1, 0], [0, 1], [1, 1],
  ];
  return Math.max(
    EPS,
    ...corners.map(([cx, cy]) => Math.abs((cx - axis.x1) * nx + (cy - axis.y1) * ny)),
  );
}

/** Mirror across horizontal axis (y = cy) */
function mirrorH(x, y, cx = 0.5, cy = 0.5) {
  return { x, y: y > cy ? 2 * cy - y : y };
}

/** Mirror across vertical axis (x = cx) */
function mirrorV(x, y, cx = 0.5, cy = 0.5) {
  return { x: x > cx ? 2 * cx - x : x, y };
}

/** Mirror across both axes */
function mirrorHV(x, y, cx = 0.5, cy = 0.5) {
  return { x: x > cx ? 2 * cx - x : x, y: y > cy ? 2 * cy - y : y };
}

function guideMirror(x, y, guide = {}) {
  const axis = guide.axis || { x1: 0.5, y1: 0, x2: 0.5, y2: 1 };
  const mode = guide.mode || 'fold';
  const dx = axis.x2 - axis.x1;
  const dy = axis.y2 - axis.y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < EPS) return { x, y, side: 0 };

  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const signed = (x - axis.x1) * nx + (y - axis.y1) * ny;
  const maxDist = maxDistanceToUnitSquare(axis, nx, ny);
  const along = clamp01(((x - axis.x1) * ux + (y - axis.y1) * uy) / len);
  const guideField = (dist, extra = {}) => ({
    x: clamp01(dist / maxDist),
    y: along,
    progress: clamp01(dist / maxDist),
    side: signed,
    ...extra,
  });

  if (mode === 'reflect' || mode === 'fold') return guideField(Math.abs(signed));
  if (mode === 'split') return guideField(Math.abs(signed), { split: true });
  return { x, y, side: signed };
}

/** N-fold radial symmetry — map all pixels into the first wedge */
function radial(x, y, count, phase = 0, twist = 0, t = 0, cx = 0.5, cy = 0.5) {
  const { r, a } = polarFromCenter(x, y, cx, cy);
  const slice = TAU / count;
  // Normalize angle to [0, TAU) with phase offset + time-based twist
  const shifted = ((a + phase * TAU + twist * t * TAU) % TAU + TAU) % TAU;
  // Fold into first wedge
  const folded = shifted % slice;
  return fromPolar(r, folded, cx, cy);
}

/** Kaleidoscope — N-fold radial + mirror within each wedge */
function kaleido(x, y, slices, phase = 0, cx = 0.5, cy = 0.5) {
  const { r, a } = polarFromCenter(x, y, cx, cy);
  const slice = TAU / slices;
  const shifted = ((a + phase * TAU) % TAU + TAU) % TAU;
  let folded = shifted % slice;
  // Mirror alternate wedges
  const wedgeIdx = Math.floor(shifted / slice);
  if (wedgeIdx % 2 === 1) folded = slice - folded;
  return fromPolar(r, folded, cx, cy);
}

/**
 * Apply symmetry transform to (x, y) based on settings object.
 * @param {number} x  — normalized 0-1
 * @param {number} y  — normalized 0-1
 * @param {Object} settings — from ProjectContext.symSettings
 * @param {number} t  — time in seconds (for twist animation)
 * @returns {{ x: number, y: number }}
 */
export function applySymmetry(x, y, settings, t = 0) {
  if (!settings || !settings.enabled || settings.type === 'none') return { x, y };

  const { type, count = 8, slices = 6, phase = 0, twist = 0, guide, center } = settings;
  const cx = Number.isFinite(center?.x) ? center.x : 0.5;
  const cy = Number.isFinite(center?.y) ? center.y : 0.5;

  switch (type) {
    case 'mirror-h':  return mirrorH(x, y, cx, cy);
    case 'mirror-v':  return mirrorV(x, y, cx, cy);
    case 'mirror-hv': return mirrorHV(x, y, cx, cy);
    case 'guide-mirror': return guideMirror(x, y, guide);
    case 'radial':    return radial(x, y, count, phase, twist, t, cx, cy);
    case 'kaleido':   return kaleido(x, y, slices, phase, cx, cy);
    default:          return { x, y };
  }
}

/**
 * Suggest a symmetry center + repeat count from the physical LED layout.
 * Center is the bounding-box middle expressed in the same normalized 0–1 space
 * the renderer uses (both axes divided by the larger dimension). Repeat count
 * defaults to the number of strips — one "arm" per strip for a typical mandala.
 * @param {Array<{x:number,y:number}>} points — all LED points in artwork coords
 * @param {number} stripCount — number of strips (arms)
 * @returns {{ center: {x:number,y:number}, count: number }}
 */
export function computeSymmetryFit(points, stripCount = 1) {
  if (!points || points.length === 0) {
    return { center: { x: 0.5, y: 0.5 }, count: 8 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const range = Math.max(maxX - minX, maxY - minY, 1e-6);
  const center = {
    x: ((minX + maxX) / 2 - minX) / range,
    y: ((minY + maxY) / 2 - minY) / range,
  };
  const count = Math.max(3, Math.min(16, Math.round(stripCount) || 8));
  return { center, count };
}
