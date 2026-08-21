// svgFlatten.js — bake <g transform> and <use> instancing into absolute,
// self-contained <path> geometry so downstream code can keep reading raw
// geometry attributes and get the right answer.
//
// THE BUG THIS FIXES (not wired in yet — see "Intended wiring" below):
// `measureLayers()` / `shapeToD()` in layoutGeometry.js read ONLY the raw
// geometry attributes of each shape element (d / cx,cy,r / x,y,width,height
// / points / …). Any `<g transform="rotate(60)">` — the normal way a vector
// editor builds a six-fold mandala — imports at the wrong coordinates,
// because the group's rotation is silently ignored. And
// `querySelectorAll('path, rect, circle, ellipse, line, polyline, polygon')`
// never matches `<use>`, so a mandala drawn as one wedge plus five `<use>`
// clones imports as ONE SIXTH of the artwork — five wedges silently
// missing, with no error.
//
// WHAT THIS MODULE DOES: `flattenSvgDocument(doc)` returns a tree with zero
// remaining `<use>` elements (expanded against their `<symbol>`/`<defs>`/`<g>`
// targets, cycle-guarded) and zero remaining `transform` attributes — every
// primitive has been converted to a `<path>` whose `d` is already expressed
// in the SAME coordinate space as the outer `<svg>`. `<g data-name>` layer
// grouping (which measureLayers's own layer-detection heuristic depends on)
// is preserved untouched; only the geometry *inside* each group changes.
//
// INTENDED WIRING (a later pass owns layoutGeometry.js / useLayoutImport.js
// — NOT done here): before calling `measureLayers(doc)`, first run
// `sanitizeSvgSource()` (svgSanitize.js) on the raw imported text, reparse
// it, then run `flattenSvgDocument(doc)` from this file, and hand its
// `.root` (or a document wrapping it) to `measureLayers` instead of the raw
// parsed doc. `shapeToD`/`measureLayers` need no changes themselves — the
// fix is entirely upstream of them, in what tree they're handed.
//
// Pure ESM, no React/DOM/audio dependency at module scope. Every function
// that walks a tree is written against a small duck-typed Element/Document
// interface (tagName/localName, getAttribute/setAttribute/removeAttribute,
// children, parentElement, ownerDocument.createElementNS, cloneNode,
// replaceChild/removeChild) — the exact method names a real browser DOM
// already has, so this runs unmodified against a real `document` and
// against the minimal stub in svgDomStub.js under `node --test` (see
// svgFlatten.test.js). The matrix math (parseTransform / multiplyMatrix /
// applyMatrixToPathData) needs no DOM at all and is the load-bearing part —
// it is tested directly, independent of any stub.

const SVG_NS = 'http://www.w3.org/2000/svg';

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

// Attributes that describe a primitive's own (pre-flatten) geometry, plus
// `transform` — excluded when copying attributes onto a freshly-built
// <path> replacement, since both are fully absorbed into the new `d`.
const GEOMETRY_ATTRS = new Set([
  'x', 'y', 'width', 'height', 'rx', 'ry',
  'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2',
  'points', 'd', 'transform',
]);

function tagOf(el) {
  const raw = (el && (el.tagName || el.localName)) || '';
  return String(raw).replace(/^[^:]+:/, '').toLowerCase();
}

// ── Matrix math (pure — no DOM) ─────────────────────────────────────────────

export const IDENTITY_MATRIX = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

// m1 × m2, i.e. "apply m2, then apply m1" to a point: (m1·m2)·p = m1·(m2·p).
export function multiplyMatrix(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

function mapPoint(m, x, y) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

const NUM_RE = /[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g;
function parseNums(str) {
  return (str.match(NUM_RE) || []).map(Number);
}

function transformFnToMatrix(name, n) {
  switch (name) {
    case 'matrix':
      if (n.length < 6 || n.slice(0, 6).some(Number.isNaN)) return null;
      return { a: n[0], b: n[1], c: n[2], d: n[3], e: n[4], f: n[5] };
    case 'translate': {
      if (n.length < 1 || Number.isNaN(n[0])) return null;
      return { a: 1, b: 0, c: 0, d: 1, e: n[0], f: n.length > 1 && !Number.isNaN(n[1]) ? n[1] : 0 };
    }
    case 'scale': {
      if (n.length < 1 || Number.isNaN(n[0])) return null;
      const sy = n.length > 1 && !Number.isNaN(n[1]) ? n[1] : n[0];
      return { a: n[0], b: 0, c: 0, d: sy, e: 0, f: 0 };
    }
    case 'rotate': {
      if (n.length < 1 || Number.isNaN(n[0])) return null;
      const rad = (n[0] * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rot = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      if (n.length >= 3 && !Number.isNaN(n[1]) && !Number.isNaN(n[2])) {
        const [cx, cy] = [n[1], n[2]];
        const toOrigin = { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy };
        const fromOrigin = { a: 1, b: 0, c: 0, d: 1, e: cx, f: cy };
        return multiplyMatrix(multiplyMatrix(fromOrigin, rot), toOrigin);
      }
      return rot;
    }
    case 'skewx':
      if (n.length < 1 || Number.isNaN(n[0])) return null;
      return { a: 1, b: 0, c: Math.tan((n[0] * Math.PI) / 180), d: 1, e: 0, f: 0 };
    case 'skewy':
      if (n.length < 1 || Number.isNaN(n[0])) return null;
      return { a: 1, b: Math.tan((n[0] * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
    default:
      return null;
  }
}

const TRANSFORM_FN_RE = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

// Garbage-in-safe: an unparseable or empty string returns the identity
// matrix, never throws. Multiple functions in one attribute compose
// left-to-right in listed order (translate(...) rotate(...) == translate
// applied first, matching the SVG spec).
export function parseTransform(str) {
  if (!str || typeof str !== 'string') return { ...IDENTITY_MATRIX };
  let composite = { ...IDENTITY_MATRIX };
  TRANSFORM_FN_RE.lastIndex = 0;
  let match;
  while ((match = TRANSFORM_FN_RE.exec(str))) {
    const m = transformFnToMatrix(match[1].toLowerCase(), parseNums(match[2]));
    if (m) composite = multiplyMatrix(composite, m);
  }
  return composite;
}

// Walks el.parentElement up to the root, composing every ancestor's
// (including el's own) `transform` attribute in root-to-self order, so the
// result maps el's LOCAL coordinates directly into the outer <svg>'s
// coordinate space. An element with no transformed ancestors returns the
// identity matrix.
export function accumulatedMatrix(el) {
  const chain = [];
  let node = el;
  let guard = 0;
  while (node && guard < 1000) {
    chain.push(node);
    node = node.parentElement || null;
    guard += 1;
  }
  let composite = { ...IDENTITY_MATRIX };
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const raw = typeof chain[i].getAttribute === 'function' ? chain[i].getAttribute('transform') : null;
    composite = multiplyMatrix(composite, parseTransform(raw));
  }
  return composite;
}

// True when m maps every point to itself. Worth asking, because a shape
// under the identity needs no rewriting at all — and rewriting it anyway
// would silently renormalise perfectly good path data (`H`/`V` collapsing
// to `L`, relative commands going absolute, coordinates rounding), which
// changes stored geometry text for artwork that had nothing wrong with it.
export function isIdentityMatrix(m, tolerance = 1e-9) {
  if (!m) return false;
  return Math.abs(m.a - 1) <= tolerance
    && Math.abs(m.b) <= tolerance
    && Math.abs(m.c) <= tolerance
    && Math.abs(m.d - 1) <= tolerance
    && Math.abs(m.e) <= tolerance
    && Math.abs(m.f) <= tolerance;
}

export function matrixDeterminant(m) {
  return m.a * m.d - m.b * m.c;
}

// True when m is a similarity transform — rotation + translation + uniform
// scale, with or without a reflection (det<0). This is what a mandala's
// authored <g transform="rotate(60 cx cy)"> always is. Non-uniform scale or
// skew makes it false.
export function isRigidMatrix(m, tolerance = 1e-6) {
  const len1 = Math.hypot(m.a, m.b);
  const len2 = Math.hypot(m.c, m.d);
  if (len1 < 1e-9 || len2 < 1e-9) return false;
  const dot = m.a * m.c + m.b * m.d;
  const orthogonality = Math.abs(dot) / (len1 * len2);
  const scaleRatio = Math.abs(len2 / len1 - 1);
  return orthogonality < tolerance && scaleRatio < tolerance;
}

export function matrixScaleFactor(m) {
  return Math.hypot(m.a, m.b);
}

export function matrixRotationDeg(m) {
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

// ── Elliptical arc → cubic Bézier subdivision (SVG spec Appendix F.6) ──────
// Used only when the accumulated matrix is NOT rigid (shear / non-uniform
// scale), because an ellipse under a general affine map is only exactly
// representable as an SVG arc when the map is a similarity transform.
// Bézier curves ARE affine-invariant, so subdividing first and mapping the
// control points afterward is exact for the subdivision's own approximation
// of the ellipse (same tolerance any arc-to-bezier renderer already has).
function endpointToCenter(x0, y0, rx, ry, phiDeg, laf, sf, x, y) {
  if (!rx || !ry) return null;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  let rxs = rx * rx;
  let rys = ry * ry;
  const x1ps = x1p * x1p;
  const y1ps = y1p * y1p;
  const lambda = x1ps / rxs + y1ps / rys;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    rxs = rx * rx;
    rys = ry * ry;
  }
  const sign = laf !== sf ? 1 : -1;
  const denom = rxs * y1ps + rys * x1ps || 1e-12;
  let num = rxs * rys - rxs * y1ps - rys * x1ps;
  if (num < 0) num = 0;
  const co = sign * Math.sqrt(num / denom);
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  const vecAngle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy)) || 1e-12;
    let ang = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) ang = -ang;
    return ang;
  };
  const theta1 = vecAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = vecAngle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sf && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sf && dtheta < 0) dtheta += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, theta1, dtheta };
}

function segmentToBezier(cx, cy, rx, ry, phi, theta1, theta2) {
  const alpha = (4 / 3) * Math.tan((theta2 - theta1) / 4);
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const point = (t) => {
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    return { x: cx + cosPhi * ex - sinPhi * ey, y: cy + sinPhi * ex + cosPhi * ey };
  };
  const deriv = (t) => {
    const ex = -rx * Math.sin(t);
    const ey = ry * Math.cos(t);
    return { x: cosPhi * ex - sinPhi * ey, y: sinPhi * ex + cosPhi * ey };
  };
  const p1 = point(theta1);
  const p2 = point(theta2);
  const d1 = deriv(theta1);
  const d2 = deriv(theta2);
  return {
    cp1: { x: p1.x + alpha * d1.x, y: p1.y + alpha * d1.y },
    cp2: { x: p2.x - alpha * d2.x, y: p2.y - alpha * d2.y },
    end: p2,
  };
}

// Returns an array of {cp1,cp2,end} cubic segments in the ORIGINAL
// (untransformed) coordinate space, or null when the arc is degenerate
// (rx or ry is 0 — a straight line, handled by the caller).
export function arcToCubicBeziers(x0, y0, rx, ry, xAxisRotationDeg, largeArcFlag, sweepFlag, x, y) {
  const params = endpointToCenter(x0, y0, rx, ry, xAxisRotationDeg, !!largeArcFlag, !!sweepFlag, x, y);
  if (!params) return null;
  const { cx, cy, rx: rxA, ry: ryA, phi, theta1, dtheta } = params;
  const segments = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2 + 1e-6)));
  const delta = dtheta / segments;
  const out = [];
  let t = theta1;
  for (let i = 0; i < segments; i += 1) {
    const t2 = t + delta;
    out.push(segmentToBezier(cx, cy, rxA, ryA, phi, t, t2));
    t = t2;
  }
  return out;
}

// ── Path data: absolutize + fully expand shorthand, then map every point ───

const PATH_TOKEN_RE = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g;
const PATH_ARG_COUNTS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

// Parses `d` into a flat list of fully-explicit absolute segments:
// {cmd:'M'|'L', x, y} | {cmd:'C', x1,y1,x2,y2,x,y} | {cmd:'Q', x1,y1,x,y} |
// {cmd:'A', x0,y0 (start point), rx,ry,xrot,laf,sf, x,y} | {cmd:'Z'}.
// H/V become L; S/T are expanded to C/Q using the real (pre-transform)
// reflected control point, since matrix mapping and the "reflect about
// current point" construction commute under any affine map. Never throws —
// a malformed tail is simply dropped, same tolerance as the rest of the
// pattern/geometry pipeline in this codebase.
export function absolutizePath(d) {
  const tokens = String(d || '').match(PATH_TOKEN_RE) || [];
  const isCommand = (t) => /^[a-zA-Z]$/.test(t);
  const segments = [];
  let i = 0;
  let cmd = null;
  let cur = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  let prevCtrl = null; // { type: 'C' | 'Q', x, y } — last curve's final control point

  while (i < tokens.length) {
    if (isCommand(tokens[i])) {
      cmd = tokens[i];
      i += 1;
    }
    if (!cmd) break;
    const upper = cmd.toUpperCase();

    if (upper === 'Z') {
      segments.push({ cmd: 'Z' });
      cur = { ...subpathStart };
      prevCtrl = null;
      cmd = null;
      continue;
    }

    const count = PATH_ARG_COUNTS[upper];
    if (count === undefined) break;
    if (i + count > tokens.length) break;
    const raw = tokens.slice(i, i + count).map(Number);
    if (raw.some(Number.isNaN)) break;
    i += count;
    const relative = cmd !== upper;

    switch (upper) {
      case 'M': {
        const px = relative ? cur.x + raw[0] : raw[0];
        const py = relative ? cur.y + raw[1] : raw[1];
        segments.push({ cmd: 'M', x: px, y: py });
        cur = { x: px, y: py };
        subpathStart = { ...cur };
        prevCtrl = null;
        cmd = relative ? 'l' : 'L'; // implicit repeats after M are lineto
        break;
      }
      case 'L': {
        const px = relative ? cur.x + raw[0] : raw[0];
        const py = relative ? cur.y + raw[1] : raw[1];
        segments.push({ cmd: 'L', x: px, y: py });
        cur = { x: px, y: py };
        prevCtrl = null;
        break;
      }
      case 'H': {
        const px = relative ? cur.x + raw[0] : raw[0];
        segments.push({ cmd: 'L', x: px, y: cur.y });
        cur = { x: px, y: cur.y };
        prevCtrl = null;
        break;
      }
      case 'V': {
        const py = relative ? cur.y + raw[0] : raw[0];
        segments.push({ cmd: 'L', x: cur.x, y: py });
        cur = { x: cur.x, y: py };
        prevCtrl = null;
        break;
      }
      case 'C': {
        let [x1, y1, x2, y2, x, y] = raw;
        if (relative) { x1 += cur.x; y1 += cur.y; x2 += cur.x; y2 += cur.y; x += cur.x; y += cur.y; }
        segments.push({ cmd: 'C', x1, y1, x2, y2, x, y });
        cur = { x, y };
        prevCtrl = { type: 'C', x: x2, y: y2 };
        break;
      }
      case 'S': {
        let [x2, y2, x, y] = raw;
        if (relative) { x2 += cur.x; y2 += cur.y; x += cur.x; y += cur.y; }
        const reflected = prevCtrl && prevCtrl.type === 'C'
          ? { x: 2 * cur.x - prevCtrl.x, y: 2 * cur.y - prevCtrl.y }
          : { ...cur };
        segments.push({ cmd: 'C', x1: reflected.x, y1: reflected.y, x2, y2, x, y });
        cur = { x, y };
        prevCtrl = { type: 'C', x: x2, y: y2 };
        break;
      }
      case 'Q': {
        let [x1, y1, x, y] = raw;
        if (relative) { x1 += cur.x; y1 += cur.y; x += cur.x; y += cur.y; }
        segments.push({ cmd: 'Q', x1, y1, x, y });
        cur = { x, y };
        prevCtrl = { type: 'Q', x: x1, y: y1 };
        break;
      }
      case 'T': {
        let [x, y] = raw;
        if (relative) { x += cur.x; y += cur.y; }
        const reflected = prevCtrl && prevCtrl.type === 'Q'
          ? { x: 2 * cur.x - prevCtrl.x, y: 2 * cur.y - prevCtrl.y }
          : { ...cur };
        segments.push({ cmd: 'Q', x1: reflected.x, y1: reflected.y, x, y });
        cur = { x, y };
        prevCtrl = { type: 'Q', x: reflected.x, y: reflected.y };
        break;
      }
      case 'A': {
        let [rx, ry, xrot, laf, sf, x, y] = raw;
        if (relative) { x += cur.x; y += cur.y; }
        segments.push({
          cmd: 'A', x0: cur.x, y0: cur.y,
          rx, ry, xrot, laf: laf ? 1 : 0, sf: sf ? 1 : 0, x, y,
        });
        cur = { x, y };
        prevCtrl = null;
        break;
      }
      default:
        break;
    }
  }

  return segments;
}

function fmt(n) {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
}

// The one function that answers "what does this path look like once its
// ancestor <g transform>s are baked in". Absolutizes+expands `d` first
// (absolutizePath), then maps every resulting point through the matrix.
// Lines/curves/moves are affine-invariant, so their control points are
// simply mapped directly. Arcs are special: under a RIGID matrix (rotation
// + translation + uniform scale — what mandala transforms actually are) an
// arc transforms exactly by scaling rx/ry, adding the matrix's rotation to
// the arc's x-axis-rotation, and flipping the sweep flag when det(m) < 0.
// Under a general matrix the arc is first subdivided into cubic Béziers
// (arcToCubicBeziers) in its original space, then each control point is
// mapped — exact for that subdivision, since Béziers are affine-invariant
// and ellipses under a shear are not representable as a single SVG arc.
export function applyMatrixToPathData(d, m) {
  const segments = absolutizePath(d);
  const rigid = isRigidMatrix(m);
  const scale = rigid ? matrixScaleFactor(m) : null;
  const rotationDeg = rigid ? matrixRotationDeg(m) : null;
  const det = matrixDeterminant(m);
  const out = [];

  for (const seg of segments) {
    if (seg.cmd === 'Z') { out.push('Z'); continue; }
    if (seg.cmd === 'M' || seg.cmd === 'L') {
      const p = mapPoint(m, seg.x, seg.y);
      out.push(`${seg.cmd} ${fmt(p.x)},${fmt(p.y)}`);
      continue;
    }
    if (seg.cmd === 'C') {
      const p1 = mapPoint(m, seg.x1, seg.y1);
      const p2 = mapPoint(m, seg.x2, seg.y2);
      const p = mapPoint(m, seg.x, seg.y);
      out.push(`C ${fmt(p1.x)},${fmt(p1.y)} ${fmt(p2.x)},${fmt(p2.y)} ${fmt(p.x)},${fmt(p.y)}`);
      continue;
    }
    if (seg.cmd === 'Q') {
      const p1 = mapPoint(m, seg.x1, seg.y1);
      const p = mapPoint(m, seg.x, seg.y);
      out.push(`Q ${fmt(p1.x)},${fmt(p1.y)} ${fmt(p.x)},${fmt(p.y)}`);
      continue;
    }
    if (seg.cmd === 'A') {
      if (Math.abs(seg.rx) < 1e-9 || Math.abs(seg.ry) < 1e-9) {
        const p = mapPoint(m, seg.x, seg.y);
        out.push(`L ${fmt(p.x)},${fmt(p.y)}`);
        continue;
      }
      if (rigid) {
        const p = mapPoint(m, seg.x, seg.y);
        const newRx = Math.abs(seg.rx * scale);
        const newRy = Math.abs(seg.ry * scale);
        const newXrot = ((seg.xrot + rotationDeg) % 360 + 360) % 360;
        const newSweep = det < 0 ? (seg.sf ? 0 : 1) : seg.sf;
        out.push(`A ${fmt(newRx)},${fmt(newRy)} ${fmt(newXrot)} ${seg.laf},${newSweep} ${fmt(p.x)},${fmt(p.y)}`);
        continue;
      }
      const beziers = arcToCubicBeziers(seg.x0, seg.y0, seg.rx, seg.ry, seg.xrot, seg.laf, seg.sf, seg.x, seg.y);
      if (!beziers) {
        const p = mapPoint(m, seg.x, seg.y);
        out.push(`L ${fmt(p.x)},${fmt(p.y)}`);
        continue;
      }
      for (const b of beziers) {
        const cp1 = mapPoint(m, b.cp1.x, b.cp1.y);
        const cp2 = mapPoint(m, b.cp2.x, b.cp2.y);
        const end = mapPoint(m, b.end.x, b.end.y);
        out.push(`C ${fmt(cp1.x)},${fmt(cp1.y)} ${fmt(cp2.x)},${fmt(cp2.y)} ${fmt(end.x)},${fmt(end.y)}`);
      }
      continue;
    }
  }

  return out.join(' ');
}

// ── <use> expansion ─────────────────────────────────────────────────────────

function findElementById(root, id) {
  if (!root) return null;
  if ((root.getAttribute?.('id') || '') === id) return root;
  for (const child of root.children || []) {
    const found = findElementById(child, id);
    if (found) return found;
  }
  return null;
}

function createSvgElement(doc, referenceEl, tag) {
  const ownerDoc = (doc && typeof doc.createElementNS === 'function') ? doc
    : (referenceEl && referenceEl.ownerDocument) || doc;
  if (ownerDoc && typeof ownerDoc.createElementNS === 'function') return ownerDoc.createElementNS(SVG_NS, tag);
  if (ownerDoc && typeof ownerDoc.createElement === 'function') return ownerDoc.createElement(tag);
  throw new Error('svgFlatten: no document available to create SVG elements');
}

// Replaces every <use> under svgRoot with a <g> wrapping a deep clone of its
// #href target (carrying the use's own transform plus an x/y translate),
// recursively — so a clone that itself contains a <use> gets expanded too.
// MUST run before matrix accumulation (accumulatedMatrix only ever sees
// <g>/shape elements, never <use>, once this has run). Guards cycles with a
// visited-id stack threaded through the recursion (A -> B -> A is caught
// however many nested clones deep A and B live at) and caps total
// expansions and nesting depth so a pathological or hostile file can't blow
// up memory/CPU.
export function expandUses(svgRoot, { maxDepth = 4, maxExpansions = 2000 } = {}) {
  const warnings = [];
  let expansions = 0;
  let depthWarned = false;
  let cappedWarned = false;

  function expandInto(node, visitedIds, depth) {
    const kids = Array.from(node.children || []);
    for (const child of kids) {
      const tag = tagOf(child);
      if (tag !== 'use') {
        expandInto(child, visitedIds, depth);
        continue;
      }

      if (expansions >= maxExpansions) {
        if (!cappedWarned) {
          warnings.push(`Reached the maximum of ${maxExpansions} <use> expansions; remaining clones were left unexpanded.`);
          cappedWarned = true;
        }
        continue;
      }

      const hrefRaw = (child.getAttribute('href') ?? child.getAttribute('xlink:href') ?? '').trim();
      const targetId = hrefRaw.replace(/^#/, '');
      if (!targetId) {
        warnings.push('Dropped a <use> element with no (or an unsupported) href.');
        node.removeChild?.(child);
        continue;
      }
      if (visitedIds.includes(targetId)) {
        warnings.push(`Skipped a <use> referencing "#${targetId}" — it is its own ancestor (cycle).`);
        node.removeChild?.(child);
        continue;
      }
      if (depth >= maxDepth) {
        if (!depthWarned) {
          warnings.push(`Reached the maximum <use> nesting depth (${maxDepth}); left "#${targetId}" unexpanded.`);
          depthWarned = true;
        }
        continue;
      }

      const target = findElementById(svgRoot, targetId);
      if (!target) {
        warnings.push(`Dropped a <use> referencing missing id "#${targetId}".`);
        node.removeChild?.(child);
        continue;
      }
      if (target === child) {
        warnings.push(`Skipped a <use> referencing "#${targetId}" — it is its own ancestor (cycle).`);
        node.removeChild?.(child);
        continue;
      }

      const clone = target.cloneNode(true);
      expansions += 1;

      const doc = child.ownerDocument || node.ownerDocument || svgRoot.ownerDocument;
      const wrapper = createSvgElement(doc, node, 'g');
      // Marks this <g> as an instanced COPY, not a group the artist drew.
      // Layer detection downstream (measureLayers) uses it to tell "this
      // layer contains several sub-layers" from "this layer contains one
      // motif repeated six times" — without it, a single named layer
      // holding a six-fold mandala would break apart into six layers the
      // moment expansion started working.
      wrapper.setAttribute('data-lw-instance', '1');
      const x = parseFloat(child.getAttribute('x') || '0') || 0;
      const y = parseFloat(child.getAttribute('y') || '0') || 0;
      const ownTransform = child.getAttribute('transform') || '';
      const translatePart = x || y ? `translate(${x} ${y})` : '';
      const combinedTransform = [ownTransform, translatePart].filter(Boolean).join(' ');
      if (combinedTransform) wrapper.setAttribute('transform', combinedTransform);
      const sourceId = child.getAttribute('id');
      if (sourceId) wrapper.setAttribute('data-expanded-from', sourceId);
      // Carry the <use>'s own layer name onto the wrapper. Downstream layer
      // detection (measureLayers) groups by `<g data-name>`, so a named
      // instance must not lose its name on the way through expansion.
      const sourceName = child.getAttribute('data-name');
      if (sourceName) wrapper.setAttribute('data-name', sourceName);

      // A <symbol> (or a <use> that targets a nested <svg>) doesn't render
      // itself — only its children do — so unwrap it into the wrapper.
      const targetTag = tagOf(target);
      const contentChildren = targetTag === 'symbol' || targetTag === 'svg'
        ? Array.from(clone.children || [])
        : [clone];
      for (const c of contentChildren) wrapper.appendChild(c);

      if (typeof node.replaceChild === 'function') {
        node.replaceChild(wrapper, child);
      }

      expandInto(wrapper, [...visitedIds, targetId], depth + 1);
    }
  }

  expandInto(svgRoot, [], 0);
  return { root: svgRoot, warnings, expansions };
}

// ── Primitive → path conversion (self-contained; intentionally mirrors the
// same algorithm as shapeToD() in layoutGeometry.js, NOT imported from it —
// this module stays independent of layoutGeometry.js per the ownership
// split for tonight's session) ──────────────────────────────────────────────

function numAttr(el, name) {
  const v = parseFloat(el.getAttribute(name) ?? '0');
  return Number.isFinite(v) ? v : 0;
}

function primitiveToPathD(el, tag) {
  switch (tag) {
    case 'path':
      return el.getAttribute('d') || '';
    case 'rect': {
      const x = numAttr(el, 'x');
      const y = numAttr(el, 'y');
      const w = numAttr(el, 'width');
      const h = numAttr(el, 'height');
      if (!w || !h) return '';
      const rxAttr = el.getAttribute('rx');
      const ryAttr = el.getAttribute('ry');
      let rx = parseFloat(rxAttr ?? ryAttr ?? '0');
      let ry = parseFloat(ryAttr ?? rxAttr ?? '0');
      if (!Number.isFinite(rx)) rx = 0;
      if (!Number.isFinite(ry)) ry = 0;
      rx = Math.min(Math.abs(rx), w / 2);
      ry = Math.min(Math.abs(ry), h / 2);
      if (rx || ry) {
        return `M ${x + rx},${y} H ${x + w - rx} A ${rx},${ry} 0 0 1 ${x + w},${y + ry}`
          + ` V ${y + h - ry} A ${rx},${ry} 0 0 1 ${x + w - rx},${y + h}`
          + ` H ${x + rx} A ${rx},${ry} 0 0 1 ${x},${y + h - ry}`
          + ` V ${y + ry} A ${rx},${ry} 0 0 1 ${x + rx},${y} Z`;
      }
      return `M ${x},${y} H ${x + w} V ${y + h} H ${x} Z`;
    }
    case 'circle': {
      const cx = numAttr(el, 'cx');
      const cy = numAttr(el, 'cy');
      const r = numAttr(el, 'r');
      if (!r) return '';
      return `M ${cx - r},${cy} A ${r},${r} 0 1 0 ${cx + r},${cy} A ${r},${r} 0 1 0 ${cx - r},${cy} Z`;
    }
    case 'ellipse': {
      const cx = numAttr(el, 'cx');
      const cy = numAttr(el, 'cy');
      const rx = numAttr(el, 'rx');
      const ry = numAttr(el, 'ry');
      if (!rx || !ry) return '';
      return `M ${cx - rx},${cy} A ${rx},${ry} 0 1 0 ${cx + rx},${cy} A ${rx},${ry} 0 1 0 ${cx - rx},${cy} Z`;
    }
    case 'line':
      return `M ${numAttr(el, 'x1')},${numAttr(el, 'y1')} L ${numAttr(el, 'x2')},${numAttr(el, 'y2')}`;
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number)
        .filter((v, i, a) => !Number.isNaN(v) && i < a.length - (a.length % 2 ? 1 : 0));
      if (pts.length < 4) return '';
      let dOut = `M ${pts[0]},${pts[1]}`;
      for (let i = 2; i < pts.length; i += 2) dOut += ` L ${pts[i]},${pts[i + 1]}`;
      if (tag === 'polygon') dOut += ' Z';
      return dOut;
    }
    default:
      return '';
  }
}

function convertShapeToPath(doc, el, tag, transformedD) {
  if (tag === 'path') {
    el.setAttribute('d', transformedD);
    el.removeAttribute('transform');
    return el;
  }
  const parent = el.parentElement;
  const pathEl = createSvgElement(doc, el, 'path');
  for (const attr of [...(el.attributes || [])]) {
    if (GEOMETRY_ATTRS.has(attr.name.toLowerCase())) continue;
    pathEl.setAttribute(attr.name, attr.value);
  }
  pathEl.setAttribute('d', transformedD);
  if (parent && typeof parent.replaceChild === 'function') {
    parent.replaceChild(pathEl, el);
  }
  return pathEl;
}

// ── Top-level entry point ───────────────────────────────────────────────────

// flattenSvgDocument(doc, opts) -> { ok, reason?, root, warnings[] }
//
// `doc` is anything with a `.querySelector('svg')` (a Document, real or
// stub) — or an <svg> element itself. `opts.maxDepth`/`opts.maxExpansions`
// pass through to expandUses.
//
// Never throws. Converts circle/ellipse/rect(incl. rounded)/line/
// polyline/polygon to <path>, expands every <use>, bakes every ancestor
// <g transform> into each shape's `d`, and strips `transform` everywhere
// (its effect has been fully absorbed by then). Drops <image>/<text>/
// <foreignObject> with a warning (none are convertible to LED path
// geometry). Does NOT apply clip-path/mask — their geometric effect is
// ignored, and a warning is recorded so the caller can surface it; run
// sanitizeSvgSource() first if the source is untrusted (this module does no
// sanitization of its own — see svgSanitize.js).
export function flattenSvgDocument(doc, opts = {}) {
  const warnings = [];

  let svgRoot = null;
  if (doc && typeof doc.querySelector === 'function') {
    svgRoot = doc.querySelector('svg');
  } else if (doc && typeof doc.getAttribute === 'function' && tagOf(doc) === 'svg') {
    svgRoot = doc;
  }
  if (!svgRoot) {
    return { ok: false, reason: 'No <svg> root element found.', root: null, warnings };
  }

  const useResult = expandUses(svgRoot, {
    maxDepth: opts.maxDepth ?? 4,
    maxExpansions: opts.maxExpansions ?? 2000,
  });
  warnings.push(...useResult.warnings);

  const rootDoc = svgRoot.ownerDocument || (typeof doc?.createElementNS === 'function' ? doc : null);

  function processElement(el) {
    const tag = tagOf(el);

    if (tag === 'defs' || tag === 'symbol') return; // never rendered directly; leave untouched

    if (tag === 'image' || tag === 'foreignobject') {
      warnings.push(`Dropped unsupported <${tag}> element (not convertible to LED path geometry).`);
      el.parentElement?.removeChild?.(el);
      return;
    }
    if (tag === 'text') {
      warnings.push('Dropped <text> element (text is not convertible to LED path geometry).');
      el.parentElement?.removeChild?.(el);
      return;
    }
    if (el.getAttribute?.('clip-path') || el.getAttribute?.('mask')) {
      warnings.push('Ignored clip-path/mask on an element; its full unclipped geometry was used.');
    }

    if (SHAPE_TAGS.has(tag)) {
      const matrix = accumulatedMatrix(el);
      // Nothing to bake in. Emit the primitive's own path data unchanged —
      // for a <path> that means leaving the exporter's `d` exactly as
      // written, and for a rect/circle/polygon it means the same string the
      // old un-flattened reader produced. Running it through the matrix
      // pipeline anyway would renormalise perfectly good geometry (`H`/`V`
      // collapsing to `L`, relatives going absolute, coordinates rounding)
      // for every ordinary flat SVG, to no benefit.
      const identity = isIdentityMatrix(matrix);
      if (tag === 'path' && identity) {
        el.removeAttribute?.('transform');
        return;
      }
      const rawD = primitiveToPathD(el, tag);
      if (rawD) {
        convertShapeToPath(rootDoc, el, tag, identity ? rawD : applyMatrixToPathData(rawD, matrix));
      }
      return;
    }

    for (const child of Array.from(el.children || [])) processElement(child);
    el.removeAttribute?.('transform');
  }

  for (const child of Array.from(svgRoot.children || [])) processElement(child);
  svgRoot.removeAttribute?.('transform');

  return { ok: true, root: svgRoot, warnings };
}
