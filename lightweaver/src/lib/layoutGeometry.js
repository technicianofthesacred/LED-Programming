// Pure geometry / data-shaping helpers for the Layout screen — no React, no
// component state. Extracted verbatim from LayoutScreen.jsx (Phase 2 step 1
// of docs/layout-redesign-plan.md); behavior is unchanged, only the module
// boundary moved.
import { samplePath as libSamplePath } from './mapper.js';
import { LED_COUNT_MAX } from './controlScale.js';

// ── Strip identity helpers ─────────────────────────────────────────────────

// A strip owns its own `strip-<n>` id namespace, distinct from the artwork
// layer/path it was sampled from (recorded on `sourceLayerId`/`sourcePathId`).
// Legacy strips reused their source layer/path id as their own id, and several
// call sites relied on that coincidence to answer "which artwork does this strip
// come from?". `stripSourceKey` recovers that answer for both eras: the source
// path id (sub-path strips), else the source layer id (whole-layer strips), else
// the strip id itself (freehand/merged strips that have no artwork source) — so
// every coincidence-era comparison keeps identical behaviour.
export const stripSourceKey = strip => strip?.sourcePathId ?? strip?.sourceLayerId ?? strip?.id;

// Allocate the next collision-free `strip-<n>` id by scanning existing strips for
// the highest number in use. (The layout reducer carries `nextStripSeq` for a
// persistence-safe monotonic sequence; this scan is enough while layout state is
// still scattered useState.)
export function nextStripId(strips = []) {
  let max = 0;
  for (const strip of strips) {
    const match = /^strip-(\d+)$/.exec(strip?.id || '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `strip-${max + 1}`;
}

// ── Pure utility functions ─────────────────────────────────────────────────

export function shapeToD(el) {
  const tag = el.tagName.replace(/^[^:]+:/, '').toLowerCase();
  const n = a => parseFloat(el.getAttribute(a) || 0);
  switch (tag) {
    case 'path': return el.getAttribute('d') || '';
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      if (!w || !h) return '';
      let rx = parseFloat(el.getAttribute('rx') ?? el.getAttribute('ry') ?? 0);
      let ry = parseFloat(el.getAttribute('ry') ?? el.getAttribute('rx') ?? 0);
      rx = Math.min(Math.abs(rx), w / 2); ry = Math.min(Math.abs(ry), h / 2);
      if (rx || ry) {
        return `M ${x+rx},${y} H ${x+w-rx} A ${rx},${ry} 0 0 1 ${x+w},${y+ry}`
             + ` V ${y+h-ry} A ${rx},${ry} 0 0 1 ${x+w-rx},${y+h}`
             + ` H ${x+rx} A ${rx},${ry} 0 0 1 ${x},${y+h-ry}`
             + ` V ${y+ry} A ${rx},${ry} 0 0 1 ${x+rx},${y} Z`;
      }
      return `M ${x},${y} H ${x+w} V ${y+h} H ${x} Z`;
    }
    case 'circle': {
      const cx = n('cx'), cy = n('cy'), r = n('r');
      if (!r) return '';
      return `M ${cx-r},${cy} A ${r},${r} 0 1 0 ${cx+r},${cy} A ${r},${r} 0 1 0 ${cx-r},${cy} Z`;
    }
    case 'ellipse': {
      const cx = n('cx'), cy = n('cy'), rx = n('rx'), ry = n('ry');
      if (!rx || !ry) return '';
      return `M ${cx-rx},${cy} A ${rx},${ry} 0 1 0 ${cx+rx},${cy} A ${rx},${ry} 0 1 0 ${cx-rx},${cy} Z`;
    }
    case 'line': return `M ${n('x1')},${n('y1')} L ${n('x2')},${n('y2')}`;
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number)
        .filter((v, i, a) => !isNaN(v) && i < a.length - (a.length % 2 ? 1 : 0));
      if (pts.length < 4) return '';
      let d = `M ${pts[0]},${pts[1]}`;
      for (let i = 2; i < pts.length; i += 2) d += ` L ${pts[i]},${pts[i+1]}`;
      if (tag === 'polygon') d += ' Z';
      return d;
    }
    default: return '';
  }
}

export function splitCompoundPath(d) {
  const parts = d.match(/[Mm][^Mm]*/g);
  if (!parts || parts.length <= 1) return [d];
  return parts.map(p => p.trim()).filter(Boolean);
}

export function measurePathLen(d) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  return p.getTotalLength ? p.getTotalLength() : 0;
}

export function offsetPixels(pixels = [], dx = 0, dy = 0) {
  if (!dx && !dy) return pixels;
  return pixels.map(px => ({ ...px, x: px.x + dx, y: px.y + dy }));
}

export function offsetSamplePoints(points = [], dx = 0, dy = 0) {
  if (!dx && !dy) return points;
  return points.map(pt => ({ ...pt, x: pt.x + dx, y: pt.y + dy }));
}

export function offsetArrow(arrow, dx = 0, dy = 0) {
  if (!arrow || (!dx && !dy)) return arrow;
  const move = pt => ({ ...pt, x: pt.x + dx, y: pt.y + dy });
  return { tip: move(arrow.tip), left: move(arrow.left), right: move(arrow.right), start: move(arrow.start), end: move(arrow.end) };
}

export function pointsAttr(points = []) {
  return points.map(point => `${point.x},${point.y}`).join(' ');
}

export function escapeAttr(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function layerArtworkMarkup(layer) {
  const children = (layer.subPaths?.length ? layer.subPaths : [{
    pathId: layer.layerId,
    name: layer.name,
    pathData: layer.pathData,
  }])
    .filter(item => item.pathData)
    .map(item => (
      `<path id="${escapeAttr(item.pathId)}"` +
      ` data-artwork-path-id="${escapeAttr(item.pathId)}"` +
      ` d="${escapeAttr(item.pathData)}"` +
      ` fill="none" stroke="${escapeAttr(layer._color || 'currentColor')}"` +
      ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    ))
    .join('');

  return `<g id="${escapeAttr(layer.layerId)}" data-name="${escapeAttr(layer.name || layer.layerId)}">${children}</g>`;
}

export function actionablePolylinePoints(points = []) {
  if (points.length < 2) return points;
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const hasWidth = Math.max(...xs) - Math.min(...xs) > 0.01;
  const hasHeight = Math.max(...ys) - Math.min(...ys) > 0.01;
  if (hasWidth && hasHeight) return points;
  const next = points.map(point => ({ ...point }));
  const last = next[next.length - 1];
  if (!hasWidth) last.x += 0.05;
  if (!hasHeight) last.y += 0.05;
  return next;
}

export function translateStripFromStart(strip, dx, dy) {
  const nextX = (strip.x || 0) + dx;
  const nextY = (strip.y || 0) + dy;
  return {
    ...strip,
    x: nextX,
    y: nextY,
    pixels: sampleStripPixels(strip.pathData, strip.pixelCount, strip.reversed, nextX, nextY),
  };
}

export function sampleStripPixels(pathData, pixelCount, reversed = false, x = 0, y = 0) {
  const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathEl.setAttribute('d', pathData);
  let pixels = libSamplePath(pathEl, pixelCount);
  if (reversed) pixels = pixels.slice().reverse();
  return offsetPixels(pixels, x || 0, y || 0);
}

export function svgPathLength(pathData) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('d', pathData || '');
  return el.getTotalLength ? el.getTotalLength() : 0;
}

// Recompute every strip's LED count from (pxPerMm, density) using the
// canonical formula count = (svgLength / pxPerMm) * density / 1000.
export function recountStrips(strips, pxPerMm, density) {
  const scale = Number.isFinite(pxPerMm) && pxPerMm > 0 ? pxPerMm : 3.7795;
  return strips.map(s => {
    const len = (Number.isFinite(s.svgLength) && s.svgLength > 0)
      ? s.svgLength
      : svgPathLength(s.pathData);
    const count = Math.max(1, Math.round((len / scale) * density / 1000));
    return {
      ...s,
      svgLength: len,
      pixelCount: count,
      pixels: sampleStripPixels(s.pathData, count, s.reversed, s.x || 0, s.y || 0),
    };
  });
}

export function rgbCss(rgb, fallback = 'white') {
  if (!rgb) return fallback;
  const r = Math.round(rgb.r ?? rgb.avgR ?? 0);
  const g = Math.round(rgb.g ?? rgb.avgG ?? 0);
  const b = Math.round(rgb.b ?? rgb.avgB ?? 0);
  if (r + g + b <= 3) return fallback;
  return `rgb(${r} ${g} ${b})`;
}

export function clampLedCount(value, max = LED_COUNT_MAX) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(max, parsed));
}

export function translatePathData(pathData = '', dx = 0, dy = 0) {
  if (!pathData || (!dx && !dy)) return pathData;
  const tokens = pathData.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi) || [];
  const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
  const out = [];
  let i = 0;
  let command = '';
  const fmt = n => Number.parseFloat(Number(n).toFixed(3)).toString();
  const isCommand = token => /^[a-zA-Z]$/.test(token);
  const transform = (cmd, nums) => {
    const upper = cmd.toUpperCase();
    const absolute = cmd === upper;
    if (!absolute) return nums;
    const next = [...nums];
    if (upper === 'H') next[0] += dx;
    else if (upper === 'V') next[0] += dy;
    else if (upper === 'A') {
      next[5] += dx;
      next[6] += dy;
    } else {
      for (let j = 0; j < next.length; j += 2) {
        next[j] += dx;
        next[j + 1] += dy;
      }
    }
    return next;
  };
  while (i < tokens.length) {
    if (isCommand(tokens[i])) command = tokens[i++];
    if (!command) break;
    const upper = command.toUpperCase();
    if (upper === 'Z') {
      out.push(command);
      command = '';
      continue;
    }
    const count = counts[upper];
    if (!count) break;
    out.push(command);
    while (i < tokens.length && !isCommand(tokens[i])) {
      const nums = tokens.slice(i, i + count).map(Number);
      if (nums.length < count || nums.some(Number.isNaN)) break;
      out.push(...transform(command, nums).map(fmt));
      i += count;
      if (upper === 'M') command = command === 'M' ? 'L' : 'l';
    }
  }
  return out.join(' ');
}

export function pathIntersectsRect(pathData, minX, minY, maxX, maxY) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', pathData);
  const len = p.getTotalLength ? p.getTotalLength() : 0;
  if (!len) return false;
  const samples = Math.min(24, Math.max(6, Math.ceil(len / 40)));
  for (let i = 0; i <= samples; i++) {
    const { x, y } = p.getPointAtLength((i / samples) * len);
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) return true;
  }
  return false;
}

export function measureLayers(doc) {
  const srcSvg = doc.querySelector('svg');
  const SHAPES = 'path, rect, circle, ellipse, line, polyline, polygon';

  let groups = Array.from(srcSvg.children).filter(el => el.tagName === 'g' && el.hasAttribute('data-name'));
  if (!groups.length) groups = Array.from(srcSvg.children).filter(el => el.tagName === 'g');
  if (groups.length === 1) {
    const inner = Array.from(groups[0].children).filter(el => el.tagName === 'g');
    if (inner.length > 1) groups = inner;
  }

  if (!groups.length) {
    const shapes = Array.from(srcSvg.querySelectorAll(SHAPES));
    if (!shapes.length) return [];
    const pathData = shapes.map(el => shapeToD(el)).filter(Boolean).join(' ');
    return [{ layerId: 'all-shapes', name: 'Layer 1', pathData,
              svgLength: measurePathLen(pathData), subPaths: [] }];
  }

  return groups.map((g, i) => {
    const shapes   = Array.from(g.querySelectorAll(SHAPES));
    const pathData = shapes.map(el => shapeToD(el)).filter(Boolean).join(' ');
    const svgLength = measurePathLen(pathData);
    const name = g.getAttribute('data-name') || g.getAttribute('inkscape:label') || g.id || `Layer ${i + 1}`;
    const layerId = g.id || `layer-${i}`;

    let spIdx = 0;
    const subPaths = shapes.flatMap(el => {
      const pd = shapeToD(el);
      if (!pd) return [];
      return splitCompoundPath(pd).map(seg => ({
        pathId: `${layerId}-p${spIdx++}`,
        name: `Path ${spIdx}`,
        pathData: seg,
        svgLength: measurePathLen(seg),
      }));
    });

    return { layerId, name, pathData, svgLength, subPaths };
  });
}

export function getPxPerMm(srcSvg) {
  const vb = srcSvg.getAttribute('viewBox');
  if (!vb) return 3.7795;
  const parts = vb.trim().split(/[\s,]+/).map(Number);
  const vbW = parts[2];
  if (!vbW) return 3.7795;
  const w = srcSvg.getAttribute('width') || '';
  if (w.endsWith('mm')) return vbW / parseFloat(w);
  if (w.endsWith('cm')) return vbW / (parseFloat(w) * 10);
  if (w.endsWith('in')) return vbW / (parseFloat(w) * 25.4);
  if (w.endsWith('pt')) return vbW / (parseFloat(w) * 0.3528);
  return 3.7795;
}

export function calcArrow(pathData, reversed = false) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', pathData);
  const len = p.getTotalLength ? p.getTotalLength() : 0;
  if (len < 8) return null;
  const t = reversed ? 0.65 : 0.35;
  const dT = 0.025;
  const ptA = p.getPointAtLength((t - (reversed ? dT : -dT)) * len);
  const ptB = p.getPointAtLength((t + (reversed ? dT : -dT)) * len);
  const dx = ptB.x - ptA.x, dy = ptB.y - ptA.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  const mid = p.getPointAtLength(t * len);
  const sz = 7;
  const startLen = reversed ? len : 0;
  const endLen   = reversed ? 0   : len;
  return {
    tip:   { x: mid.x + ux * sz,                        y: mid.y + uy * sz },
    left:  { x: mid.x - ux * sz * 0.5 + uy * sz * 0.9, y: mid.y - uy * sz * 0.5 - ux * sz * 0.9 },
    right: { x: mid.x - ux * sz * 0.5 - uy * sz * 0.9, y: mid.y - uy * sz * 0.5 + ux * sz * 0.9 },
    start: p.getPointAtLength(startLen),
    end:   p.getPointAtLength(endLen),
  };
}

export function sampleForViz(pathData, count = 40) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', pathData);
  const len = p.getTotalLength ? p.getTotalLength() : 100;
  const n = Math.max(2, count);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const pt  = p.getPointAtLength(t * len);
    const pt2 = p.getPointAtLength(Math.min(len, t * len + 2));
    pts.push({ x: pt.x, y: pt.y, tx: pt2.x - pt.x, ty: pt2.y - pt.y });
  }
  return pts;
}

export function ptsToD(pts) {
  return `M ${pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')}`;
}

export function svgPt(svgEl, clientX, clientY) {
  const pt = svgEl.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  return pt.matrixTransform(svgEl.getScreenCTM().inverse());
}

export function parsedVb(viewBox) {
  const parts = (viewBox || '0 0 640 400').trim().split(/[\s,]+/).map(Number);
  return { x: parts[0] || 0, y: parts[1] || 0, w: parts[2] || 640, h: parts[3] || 400 };
}

export const STRIP_COLORS = [
  'oklch(80% 0.130 72)',  'oklch(78% 0.140 40)',  'oklch(74% 0.075 168)',
  'oklch(80% 0.110 95)',  'oklch(78% 0.150 30)',  'oklch(72% 0.090 200)',
  'oklch(80% 0.120 130)', 'oklch(76% 0.140 12)',
];

export const DENSITY_OPTIONS = [30, 60, 96, 144];
export const GLOW_MODES = ['dots', 'center', 'outward', 'inward'];
