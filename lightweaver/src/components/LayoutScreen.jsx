import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { samplePath as libSamplePath } from '../lib/mapper.js';
import { WledBar } from './WledBar.jsx';
import { useProject } from '../state/ProjectContext.jsx';
import { PATTERNS } from '../data.js';
import {
  buildGammaLut,
  compilePattern,
  normalizePalette,
  renderPixelFrame,
} from '../lib/frameEngine.js';
import {
  activeLedCoreAlpha,
  ledCssColor,
  restingLedAlpha,
} from '../lib/previewVisuals.js';
import { usePersistentPanelSize } from '../hooks/usePersistentPanelSize.js';
import { shouldRebuildStripPixels } from '../lib/stripPixels.js';
import {
  LED_COUNT_MAX,
  LED_COUNT_SLIDER_MAX,
  LED_COUNT_SLIDER_MIN,
  SPEED_SLIDER_MAX,
  SPEED_SLIDER_MIN,
  formatControlSpeed,
  ledCountToSliderValue,
  sliderValueToLedCount,
  sliderValueToSpeed,
  speedToSliderValue,
} from '../lib/controlScale.js';
import { PatchBoardScreen } from './PatchBoardScreen.jsx';
import {
  applyPatchRouteOrder,
  cutsForStrip,
  deleteStripCut,
  mainChain,
  nudgeStripCut,
  normalizePatchBoard,
  sliceStripIntoPatchesPreservingRoute,
} from '../lib/patchBoard.js';

// ── Pure utility functions ─────────────────────────────────────────────────

function shapeToD(el) {
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

function splitCompoundPath(d) {
  const parts = d.match(/[Mm][^Mm]*/g);
  if (!parts || parts.length <= 1) return [d];
  return parts.map(p => p.trim()).filter(Boolean);
}

function measurePathLen(d) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  return p.getTotalLength ? p.getTotalLength() : 0;
}

function offsetPixels(pixels = [], dx = 0, dy = 0) {
  if (!dx && !dy) return pixels;
  return pixels.map(px => ({ ...px, x: px.x + dx, y: px.y + dy }));
}

function offsetSamplePoints(points = [], dx = 0, dy = 0) {
  if (!dx && !dy) return points;
  return points.map(pt => ({ ...pt, x: pt.x + dx, y: pt.y + dy }));
}

function offsetArrow(arrow, dx = 0, dy = 0) {
  if (!arrow || (!dx && !dy)) return arrow;
  const move = pt => ({ ...pt, x: pt.x + dx, y: pt.y + dy });
  return { tip: move(arrow.tip), left: move(arrow.left), right: move(arrow.right), start: move(arrow.start), end: move(arrow.end) };
}

function pointsAttr(points = []) {
  return points.map(point => `${point.x},${point.y}`).join(' ');
}

function escapeAttr(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function layerArtworkMarkup(layer) {
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

function actionablePolylinePoints(points = []) {
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

function translateStripFromStart(strip, dx, dy) {
  const nextX = (strip.x || 0) + dx;
  const nextY = (strip.y || 0) + dy;
  return {
    ...strip,
    x: nextX,
    y: nextY,
    pixels: sampleStripPixels(strip.pathData, strip.pixelCount, strip.reversed, nextX, nextY),
  };
}

function sampleStripPixels(pathData, pixelCount, reversed = false, x = 0, y = 0) {
  const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathEl.setAttribute('d', pathData);
  let pixels = libSamplePath(pathEl, pixelCount);
  if (reversed) pixels = pixels.slice().reverse();
  return offsetPixels(pixels, x || 0, y || 0);
}

function rgbCss(rgb, fallback = 'white') {
  if (!rgb) return fallback;
  const r = Math.round(rgb.r ?? rgb.avgR ?? 0);
  const g = Math.round(rgb.g ?? rgb.avgG ?? 0);
  const b = Math.round(rgb.b ?? rgb.avgB ?? 0);
  if (r + g + b <= 3) return fallback;
  return `rgb(${r} ${g} ${b})`;
}

function clampLedCount(value, max = LED_COUNT_MAX) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(max, parsed));
}

function startedFromDragHandle(e) {
  return !!e.target?.closest?.('[data-drag-handle="true"]');
}

function translatePathData(pathData = '', dx = 0, dy = 0) {
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

function pathIntersectsRect(pathData, minX, minY, maxX, maxY) {
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

function measureLayers(doc) {
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

function getPxPerMm(srcSvg) {
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

function calcArrow(pathData, reversed = false) {
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

function sampleForViz(pathData, count = 40) {
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

function ptsToD(pts) {
  return `M ${pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')}`;
}

function svgPt(svgEl, clientX, clientY) {
  const pt = svgEl.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  return pt.matrixTransform(svgEl.getScreenCTM().inverse());
}

function parsedVb(viewBox) {
  const parts = (viewBox || '0 0 640 400').trim().split(/[\s,]+/).map(Number);
  return { x: parts[0] || 0, y: parts[1] || 0, w: parts[2] || 640, h: parts[3] || 400 };
}

function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  a.click();
}

const STRIP_COLORS = [
  'oklch(72% 0.15 210)', 'oklch(78% 0.14 300)', 'oklch(78% 0.14 60)',
  'oklch(80% 0.15 155)', 'oklch(78% 0.17 30)',  'oklch(74% 0.16 0)',
  'oklch(80% 0.14 270)', 'oklch(76% 0.16 180)',
];

const DENSITY_OPTIONS = [30, 60, 96, 144];
const LED_COUNT_PRESETS = [30, 43, 60, 100, 150, 300, 600, 1000, 1500, 3000];
const MAX_HISTORY = 50;
const LS_KEY = 'lw-layout-autosave';
const GLOW_MODES = ['dots', 'center', 'outward', 'inward'];

// ── SVG icon helpers ───────────────────────────────────────────────────────

const EyeIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ width: 12, height: 12, flexShrink: 0 }}>
    <path d="M1 6s2-4 5-4 5 4 5 4-2 4-5 4-5-4-5-4z"/>
    <circle cx="6" cy="6" r="1.5"/>
  </svg>
);

const EyeOffIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ width: 12, height: 12, flexShrink: 0 }}>
    <path d="M1 1l10 10M5 2.5A5 5 0 0 1 11 6s-.5 1-1.5 2M7.5 9.5A5 5 0 0 1 1 6s2-4 5-4"/>
  </svg>
);

const ChevronRightIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 10, height: 10, flexShrink: 0 }}>
    <path d="M4.5 3l3 3-3 3"/>
  </svg>
);

const ChevronDownIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 10, height: 10, flexShrink: 0 }}>
    <path d="M3 4.5l3 3 3-3"/>
  </svg>
);

const DragHandleIcon = () => (
  <svg viewBox="0 0 8 12" fill="currentColor" style={{ width: 8, height: 12, flexShrink: 0 }}>
    <circle cx="2" cy="2" r="1"/><circle cx="6" cy="2" r="1"/>
    <circle cx="2" cy="6" r="1"/><circle cx="6" cy="6" r="1"/>
    <circle cx="2" cy="10" r="1"/><circle cx="6" cy="10" r="1"/>
  </svg>
);

const GroupIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" style={{ width: 11, height: 11, flexShrink: 0 }}>
    <rect x="1" y="1" width="4" height="4" rx="1"/>
    <rect x="7" y="1" width="4" height="4" rx="1"/>
    <rect x="1" y="7" width="4" height="4" rx="1"/>
    <rect x="7" y="7" width="4" height="4" rx="1"/>
  </svg>
);

function InlineRename({ value, onCommit, className, style }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(value);
  const inputRef              = useRef(null);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== value) onCommit(t);
  };

  if (!editing) {
    return (
      <span className={className} style={style}
            title="Double-click to rename"
            onDoubleClick={e => { e.stopPropagation(); setDraft(value); setEditing(true); setTimeout(() => inputRef.current?.select(), 20); }}>
        {value}
      </span>
    );
  }
  return (
    <input ref={inputRef} value={draft} autoFocus
           onChange={e => setDraft(e.target.value)}
           onBlur={commit}
           onKeyDown={e => {
             if (e.key === 'Enter') { e.preventDefault(); commit(); }
             if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
           }}
           onClick={e => e.stopPropagation()}
           style={{ ...style, background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 3,
                    padding: '0 5px', color: 'var(--text)', fontSize: 'inherit', fontFamily: 'inherit', outline: 'none', minWidth: 0 }}/>
  );
}

// ── Light visualization sub-components ────────────────────────────────────

function LightCone({ uid, cx, cy, angle, color, reach = 90, intensity = 0.5 }) {
  const gid = `lcg-${uid}`;
  const a = (angle - 90) * Math.PI / 180;
  const spread = 34 * Math.PI / 180;
  const fx = cx + Math.cos(a) * reach * 0.42;
  const fy = cy + Math.sin(a) * reach * 0.42;
  const left = { x: cx + Math.cos(a - spread) * reach, y: cy + Math.sin(a - spread) * reach };
  const right = { x: cx + Math.cos(a + spread) * reach, y: cy + Math.sin(a + spread) * reach };
  const far = { x: cx + Math.cos(a) * reach * 1.08, y: cy + Math.sin(a) * reach * 1.08 };
  return (
    <>
      <defs>
        <radialGradient id={gid} cx={fx} cy={fy} r={reach} gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor={color} stopOpacity={0.95 * intensity}/>
          <stop offset="48%"  stopColor={color} stopOpacity={0.28 * intensity}/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </radialGradient>
      </defs>
      <path
        data-light-cone={uid}
        d={`M ${cx} ${cy} L ${left.x} ${left.y} Q ${far.x} ${far.y} ${right.x} ${right.y} Z`}
        fill={`url(#${gid})`}
        opacity={0.9}
        style={{ mixBlendMode: 'screen' }}
      />
    </>
  );
}

function OmniHalo({ uid, cx, cy, color, reach = 90, intensity = 0.5 }) {
  const gid = `ohg-${uid}`;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx={cx} cy={cy} r={reach} gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor={color} stopOpacity={0.8 * intensity}/>
          <stop offset="60%"  stopColor={color} stopOpacity={0.2 * intensity}/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={reach} fill={`url(#${gid})`} style={{ mixBlendMode: 'screen' }}/>
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function LayoutScreen() {
  const project = useProject();
  const [panelWidth, , beginPanelResize] = usePersistentPanelSize('lw-layout-panel-width', {
    defaultValue: 360,
    min: 280,
    max: 680,
  });
  const [viewBox, setViewBox]       = useState(project.viewBox || '0 0 640 400');
  const [svgText, setSvgText]       = useState(project.svgText ?? null);
  const [layers, setLayers]         = useState(project.layoutLayers || []);
  const [strips, setStrips]         = useState(project.strips || []);
  const [density, setDensity]       = useState(project.layoutDensity ?? 60);
  const [pxPerMm, setPxPerMm]       = useState(project.layoutPxPerMm ?? 3.7795);
  const [selLayerId, setSelLayerId] = useState(null);
  const [selStripId, setSelStripId] = useState(null);
  const [hidden, setHidden]         = useState(project.hidden || {});
  const [showLight, setShowLight]   = useState(false);
  const [showLeds, setShowLeds]     = useState(true);
  const [glowMode, setGlowMode]     = useState('dots');
  const [directedGlow, setDirectedGlow] = useState(false);
  const [showHeat, setShowHeat]     = useState(false);
  const [editCounts, setEditCounts] = useState(project.layoutEditCounts || {});
  const [error, setError]           = useState(null);

  // Layer panel state
  const [expandedLayers, setExpandedLayers] = useState({});
  const [pathSel, setPathSel]       = useState([]);
  const [pathSelName, setPathSelName] = useState('');
  const [selectedStripIds, setSelectedStripIds] = useState([]);
  const [stripSelectionName, setStripSelectionName] = useState('');

  // Draw tool state
  const [drawMode, setDrawMode]     = useState(false);
  const [waypoints, setWaypoints]   = useState([]);
  const [ghostPt, setGhostPt]       = useState(null);

  // Inline draw naming panel (replaces browser prompt)
  const [pendingDraw, setPendingDraw] = useState(null); // { pathData, svgLength }
  const [pendingDrawName, setPendingDrawName] = useState('');
  const [pendingDrawCount, setPendingDrawCount] = useState(0);
  const pendingDrawNameRef = useRef(null);
  const [wireOverlayMode, setWireOverlayMode] = useState('idle');
  const [selectedWireCut, setSelectedWireCut] = useState(null);
  const [selectedWirePatchId, setSelectedWirePatchId] = useState(null);
  const [linkRouteIds, setLinkRouteIds] = useState([]);
  const linkRouteStartedRef = useRef(false);

  // Rubber-band lasso select — coords stored in CLIENT (viewport px), not SVG
  const [rubberBand, setRubberBand] = useState(null); // {x1,y1,x2,y2} client px
  const rubberBandRef          = useRef(null);
  const justFinishedLassoRef   = useRef(false);
  const lassoFinishRef         = useRef(null);

  // Canvas pan / zoom
  const [zoom, setZoom]   = useState(1.0);
  const [panX, setPanX]   = useState(0);
  const [panY, setPanY]   = useState(0);
  const spaceRef          = useRef(false);
  const isPanningRef      = useRef(false);
  const panAnchorRef      = useRef(null);
  const [isPanning, setIsPanning] = useState(false);
  const stripDragRef      = useRef(null);
  const stripDragFrameRef = useRef(0);
  const stripDragPointRef = useRef(null);
  const stripDragSuppressClickRef = useRef(false);
  const stripsRef         = useRef(strips);
  const [movingStripIds, setMovingStripIds] = useState([]);

  // Drag-and-drop
  const [dragOver, setDragOver] = useState(false);

  // Canvas cursor position overlay
  const [cursorSvgPt, setCursorSvgPt] = useState(null);

  // Undo / redo
  const historyRef = useRef([]);
  const futureRef  = useRef([]);
  const [histLen, setHistLen]   = useState(0);
  const [futLen,  setFutLen]    = useState(0);

  // Layer groups + ordering (V1 parity)
  const [layerGroups, setLayerGroups]     = useState(project.layoutLayerGroups || []);  // [{groupId,name,_hidden,_expanded,members:[{layerId,pathId,pathData,name,svgLength}]}]
  const [layerOrder, setLayerOrder]       = useState(project.layoutLayerOrder || []);  // [{type:'layer'|'group', id}]
  const [layerDragging, setLayerDragging] = useState(null);
  const [layerDragOver, setLayerDragOver] = useState(null);
  const [stripGroupDragOver, setStripGroupDragOver] = useState(null);

  // Refs so snapshot/save always capture latest values without dependency churn
  const layerGroupsRef = useRef(layerGroups);
  const layerOrderRef  = useRef(layerOrder);
  useEffect(() => { layerGroupsRef.current = layerGroups; }, [layerGroups]);
  useEffect(() => { layerOrderRef.current  = layerOrder;  }, [layerOrder]);

  const fileRef     = useRef(null);
  const loadRef     = useRef(null);
  const svgRef      = useRef(null);
  const artworkRef  = useRef(null);
  const vpRef       = useRef(null);
  const stripListRef = useRef(null);
  const [hoveredLayerId, setHoveredLayerId] = useState(null);
  const [hoveredSubPathId, setHoveredSubPathId] = useState(null);
  const colorIdxRef = useRef(0);
  const nextColor   = () => STRIP_COLORS[colorIdxRef.current++ % STRIP_COLORS.length];

  const {
    strips: projectStrips,
    viewBox: projectViewBox,
    svgText: projectSvgText,
    hidden: projectHidden,
    layoutLayers,
    setLayoutLayers,
    layoutDensity,
    setLayoutDensity,
    layoutPxPerMm,
    setLayoutPxPerMm,
    layoutEditCounts,
    setLayoutEditCounts,
    layoutLayerGroups,
    setLayoutLayerGroups,
    layoutLayerOrder,
    setLayoutLayerOrder,
    projectRevision,
    setPatchBoard,
    setStrips: setProjectStrips,
    setViewBox: setProjectViewBox,
    setSvgText: setProjectSvgText,
    setHidden: setProjectHidden,
    serializeProject,
    loadProject,
    // Pattern state
    activePatternId, setActivePatternId,
    palette,
    masterSpeed, setMasterSpeed,
    masterBrightness, setMasterBrightness,
    masterSaturation, setMasterSaturation,
    masterHueShift,
    gammaEnabled, setGammaEnabled,
    gammaValue, setGammaValue,
    patternParams, setPatternParams,
    bpm, setBpm,
    symSettings,
    audioBands,
    usbLedConnected,
    usbLedStatus,
  } = project;

  const usbLedMaxPixels = usbLedStatus?.maxPixels || 300;

  useEffect(() => { setProjectStrips(strips); },    [strips, setProjectStrips]);
  useEffect(() => { stripsRef.current = strips; },   [strips]);
  useEffect(() => { setProjectViewBox(viewBox); },  [viewBox, setProjectViewBox]);
  useEffect(() => { setProjectSvgText(svgText); },  [svgText, setProjectSvgText]);
  useEffect(() => { setProjectHidden(hidden); },    [hidden, setProjectHidden]);
  useEffect(() => { setLayoutLayers(layers); },      [layers, setLayoutLayers]);
  useEffect(() => { setLayoutDensity(density); },    [density, setLayoutDensity]);
  useEffect(() => { setLayoutPxPerMm(pxPerMm); },    [pxPerMm, setLayoutPxPerMm]);
  useEffect(() => { setLayoutEditCounts(editCounts); }, [editCounts, setLayoutEditCounts]);
  useEffect(() => { setLayoutLayerGroups(layerGroups); }, [layerGroups, setLayoutLayerGroups]);
  useEffect(() => { setLayoutLayerOrder(layerOrder); }, [layerOrder, setLayoutLayerOrder]);
  useEffect(() => {
    setSelectedStripIds(prev => prev.filter(id => strips.some(s => s.id === id)));
  }, [strips]);

  // ── Computed viewBox with pan/zoom ────────────────────────────────────────

  const computedViewBox = useMemo(() => {
    const vb = parsedVb(viewBox);
    const w = vb.w / zoom;
    const h = vb.h / zoom;
    const cx = vb.x + vb.w / 2;
    const cy = vb.y + vb.h / 2;
    return `${(cx - w / 2 + panX).toFixed(2)} ${(cy - h / 2 + panY).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`;
  }, [viewBox, zoom, panX, panY]);

  const resetView = () => { setZoom(1); setPanX(0); setPanY(0); };

  // ── Snapshot helpers ──────────────────────────────────────────────────────

  const makeSnapshot = useCallback((curStrips, curLayers, curEditCounts, curHidden, curSvgText, curViewBox, curDensity) => ({
    strips:      curStrips.map(s => ({ ...s, pixels: s.pixels.slice() })),
    layers:      curLayers.map(({ subPaths, ...rest }) => ({ ...rest, subPaths: subPaths?.map(sp => ({ ...sp })) ?? [] })),
    editCounts:  { ...curEditCounts },
    hidden:      { ...curHidden },
    svgText:     curSvgText,
    viewBox:     curViewBox,
    density:     curDensity,
    layerGroups: layerGroupsRef.current.map(g => ({ ...g, members: g.members.map(m => ({ ...m })) })),
    layerOrder:  [...layerOrderRef.current],
  }), []);

  const pushHistory = useCallback((curStrips, curLayers, curEditCounts, curHidden, curSvgText, curViewBox, curDensity) => {
    const snap = makeSnapshot(curStrips, curLayers, curEditCounts, curHidden, curSvgText, curViewBox, curDensity);
    if (historyRef.current.length >= MAX_HISTORY) historyRef.current.shift();
    historyRef.current.push(snap);
    futureRef.current = [];
    setHistLen(historyRef.current.length);
    setFutLen(0);
  }, [makeSnapshot]);

  // ── localStorage auto-save ─────────────────────────────────────────────

  const lsSave = useCallback((curStrips, curLayers, curEditCounts, curHidden, curSvgText, curViewBox, curDensity) => {
    try {
      const data = {
        version: 2,
        strips:      curStrips.map(({ pixels: _px, ...s }) => s),
        layers:      curLayers,
        editCounts:  curEditCounts,
        hidden:      curHidden,
        svgText:     curSvgText,
        viewBox:     curViewBox,
        density:     curDensity,
        layerGroups: layerGroupsRef.current,
        layerOrder:  layerOrderRef.current,
        // Pattern state
        activePatternId,
        masterSpeed, masterBrightness, masterSaturation,
        gammaEnabled, gammaValue,
        patternParams,
        bpm,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch {}
  }, [activePatternId, masterSpeed, masterBrightness, masterSaturation, gammaEnabled, gammaValue, patternParams, bpm]);

  // ── Restore strips from saved data ────────────────────────────────────────

  const rebuildStrip = (stripData) => {
    return {
      ...stripData,
      pixels: sampleStripPixels(stripData.pathData, stripData.pixelCount, stripData.reversed, stripData.x || 0, stripData.y || 0),
    };
  };

  useEffect(() => {
    setViewBox(projectViewBox || '0 0 640 400');
    setSvgText(projectSvgText ?? null);
    setHidden(projectHidden || {});
    setLayers(layoutLayers || []);
    setDensity(layoutDensity ?? 60);
    setPxPerMm(layoutPxPerMm ?? 3.7795);
    setEditCounts(layoutEditCounts || {});
    setLayerGroups(layoutLayerGroups || []);
    setLayerOrder(layoutLayerOrder || (layoutLayers || []).map(l => ({ type: 'layer', id: l.layerId })));
    setStrips((projectStrips || []).map(s => shouldRebuildStripPixels(s) ? rebuildStrip(s) : s));
    setSelLayerId(null);
    setSelStripId(null);
    resetView();
  }, [projectRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── File processing (shared by button + drag-drop) ────────────────────────

  const processFile = useCallback(async (file) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith('.svg')) {
      setError('Only .svg files are supported. In Illustrator: File → Export As → SVG.');
      return;
    }
    const text = await file.text();
    if (!text.includes('<svg') && !text.includes('<SVG')) {
      setError('This does not appear to be a valid SVG file.');
      return;
    }
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const srcSvg = doc.querySelector('svg');
    if (!srcSvg) { setError('Could not parse SVG.'); return; }
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) { setError('SVG parse error: ' + parseErr.textContent.slice(0, 120)); return; }

    const vb = srcSvg.getAttribute('viewBox') || '0 0 640 400';
    const newPxPerMm = getPxPerMm(srcSvg);
    colorIdxRef.current = 0;
    const parsed = measureLayers(doc);
    if (!parsed.length) {
      setError('No layers found. In Illustrator use File → Export As → SVG (not Save As).');
    }
    const newLayers = parsed.map(l => ({ ...l, _color: nextColor(), _emit: 'dir', _angle: 0 }));
    const newLayerOrder = parsed.map(l => ({ type: 'layer', id: l.layerId }));
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setViewBox(vb);
    setPxPerMm(newPxPerMm);
    setSvgText(text);
    setLayers(newLayers);
    setStrips([]);
    setEditCounts({});
    setHidden({});
    setLayerGroups([]);
    setLayerOrder(newLayerOrder);
    setSelLayerId(null);
    setSelStripId(null);
    setDrawMode(false);
    setWaypoints([]);
    resetView();
    lsSave([], newLayers, {}, {}, text, vb, density);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, pushHistory, lsSave]);

  // ── SVG import via button ─────────────────────────────────────────────────

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    await processFile(file);
  };

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };
  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
  };
  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) await processFile(file);
  };

  // ── Inline SVG artwork ─────────────────────────────────────────────────────

  const artworkHTML = useMemo(() => {
    if (!svgText || !layers.length) return null;
    return layers.map(layerArtworkMarkup).join('');
  }, [svgText, layers]);

  // ── Derived state ──────────────────────────────────────────────────────────

  const selLayer = layers.find(l => l.layerId === selLayerId) ?? null;

  const getLedCount = (layer) => {
    if (editCounts[layer.layerId] != null) return editCounts[layer.layerId];
    return Math.max(1, Math.round((layer.svgLength / pxPerMm) * density / 1000));
  };

  const makeStrip = (layer, count) => {
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', layer.pathData);
    const pixels = libSamplePath(pathEl, count);
    return {
      id: layer.layerId, name: layer.name,
      pathData: layer.pathData, pixelCount: count,
      pixels, color: layer._color,
      x: 0, y: 0,
      emit: layer._emit || 'dir', angle: layer._angle || 0,
      reversed: false,
      speed: 1.0,
      brightness: 1.0,
      hueShift: 0,
      patternId: null,
    };
  };

  const scrollToStrip = (id) => {
    requestAnimationFrame(() => {
      const el = stripListRef.current?.querySelector(`[data-strip-id="${id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const stripGroupMember = (s) => ({
    type: 'strip',
    stripId: s.id,
    pathId: s.id,
    layerId: s.id,
    pathData: s.pathData,
    name: s.name,
    svgLength: s.svgLength || 0,
    pixelCount: s.pixelCount,
    color: s.color,
  });

  const readDraggedStripIds = (e) => {
    try {
      const raw = e.dataTransfer.getData('application/x-lightweaver-strip');
      const ids = JSON.parse(raw || '[]');
      return Array.isArray(ids) ? ids.filter(Boolean) : [];
    } catch {
      return [];
    }
  };

  const readDraggedPathEntries = (e) => {
    try {
      const raw = e.dataTransfer.getData('application/x-lightweaver-path');
      const entries = JSON.parse(raw || '[]');
      return Array.isArray(entries) ? entries.filter(entry => entry?.pathId && entry?.pathData) : [];
    } catch {
      return [];
    }
  };

  const createLayerGroupFromEntries = useCallback((entries, nameOverride = '') => {
    const unique = [];
    const seen = new Set();
    for (const entry of entries) {
      if (!entry?.pathId || seen.has(entry.pathId)) continue;
      seen.add(entry.pathId);
      unique.push(entry);
    }
    if (unique.length < 2) return;
    const groupId = `grp-${Date.now()}`;
    const baseName = unique[0].name?.split('·')[0]?.trim();
    const name = nameOverride.trim() || baseName || `Group ${layerGroups.length + 1}`;
    const newGroup = { groupId, name, _hidden: false, _expanded: true, members: unique.map(p => ({ ...p })) };
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setLayerGroups(prev => [...prev, newGroup]);
    setLayerOrder(prev => [{ type: 'group', id: groupId }, ...prev]);
    setPathSel(unique);
  }, [layerGroups.length, strips, layers, editCounts, hidden, svgText, viewBox, density, pushHistory]);

  const addPathsToGroup = useCallback((groupId, entries) => {
    const group = layerGroups.find(g => g.groupId === groupId);
    if (!group || group.type === 'strip') return;
    const incoming = entries.filter(entry => entry?.pathId && entry?.pathData);
    if (!incoming.length) return;
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setLayerGroups(prev => prev.map(g => {
      if (g.groupId !== groupId) return g;
      const existingIds = new Set(g.members.map(m => m.pathId));
      const nextMembers = [...g.members];
      incoming.forEach(entry => {
        if (!existingIds.has(entry.pathId)) nextMembers.push({ ...entry });
      });
      return { ...g, _expanded: true, members: nextMembers };
    }));
    setPathSel(incoming);
  }, [layerGroups, strips, layers, editCounts, hidden, svgText, viewBox, density, pushHistory]);

  const togglePathSelection = useCallback((entry, additive = false) => {
    setSelLayerId(null);
    setSelStripId(null);
    setSelectedStripIds([]);
    setStripSelectionName('');
    setPathSel(prev => {
      if (!additive) return [entry];
      return prev.some(p => p.pathId === entry.pathId)
        ? prev.filter(p => p.pathId !== entry.pathId)
        : [...prev, entry];
    });
  }, []);

  const createStripGroupFromIds = useCallback((stripIds, nameOverride = '') => {
    const uniqueIds = [...new Set(stripIds)].filter(Boolean);
    const picked = strips.filter(s => uniqueIds.includes(s.id));
    if (picked.length < 2) return;

    const pickedIds = new Set(picked.map(s => s.id));
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => pickedIds.has(m.stripId || m.pathId)))
      .map(g => g.groupId));
    const groupId = `strip-grp-${Date.now()}`;
    const name = nameOverride.trim() || stripSelectionName.trim() || `Strip Group ${layerGroups.length + 1}`;
    const newGroup = {
      groupId,
      type: 'strip',
      name,
      _hidden: false,
      _expanded: true,
      members: picked.map(stripGroupMember),
    };

    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setLayerGroups(prev => [
      ...prev
        .map(g => ({ ...g, members: g.members.filter(m => !pickedIds.has(m.stripId || m.pathId)) }))
        .filter(g => g.members.length > 0),
      newGroup,
    ]);
    setLayerOrder(prev => [{ type: 'group', id: groupId }, ...prev.filter(item => item.id !== groupId && !emptiedGroupIds.has(item.id))]);
    setSelectedStripIds(picked.map(s => s.id));
    setStripSelectionName('');
  }, [strips, layerGroups, stripSelectionName, layers, editCounts, hidden, svgText, viewBox, density, pushHistory]);

  const addStripsToGroup = useCallback((groupId, stripIds) => {
    const group = layerGroups.find(g => g.groupId === groupId);
    if (!group || group.type !== 'strip') return;
    const ids = [...new Set(stripIds)].filter(Boolean);
    const picked = strips.filter(s => ids.includes(s.id));
    if (!picked.length) return;
    const pickedIds = new Set(picked.map(s => s.id));

    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setLayerGroups(prev => prev
      .map(g => {
        const existing = g.members.filter(m => !pickedIds.has(m.stripId || m.pathId));
        if (g.groupId !== groupId) return { ...g, members: existing };
        return {
          ...g,
          type: 'strip',
          _expanded: true,
          members: [...existing, ...picked.map(stripGroupMember)],
        };
      })
      .filter(g => g.members.length > 0));
    setSelectedStripIds(picked.map(s => s.id));
  }, [layerGroups, strips, layers, editCounts, hidden, svgText, viewBox, density, pushHistory]);

  const addStrip = () => {
    if (!selLayer) return;
    const newStrip = makeStrip(selLayer, getLedCount(selLayer));
    const newStrips = [...strips.filter(s => s.id !== selLayer.layerId), newStrip];
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setStrips(newStrips);
    setSelStripId(newStrip.id);
    lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
    scrollToStrip(newStrip.id);
  };

  const addSubPathStrip = (sp, layer) => {
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', sp.pathData);
    const count = Math.max(1, Math.round((sp.svgLength / pxPerMm) * density / 1000));
    const pixels = libSamplePath(pathEl, count);
    const newStrip = {
      id: sp.pathId,
      name: `${layer.name} · ${sp.name}`,
      pathData: sp.pathData,
      pixelCount: count,
      pixels,
      color: layer._color,
      x: 0, y: 0,
      emit: 'dir',
      angle: 0,
      reversed: false,
      speed: 1.0,
      brightness: 1.0,
      hueShift: 0,
      patternId: null,
    };
    const newStrips = [...strips.filter(s => s.id !== sp.pathId), newStrip];
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setStrips(newStrips);
    setSelStripId(newStrip.id);
    lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
    scrollToStrip(newStrip.id);
  };

  const addSelectedPathsAsStrips = useCallback((mode = 'merged') => {
    if (!pathSel.length) return;
    const now = Date.now();

    if (mode === 'merged') {
      const combinedPathData = pathSel.map(p => p.pathData).join(' ');
      const totalLen = pathSel.reduce((s, p) => s + p.svgLength, 0);
      const count = Math.max(1, Math.round((totalLen / pxPerMm) * density / 1000));
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', combinedPathData);
      const pixels = libSamplePath(pathEl, count);
      const name = pathSelName.trim() || `Strip ${strips.length + 1}`;
      const newStrip = {
        id: `sel-${now}`, name,
        pathData: combinedPathData, pixelCount: count, pixels,
        x: 0, y: 0,
        color: nextColor(), emit: 'dir', angle: 0, reversed: false,
        speed: 1.0, brightness: 1.0, hueShift: 0, patternId: null,
      };
      const newStrips = [...strips, newStrip];
      pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
      setStrips(newStrips);
      setSelStripId(newStrip.id);
      setSelectedStripIds([newStrip.id]);
      lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
      setPathSel([]);
      setPathSelName('');
      scrollToStrip(newStrip.id);
      return;
    }

    const created = pathSel.map((p, index) => {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', p.pathData);
      const count = Math.max(1, Math.round((p.svgLength / pxPerMm) * density / 1000));
      const pixels = libSamplePath(pathEl, count);
      const layerColor = layers.find(l => l.layerId === p.layerId)?._color;
      return {
        id: `sel-${now}-${index}`,
        name: p.name,
        pathData: p.pathData,
        pixelCount: count,
        pixels,
        x: 0, y: 0,
        color: layerColor || nextColor(),
        emit: 'dir', angle: 0, reversed: false,
        speed: 1.0, brightness: 1.0, hueShift: 0, patternId: null,
      };
    });
    const newStrips = [...strips, ...created];
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setStrips(newStrips);
    setSelStripId(created[0]?.id || null);
    setSelectedStripIds(created.map(s => s.id));

    if (mode === 'grouped' && created.length > 1) {
      const groupId = `strip-grp-${now}`;
      const name = pathSelName.trim() || `Strip Group ${layerGroups.length + 1}`;
      const newGroup = {
        groupId,
        type: 'strip',
        name,
        _hidden: false,
        _expanded: true,
        members: created.map(stripGroupMember),
      };
      setLayerGroups(prev => [...prev, newGroup]);
      setLayerOrder(prev => [{ type: 'group', id: groupId }, ...prev]);
    }

    lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
    setPathSel([]);
    setPathSelName('');
    scrollToStrip(created[0]?.id);
  }, [pathSel, pathSelName, strips, layers, editCounts, hidden, svgText, viewBox, density, pxPerMm, layerGroups.length, pushHistory, lsSave]);

  const addAllStrips = useCallback(() => {
    const newStrips = layers.filter(l => l.pathData).map(l => makeStrip(l, getLedCount(l)));
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setStrips(newStrips);
    if (newStrips.length > 0) setSelStripId(newStrips[0].id);
    lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
    scrollToStrip(newStrips[0]?.id);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, pushHistory, lsSave]);

  const removeStrip = useCallback((id) => {
    const newStrips = strips.filter(s => s.id !== id);
    const newEditCounts = { ...editCounts };
    delete newEditCounts[id];
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => (m.stripId || m.pathId) === id))
      .map(g => g.groupId));
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setStrips(newStrips);
    setLayerGroups(prev => prev
      .map(g => ({ ...g, members: g.members.filter(m => (m.stripId || m.pathId) !== id) }))
      .filter(g => g.members.length > 0));
    setLayerOrder(prev => prev.filter(item => !emptiedGroupIds.has(item.id)));
    setSelectedStripIds(prev => prev.filter(stripId => stripId !== id));
    setEditCounts(newEditCounts);
    if (selStripId === id) setSelStripId(null);
    lsSave(newStrips, layers, newEditCounts, hidden, svgText, viewBox, density);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, selStripId, layerGroups, pushHistory, lsSave]);

  const reverseStrip = (id) => {
    const newStrips = strips.map(s => {
      if (s.id !== id) return s;
      const reversed = !s.reversed;
      const pixels = s.pixels.slice().reverse();
      return { ...s, reversed, pixels };
    });
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setStrips(newStrips);
    lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
  };

  const selectLayer = (layerId) => {
    setSelLayerId(layerId);
    setSelStripId(null);
    setSelectedStripIds([]);
    setStripSelectionName('');
  };

  const selectStrip = (id) => {
    setSelStripId(id);
    setSelectedStripIds([id]);
    setStripSelectionName('');
    setPathSel([]);
    setPathSelName('');
    const s = strips.find(st => st.id === id);
    if (s) setSelLayerId(s.id);
  };

  const toggleStripSelection = useCallback((id) => {
    setSelectedStripIds(prev => {
      const base = prev.length ? prev : (selStripId ? [selStripId] : []);
      return base.includes(id) ? base.filter(x => x !== id) : [...base, id];
    });
    setSelStripId(id);
    setSelLayerId(null);
    setPathSel([]);
    setPathSelName('');
  }, [selStripId]);

  const startStripMove = useCallback((event, strip) => {
    if (event.button !== 0 || drawMode || !svgRef.current) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      toggleStripSelection(strip.id);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const ids = selectedStripIds.includes(strip.id) ? selectedStripIds : [strip.id];
    const idSet = new Set(ids);
    const startPoint = svgPt(svgRef.current, event.clientX, event.clientY);
    const startStrips = strips.filter(s => idSet.has(s.id)).map(s => ({
      ...s,
      pixels: (s.pixels || []).map(px => ({ ...px })),
    }));
    if (!startStrips.length) return;

    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setSelectedStripIds(ids);
    setSelStripId(strip.id);
    setSelLayerId(null);
    setPathSel([]);
    setPathSelName('');
    setMovingStripIds(ids);
    stripDragSuppressClickRef.current = false;
    stripDragPointRef.current = null;
    stripDragRef.current = {
      ids,
      startPoint,
      startStrips,
      startMap: new Map(startStrips.map(s => [s.id, s])),
    };

    const applyStripDragPoint = (clientX, clientY, commitPixels = false) => {
      const drag = stripDragRef.current;
      if (!drag || !svgRef.current) return stripsRef.current;
      const pt = svgPt(svgRef.current, clientX, clientY);
      const dx = pt.x - drag.startPoint.x;
      const dy = pt.y - drag.startPoint.y;
      if (Math.hypot(dx, dy) > 1.5) stripDragSuppressClickRef.current = true;
      const next = stripsRef.current.map(s => {
        const start = drag.startMap.get(s.id);
        if (!start) return s;
        return commitPixels
          ? translateStripFromStart(start, dx, dy)
          : { ...s, x: (start.x || 0) + dx, y: (start.y || 0) + dy };
      });
      stripsRef.current = next;
      setStrips(next);
      return next;
    };

    const onMove = (moveEvent) => {
      stripDragPointRef.current = { clientX: moveEvent.clientX, clientY: moveEvent.clientY };
      if (stripDragFrameRef.current) return;
      stripDragFrameRef.current = requestAnimationFrame(() => {
        stripDragFrameRef.current = 0;
        const point = stripDragPointRef.current;
        if (point) applyStripDragPoint(point.clientX, point.clientY, false);
      });
    };

    const onUp = (upEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (stripDragFrameRef.current) {
        cancelAnimationFrame(stripDragFrameRef.current);
        stripDragFrameRef.current = 0;
      }
      const finalPoint = stripDragPointRef.current ?? { clientX: upEvent.clientX, clientY: upEvent.clientY };
      const finalStrips = applyStripDragPoint(finalPoint.clientX, finalPoint.clientY, true);
      stripDragPointRef.current = null;
      stripDragRef.current = null;
      setMovingStripIds([]);
      lsSave(finalStrips, layers, editCounts, hidden, svgText, viewBox, density);
      setTimeout(() => { stripDragSuppressClickRef.current = false; }, 0);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [drawMode, selectedStripIds, strips, layers, editCounts, hidden, svgText, viewBox, density, pushHistory, lsSave, toggleStripSelection]);

  // ── Rename helpers ─────────────────────────────────────────────────────────

  const renameLayer = (layerId, name) =>
    setLayers(prev => prev.map(l => l.layerId === layerId ? { ...l, name } : l));

  const renameSubPath = (layerId, pathId, name) =>
    setLayers(prev => prev.map(l => l.layerId !== layerId ? l : {
      ...l, subPaths: l.subPaths.map(sp => sp.pathId === pathId ? { ...sp, name } : sp),
    }));

  const renameStrip = (id, name) => updateStrip(id, { name });

  const renameGroup = (groupId, name) =>
    setLayerGroups(prev => prev.map(g => g.groupId === groupId ? { ...g, name } : g));

  // ── Delete layer ───────────────────────────────────────────────────────────

  const deleteLayer = useCallback((layerId) => {
    const layer = layers.find(item => item.layerId === layerId);
    const relatedPathIds = new Set([
      layerId,
      ...(layer?.subPaths || []).map(path => path.pathId),
    ]);
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    const nextLayers = layers.filter(l => l.layerId !== layerId);
    const nextStrips = strips.filter(s => !relatedPathIds.has(s.id));
    const nextEditCounts = { ...editCounts };
    const nextHidden = { ...hidden };
    relatedPathIds.forEach(id => {
      delete nextEditCounts[id];
      delete nextHidden[id];
    });
    setLayers(nextLayers);
    setLayerOrder(prev => prev.filter(x => x.id !== layerId));
    setLayerGroups(prev => prev.map(g => ({ ...g, members: g.members.filter(m => m.layerId !== layerId) }))
                               .filter(g => g.members.length > 0));
    setStrips(nextStrips);
    setEditCounts(nextEditCounts);
    setHidden(nextHidden);
    setSelectedStripIds(prev => prev.filter(id => !relatedPathIds.has(id)));
    if (selLayerId === layerId) setSelLayerId(null);
    if (selStripId && relatedPathIds.has(selStripId)) setSelStripId(null);
    lsSave(nextStrips, nextLayers, nextEditCounts, nextHidden, svgText, viewBox, density);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, selLayerId, selStripId, pushHistory, lsSave]);

  const deleteSelectedVectorPaths = useCallback(() => {
    if (!pathSel.length) return;

    const selectedPathIds = new Set(pathSel.map(path => path.pathId));
    const selectedLayerIds = new Set(pathSel.map(path => path.layerId));
    const selectedPathData = new Set(pathSel.map(path => path.pathData));
    const deletedLayerIds = new Set();

    const nextLayers = [];
    for (const layer of layers) {
      if (!selectedLayerIds.has(layer.layerId) && !selectedPathIds.has(layer.layerId)) {
        nextLayers.push(layer);
        continue;
      }

      const wholeLayerSelected = selectedPathIds.has(layer.layerId) || !(layer.subPaths?.length);
      if (wholeLayerSelected) {
        deletedLayerIds.add(layer.layerId);
        continue;
      }

      const nextSubPaths = layer.subPaths.filter(path => !selectedPathIds.has(path.pathId));
      if (!nextSubPaths.length) {
        deletedLayerIds.add(layer.layerId);
        continue;
      }

      nextLayers.push({
        ...layer,
        subPaths: nextSubPaths,
        pathData: nextSubPaths.map(path => path.pathData).join(' '),
        svgLength: nextSubPaths.reduce((sum, path) => sum + (path.svgLength || 0), 0),
      });
    }

    const removedIds = new Set([...selectedPathIds, ...deletedLayerIds]);
    const nextStrips = strips.filter(strip =>
      !removedIds.has(strip.id) &&
      !selectedPathData.has(strip.pathData));
    const nextEditCounts = { ...editCounts };
    const nextHidden = { ...hidden };
    removedIds.forEach(id => {
      delete nextEditCounts[id];
      delete nextHidden[id];
    });

    const nextLayerGroups = layerGroups
      .map(group => ({
        ...group,
        members: group.members.filter(member =>
          !removedIds.has(member.stripId || member.pathId) &&
          !deletedLayerIds.has(member.layerId)),
      }))
      .filter(group => group.members.length > 0);
    const liveGroupIds = new Set(nextLayerGroups.map(group => group.groupId));
    const liveLayerIds = new Set(nextLayers.map(layer => layer.layerId));
    const nextLayerOrder = layerOrder.filter(item =>
      item.type === 'group'
        ? liveGroupIds.has(item.id)
        : liveLayerIds.has(item.id));

    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setLayers(nextLayers);
    setStrips(nextStrips);
    setEditCounts(nextEditCounts);
    setHidden(nextHidden);
    setLayerGroups(nextLayerGroups);
    setLayerOrder(nextLayerOrder);
    setPathSel([]);
    setPathSelName('');
    setSelectedStripIds(prev => prev.filter(id => nextStrips.some(strip => strip.id === id)));
    if (selLayerId && deletedLayerIds.has(selLayerId)) setSelLayerId(null);
    if (selStripId && !nextStrips.some(strip => strip.id === selStripId)) setSelStripId(null);
    lsSave(nextStrips, nextLayers, nextEditCounts, nextHidden, svgText, viewBox, density);
  }, [pathSel, layers, strips, editCounts, hidden, svgText, viewBox, density, layerGroups, layerOrder, selLayerId, selStripId, pushHistory, lsSave]);

  // ── Duplicate strip ────────────────────────────────────────────────────────

  const duplicateStrip = useCallback((id) => {
    const s = strips.find(st => st.id === id);
    if (!s) return;
    const newId = `dup-${Date.now()}`;
    const newStrip = { ...s, id: newId, name: `${s.name} copy`, pixels: s.pixels.slice() };
    const newStrips = strips.flatMap(st => st.id === id ? [st, newStrip] : [st]);
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setStrips(newStrips);
    setSelStripId(newId);
    lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
    scrollToStrip(newId);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, pushHistory, lsSave]);

  // ── Layer group management ─────────────────────────────────────────────────

  const createLayerGroup = useCallback(() => {
    createLayerGroupFromEntries(pathSel);
    setPathSel([]);
    setPathSelName('');
  }, [pathSel, createLayerGroupFromEntries]);

  const groupSelectedStrips = useCallback(() => {
    createStripGroupFromIds(selectedStripIds);
  }, [selectedStripIds, createStripGroupFromIds]);

  const mergeSelectedStrips = useCallback(() => {
    const selected = new Set(selectedStripIds);
    const picked = strips.filter(s => selected.has(s.id));
    if (picked.length < 2) return;

    const first = picked[0];
    const pickedIds = new Set(picked.map(s => s.id));
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => pickedIds.has(m.stripId || m.pathId)))
      .map(g => g.groupId));
    const mergedId = `merged-${Date.now()}`;
    const mergedName = stripSelectionName.trim() || `Merged Strip ${strips.length - picked.length + 1}`;
    const pixels = picked.flatMap(s => s.pixels?.length ? s.pixels : []);
    const mergedStrip = {
      ...first,
      id: mergedId,
      name: mergedName,
      pathData: picked.map(s => translatePathData(s.pathData, s.x || 0, s.y || 0)).filter(Boolean).join(' '),
      pixelCount: picked.reduce((sum, s) => sum + (s.pixelCount || 0), 0),
      pixels,
      x: 0,
      y: 0,
      color: first.color || nextColor(),
      reversed: false,
      mergedFrom: picked.map(s => ({ id: s.id, name: s.name, pixelCount: s.pixelCount })),
    };
    const insertAt = strips.findIndex(s => pickedIds.has(s.id));
    const remaining = strips.filter(s => !pickedIds.has(s.id));
    const newStrips = [...remaining];
    newStrips.splice(Math.max(0, insertAt), 0, mergedStrip);

    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setLayerGroups(prev => prev
      .map(g => ({ ...g, members: g.members.filter(m => !pickedIds.has(m.stripId || m.pathId)) }))
      .filter(g => g.members.length > 0));
    setLayerOrder(prev => prev.filter(item => !emptiedGroupIds.has(item.id)));
    setStrips(newStrips);
    setHidden(prev => {
      const next = { ...prev };
      pickedIds.forEach(id => { delete next[id]; });
      return next;
    });
    setSelLayerId(null);
    setSelStripId(mergedId);
    setSelectedStripIds([mergedId]);
    setStripSelectionName('');
    lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
    scrollToStrip(mergedId);
  }, [selectedStripIds, strips, stripSelectionName, layerGroups, layers, editCounts, hidden, svgText, viewBox, density, pushHistory, lsSave]);

  const removeSelectedStrips = useCallback(() => {
    const selected = new Set(selectedStripIds);
    if (selected.size < 2) return;
    const newStrips = strips.filter(s => !selected.has(s.id));
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => selected.has(m.stripId || m.pathId)))
      .map(g => g.groupId));
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setStrips(newStrips);
    setLayerGroups(prev => prev
      .map(g => ({ ...g, members: g.members.filter(m => !selected.has(m.stripId || m.pathId)) }))
      .filter(g => g.members.length > 0));
    setLayerOrder(prev => prev.filter(item => !emptiedGroupIds.has(item.id)));
    setHidden(prev => {
      const next = { ...prev };
      selected.forEach(id => { delete next[id]; });
      return next;
    });
    setSelectedStripIds([]);
    setStripSelectionName('');
    if (selected.has(selStripId)) setSelStripId(null);
    lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
  }, [selectedStripIds, strips, layers, editCounts, hidden, svgText, viewBox, density, selStripId, layerGroups, pushHistory, lsSave]);

  const deleteLayerGroup = useCallback((groupId) => {
    setLayerGroups(prev => prev.filter(g => g.groupId !== groupId));
    setLayerOrder(prev => prev.filter(x => x.id !== groupId));
  }, []);

  const toggleGroupExpanded = (groupId) =>
    setLayerGroups(prev => prev.map(g => g.groupId === groupId ? { ...g, _expanded: !g._expanded } : g));

  const toggleGroupHidden = useCallback((groupId) => {
    const group = layerGroups.find(g => g.groupId === groupId);
    if (!group) return;
    const nextHidden = !group._hidden;
    setLayerGroups(prev => prev.map(g => g.groupId === groupId ? { ...g, _hidden: nextHidden } : g));
    setHidden(prev => {
      const next = { ...prev };
      group.members.forEach(m => { next[m.stripId || m.pathId] = nextHidden; });
      return next;
    });
  }, [layerGroups]);

  // ── Layer order (drag-and-drop) ────────────────────────────────────────────

  const reorderLayerOrder = useCallback((fromId, toId) => {
    if (fromId === toId) return;
    setLayerOrder(prev => {
      const fi = prev.findIndex(x => x.id === fromId);
      const ti = prev.findIndex(x => x.id === toId);
      if (fi === -1 || ti === -1) return prev;
      const next = [...prev];
      const [removed] = next.splice(fi, 1);
      next.splice(ti, 0, removed);
      return next;
    });
  }, []);

  // ── Update strip property (with localStorage save) ─────────────────────────

  const updateStrip = useCallback((id, patch) => {
    setStrips(prev => {
      const next = prev.map(x => x.id === id ? { ...x, ...patch } : x);
      lsSave(next, layers, editCounts, hidden, svgText, viewBox, density);
      return next;
    });
  }, [layers, editCounts, hidden, svgText, viewBox, density, lsSave]);

  const updateStripWithHistory = useCallback((id, patch) => {
    setStrips(prev => {
      pushHistory(prev, layers, editCounts, hidden, svgText, viewBox, density);
      const next = prev.map(x => x.id === id ? { ...x, ...patch } : x);
      lsSave(next, layers, editCounts, hidden, svgText, viewBox, density);
      return next;
    });
  }, [layers, editCounts, hidden, svgText, viewBox, density, pushHistory, lsSave]);

  const setStripOffset = useCallback((id, nextX, nextY, withHistory = false) => {
    setStrips(prev => {
      if (withHistory) pushHistory(prev, layers, editCounts, hidden, svgText, viewBox, density);
      const next = prev.map(s => {
        if (s.id !== id) return s;
        return {
          ...s,
          x: nextX,
          y: nextY,
          pixels: sampleStripPixels(s.pathData, s.pixelCount, s.reversed, nextX, nextY),
        };
      });
      lsSave(next, layers, editCounts, hidden, svgText, viewBox, density);
      return next;
    });
  }, [layers, editCounts, hidden, svgText, viewBox, density, pushHistory, lsSave]);

  const updatePatchBoard = useCallback((mutate) => {
    setPatchBoard(prev => {
      const next = normalizePatchBoard(prev, strips);
      mutate(next);
      return normalizePatchBoard(next, strips);
    });
  }, [setPatchBoard, strips]);

  const nearestLedIndex = useCallback((event, strip) => {
    if (!svgRef.current || !strip?.pixels?.length) return null;
    const point = svgPt(svgRef.current, event.clientX, event.clientY);
    let nearestIndex = 0;
    let nearestDistance = Infinity;
    strip.pixels.forEach((pixel, index) => {
      const distance = Math.hypot(point.x - pixel.x, point.y - pixel.y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    const maxCut = strip.pixels.length - 2;
    if (maxCut < 0) return null;
    return Math.max(0, Math.min(maxCut, nearestIndex));
  }, []);

  const chopStripAtEvent = useCallback((event, strip) => {
    if (!strip || project.patchBoard?.physicalLocked) return;
    const cutLed = nearestLedIndex(event, strip);
    if (cutLed === null) return;
    const currentCuts = cutsForStrip(normalizePatchBoard(project.patchBoard, strips), strip.id);
    const nextCuts = [...new Set([...currentCuts, cutLed])].sort((a, b) => a - b);
    updatePatchBoard(next => sliceStripIntoPatchesPreservingRoute(next, strip, nextCuts));
    setSelStripId(strip.id);
    setSelectedStripIds([strip.id]);
    setSelectedWireCut({ stripId: strip.id, cutLed });
    setSelectedWirePatchId(null);
  }, [nearestLedIndex, project.patchBoard, strips, updatePatchBoard]);

  const toggleRoutePatch = useCallback((patchId) => {
    if (wireOverlayMode !== 'link' || project.patchBoard?.physicalLocked) return;
    setLinkRouteIds(prev => {
      const baseRoute = linkRouteStartedRef.current ? prev : [];
      const nextRoute = baseRoute.includes(patchId)
        ? baseRoute.filter(id => id !== patchId)
        : [...baseRoute, patchId];
      linkRouteStartedRef.current = true;
      updatePatchBoard(next => applyPatchRouteOrder(next, nextRoute));
      setSelectedWirePatchId(patchId);
      setSelectedWireCut(null);
      return nextRoute;
    });
  }, [project.patchBoard, updatePatchBoard, wireOverlayMode]);

  const nudgeSelectedWireCut = useCallback((delta) => {
    if (!selectedWireCut) return;
    const strip = strips.find(item => item.id === selectedWireCut.stripId);
    if (!strip) return;
    const step = Math.sign(Number(delta) || 0);
    if (!step) return;
    const board = normalizePatchBoard(project.patchBoard, strips);
    const currentCuts = cutsForStrip(board, strip.id);
    const index = currentCuts.indexOf(selectedWireCut.cutLed);
    if (index < 0) return;
    const maxLed = Math.max(0, strip.pixels?.length ?? strip.pixelCount ?? 1) - 1;
    const previousLimit = index === 0 ? 0 : currentCuts[index - 1] + 1;
    const nextLimit = index === currentCuts.length - 1 ? maxLed - 1 : currentCuts[index + 1] - 1;
    const nextCutLed = selectedWireCut.cutLed + step;
    if (nextCutLed < previousLimit || nextCutLed > nextLimit) return;
    updatePatchBoard(next => nudgeStripCut(next, strip, selectedWireCut.cutLed, step));
    setSelectedWireCut({ stripId: strip.id, cutLed: nextCutLed });
  }, [project.patchBoard, selectedWireCut, strips, updatePatchBoard]);

  const deleteSelectedWireCut = useCallback(() => {
    if (!selectedWireCut) return;
    const strip = strips.find(item => item.id === selectedWireCut.stripId);
    if (!strip) return;
    updatePatchBoard(next => deleteStripCut(next, strip, selectedWireCut.cutLed));
    setSelectedWireCut(null);
  }, [selectedWireCut, strips, updatePatchBoard]);

  const resampleStrip = useCallback((id, newCount) => {
    setStrips(prev => {
      const next = prev.map(s => {
        if (s.id !== id) return s;
        return rebuildStrip({ ...s, pixelCount: newCount });
      });
      lsSave(next, layers, editCounts, hidden, svgText, viewBox, density);
      return next;
    });
  }, [layers, editCounts, hidden, svgText, viewBox, density, lsSave]);

  const handleDensityChange = useCallback((newDensity) => {
    let saved;
    setStrips(prev => {
      saved = prev.map(s => {
        const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathEl.setAttribute('d', s.pathData);
        const svgLen = pathEl.getTotalLength ? pathEl.getTotalLength() : 0;
        const count = Math.max(1, Math.round((svgLen / pxPerMm) * newDensity / 1000));
        const pixels = sampleStripPixels(s.pathData, count, s.reversed, s.x || 0, s.y || 0);
        return { ...s, pixelCount: count, pixels };
      });
      return saved;
    });
    setEditCounts({});
    setDensity(newDensity);
    setTimeout(() => {
      if (saved) lsSave(saved, layers, {}, hidden, svgText, viewBox, newDensity);
    }, 0);
  }, [pxPerMm, lsSave, layers, hidden, svgText, viewBox]);

  // ── Draw tool ──────────────────────────────────────────────────────────────

  const finishDraw = useCallback((pts) => {
    if (pts.length < 2) return;
    const pathData = ptsToD(pts);
    const tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tempPath.setAttribute('d', pathData);
    const svgLength = tempPath.getTotalLength ? tempPath.getTotalLength() : 0;
    const pitch = 16.6;
    const autoCount = Math.max(1, Math.round(svgLength / (pitch * pxPerMm)));
    const defaultName = `Strip ${strips.length + 1}`;
    setPendingDraw({ pathData, svgLength });
    setPendingDrawName(defaultName);
    setPendingDrawCount(autoCount);
    setTimeout(() => pendingDrawNameRef.current?.select(), 50);
  }, [strips.length, pxPerMm]);

  const confirmDraw = useCallback(() => {
    if (!pendingDraw) return;
    const { pathData } = pendingDraw;
    const count = Math.max(1, pendingDrawCount);
    const name = pendingDrawName.trim() || `Strip ${strips.length + 1}`;
    const color = nextColor();
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', pathData);
    const pixels = libSamplePath(pathEl, count);
    const newStrip = {
      id: `drawn-${Date.now()}`,
      name,
      pathData, pixelCount: count, pixels, color,
      x: 0, y: 0,
      emit: 'dir', angle: 0, reversed: false,
      speed: 1.0, brightness: 1.0, hueShift: 0, patternId: null,
    };
    const newStrips = [...strips, newStrip];
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setStrips(newStrips);
    setSelStripId(newStrip.id);
    lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
    setPendingDraw(null);
    scrollToStrip(newStrip.id);
  }, [pendingDraw, pendingDrawCount, pendingDrawName, strips, layers, editCounts, hidden, svgText, viewBox, density, pushHistory, lsSave]);

  const cancelDraw = () => { setPendingDraw(null); };

  // ── Per-layer artwork opacity ─────────────────────────────────────────────

  useEffect(() => {
    const bg = artworkRef.current;
    if (!bg) return;

    // Collect every layer ID that should be "active" (highlighted)
    const activeIds = new Set();
    if (hoveredLayerId) activeIds.add(hoveredLayerId);
    if (selLayerId)     activeIds.add(selLayerId);
    if (selStripId) {
      const s = strips.find(st => st.id === selStripId);
      if (s) activeIds.add(s.id);
    }
    pathSel.forEach(p => { if (p.layerId) activeIds.add(p.layerId); });

    const hasFixed = selLayerId || selStripId || pathSel.length > 0;
    const dimOpacity = (hoveredLayerId && !hasFixed) ? '0.22' : '0.06';

    if (activeIds.size === 0) {
      bg.style.opacity = '0.5';
      layers.forEach(l => {
        const el = bg.querySelector('#' + CSS.escape(l.layerId));
        if (el) el.style.opacity = '';
      });
    } else {
      bg.style.opacity = '1';
      layers.forEach(l => {
        const el = bg.querySelector('#' + CSS.escape(l.layerId));
        if (!el) return;
        el.style.opacity = activeIds.has(l.layerId) ? '0.9' : dimOpacity;
      });
    }
  }, [hoveredLayerId, selLayerId, selStripId, strips, layers, artworkHTML, pathSel]);

  // ── pathSelName auto-fill ────────────────────────────────────────────────

  useEffect(() => {
    if (pathSel.length === 1) {
      setPathSelName(pathSel[0].name);
    } else if (pathSel.length === 0) {
      setPathSelName('');
    }
    // Intentionally using full pathSel as dep so name updates when selection changes
  }, [pathSel]);

  // ── Save / Load project ────────────────────────────────────────────────────

  const saveProject = () => {
    const date = new Date().toISOString().slice(0, 10);
    const data = {
      ...serializeProject(),
      layout: {
        ...serializeProject().layout,
        strips,
        layers,
        svgText,
        viewBox,
        density,
        pxPerMm,
        editCounts,
        hidden,
        layerGroups,
        layerOrder,
      },
    };
    download(`lightweaver-project-${date}.json`, JSON.stringify(data, null, 2));
  };

  const handleLoad = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    if (strips.length > 0) {
      const ok = window.confirm('Loading a project will replace your current strips. Continue?');
      if (!ok) return;
    }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!loadProject(data)) { alert('Unrecognised file format.'); return; }
    } catch (err) {
      alert('Could not load file: ' + err.message);
    }
  };

  // ── Undo / Redo ────────────────────────────────────────────────────────────

  const applySnapshot = (snap) => {
    if (snap.svgText !== svgText) {
      const doc = new DOMParser().parseFromString(snap.svgText || '', 'image/svg+xml');
      const srcSvg = doc.querySelector('svg');
      if (srcSvg) setPxPerMm(getPxPerMm(srcSvg));
    }
    setSvgText(snap.svgText);
    setViewBox(snap.viewBox);
    setDensity(snap.density);
    setLayers(snap.layers);
    setStrips(snap.strips.map(rebuildStrip));
    setEditCounts(snap.editCounts);
    setHidden(snap.hidden);
    if (snap.layerGroups) setLayerGroups(snap.layerGroups);
    if (snap.layerOrder)  setLayerOrder(snap.layerOrder);
  };

  const doUndo = useCallback(() => {
    if (!historyRef.current.length) return;
    const snap = historyRef.current.pop();
    futureRef.current.push(makeSnapshot(strips, layers, editCounts, hidden, svgText, viewBox, density));
    setHistLen(historyRef.current.length);
    setFutLen(futureRef.current.length);
    applySnapshot(snap);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, makeSnapshot]);

  const doRedo = useCallback(() => {
    if (!futureRef.current.length) return;
    const snap = futureRef.current.pop();
    historyRef.current.push(makeSnapshot(strips, layers, editCounts, hidden, svgText, viewBox, density));
    setHistLen(historyRef.current.length);
    setFutLen(futureRef.current.length);
    applySnapshot(snap);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, makeSnapshot]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === 'Space') {
        spaceRef.current = true;
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
          e.preventDefault();
        }
        return;
      }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

      // Draw mode: backspace removes last waypoint
      if (drawMode && e.key === 'Backspace') {
        e.preventDefault();
        setWaypoints(prev => prev.slice(0, -1));
        return;
      }

      if (e.key === 'Escape') {
        if (drawMode) { setDrawMode(false); setWaypoints([]); setGhostPt(null); }
        else if (pendingDraw) { cancelDraw(); }
        else {
          setSelLayerId(null);
          setSelStripId(null);
          setSelectedStripIds([]);
          setStripSelectionName('');
          setPathSel([]);
          setPathSelName('');
        }
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        if (!e.shiftKey && e.key === 'z') { e.preventDefault(); doUndo(); return; }
        if ((e.shiftKey && e.key === 'z') || (!e.shiftKey && e.key === 'y')) { e.preventDefault(); doRedo(); return; }
        return;
      }

      // Single-key shortcuts
      switch (e.key) {
        case 's': setDrawMode(false); setWaypoints([]); setGhostPt(null); break;
        case 'd': setDrawMode(m => !m); setWaypoints([]); setGhostPt(null); break;
        case 'Backspace':
        case 'Delete':
          e.preventDefault();
          if (pathSel.length > 0) deleteSelectedVectorPaths();
          else if (selectedStripIds.length > 1) removeSelectedStrips();
          else if (selStripId && layers.some(layer => layer.layerId === selStripId)) deleteLayer(selStripId);
          else if (selStripId) removeStrip(selStripId);
          else if (selLayerId) deleteLayer(selLayerId);
          break;
        case 'x':
          e.preventDefault();
          if (selectedStripIds.length > 1) removeSelectedStrips();
          else if (selStripId) removeStrip(selStripId);
          else if (pathSel.length > 0) deleteSelectedVectorPaths();
          else if (selLayerId) deleteLayer(selLayerId);
          break;
        case 'g':
          if (selectedStripIds.length > 1) groupSelectedStrips();
          else if (pathSel.length > 1) createLayerGroup();
          break;
        case 'm':
          if (selectedStripIds.length > 1) mergeSelectedStrips();
          break;
        case 'h':
          if (selStripId) setHidden(h => ({ ...h, [selStripId]: !h[selStripId] }));
          else if (selLayerId) setHidden(h => ({ ...h, [selLayerId]: !h[selLayerId] }));
          break;
        case 'a':
          if (layers.length > 0) addAllStrips();
          break;
        case 'f':
          resetView();
          break;
        default: break;
      }
    };
    const onKeyUp = (e) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        setIsPanning(false);
        isPanningRef.current = false;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [drawMode, pendingDraw, selStripId, selLayerId, selectedStripIds, pathSel, removeStrip, removeSelectedStrips, deleteSelectedVectorPaths, deleteLayer, groupSelectedStrips, mergeSelectedStrips, createLayerGroup, doUndo, doRedo, layers, addAllStrips]);

  // ── Memoised visualisation data ────────────────────────────────────────────

  const isEditingGesture = movingStripIds.length > 0 || !!rubberBand;

  const layoutPatternFrame = useMemo(() => {
    if (!strips.length) return new Map();
    const frameStrips = strips
      .filter(s => !hidden[s.id])
      .map(s => ({
        id: s.id,
        patternId: s.patternId || null,
        speed: s.speed,
        brightness: s.brightness,
        hueShift: s.hueShift,
        pts: (s.pixels || []).map((px, i) => ({
          x: px.x,
          y: px.y,
          p: (s.pixels || []).length > 1 ? i / ((s.pixels || []).length - 1) : 0.5,
          i,
        })),
      }));
    if (!frameStrips.length) return new Map();

    const perStripFns = new Map();
    for (const s of frameStrips) {
      if (s.patternId && !perStripFns.has(s.patternId)) {
        const fn = compilePattern(s.patternId);
        if (fn) perStripFns.set(s.patternId, fn);
      }
    }

    const frame = renderPixelFrame({
      t: 8.75,
      strips: frameStrips,
      patternId: activePatternId,
      activeFn: compilePattern(activePatternId),
      params: patternParams?.[activePatternId] || {},
      patternParamsById: patternParams,
      paletteNorm: normalizePalette(palette),
      bpm,
      masterSpeed,
      masterBrightness,
      masterSaturation,
      masterHueShift,
      gammaLUT: buildGammaLut(gammaEnabled, gammaValue),
      symSettings,
      audioBands: null,
      perStripFns,
    });
    return new Map(frame.stripFrames.map(stripFrame => [stripFrame.id, stripFrame]));
  }, [
    strips,
    hidden,
    activePatternId,
    patternParams,
    palette,
    bpm,
    masterSpeed,
    masterBrightness,
    masterSaturation,
    masterHueShift,
    gammaEnabled,
    gammaValue,
    symSettings,
  ]);

  const stripSamples = useMemo(() => {
    if (!showLight || isEditingGesture || glowMode === 'dots') return {};
    return Object.fromEntries(strips.map(s => [
      s.id,
      offsetSamplePoints(sampleForViz(s.pathData, s.pixelCount), s.x || 0, s.y || 0),
    ]));
  }, [strips, showLight, isEditingGesture, glowMode]);

  const stripArrows = useMemo(() => {
    if (isEditingGesture) return {};
    return Object.fromEntries(strips.map(s => [s.id, offsetArrow(calcArrow(s.pathData, s.reversed ?? false), s.x || 0, s.y || 0)]));
  }, [strips, isEditingGesture]);

  const wirePathCanvasSegments = useMemo(() => {
    const board = normalizePatchBoard(project.patchBoard, strips);
    const stripsById = new Map(strips.map(strip => [strip.id, strip]));
    const rowOrder = new Map(mainChain(board).rowIds.map((patchId, order) => [patchId, order]));
    const segmentPatches = board.patches
      .filter(patch => patch.source?.type === 'strip')
      .map(patch => ({
        patch,
        order: rowOrder.get(patch.id),
        linked: rowOrder.has(patch.id),
      }));
    const patchCountsByStrip = segmentPatches.reduce((counts, { patch }) => {
      const stripId = patch.source.stripId;
      counts.set(stripId, (counts.get(stripId) || 0) + 1);
      return counts;
    }, new Map());

    const segments = [];
    segmentPatches.forEach(({ patch, order, linked }) => {
      const stripId = patch.source.stripId;
      if (hidden[stripId]) return;
      const strip = stripsById.get(stripId);
      if (!strip?.pixels?.length) return;
      const start = Number(patch.source.startLed);
      const end = Number(patch.source.endLed);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const min = Math.min(start, end);
      const max = Math.max(start, end);
      const sampledPoints = strip.pixels
        .filter((point, index) => index >= min && index <= max)
        .map(point => ({ x: point.x, y: point.y }));
      if (!sampledPoints.length) return;
      const points = start > end ? [...sampledPoints].reverse() : sampledPoints;
      const renderPoints = points.length === 1 ? [points[0], points[0]] : points;
      const isFullStrip = min === 0 && max === strip.pixels.length - 1;
      segments.push({
        id: patch.id,
        patchId: patch.id,
        stripId,
        color: strip.color || 'var(--accent)',
        order,
        linked,
        showWhenIdle: (patchCountsByStrip.get(stripId) || 0) > 1 || !isFullStrip,
        points: renderPoints,
        mid: points[Math.floor(points.length / 2)],
        startPoint: renderPoints[0],
        endPoint: renderPoints[renderPoints.length - 1],
      });
    });
    return segments;
  }, [project.patchBoard, strips, hidden]);

  const visibleWirePathCanvasSegments = useMemo(
    () => wireOverlayMode === 'link'
      ? wirePathCanvasSegments
      : wirePathCanvasSegments.filter(segment => segment.showWhenIdle),
    [wireOverlayMode, wirePathCanvasSegments],
  );

  const wireRouteJumps = useMemo(() => {
    const linked = wirePathCanvasSegments
      .filter(segment => segment.linked && Number.isFinite(segment.order))
      .sort((a, b) => a.order - b.order);
    return linked.slice(0, -1).map((segment, index) => ({
      id: `${segment.patchId}-${linked[index + 1].patchId}`,
      from: segment.endPoint,
      to: linked[index + 1].startPoint,
    }));
  }, [wirePathCanvasSegments]);

  const wireCutMarkers = useMemo(() => {
    const board = normalizePatchBoard(project.patchBoard, strips);
    return strips
      .filter(strip => !hidden[strip.id] && strip.pixels?.length)
      .flatMap(strip => cutsForStrip(board, strip.id)
        .map(cutLed => {
          const point = strip.pixels[cutLed];
          if (!point) return null;
          const before = strip.pixels[Math.max(0, cutLed - 1)] || point;
          const after = strip.pixels[Math.min(strip.pixels.length - 1, cutLed + 1)] || point;
          const angle = Math.atan2(after.y - before.y, after.x - before.x) * 180 / Math.PI;
          return {
            id: `${strip.id}-${cutLed}`,
            stripId: strip.id,
            cutLed,
            x: point.x,
            y: point.y,
            angle: Number.isFinite(angle) ? angle : 0,
            color: strip.color || 'var(--accent)',
            selected: selectedWireCut?.stripId === strip.id && selectedWireCut?.cutLed === cutLed,
          };
        })
        .filter(Boolean));
  }, [project.patchBoard, strips, hidden, selectedWireCut]);

  const totalLeds = strips.reduce((n, s) => n + s.pixelCount, 0);
  const selectedStrips = useMemo(() => {
    const selected = new Set(selectedStripIds);
    return strips.filter(s => selected.has(s.id));
  }, [strips, selectedStripIds]);

  // ── Viewport scale for adaptive sizing ────────────────────────────────────

  const vbScale = useMemo(() => {
    const vb = parsedVb(viewBox);
    return Math.max(vb.w, vb.h) / 600;
  }, [viewBox]);

  // ── Lasso hit-test (runs on global mouseup, uses latest layers/hidden via ref) ─

  const finishLasso = useCallback((ev) => {
    const rb = rubberBandRef.current;
    rubberBandRef.current = null;
    setRubberBand(null);
    if (!rb || (Math.abs(rb.x2 - rb.x1) < 4 && Math.abs(rb.y2 - rb.y1) < 4)) return;
    const svg = svgRef.current;
    if (!svg) return;
    // Convert viewport-relative lasso corners → client coords → SVG user coords
    const vl = rb.vpLeft ?? 0, vt = rb.vpTop ?? 0;
    const tl = svgPt(svg, Math.min(rb.x1, rb.x2) + vl, Math.min(rb.y1, rb.y2) + vt);
    const br = svgPt(svg, Math.max(rb.x1, rb.x2) + vl, Math.max(rb.y1, rb.y2) + vt);
    const hits = [];
    layers.forEach(l => {
      if (hidden[l.layerId] || !l.pathData) return;
      const targets = l.subPaths?.length > 0
        ? l.subPaths
        : [{ pathId: l.layerId, pathData: l.pathData, name: l.name, svgLength: l.svgLength }];
      targets.forEach(t => {
        if (!hidden[t.pathId] && pathIntersectsRect(t.pathData, tl.x, tl.y, br.x, br.y)) {
          hits.push({ layerId: l.layerId, pathId: t.pathId, pathData: t.pathData,
                      name: l.subPaths?.length > 0 ? `${l.name} · ${t.name}` : l.name,
                      svgLength: t.svgLength });
        }
      });
    });
    if (hits.length > 0) {
      justFinishedLassoRef.current = true;
      setPathSel(prev => ev.shiftKey
        ? [...prev, ...hits.filter(h => !prev.some(p => p.pathId === h.pathId))]
        : hits);
      setSelLayerId(null);
      setSelectedStripIds([]);
      setStripSelectionName('');
    }
  }, [layers, hidden]);
  useEffect(() => { lassoFinishRef.current = finishLasso; }, [finishLasso]);

  // ── Draw mode SVG events ───────────────────────────────────────────────────

  const handleSvgMouseDown = (e) => {
    if (spaceRef.current) {
      isPanningRef.current = true;
      setIsPanning(true);
      panAnchorRef.current = { clientX: e.clientX, clientY: e.clientY, panX, panY };
      e.preventDefault();
      return;
    }
    // Start rubber-band lasso when clicking on empty canvas (not on a path element)
    if (!drawMode && svgRef.current) {
      const onBackground = e.target === svgRef.current || e.target.tagName === 'svg';
      if (onBackground) {
        // Store viewport-relative coords so position:absolute lasso div tracks correctly
        // (position:fixed breaks when any ancestor has backdrop-filter)
        const vpRect = vpRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const rx = e.clientX - vpRect.left;
        const ry = e.clientY - vpRect.top;
        rubberBandRef.current = { x1: rx, y1: ry, x2: rx, y2: ry, vpLeft: vpRect.left, vpTop: vpRect.top };
        setRubberBand({ ...rubberBandRef.current });
        e.preventDefault();
        // Global listeners so drag continues even outside SVG bounds
        const onWinMove = (ev) => {
          if (!rubberBandRef.current) return;
          const rb = rubberBandRef.current;
          rubberBandRef.current = { ...rb, x2: ev.clientX - rb.vpLeft, y2: ev.clientY - rb.vpTop };
          setRubberBand({ ...rubberBandRef.current });
        };
        const onWinUp = (ev) => {
          window.removeEventListener('mousemove', onWinMove);
          window.removeEventListener('mouseup', onWinUp);
          lassoFinishRef.current?.(ev);
        };
        window.addEventListener('mousemove', onWinMove);
        window.addEventListener('mouseup', onWinUp);
      }
    }
  };

  const handleSvgClick = (e) => {
    if (isPanningRef.current) return;
    if (e.detail > 1) return;
    if (drawMode) {
      const pt = svgPt(svgRef.current, e.clientX, e.clientY);
      setWaypoints(prev => [...prev, pt]);
      return;
    }
    // Don't clear selection if we just finished a lasso drag
    if (justFinishedLassoRef.current) { justFinishedLassoRef.current = false; return; }
    if (e.target === svgRef.current || e.target.tagName === 'svg') {
      setPathSel([]);
      setPathSelName('');
      setSelLayerId(null);
      setSelStripId(null);
      setSelectedStripIds([]);
      setStripSelectionName('');
    }
  };

  const handleSvgDblClick = (e) => {
    if (!drawMode) return;
    e.preventDefault();
    const pts = waypoints.length >= 2 ? waypoints.slice(0, -1) : waypoints;
    setWaypoints([]);
    setGhostPt(null);
    setDrawMode(false);
    if (pts.length >= 2) finishDraw(pts);
  };

  const handleSvgMouseMove = (e) => {
    if (isPanningRef.current && panAnchorRef.current && svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const vb = parsedVb(viewBox);
      const vbW = vb.w / zoom;
      const vbH = vb.h / zoom;
      const dx = (e.clientX - panAnchorRef.current.clientX) * (vbW / rect.width);
      const dy = (e.clientY - panAnchorRef.current.clientY) * (vbH / rect.height);
      setPanX(panAnchorRef.current.panX - dx);
      setPanY(panAnchorRef.current.panY - dy);
      return;
    }
    if (svgRef.current) {
      const pt = svgPt(svgRef.current, e.clientX, e.clientY);
      setCursorSvgPt(pt);
      if (drawMode) { setGhostPt(pt); return; }
    }
  };

  const handleSvgMouseUp = () => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      setIsPanning(false);
    }
    // Lasso finish is handled by the global window listener added in handleSvgMouseDown
  };

  const handleSvgMouseLeave = () => {
    setCursorSvgPt(null);
    if (!drawMode) setGhostPt(null);
  };

  const handleContextMenu = (e) => {
    if (drawMode) {
      e.preventDefault();
      setDrawMode(false);
      setWaypoints([]);
      setGhostPt(null);
    }
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom(z => Math.max(0.15, Math.min(40, z * factor)));
  };

  // Ghost path for draw mode
  const ghostD = useMemo(() => {
    if (!drawMode) return null;
    const pts = ghostPt ? [...waypoints, ghostPt] : waypoints;
    if (pts.length < 1) return null;
    return ptsToD(pts.length === 1 ? [pts[0], pts[0]] : pts);
  }, [drawMode, waypoints, ghostPt]);

  // Estimated LED count during drawing
  const drawEstimatedLeds = useMemo(() => {
    if (!drawMode || waypoints.length < 2) return 0;
    const pathData = ptsToD(waypoints);
    const len = measurePathLen(pathData);
    return Math.max(1, Math.round(len / (16.6 * pxPerMm)));
  }, [drawMode, waypoints, pxPerMm]);

  const existingStrip = selLayer ? strips.find(s => s.id === selLayer.layerId) : null;

  const enableLightPreview = useCallback(() => {
    setShowLight(true);
    setGlowMode(mode => mode === 'dots' ? 'center' : mode);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  const effectiveGlowMode = isEditingGesture ? 'dots' : glowMode;
  const effectiveShowLight = showLight && !isEditingGesture && effectiveGlowMode !== 'dots';
  const glowStdDev = effectiveGlowMode === 'outward' ? 2.8 : effectiveGlowMode === 'inward' ? 0.8 : 1.6;

  return (
    <div className="lw-layout-screen" style={{ '--lw-layout-panel-width': `${panelWidth}px` }}>

      {/* ── Hidden file inputs ─────────────────────────────────────── */}
      <input ref={fileRef} type="file" accept=".svg"  style={{ display: 'none' }} onChange={handleFile}/>
      <input ref={loadRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoad}/>

      {/* ── Canvas column ──────────────────────────────────────────── */}
      <div className="lw-canvas-col">
        <div className="lw-canvas-toolbar">
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M6 1v8M3 5l3-4 3 4M1 10h10"/>
            </svg>
            Import SVG
          </button>

          {layers.length > 0 && (
            <button className="btn btn-ghost" onClick={addAllStrips}
                    title={`Add all ${layers.length} layers as strips (A)`}>
              + All ({layers.length})
            </button>
          )}

          <span className="tbar-divider"/>

          {/* Draw tool */}
          <button
            className={`btn ${drawMode ? 'btn-primary' : 'btn-ghost'}`}
            title={drawMode ? 'Cancel draw (Esc / right-click)' : 'Draw strip (D) — click waypoints, double-click to finish, backspace to undo point'}
            onClick={() => { setDrawMode(m => !m); setWireOverlayMode('idle'); setWaypoints([]); setGhostPt(null); }}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 10 L8 2 M8 2 L10 4 M5 8 L10 4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {drawMode ? 'Drawing…' : 'Draw'}
          </button>

          <button
            className={`btn ${wireOverlayMode === 'chop' ? 'btn-primary' : 'btn-ghost'}`}
            title="Chop wire path segments on the artwork"
            onClick={() => {
              setDrawMode(false);
              setWaypoints([]);
              setGhostPt(null);
              setWireOverlayMode(mode => mode === 'chop' ? 'idle' : 'chop');
            }}>
            Chop
          </button>
          <button
            className={`btn ${wireOverlayMode === 'link' ? 'btn-primary' : 'btn-ghost'}`}
            title="Link chopped segments into physical order"
            onClick={() => {
              setDrawMode(false);
              setWaypoints([]);
              setGhostPt(null);
              setSelectedWirePatchId(null);
              setWireOverlayMode(mode => {
                const nextMode = mode === 'link' ? 'idle' : 'link';
                if (nextMode === 'link') {
                  const currentRows = mainChain(normalizePatchBoard(project.patchBoard, strips)).rowIds;
                  setLinkRouteIds(currentRows);
                  linkRouteStartedRef.current = false;
                } else {
                  setLinkRouteIds([]);
                  linkRouteStartedRef.current = false;
                }
                return nextMode;
              });
            }}>
            Link
          </button>
          {wireOverlayMode !== 'idle' && (
            <span className="lw-route-mode-chip">
              {wireOverlayMode === 'chop' ? 'Chop' : 'Link'}
            </span>
          )}

          <span className="tbar-divider"/>

          {/* Undo / Redo */}
          <button className="btn btn-ghost" onClick={doUndo} disabled={histLen === 0}
                  title={`Undo (⌘Z) · ${histLen} step${histLen !== 1 ? 's' : ''}`}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 5 L5 2 M2 5 L5 8 M2 5 Q6 2 10 6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {histLen > 0 && <span style={{ fontSize: 'var(--fs-2xs)', fontFamily: 'var(--mono-font)', opacity: 0.7 }}>{histLen}</span>}
          </button>
          <button className="btn btn-ghost" onClick={doRedo} disabled={futLen === 0}
                  title={`Redo (⌘⇧Z) · ${futLen} step${futLen !== 1 ? 's' : ''}`}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M10 5 L7 2 M10 5 L7 8 M10 5 Q6 2 2 6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {futLen > 0 && <span style={{ fontSize: 'var(--fs-2xs)', fontFamily: 'var(--mono-font)', opacity: 0.7 }}>{futLen}</span>}
          </button>

          <span className="tbar-divider"/>
          <span className="tbar-label">Density</span>
          <div style={{ display: 'flex', gap: 2 }}>
            {DENSITY_OPTIONS.map(d => (
              <button key={d} className={`btn ${density === d ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ padding: '3px 8px', fontSize: 'var(--fs-sm)' }}
                      onClick={() => handleDensityChange(d)}>{d}/m</button>
            ))}
          </div>

          <div style={{ flex: 1 }}/>

          {/* Zoom controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button className="btn btn-ghost" style={{ padding: '3px 7px', fontSize: 'var(--fs-sm)' }}
                    onClick={() => setZoom(z => Math.min(40, z * 1.25))} title="Zoom in (+)">+</button>
            <button className="btn btn-ghost" style={{ padding: '3px 5px', fontSize: 'var(--fs-2xs)', fontFamily: 'var(--mono-font)', minWidth: 38, textAlign: 'center' }}
                    onClick={resetView} title="Reset view (F)">
              {Math.round(zoom * 100)}%
            </button>
            <button className="btn btn-ghost" style={{ padding: '3px 7px', fontSize: 'var(--fs-sm)' }}
                    onClick={() => setZoom(z => Math.max(0.15, z / 1.25))} title="Zoom out (-)">−</button>
          </div>

          <span className="tbar-divider"/>

          {/* Save / Load */}
          <button className="btn btn-ghost" onClick={saveProject} title="Save project JSON">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2" y="2" width="8" height="8" rx="1"/>
              <path d="M4 2v3h4V2M4 7h4"/>
            </svg>
            Save
          </button>
          <button className="btn btn-ghost" onClick={() => loadRef.current?.click()} title="Load project JSON">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 9V5l4-3 4 3v4H2M5 9V6h2v3"/>
            </svg>
            Load
          </button>

          <span className="tbar-divider"/>

          <button className={`btn ${showLight ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setShowLight(v => !v)}
                  title="Toggle ambient light preview (pauses while dragging for speed)">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
              <circle cx="6" cy="6" r="2"/>
              <path d="M6 1v1.5M6 9.5V11M1 6h1.5M9.5 6H11M2.5 2.5l1 1M8.5 8.5l1 1M2.5 9.5l1-1M8.5 3.5l1-1"/>
            </svg>
            Light
          </button>
          <button className={`btn ${showLeds ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setShowLeds(v => !v)}
                  title="Toggle LED dots">
            LEDs
          </button>
          <button className={`btn ${showHeat ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setShowHeat(v => !v)} title="Coverage heatmap">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M6 1c-2 2-3 3-3 5a3 3 0 006 0c0-2-1-3-3-5z"/></svg>
            Heat
          </button>
          <button className={`btn ${directedGlow ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => {
                    setDirectedGlow(v => !v);
                    enableLightPreview();
                  }}
                  title="Directed glow — elongate bloom along strip direction">
            ◈
          </button>
          <button className="btn btn-ghost"
                  onClick={() => setGlowMode(m => GLOW_MODES[(GLOW_MODES.indexOf(m) + 1) % GLOW_MODES.length])}
                  title="Cycle glow mode (dots is fastest for editing)">
            ◉ {glowMode}
          </button>
        </div>

        {/* Viewport */}
        <div
          ref={vpRef}
          className={`lw-viewport${dragOver ? ' lw-viewport--drop' : ''}`}
          style={{ display: 'grid', placeItems: 'center', cursor: isPanning ? 'grabbing' : 'default' }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragOver && (
            <div style={{
              position: 'absolute', inset: 12, border: '2px dashed var(--accent)',
              borderRadius: 8, pointerEvents: 'none', zIndex: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'oklch(16% 0.02 210 / 0.4)',
            }}>
              <span style={{ color: 'var(--accent)', fontSize: 'var(--fs-md)', fontWeight: 500 }}>Drop SVG here</span>
            </div>
          )}
          <svg
            ref={svgRef}
            viewBox={computedViewBox}
            overflow="visible"
            preserveAspectRatio="xMidYMid meet"
            style={{
              width: '100%', height: '100%',
              maxWidth: '100%', maxHeight: '100%',
              aspectRatio: `${parsedVb(viewBox).w} / ${parsedVb(viewBox).h}`,
              objectFit: 'contain',
              cursor: drawMode ? 'crosshair' : rubberBand ? 'crosshair' : isPanning ? 'grabbing' : spaceRef.current ? 'grab' : 'default',
            }}
            onClick={handleSvgClick}
            onDoubleClick={handleSvgDblClick}
            onMouseMove={handleSvgMouseMove}
            onMouseDown={handleSvgMouseDown}
            onMouseUp={handleSvgMouseUp}
            onMouseLeave={handleSvgMouseLeave}
            onContextMenu={handleContextMenu}
            onWheel={handleWheel}
          >
            <defs>
              {effectiveGlowMode !== 'dots' && (
                <filter id="lw-led-bloom" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation={glowStdDev}/>
                </filter>
              )}
              {/* Single filter for all ambient light — one blur op on the whole group, not per-element */}
              <filter id="lw-light-glow" x="-150%" y="-150%" width="400%" height="400%">
                <feGaussianBlur stdDeviation={vbScale * 4}/>
              </filter>
              <radialGradient id="heat-grad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="oklch(80% 0.2 30)" stopOpacity="1"/>
                <stop offset="100%" stopColor="oklch(80% 0.2 30)" stopOpacity="0"/>
              </radialGradient>
            </defs>

            {/* ── Artwork background ── */}
            {artworkHTML && (
              <g ref={artworkRef}
                 style={{ pointerEvents: 'none', filter: 'saturate(3) brightness(1.4)', mixBlendMode: 'screen',
                          opacity: effectiveShowLight ? 0.18 : 1, transition: isEditingGesture ? 'none' : 'opacity 0.2s' }}
                 dangerouslySetInnerHTML={{ __html: artworkHTML }}/>
            )}

            {/* ── Coverage heat map ── */}
            {showHeat && (
              <g style={{ pointerEvents: 'none' }}>
                {strips.filter(s => !hidden[s.id]).flatMap(s =>
                  s.pixels.map((px, i) => (
                    <circle key={`${s.id}-heat-${i}`} cx={px.x} cy={px.y}
                            r={vbScale * 18}
                            fill="url(#heat-grad)" opacity={0.09}
                            style={{ mixBlendMode: 'screen' }}/>
                  ))
                )}
              </g>
            )}

            {/* ── Selected layer glow (only when selected from panel, not canvas path-click) ── */}
            {selLayer && !selStripId && pathSel.length === 0 && (() => {
              const glowPaths = selLayer.subPaths?.length > 0
                ? selLayer.subPaths.map(sp => ({ id: sp.pathId, d: sp.pathData }))
                : [{ id: selLayer.layerId, d: selLayer.pathData }];
              return glowPaths.filter(p => p.d).map(p => (
                <g key={p.id} style={{ pointerEvents: 'none' }}>
                  <path d={p.d} stroke={selLayer._color} strokeWidth="2" strokeOpacity={0.5} fill="none" strokeLinecap="round"/>
                  <path d={p.d} stroke="#4cc9f0" strokeWidth="7" strokeOpacity={0.12} fill="none" strokeLinecap="round"/>
                  <path d={p.d} stroke="#4cc9f0" strokeWidth="3" strokeOpacity={0.55} fill="none" strokeLinecap="round"/>
                  <path d={p.d} stroke="white"   strokeWidth="1"  strokeOpacity={0.85} fill="none" strokeLinecap="round"/>
                </g>
              ));
            })()}

            {/* ── Hit paths — individual path selection ── */}
            {!drawMode && layers.map(l => {
              if (hidden[l.layerId] || !l.pathData) return null;
              const hasSubPaths = l.subPaths?.length > 0;
              const targets = hasSubPaths
                ? l.subPaths.map(sp => ({ pathId: sp.pathId, pathData: sp.pathData, name: sp.name, svgLength: sp.svgLength }))
                : [{ pathId: l.layerId, pathData: l.pathData, name: l.name, svgLength: l.svgLength }];
              return targets.map(t => {
                const entry = {
                  layerId: l.layerId, pathId: t.pathId, pathData: t.pathData,
                  name: hasSubPaths ? `${l.name} · ${t.name}` : l.name,
                  svgLength: t.svgLength,
                };
                return (
                  <path key={t.pathId} d={t.pathData}
                        data-vector-layer-id={l.layerId}
                        data-vector-path-id={t.pathId}
                        fill="none" stroke="#fff" strokeOpacity="0.001"
                        strokeWidth="16" strokeLinecap="round" pointerEvents="stroke"
                        style={{ cursor: 'pointer' }}
                        onMouseDown={e => e.stopPropagation()}
                        onMouseEnter={() => { setHoveredLayerId(l.layerId); setHoveredSubPathId(t.pathId); }}
                        onMouseLeave={() => { setHoveredLayerId(null); setHoveredSubPathId(null); }}
                        onClick={e => {
                          e.stopPropagation();
	                          if (e.shiftKey) {
	                            // Shift-click: toggle this path in/out of selection
	                            setPathSel(prev => prev.some(p => p.pathId === t.pathId)
	                              ? prev.filter(p => p.pathId !== t.pathId)
	                              : [...prev, entry]);
	                          } else {
                            // Single click: select only this individual path
                            setPathSel([entry]);
                            setSelStripId(null);
                            // Clear inspector — canvas clicks don't open the layer inspector
	                            // (use the layer panel rows for that)
	                            setSelLayerId(null);
	                          }
	                          setSelectedStripIds([]);
	                          setStripSelectionName('');
	                        }}/>
                );
              });
            })}

            {/* ── Hovered sub-path outline ── */}
            {hoveredSubPathId && (() => {
              for (const l of layers) {
                if (hidden[l.layerId]) continue;
                const t = l.subPaths?.find(s => s.pathId === hoveredSubPathId)
                       ?? (l.layerId === hoveredSubPathId ? { pathData: l.pathData } : null);
                if (t?.pathData) return (
                  <path key="hover-sp" d={t.pathData} fill="none"
                        stroke="oklch(76% 0.18 290)" strokeWidth="3" strokeOpacity={0.55}
                        strokeLinecap="round" pointerEvents="none"/>
                );
              }
              return null;
            })()}


            {/* ── Path selection highlight (marching ants = canvas path-pick for strip assignment) ── */}
            {pathSel.map((p, idx) => {
              const midEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
              midEl.setAttribute('d', p.pathData);
              const len = midEl.getTotalLength ? midEl.getTotalLength() : 100;
              const midPt = midEl.getPointAtLength ? midEl.getPointAtLength(len * 0.5) : { x: 0, y: 0 };
              return (
                <g key={'sel-' + p.pathId} style={{ pointerEvents: 'none' }}>
                  <path d={p.pathData} stroke="oklch(84% 0.28 138)" strokeWidth="8" fill="none" opacity={0.14} strokeLinecap="round"/>
                  <path d={p.pathData} stroke="oklch(84% 0.28 138)" strokeWidth="2.5" fill="none" opacity={0.9}
                        strokeDasharray="10 5" strokeLinecap="round"
                        style={{ animation: 'lw-march 0.5s linear infinite' }}/>
                  <circle cx={midPt.x} cy={midPt.y} r={vbScale * 9} fill="oklch(84% 0.28 138)" opacity={0.9}/>
                  <text x={midPt.x} y={midPt.y + vbScale * 4} textAnchor="middle" fill="oklch(12% 0.04 138)" fontSize={vbScale * 9}
                        fontWeight="bold" style={{ userSelect: 'none' }}>{idx + 1}</text>
                </g>
              );
            })}

            {/* ── Light visualization ── */}
            {effectiveShowLight && (
              <g filter={directedGlow ? undefined : 'url(#lw-light-glow)'} style={{ mixBlendMode: 'screen', pointerEvents: 'none' }}>
                {strips.map(s => !hidden[s.id] && (stripSamples[s.id] || []).map((pt, i) => {
                  const stripFrame = layoutPatternFrame.get(s.id);
                  const lightColor = rgbCss(stripFrame?.leds?.[i] || stripFrame, s.color);
                  const reach = vbScale * (effectiveGlowMode === 'inward' ? 24 : effectiveGlowMode === 'outward' ? 50 : 38);
                  const intensity = s.id === selStripId ? 0.42 : 0.28;
                  if (directedGlow) {
                    const isOmni = s.emit === 'omni';
                    const tangentAngle = Math.atan2(pt.ty || 0, pt.tx || 1) * 180 / Math.PI + 90;
                    const angle = Number.isFinite(Number(s.angle)) ? Number(s.angle) : tangentAngle;
                    return isOmni
                      ? <OmniHalo key={`${s.id}-${i}`} uid={`${s.id}-${i}`} cx={pt.x} cy={pt.y} color={lightColor} reach={reach * 0.72} intensity={intensity}/>
                      : <LightCone key={`${s.id}-${i}`} uid={`${s.id}-${i}`} cx={pt.x} cy={pt.y} angle={angle} color={lightColor} reach={reach} intensity={intensity}/>;
                  }
                  return (
                    <circle key={`${s.id}-${i}`}
                            cx={pt.x} cy={pt.y}
                            r={vbScale * 22}
                            fill={lightColor}
                            opacity={0.28}/>
                  );
                }))}
              </g>
            )}

            {/* ── Strip paths ── */}
            {strips.map(s => {
              const isSel = s.id === selStripId;
              const isHid = !!hidden[s.id];
              const isMoving = movingStripIds.includes(s.id);
              const stripFrame = layoutPatternFrame.get(s.id);
              const stripColor = rgbCss(stripFrame, s.color);
              return (
                <g key={s.id} transform={`translate(${s.x || 0} ${s.y || 0})`}>
                  <path d={s.pathData}
                        data-strip-path={s.id}
                        fill="none"
                        stroke="white"
                        strokeOpacity="0.001"
                        strokeWidth="18"
                        strokeLinecap="round"
                        pointerEvents="visibleStroke"
                        style={{ cursor: isMoving ? 'grabbing' : 'grab' }}
                        onMouseDown={e => {
                          if (wireOverlayMode === 'chop') {
                            e.preventDefault();
                            e.stopPropagation();
                            return;
                          }
                          startStripMove(e, s);
                        }}
                        onClick={e => {
                          e.stopPropagation();
                          if (stripDragSuppressClickRef.current) return;
                          if (wireOverlayMode === 'chop') {
                            chopStripAtEvent(e, s);
                            return;
                          }
                          if (e.shiftKey || e.metaKey || e.ctrlKey) toggleStripSelection(s.id);
                          else selectStrip(s.id);
                        }}/>
                  <path d={s.pathData}
                        stroke={isHid ? 'oklch(40% 0.01 260)' : stripColor}
                        strokeWidth={isSel ? 8 : 4.5} fill="none"
                        strokeOpacity={isHid ? 0 : isSel ? 0.22 : 0.1}
                        strokeLinecap="round"
                        pointerEvents="none"/>
                  <path d={s.pathData}
                        stroke={isHid ? 'oklch(40% 0.01 260)' : stripColor}
                        strokeWidth={isSel ? 3.5 : 1.8} fill="none"
                        pointerEvents="none"
                        opacity={isHid ? 0.25 : isMoving ? 1 : isSel ? 1 : 0.7}
                        style={{ filter: isSel && !isEditingGesture ? `drop-shadow(0 0 3px ${stripColor})` : 'none' }}/>
                </g>
              );
            })}

            {!isEditingGesture && visibleWirePathCanvasSegments.length > 0 && (
              <g
                className="lw-wire-canvas-segments"
                style={{ pointerEvents: wireOverlayMode === 'link' ? 'auto' : 'none' }}
              >
                {visibleWirePathCanvasSegments.map(segment => (
                  <g key={segment.id}>
                    {wireOverlayMode === 'link' && (
                      <polyline
                        points={pointsAttr(actionablePolylinePoints(segment.points))}
                        className="lw-wire-canvas-segment-hit"
                        onClick={event => {
                          event.stopPropagation();
                          toggleRoutePatch(segment.patchId);
                        }}
                      />
                    )}
                    <polyline
                      points={pointsAttr(segment.points)}
                      className="lw-wire-canvas-segment"
                      style={{ '--wire-color': segment.color }}
                    />
                    {segment.linked && Number.isFinite(segment.order) && (
                      <g className="lw-route-badge">
                        <circle cx={segment.mid.x} cy={segment.mid.y} r={vbScale * 9}/>
                        <text x={segment.mid.x} y={segment.mid.y + vbScale * 3.5} fontSize={vbScale * 8}>
                          {segment.order + 1}
                        </text>
                      </g>
                    )}
                  </g>
                ))}
              </g>
            )}

            {!isEditingGesture && wireRouteJumps.length > 0 && (
              <g className="lw-wire-route-jumps" style={{ pointerEvents: 'none' }}>
                {wireRouteJumps.map(jump => (
                  <line
                    key={jump.id}
                    className="lw-wire-route-jump"
                    x1={jump.from.x}
                    y1={jump.from.y}
                    x2={jump.to.x}
                    y2={jump.to.y}
                  />
                ))}
              </g>
            )}

            {!isEditingGesture && wireCutMarkers.length > 0 && (
              <g className="lw-wire-cut-markers" style={{ pointerEvents: 'none' }}>
                {wireCutMarkers.map(marker => {
                  const notchSize = vbScale * (marker.selected ? 10 : 8);
                  const wing = notchSize * 0.48;
                  return (
                    <g
                      key={marker.id}
                      className={`lw-wire-cut-marker ${marker.selected ? 'selected' : ''}`}
                      transform={`translate(${marker.x} ${marker.y}) rotate(${marker.angle})`}
                      style={{ '--wire-color': marker.color }}
                    >
                      <path
                        className="lw-wire-cut-marker-notch"
                        d={`M 0 ${-notchSize} L 0 ${notchSize} M ${-wing} ${-notchSize * 0.62} L 0 0 L ${-wing} ${notchSize * 0.62}`}
                      />
                    </g>
                  );
                })}
              </g>
            )}

            {/* ── LED dots — dim hardware at rest, bright only when pattern is lit ── */}
            {showLeds && !isEditingGesture && strips.filter(s => !hidden[s.id]).map(s => (
              effectiveGlowMode === 'dots' ? (
	                <g key={s.id + '-dots'} style={{ pointerEvents: 'none' }}>
                  {s.pixels.map((px, i) => {
                    const ledFrame = layoutPatternFrame.get(s.id)?.leds?.[i];
                    const selected = s.id === selStripId;
                    const ledColor = ledCssColor(ledFrame, 'oklch(58% 0.035 240)');
                    const shellOpacity = restingLedAlpha(ledFrame, { selected });
                    const coreOpacity = activeLedCoreAlpha(ledFrame, { selected });
                    return (
                    <g key={i}>
                      <circle cx={px.x} cy={px.y}
                              r={s.id === selStripId ? vbScale * 5.2 : vbScale * 3.8}
                              fill={ledColor} opacity={shellOpacity}/>
                      {coreOpacity > 0 && (
                        <circle cx={px.x} cy={px.y}
                                r={selected ? vbScale * 2.9 : vbScale * 2.25}
                                fill={ledColor} opacity={coreOpacity}/>
                      )}
                    </g>
                    );
                  })}
                </g>
              ) : (
	                <g key={s.id + '-dots'} filter="url(#lw-led-bloom)" style={{ pointerEvents: 'none' }}>
                  {s.pixels.map((px, i) => {
                    const ledFrame = layoutPatternFrame.get(s.id)?.leds?.[i];
                    const selected = s.id === selStripId;
                    const ledColor = ledCssColor(ledFrame, 'oklch(58% 0.035 240)');
                    const coreOpacity = activeLedCoreAlpha(ledFrame, { selected });
                    const restOpacity = restingLedAlpha(ledFrame, { selected }) * 0.45;
                    return (
                    <circle key={i} cx={px.x} cy={px.y}
                            r={s.id === selStripId ? vbScale * 2.8 : vbScale * 2.2}
                            fill={ledColor}
                            opacity={Math.max(coreOpacity * (effectiveGlowMode === 'outward' ? 0.58 : 0.74), restOpacity)}/>
                    );
                  })}
                </g>
              )
            ))}

            {/* ── Strip mid-path labels (selected strip only) ── */}
            {!isEditingGesture && strips.filter(s => !hidden[s.id] && s.pixels?.length > 0 && s.id === selStripId).map(s => {
              const mid = s.pixels[Math.floor(s.pixels.length / 2)];
              return (
                <text key={s.id + '-lbl'}
                      x={mid.x} y={mid.y - vbScale * 14}
                      textAnchor="middle"
                      fill={s.color}
                      fontSize={vbScale * 10}
                      fontFamily="var(--ui-font, monospace)"
                      opacity={1}
                      style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  {s.name} · {s.pixelCount} LEDs
                </text>
              );
            })}

            {/* ── Direction arrows (all visible strips) ── */}
            {!isEditingGesture && strips.filter(s => !hidden[s.id]).map(s => {
              const arrow = stripArrows[s.id];
              if (!arrow) return null;
              const isSel = s.id === selStripId;
              return (
                <g key={s.id + '-arrow'} style={{ pointerEvents: 'none' }} opacity={isSel ? 1 : 0.55}>
                  <polygon
                    points={`${arrow.tip.x},${arrow.tip.y} ${arrow.left.x},${arrow.left.y} ${arrow.right.x},${arrow.right.y}`}
                    fill={s.color} opacity={0.9}/>
                  <circle cx={arrow.start.x} cy={arrow.start.y} r={vbScale * 4} fill="#06d6a0" opacity={0.9}/>
                </g>
              );
            })}

            {/* ── Head/tail connectors on selected strip ── */}
            {selStripId && (() => {
              const s = strips.find(st => st.id === selStripId);
              if (!s || !s.pixels?.length) return null;
              const first = s.pixels[0];
              const last  = s.pixels[s.pixels.length - 1];
              return (
                <g key="strip-connectors" style={{ pointerEvents: 'none' }}>
                  <circle cx={first.x} cy={first.y} r={vbScale * 5}  fill="#06d6a0" opacity={0.95}/>
                  <circle cx={first.x} cy={first.y} r={vbScale * 9}  fill="none" stroke="#06d6a0" strokeWidth={1.5} opacity={0.35}/>
                  <circle cx={last.x}  cy={last.y}  r={vbScale * 7}  fill="none" stroke="#ff9f1c" strokeWidth={2} opacity={0.9}/>
                  <circle cx={last.x}  cy={last.y}  r={vbScale * 11} fill="none" stroke="#ff9f1c" strokeWidth={1} opacity={0.3}/>
                </g>
              );
            })()}

            {/* ── Draw mode ghost ── */}
            {drawMode && ghostD && (
              <path d={ghostD} stroke="oklch(80% 0.12 210)" strokeWidth="1.5" fill="none"
                    strokeDasharray="5 3" strokeLinecap="round" pointerEvents="none"/>
            )}
            {drawMode && waypoints.map((pt, i) => (
              <circle key={i} cx={pt.x} cy={pt.y} r={vbScale * 4} fill="oklch(72% 0.15 210)"
                      opacity={0.9} pointerEvents="none"/>
            ))}
            {/* Draw cursor dot before first waypoint */}
            {drawMode && ghostPt && waypoints.length === 0 && (
              <circle cx={ghostPt.x} cy={ghostPt.y} r={vbScale * 3}
                      fill="oklch(72% 0.15 210)" opacity={0.5} pointerEvents="none"/>
            )}

            {/* ── Empty state ── */}
            {!svgText && (
              <>
                <rect x="1" y="1" width="638" height="398" rx="4" fill="none"
                      stroke="oklch(30% 0.01 260)" strokeDasharray="6 4"/>
                <text x="320" y="185" textAnchor="middle" fill="oklch(45% 0.02 260)"
                      fontSize="14" fontFamily="var(--ui-font)">
                  Drop an SVG or click Import SVG
                </text>
                <text x="320" y="205" textAnchor="middle" fill="oklch(38% 0.02 260)"
                      fontSize="11" fontFamily="var(--ui-font)">
                  Illustrator: File → Export As → SVG (layers preserved)
                </text>
                <text x="320" y="222" textAnchor="middle" fill="oklch(32% 0.02 260)"
                      fontSize="10" fontFamily="var(--ui-font)">
                  Drag and drop supported
                </text>
              </>
            )}
          </svg>

          {/* ── Rubber-band lasso overlay (absolute inside viewport — position:fixed breaks with backdrop-filter ancestors) ── */}
          {rubberBand && (
            <div style={{
              position: 'absolute',
              left:   Math.min(rubberBand.x1, rubberBand.x2),
              top:    Math.min(rubberBand.y1, rubberBand.y2),
              width:  Math.abs(rubberBand.x2 - rubberBand.x1),
              height: Math.abs(rubberBand.y2 - rubberBand.y1),
              border: '1px dashed oklch(84% 0.28 138)',
              background: 'oklch(84% 0.28 138 / 0.07)',
              pointerEvents: 'none',
              zIndex: 9999,
              userSelect: 'none',
            }}/>
          )}

          {/* Canvas coordinate overlay */}
          {cursorSvgPt && (
            <div className="lw-viewport-overlay br" style={{ pointerEvents: 'none' }}>
              <span className="k">x</span> <span className="v">{cursorSvgPt.x.toFixed(0)}</span>
              <span style={{ margin: '0 4px', opacity: 0.3 }}>·</span>
              <span className="k">y</span> <span className="v">{cursorSvgPt.y.toFixed(0)}</span>
            </div>
          )}

          {/* Viewport hint */}
          {svgText && zoom !== 1 && (
            <div className="lw-viewport-overlay tl">
              <span className="k">scroll</span> <span className="v">zoom</span>
              <span style={{ margin: '0 4px', opacity: 0.3 }}>·</span>
              <span className="k">space+drag</span> <span className="v">pan</span>
            </div>
          )}
        </div>
        <WledBar/>
      </div>

      <div
        className="lw-resize-handle lw-resize-handle--vertical lw-layout-resize-handle"
        data-resize-key="lw-layout-panel-width"
        onMouseDown={e => beginPanelResize(e, { axis: 'x', invert: true })}
      />

      {/* ── Right panel ────────────────────────────────────────────── */}
      <div className="lw-layout-panel" style={{ borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>

        {error && (
          <div style={{ padding: '10px 14px', background: 'oklch(25% 0.08 30)', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-sm)', color: 'oklch(80% 0.12 30)', lineHeight: 1.5, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button style={{ color: 'oklch(60% 0.10 30)', fontSize: 'var(--fs-lg)', lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                    onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {/* Draw mode hint */}
        {drawMode && (
          <div style={{ padding: '8px 14px', background: 'oklch(22% 0.06 210)', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-sm)', color: 'oklch(78% 0.12 210)', lineHeight: 1.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <strong>Drawing mode</strong>
              <button style={{ fontSize: 'var(--fs-xs)', color: 'oklch(60% 0.10 210)', padding: '0 4px' }}
                      onClick={() => { setDrawMode(false); setWaypoints([]); setGhostPt(null); }}>
                Cancel (Esc)
              </button>
            </div>
            <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', display: 'block' }}>
              {waypoints.length} point{waypoints.length !== 1 ? 's' : ''}
              {waypoints.length >= 2 && ` · ~${drawEstimatedLeds} LEDs · double-click to finish`}
              {waypoints.length < 2 && ' · click to place, ⌫ undo, right-click cancel'}
            </span>
          </div>
        )}

        {/* Pending draw naming panel */}
        {pendingDraw && (
          <div style={{ padding: '12px 14px', background: 'oklch(20% 0.06 210)', borderBottom: '1px solid var(--border)', flex: '0 0 auto' }}>
            <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--accent)', marginBottom: 8 }}>
              Name your new strip
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                ref={pendingDrawNameRef}
                type="text"
                value={pendingDrawName}
                onChange={e => setPendingDrawName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmDraw(); if (e.key === 'Escape') cancelDraw(); }}
                placeholder="Strip name…"
                style={{ fontSize: 'var(--fs-md)', background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 4, padding: '5px 9px', color: 'var(--text)', width: '100%' }}
                autoFocus
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
                <span style={{ color: 'var(--text-3)', width: 72, flexShrink: 0 }}>LED count</span>
                <input type="range" min={LED_COUNT_SLIDER_MIN} max={LED_COUNT_SLIDER_MAX} step="1"
                       value={ledCountToSliderValue(pendingDrawCount)}
                       aria-label="New strip LED count slider"
                       onChange={e => setPendingDrawCount(sliderValueToLedCount(e.target.value))}
                       style={{ flex: 1, minWidth: 0 }}/>
                <input type="number" min="1" max={LED_COUNT_MAX}
                       value={pendingDrawCount}
                       aria-label="New strip LED count"
                       inputMode="numeric"
                       onFocus={e => e.target.select()}
                       onChange={e => setPendingDrawCount(clampLedCount(e.target.value))}
                       style={{ width: 72, fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-md)', textAlign: 'right',
                                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
                                padding: '3px 8px', color: 'var(--text)' }}/>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" style={{ flex: 1, fontSize: 'var(--fs-sm)' }} onClick={confirmDraw}>
                  + Add Strip
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-sm)' }} onClick={cancelDraw}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Layer list ── */}
        {layers.length > 0 && (
          <>
            <div className="lw-sec-header" style={{ margin: 0, padding: '7px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <span>Artwork layers</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="meta">{layers.length} · {layers.reduce((n, l) => n + (l.subPaths?.length || 0), 0)} paths</span>
                <button style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)', padding: '0 4px' }} title="Show all"
                        onClick={() => setHidden(h => { const n={...h}; layers.forEach(l=>{n[l.layerId]=false;}); return n; })}>
                  <EyeIcon/>
                </button>
                <button style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)', padding: '0 4px' }} title="Hide all"
                        onClick={() => setHidden(h => { const n={...h}; layers.forEach(l=>{n[l.layerId]=true;}); return n; })}>
                  <EyeOffIcon/>
                </button>
              </div>
            </div>

            <div style={{ overflow: 'auto', flex: '0 0 auto', maxHeight: '42%' }}>
              {/* Build ordered list: groups + layers in layerOrder, fallback to layers */}
              {(() => {
                const ordered = layerOrder.length > 0
                  ? layerOrder
                  : layers.map(l => ({ type: 'layer', id: l.layerId }));

                return ordered.map(item => {
                  // ── Group row ──
                  if (item.type === 'group') {
                    const group = layerGroups.find(g => g.groupId === item.id);
                    if (!group) return null;
	                    const isGroupHidden = !!group._hidden;
	                    const isStripGroup = group.type === 'strip';
	                    const isDragTarget = layerDragOver === group.groupId;
	                    return (
                      <div key={group.groupId}
                           draggable
                           onDragStart={e => {
                             if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
                             e.dataTransfer.effectAllowed='move';
                             setLayerDragging(group.groupId);
                           }}
	                           onDragOver={e => {
	                             e.preventDefault();
	                             if (isStripGroup && Array.from(e.dataTransfer.types).includes('application/x-lightweaver-strip')) {
	                               setStripGroupDragOver(group.groupId);
	                             } else if (!isStripGroup && Array.from(e.dataTransfer.types).includes('application/x-lightweaver-path')) {
	                               setLayerDragOver(group.groupId);
	                             } else {
	                               setLayerDragOver(group.groupId);
	                             }
	                           }}
	                           onDrop={e => {
	                             e.preventDefault();
	                             const draggedStripIds = readDraggedStripIds(e);
	                             const draggedPaths = readDraggedPathEntries(e);
	                             if (isStripGroup && draggedStripIds.length) addStripsToGroup(group.groupId, draggedStripIds);
	                             else if (!isStripGroup && draggedPaths.length) addPathsToGroup(group.groupId, draggedPaths);
	                             else if (layerDragging) reorderLayerOrder(layerDragging, group.groupId);
                             setLayerDragging(null);
                             setLayerDragOver(null);
                             setStripGroupDragOver(null);
                           }}
                           onDragLeave={() => setStripGroupDragOver(null)}
                           onDragEnd={() => { setLayerDragging(null); setLayerDragOver(null); setStripGroupDragOver(null); }}>
	                        <div className={`lw-layer-row${isStripGroup ? ' lw-layer-row--strip-group' : ''}`}
	                             style={{ background: stripGroupDragOver === group.groupId ? 'oklch(74% 0.13 210 / 0.14)' : isDragTarget ? 'oklch(74% 0.13 210 / 0.08)' : undefined,
	                                      borderLeft: `3px solid oklch(80% 0.14 270 / 0.6)`,
	                                      opacity: isGroupHidden ? 0.45 : 1 }}>
                          <span data-drag-handle="true" style={{ cursor: 'grab', color: 'var(--text-4)', display:'flex', alignItems:'center', paddingRight: 2 }}>
                            <DragHandleIcon/>
                          </span>
                          <button className="lw-layer-eye" onClick={e => { e.stopPropagation(); toggleGroupHidden(group.groupId); }}>
                            {isGroupHidden ? <EyeOffIcon/> : <EyeIcon/>}
                          </button>
                          <button className="lw-layer-expand" onClick={e => { e.stopPropagation(); toggleGroupExpanded(group.groupId); }}>
                            {group._expanded ? <ChevronDownIcon/> : <ChevronRightIcon/>}
                          </button>
                          <span style={{ color: 'oklch(80% 0.14 270)', display:'flex', alignItems:'center' }}><GroupIcon/></span>
	                          <InlineRename value={group.name} onCommit={n => renameGroup(group.groupId, n)}
	                                        className="lw-layer-name" style={{ fontSize: 'var(--fs-md)', flex: 1 }}/>
	                          <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-4)', fontFamily: 'var(--mono-font)', flexShrink: 0 }}>
	                            {group.members.length}{isStripGroup ? 's' : 'p'}
	                          </span>
                          <button title="Ungroup" onClick={e => { e.stopPropagation(); deleteLayerGroup(group.groupId); }}
                                  style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-4)', padding: '0 3px', lineHeight:1, flexShrink:0 }}
                                  className="lw-btn-danger-hover">⊠</button>
                        </div>
	                        {group._expanded && group.members.map((m, mi) => {
	                          const memberId = m.stripId || m.pathId;
	                          const memberHidden = !!hidden[memberId];
	                          return (
	                          <div key={memberId} className="lw-subpath-row"
	                               style={{ paddingLeft: 32, background: 'oklch(80% 0.14 270 / 0.04)', cursor: isStripGroup ? 'pointer' : undefined }}
	                               onClick={() => { if (isStripGroup) selectStrip(memberId); }}>
	                            <span style={{ fontFamily:'var(--mono-font)', fontSize:'var(--fs-2xs)', color:'oklch(80% 0.14 270)', fontWeight:'bold', width:14, flexShrink:0, textAlign:'center' }}>{mi+1}</span>
	                            <button className="lw-layer-eye" style={{ marginLeft:2 }}
	                                    onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [memberId]: !h[memberId] })); }}>
	                              {memberHidden ? <EyeOffIcon/> : <EyeIcon/>}
	                            </button>
	                            {isStripGroup && (
	                              <span className="lw-layer-dot" style={{ background: m.color || 'var(--accent)' }}/>
	                            )}
	                            <span style={{ flex:1, fontSize:'var(--fs-sm)', color:'var(--text-2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.name}</span>
	                            {isStripGroup ? (
	                              <span style={{ fontFamily:'var(--mono-font)', fontSize:'var(--fs-xs)', color:'var(--text-4)', flexShrink:0 }}>
	                                {(m.pixelCount || 0).toLocaleString()}px
	                              </span>
	                            ) : m.svgLength > 0 && (
	                              <span style={{ fontFamily:'var(--mono-font)', fontSize:'var(--fs-xs)', color:'var(--text-4)', flexShrink:0 }}>
	                                {Math.round(m.svgLength / pxPerMm)}mm
	                              </span>
	                            )}
	                            <button style={{ fontSize:'var(--fs-sm)', padding:'0 4px', color:'var(--text-4)', flexShrink:0 }}
	                                    onClick={e => {
	                                      e.stopPropagation();
	                                      setLayerGroups(prev => prev
	                                        .map(g => g.groupId !== group.groupId ? g : { ...g, members: g.members.filter((_,i)=>i!==mi) })
	                                        .filter(g => g.members.length > 0));
	                                    }}>✕</button>
	                          </div>
	                          );
	                        })}
                      </div>
                    );
                  }

                  // ── Layer row ──
                  const l = layers.find(lyr => lyr.layerId === item.id);
                  if (!l) return null;
                  const isHidden   = !!hidden[l.layerId];
                  const hasStrip   = strips.some(s => s.id === l.layerId);
                  const isSel      = l.layerId === selLayerId;
                  const canExpand  = l.subPaths?.length > 1;
                  const isExpanded = !!expandedLayers[l.layerId];
                  const stripForLayer = strips.find(s => s.id === l.layerId);
                  const isDragTarget  = layerDragOver === l.layerId;

                  return (
	                    <div key={l.layerId}
	                         draggable
	                         onDragStart={e => {
	                           if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
	                           e.dataTransfer.effectAllowed='move';
	                           e.dataTransfer.setData('application/x-lightweaver-path', JSON.stringify([{
	                             layerId: l.layerId,
	                             pathId: l.layerId,
	                             pathData: l.pathData,
	                             name: l.name,
	                             svgLength: l.svgLength,
	                           }]));
	                           setLayerDragging(l.layerId);
	                         }}
                         onDragOver={e => { e.preventDefault(); setLayerDragOver(l.layerId); }}
                         onDrop={e => { e.preventDefault(); if (layerDragging) reorderLayerOrder(layerDragging, l.layerId); setLayerDragging(null); setLayerDragOver(null); }}
                         onDragEnd={() => { setLayerDragging(null); setLayerDragOver(null); }}>
                      <div className={`lw-layer-row${isSel?' lw-layer-row--sel':''}${isHidden?' lw-layer-row--hidden':''}`}
                           style={{ borderTop: isDragTarget ? '2px solid var(--accent)' : undefined }}
                           onClick={() => selectLayer(l.layerId)}
                           onMouseEnter={() => setHoveredLayerId(l.layerId)}
                           onMouseLeave={() => setHoveredLayerId(null)}>
                        <span data-drag-handle="true" style={{ cursor:'grab', color:'var(--text-4)', display:'flex', alignItems:'center', paddingRight:2 }}>
                          <DragHandleIcon/>
                        </span>
                        <button className="lw-layer-eye" title={isHidden?'Show':'Hide'}
                                onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [l.layerId]: !h[l.layerId] })); }}>
                          {isHidden ? <EyeOffIcon/> : <EyeIcon/>}
                        </button>
                        {canExpand
                          ? <button className="lw-layer-expand" title={isExpanded?'Collapse':'Expand'}
                                    onClick={e => { e.stopPropagation(); setExpandedLayers(ex => ({ ...ex, [l.layerId]: !ex[l.layerId] })); }}>
                              {isExpanded ? <ChevronDownIcon/> : <ChevronRightIcon/>}
                            </button>
                          : <span style={{ width:16, flexShrink:0 }}/>
                        }
                        <span className="lw-layer-dot" style={{ background: l._color }}/>
                        <InlineRename value={l.name} onCommit={n => renameLayer(l.layerId, n)}
                                      className="lw-layer-name" style={{ fontSize: 'var(--fs-md)', flex: 1 }}/>
                        {canExpand && (
                          <span style={{ fontSize:'var(--fs-2xs)', color:'var(--text-4)', fontFamily:'var(--mono-font)', flexShrink:0 }}>
                            {l.subPaths.length}p
                          </span>
                        )}
                        {hasStrip && (
                          <button style={{ fontSize:'var(--fs-2xs)', color:'var(--mint)', fontFamily:'var(--mono-font)', flexShrink:0, lineHeight:1, padding:'0 2px' }}
                                  title="Select strip" onClick={e => { e.stopPropagation(); if (stripForLayer) selectStrip(stripForLayer.id); }}>●</button>
                        )}
                        {l.svgLength > 0 && (
                          <span className="lw-layer-len">{Math.round(l.svgLength / pxPerMm)}mm</span>
                        )}
                        <button title="Delete layer" onClick={e => { e.stopPropagation(); deleteLayer(l.layerId); }}
                                style={{ fontSize:'var(--fs-md)', color:'var(--text-4)', padding:'0 3px', lineHeight:1, flexShrink:0 }}
                                className="lw-btn-danger-hover">×</button>
                      </div>

	                      {isExpanded && l.subPaths?.map(sp => {
	                        const spHidden = !!hidden[sp.pathId];
	                        const spSel    = pathSel.some(p => p.pathId === sp.pathId);
	                        const entry = { layerId: l.layerId, pathId: sp.pathId, pathData: sp.pathData, name: `${l.name} · ${sp.name}`, svgLength: sp.svgLength };
	                        return (
	                          <div key={sp.pathId}
	                               draggable
	                               className={`lw-subpath-row${hoveredSubPathId === sp.pathId ? ' lw-subpath-row--hover' : ''}${spSel ? ' lw-subpath-row--sel' : ''}`}
	                               onClick={e => togglePathSelection(entry, e.shiftKey || e.metaKey || e.ctrlKey)}
	                               onDragStart={e => {
	                                 if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
	                                 const payload = spSel && pathSel.length > 0 ? pathSel : [entry];
	                                 e.dataTransfer.effectAllowed = 'move';
	                                 e.dataTransfer.setData('application/x-lightweaver-path', JSON.stringify(payload));
	                                 e.dataTransfer.setData('text/plain', payload.map(p => p.name).join(', '));
	                                 if (!spSel) setPathSel([entry]);
	                               }}
	                               onDragOver={e => {
	                                 if (!Array.from(e.dataTransfer.types).includes('application/x-lightweaver-path')) return;
	                                 e.preventDefault();
	                                 setLayerDragOver(sp.pathId);
	                               }}
	                               onDragLeave={() => setLayerDragOver(null)}
	                               onDrop={e => {
	                                 const draggedPaths = readDraggedPathEntries(e);
	                                 if (!draggedPaths.length) return;
	                                 e.preventDefault();
	                                 e.stopPropagation();
	                                 createLayerGroupFromEntries([...draggedPaths, entry]);
	                                 setLayerDragOver(null);
	                               }}
	                               onMouseEnter={() => setHoveredSubPathId(sp.pathId)}
	                               onMouseLeave={() => setHoveredSubPathId(null)}>
	                            <span data-drag-handle="true" style={{ cursor: 'grab', color: spSel ? 'var(--accent)' : 'var(--text-4)', display:'flex', alignItems:'center', paddingRight: 1, flexShrink: 0 }}>
	                              <DragHandleIcon/>
	                            </span>
	                            <button className="lw-layer-eye" style={{ padding:'0 1px' }}
	                                    onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [sp.pathId]: !h[sp.pathId] })); }}>
	                              {spHidden ? <EyeOffIcon/> : <EyeIcon/>}
	                            </button>
                            <InlineRename value={sp.name} onCommit={n => renameSubPath(l.layerId, sp.pathId, n)}
                                          style={{ flex:1, fontSize:'var(--fs-sm)', color: spHidden ? 'var(--text-4)' : 'var(--text-2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}/>
                            <span style={{ fontFamily:'var(--mono-font)', fontSize:'var(--fs-xs)', color:'var(--text-3)', flexShrink:0 }}>
                              {sp.svgLength > 0 ? `${Math.round(sp.svgLength / pxPerMm)}mm` : ''}
                            </span>
                            <button className="btn btn-primary" style={{ padding:'2px 7px', fontSize:'var(--fs-xs)', flexShrink:0 }}
                                    onClick={e => { e.stopPropagation(); addSubPathStrip(sp, l); }}>+</button>
                          </div>
                        );
                      })}
                    </div>
                  );
                });
              })()}

	              <div style={{ padding:'6px 12px', fontSize:'var(--fs-xs)', color:'var(--text-4)', lineHeight:1.5 }}>
	                Click rows to select · <strong style={{ color:'var(--text-3)' }}>⇧/⌘ click</strong> adds · drag rows into groups
	              </div>
            </div>
          </>
        )}

        {/* ── Path selection panel ── */}
        {pathSel.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--border)', padding: '10px 14px', background: 'oklch(18% 0.04 270)', flex: '0 0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-2)' }}>
                {pathSel.length} path{pathSel.length > 1 ? 's' : ''} selected
              </span>
              <button style={{ color: 'var(--text-4)', padding: '0 4px', fontSize: 'var(--fs-md)' }}
                      onClick={() => { setPathSel([]); setPathSelName(''); }}>✕</button>
            </div>
            <div style={{ maxHeight: 80, overflow: 'auto', marginBottom: 8 }}>
              {pathSel.map((p, i) => (
                <div key={p.pathId} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 'var(--fs-sm)',
                                              color: 'var(--text-3)', padding: '2px 0' }}>
                  <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-2xs)', color: '#4cc9f0',
                                 fontWeight: 'bold', width: 14, flexShrink: 0, textAlign: 'center' }}>{i + 1}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  {p.svgLength > 0 && (
                    <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', flexShrink: 0, color: 'var(--text-4)' }}>
                      {Math.round(p.svgLength / pxPerMm)}mm
                    </span>
                  )}
                  <button disabled={i === 0} style={{ fontSize: 'var(--fs-xs)', padding: '0 3px', color: 'var(--text-4)', opacity: i === 0 ? 0.3 : 1 }}
                          onClick={() => setPathSel(prev => {
                            const a = [...prev]; [a[i-1], a[i]] = [a[i], a[i-1]]; return a;
                          })}>↑</button>
                  <button disabled={i === pathSel.length - 1} style={{ fontSize: 'var(--fs-xs)', padding: '0 3px', color: 'var(--text-4)', opacity: i === pathSel.length - 1 ? 0.3 : 1 }}
                          onClick={() => setPathSel(prev => {
                            const a = [...prev]; [a[i], a[i+1]] = [a[i+1], a[i]]; return a;
                          })}>↓</button>
                  <button style={{ fontSize: 'var(--fs-sm)', padding: '0 4px', color: 'var(--text-4)' }}
                          onClick={() => setPathSel(prev => prev.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" value={pathSelName} onChange={e => setPathSelName(e.target.value)}
                     placeholder="Name…"
                     style={{ flex: 1, fontSize: 'var(--fs-sm)', background: 'var(--bg)', border: '1px solid var(--border)',
                              borderRadius: 4, padding: '4px 8px', color: 'var(--text)' }}/>
              <button className="btn btn-primary" style={{ fontSize: 'var(--fs-sm)' }}
                      title="Create one composite strip from the selected paths"
                      onClick={() => addSelectedPathsAsStrips('merged')}>
                Merge Strip
              </button>
              {pathSel.length >= 2 && (
                <>
                  <button className="btn" style={{ fontSize: 'var(--fs-sm)' }}
                          title="Create separate LED strips from the selected paths"
                          onClick={() => addSelectedPathsAsStrips('separate')}>
                    Separate
                  </button>
                  <button className="btn" style={{ fontSize: 'var(--fs-sm)', color: 'oklch(80% 0.14 270)', borderColor: 'oklch(80% 0.14 270 / 0.4)', background: 'oklch(80% 0.14 270 / 0.08)' }}
                          title="Create separate LED strips and place them in one strip group"
                          onClick={() => addSelectedPathsAsStrips('grouped')}>
                    <GroupIcon/> Strip Group
                  </button>
                </>
              )}
            </div>
            {pathSel.length >= 2 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                        title="Group the source artwork paths without creating LED strips"
                        onClick={createLayerGroup}>
                  Layer Group
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Layer inspector ── */}
        {selLayer && (
          <>
            <div className="lw-sec-header" style={{ margin: 0, padding: '7px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selLayer.name}</span>
              <span className="meta">inspector</span>
            </div>
            <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9, flex: '0 0 auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-md)' }}>
                <span style={{ color: 'var(--text-3)' }}>Length</span>
                <span style={{ fontFamily: 'var(--mono-font)' }}>
                  {selLayer.svgLength > 0 ? `${Math.round(selLayer.svgLength / pxPerMm)} mm` : '—'}
                </span>
              </div>
              {selLayer.subPaths?.length > 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-md)' }}>
                  <span style={{ color: 'var(--text-3)' }}>Sub-paths</span>
                  <span style={{ fontFamily: 'var(--mono-font)' }}>{selLayer.subPaths.length}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--fs-md)' }}>
                <span style={{ color: 'var(--text-3)' }}>Density</span>
                <div style={{ display: 'flex', gap: 2 }}>
                  {DENSITY_OPTIONS.map(d => (
                    <button key={d}
                            className={`btn ${density === d ? 'btn-primary' : 'btn-ghost'}`}
                            style={{ padding: '2px 6px', fontSize: 'var(--fs-xs)' }}
                            onClick={() => handleDensityChange(d)}>{d}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--fs-md)' }}>
                <span style={{ color: 'var(--text-3)' }}>LED count</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 auto', justifyContent: 'flex-end', minWidth: 0, marginLeft: 12 }}>
                  {editCounts[selLayer.layerId] != null && (
                    <button style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)', padding: '0 4px' }}
                            title="Reset to calculated"
                            onClick={() => setEditCounts(c => { const next = { ...c }; delete next[selLayer.layerId]; return next; })}>
                      ↺
                    </button>
                  )}
                  <input type="range" min={LED_COUNT_SLIDER_MIN} max={LED_COUNT_SLIDER_MAX} step="1"
                         value={ledCountToSliderValue(editCounts[selLayer.layerId] ?? getLedCount(selLayer))}
                         aria-label="Layer LED count slider"
                         onChange={e => {
                           const val = sliderValueToLedCount(e.target.value);
                           setEditCounts(c => ({ ...c, [selLayer.layerId]: val }));
                           if (existingStrip) resampleStrip(existingStrip.id, val);
                         }}
                         style={{ flex: '1 1 auto', minWidth: 80, maxWidth: 180 }}/>
                  <input type="number" min="1" max={LED_COUNT_MAX}
                         value={editCounts[selLayer.layerId] ?? getLedCount(selLayer)}
                         aria-label="Layer LED count"
                         inputMode="numeric"
                         onFocus={e => e.target.select()}
                         onChange={e => {
                           const val = clampLedCount(e.target.value);
                           setEditCounts(c => ({ ...c, [selLayer.layerId]: val }));
                           if (existingStrip) resampleStrip(existingStrip.id, val);
                         }}
                         onBlur={() => {
                           if (existingStrip) resampleStrip(existingStrip.id, getLedCount(selLayer));
                         }}
                         onKeyDown={e => {
                           if (e.key === 'Enter') {
                             if (existingStrip) resampleStrip(existingStrip.id, getLedCount(selLayer));
                             else addStrip();
                           }
                         }}
                         style={{ width: 72, fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-md)', textAlign: 'right',
                                  background: 'var(--bg)', border: `1px solid ${editCounts[selLayer.layerId] != null ? 'var(--accent)' : 'var(--border)'}`,
                                  borderRadius: 4, padding: '3px 8px', color: 'var(--text)' }}/>
                </div>
              </div>
              {selLayer.svgLength > 0 && getLedCount(selLayer) > 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-md)' }}>
                  <span style={{ color: 'var(--text-3)' }}>Pitch</span>
                  <span style={{ fontFamily: 'var(--mono-font)' }}>
                    {((selLayer.svgLength / pxPerMm) / getLedCount(selLayer)).toFixed(1)} mm/LED
                  </span>
                </div>
              )}

              {/* Emit controls */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--fs-md)' }}>
                <span style={{ color: 'var(--text-3)' }}>Emit</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: existingStrip ? 1 : 0.4 }}>
                  <button
                    className={`btn ${existingStrip?.emit === 'omni' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ padding: '2px 8px', fontSize: 'var(--fs-xs)' }}
                    disabled={!existingStrip}
                    title={existingStrip ? 'Omnidirectional glow' : 'Add strip first'}
                    onClick={() => {
                      if (!existingStrip) return;
                      updateStrip(existingStrip.id, { emit: 'omni', angle: 0 });
                    }}>Omni</button>
                  <button
                    className={`btn ${existingStrip && existingStrip.emit !== 'omni' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ padding: '2px 8px', fontSize: 'var(--fs-xs)' }}
                    disabled={!existingStrip}
                    title={existingStrip ? 'Directed emission' : 'Add strip first'}
	                    onClick={() => {
	                      if (!existingStrip) return;
	                      setDirectedGlow(true);
	                      enableLightPreview();
	                      updateStrip(existingStrip.id, { emit: 'dir' });
	                    }}>Dir</button>
                </div>
              </div>

              {/* Angle slider — only when directed */}
              {existingStrip?.emit !== 'omni' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', opacity: existingStrip ? 1 : 0.4 }}>
                  <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Angle</span>
                  <input type="range" min="0" max="360" step="1"
                         value={existingStrip?.angle || 0}
                         style={{ flex: 1 }}
                         disabled={!existingStrip}
	                         onChange={e => {
	                           if (!existingStrip) return;
	                           setDirectedGlow(true);
	                           enableLightPreview();
	                           updateStrip(existingStrip.id, { angle: +e.target.value });
	                         }}/>
                  <input type="number" min="0" max="360" value={existingStrip?.angle || 0}
                         disabled={!existingStrip}
                         style={{ width: 48, fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-sm)', textAlign: 'right',
                                  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 5px', color: 'var(--text)' }}
	                         onChange={e => {
	                           if (!existingStrip) return;
	                           setDirectedGlow(true);
	                           enableLightPreview();
	                           updateStrip(existingStrip.id, { angle: +e.target.value });
	                         }}/>
                  <span style={{ color: 'var(--text-3)', fontSize: 'var(--fs-xs)', flexShrink: 0 }}>°</span>
                </div>
              )}

              <button className="btn btn-primary" style={{ width: '100%', marginTop: 2 }} onClick={addStrip}>
                {existingStrip ? '↺  Update Strip' : '+  Add as Strip'}
              </button>
              {existingStrip && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" style={{ flex: 1 }}
                          onClick={() => reverseStrip(selLayer.layerId)}
                          title="Flip pixel 0 from start to end">
                    ↔ Reverse
                  </button>
                  <button className="btn btn-ghost lw-btn-danger" style={{ flex: 1 }}
                          onClick={() => removeStrip(selLayer.layerId)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Strips list ── */}
        {strips.length > 0 && (
	          <>
	            <div className="lw-sec-header" style={{ margin: 0, padding: '7px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
	              <span>LED strips</span>
	              <span className="meta">
	                {selectedStrips.length > 1 ? `${selectedStrips.length} selected · ` : ''}
	                {strips.length} strips · {totalLeds.toLocaleString()} LEDs
	              </span>
	            </div>
	            {selectedStrips.length > 1 && (
	              <div className="lw-strip-batch">
	                <div className="lw-strip-batch-head">
	                  <span>{selectedStrips.length} strips selected</span>
	                  <button title="Clear strip selection" onClick={() => { setSelectedStripIds([]); setStripSelectionName(''); }}>✕</button>
	                </div>
	                <div className="lw-strip-batch-list">
	                  {selectedStrips.map((s, i) => (
	                    <span key={s.id} className="lw-strip-chip" title={s.name}>
	                      <span className="lw-layer-dot" style={{ background: s.color }}/>
	                      {i + 1}. {s.name}
	                    </span>
	                  ))}
	                </div>
	                <div className="lw-strip-batch-actions">
	                  <input
	                    type="text"
	                    value={stripSelectionName}
	                    onChange={e => setStripSelectionName(e.target.value)}
	                    placeholder="Group or merged strip name..."
	                  />
	                  <button className="btn" title="Organize selected strips as one expandable group (G)" onClick={groupSelectedStrips}>
	                    <GroupIcon/> Group
	                  </button>
	                  <button className="btn btn-primary" title="Paste selected strips into one composite strip (M)" onClick={mergeSelectedStrips}>
	                    Merge
	                  </button>
	                </div>
	              </div>
	            )}
	            <div ref={stripListRef} style={{ flex: '0 0 auto', overflow: 'auto', minHeight: 0, maxHeight: 220 }}>
	              {strips.map((s, i) => {
	                const isSel = s.id === selStripId;
	                const isBatchSel = selectedStripIds.includes(s.id);
	                return (
	                  <div key={s.id}
	                       data-strip-id={s.id}
	                       className={`lw-strip-row${isSel ? ' lw-strip-row--sel' : ''}${isBatchSel ? ' lw-strip-row--batch-sel' : ''}`}
	                       draggable
	                       onDragStart={e => {
	                         if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
	                         const ids = selectedStripIds.includes(s.id) ? selectedStripIds : [s.id];
	                         e.dataTransfer.effectAllowed = 'move';
	                         e.dataTransfer.setData('application/x-lightweaver-strip', JSON.stringify(ids));
	                         e.dataTransfer.setData('text/plain', ids.join(','));
	                         setSelectedStripIds(ids);
	                       }}
	                       onDragOver={e => {
	                         if (!Array.from(e.dataTransfer.types).includes('application/x-lightweaver-strip')) return;
	                         e.preventDefault();
	                         setStripGroupDragOver(`strip:${s.id}`);
	                       }}
	                       onDragLeave={() => setStripGroupDragOver(null)}
	                       onDrop={e => {
	                         const draggedStripIds = readDraggedStripIds(e);
	                         if (!draggedStripIds.length) return;
	                         e.preventDefault();
	                         e.stopPropagation();
	                         createStripGroupFromIds([...draggedStripIds, s.id]);
	                         setStripGroupDragOver(null);
	                       }}
	                       onDragEnd={() => setStripGroupDragOver(null)}
	                       style={{ opacity: hidden[s.id] ? 0.4 : 1,
	                                outline: stripGroupDragOver === `strip:${s.id}` ? '1px solid var(--accent)' : undefined,
	                                outlineOffset: -1 }}
	                       onClick={e => {
	                         if (e.shiftKey || e.metaKey || e.ctrlKey) toggleStripSelection(s.id);
	                         else selectStrip(s.id);
	                       }}>
	                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
	                      <span data-drag-handle="true" style={{ cursor: 'grab', color: isBatchSel ? 'var(--accent)' : 'var(--text-4)', display:'flex', alignItems:'center', flexShrink:0 }}>
	                        <DragHandleIcon/>
	                      </span>
	                      <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', color: 'var(--text-4)', width: 16, flexShrink: 0, textAlign: 'right' }}>{i + 1}</span>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.color, flexShrink: 0,
                                     boxShadow: isSel ? `0 0 8px ${s.color}` : 'none' }}/>
                      <InlineRename value={s.name} onCommit={n => renameStrip(s.id, n)}
                                    style={{ flex: 1, fontSize: 'var(--fs-md)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}/>
                      {s.reversed && (
                        <span style={{ fontSize: 'var(--fs-2xs)', fontFamily: 'var(--mono-font)', color: 'var(--accent-2)',
                                       background: 'oklch(80% 0.13 70 / 0.15)', border: '1px solid oklch(80% 0.13 70 / 0.3)',
                                       borderRadius: 3, padding: '1px 4px', flexShrink: 0 }}>REV</span>
                      )}
                      <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', color: 'var(--text-3)', flexShrink: 0 }}>{s.pixelCount}</span>
                      <button style={{ color: 'var(--text-4)', padding: '0 3px', fontSize: 'var(--fs-md)', lineHeight: 1, flexShrink: 0 }}
                              title={hidden[s.id] ? 'Show (H)' : 'Hide (H)'}
                              onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [s.id]: !h[s.id] })); }}>
                        {hidden[s.id] ? <EyeOffIcon/> : <EyeIcon/>}
                      </button>
                      <button style={{ color: 'var(--text-4)', padding: '0 3px', fontSize: 'var(--fs-sm)', lineHeight: 1, flexShrink: 0 }}
                              title="Duplicate strip"
                              onClick={e => { e.stopPropagation(); duplicateStrip(s.id); }}>⧉</button>
                      <button className="lw-btn-danger-hover" style={{ color: 'var(--text-4)', padding: '0 3px', fontSize: 'var(--fs-lg)', lineHeight: 1, flexShrink: 0 }}
                              title="Delete strip (X)"
                              onClick={e => { e.stopPropagation(); removeStrip(s.id); }}>×</button>
                    </div>
                    {isSel && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 0 2px 0', borderTop: '1px solid var(--border)', marginTop: 6 }}>
                        {/* Speed */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
                          <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Speed</span>
                          <input type="range" min={SPEED_SLIDER_MIN} max={SPEED_SLIDER_MAX} step="1" value={speedToSliderValue(s.speed ?? 1)}
                                 style={{ flex: 1 }}
                                 onChange={e => updateStrip(s.id, { speed: sliderValueToSpeed(e.target.value) })}
                                 onPointerUp={e => updateStripWithHistory(s.id, { speed: sliderValueToSpeed(e.target.value) })}
                                 onDoubleClick={() => updateStrip(s.id, { speed: 1 })}/>
                          <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', color: 'var(--text-3)', width: 42, textAlign: 'right' }}>{formatControlSpeed(s.speed ?? 1)}</span>
                        </div>
                        {/* Brightness */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
                          <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Bright</span>
                          <input type="range" min="0" max="1" step="0.01" value={s.brightness ?? 1}
                                 style={{ flex: 1 }}
                                 onChange={e => updateStrip(s.id, { brightness: +e.target.value })}
                                 onPointerUp={e => updateStripWithHistory(s.id, { brightness: +e.target.value })}
                                 onDoubleClick={() => updateStrip(s.id, { brightness: 1 })}/>
                          <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', color: 'var(--text-3)', width: 32, textAlign: 'right' }}>{Math.round((s.brightness ?? 1) * 100)}%</span>
                        </div>
                        {/* Hue shift */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
                          <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Hue</span>
                          <input type="range" min="-180" max="180" step="1" value={s.hueShift ?? 0}
                                 style={{ flex: 1 }}
                                 onChange={e => updateStrip(s.id, { hueShift: +e.target.value })}
                                 onPointerUp={e => updateStripWithHistory(s.id, { hueShift: +e.target.value })}
                                 onDoubleClick={() => updateStrip(s.id, { hueShift: 0 })}/>
                          <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', color: 'var(--text-3)', width: 32, textAlign: 'right' }}>{s.hueShift ?? 0}°</span>
                        </div>
                        {/* Per-strip pattern override */}
	                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
	                          <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Pattern</span>
	                          <select value={s.patternId ?? ''}
	                                  style={{ flex: 1, fontSize: 'var(--fs-xs)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', padding: '2px 4px' }}
	                                  onChange={e => {
	                                    const v = e.target.value || null;
	                                    updateStrip(s.id, { patternId: v });
	                                  }}>
	                            <option value="">Inherited</option>
	                            {PATTERNS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
	                          </select>
	                        </div>
	                        {/* Position */}
	                        <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr 1fr', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
	                          <span style={{ color: 'var(--text-3)' }}>Move</span>
	                          <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-3)' }}>
	                            X
	                            <input type="number" step="1" value={Math.round(s.x || 0)}
	                                   style={{ width: '100%', minWidth: 0, fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-sm)', textAlign: 'right',
	                                            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', color: 'var(--text)' }}
	                                   onClick={e => e.stopPropagation()}
	                                   onChange={e => setStripOffset(s.id, Number(e.target.value) || 0, s.y || 0)}
	                                   onBlur={e => setStripOffset(s.id, Number(e.target.value) || 0, s.y || 0, true)}/>
	                          </label>
	                          <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-3)' }}>
	                            Y
	                            <input type="number" step="1" value={Math.round(s.y || 0)}
	                                   style={{ width: '100%', minWidth: 0, fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-sm)', textAlign: 'right',
	                                            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 6px', color: 'var(--text)' }}
	                                   onClick={e => e.stopPropagation()}
	                                   onChange={e => setStripOffset(s.id, s.x || 0, Number(e.target.value) || 0)}
	                                   onBlur={e => setStripOffset(s.id, s.x || 0, Number(e.target.value) || 0, true)}/>
	                          </label>
	                        </div>
	                        <div style={{ color: 'var(--text-4)', fontSize: 'var(--fs-xs)', paddingLeft: 60 }}>
	                          Drag this strip on the canvas to reposition it.
	                        </div>
	                        {/* Emit */}
	                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
	                          <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Emit</span>
	                          <button className={`btn ${(s.emit || 'dir') === 'omni' ? 'btn-primary' : 'btn-ghost'}`}
	                                  style={{ flex: 1, fontSize: 'var(--fs-xs)' }}
	                                  onClick={e => { e.stopPropagation(); updateStrip(s.id, { emit: 'omni', angle: 0 }); }}>
	                            Omni
	                          </button>
	                          <button className={`btn ${(s.emit || 'dir') !== 'omni' ? 'btn-primary' : 'btn-ghost'}`}
	                                  style={{ flex: 1, fontSize: 'var(--fs-xs)' }}
	                                  onClick={e => { e.stopPropagation(); setDirectedGlow(true); enableLightPreview(); updateStrip(s.id, { emit: 'dir' }); }}>
	                            Dir
	                          </button>
	                        </div>
	                        {(s.emit || 'dir') !== 'omni' && (
	                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
	                            <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Angle</span>
	                            <input type="range" min="0" max="360" step="1" value={s.angle || 0}
	                                   style={{ flex: 1 }}
	                                   onChange={e => { setDirectedGlow(true); enableLightPreview(); updateStrip(s.id, { angle: +e.target.value }); }}/>
	                            <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', color: 'var(--text-3)', width: 36, textAlign: 'right' }}>{Math.round(s.angle || 0)}°</span>
	                          </div>
	                        )}
                        {/* LED count */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)' }}>
                          <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>LEDs</span>
                          <input type="range" min={LED_COUNT_SLIDER_MIN} max={LED_COUNT_SLIDER_MAX} step="1"
                                 value={ledCountToSliderValue(s.pixelCount)}
                                 aria-label="Strip LED count slider"
                                 style={{ flex: 1, minWidth: 0 }}
                                 onChange={e => resampleStrip(s.id, sliderValueToLedCount(e.target.value))}
                                 onClick={e => e.stopPropagation()}/>
                          <input type="number" min="1" max={LED_COUNT_MAX} step="1"
                                 value={s.pixelCount}
                                 aria-label="Strip LED count"
                                 inputMode="numeric"
                                 style={{ width: 72, fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-sm)', textAlign: 'right',
                                          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px', color: 'var(--text)' }}
                                 onFocus={e => e.target.select()}
                                 onChange={e => resampleStrip(s.id, clampLedCount(e.target.value))}
                                 onBlur={e => resampleStrip(s.id, clampLedCount(e.target.value))}
                                 onKeyDown={e => { if (e.key === 'Enter') resampleStrip(s.id, clampLedCount(e.target.value)); }}
                                 onClick={e => e.stopPropagation()}/>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 6, marginLeft: 60 }}>
                          {LED_COUNT_PRESETS.map(count => (
                            <button key={count} type="button"
                                    className={`btn ${s.pixelCount === count ? 'btn-primary' : 'btn-ghost'}`}
                                    style={{ fontSize: 'var(--fs-xs)', padding: '3px 6px' }}
                                    onClick={e => { e.stopPropagation(); resampleStrip(s.id, count); }}>
                              {count}
                            </button>
                          ))}
                        </div>
                        {usbLedConnected && (
                          <div style={{ marginLeft: 60, marginTop: -2, fontSize: 'var(--fs-xs)', color: s.pixelCount > usbLedMaxPixels ? 'var(--accent-2)' : 'var(--text-4)' }}>
                            USB direct cap {usbLedMaxPixels} LEDs; WLED/export can keep the project count above that.
                          </div>
                        )}
                        {/* Strip actions */}
                        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                          <button className="btn btn-ghost" style={{ flex: 1, fontSize: 'var(--fs-xs)' }}
                                  onClick={e => { e.stopPropagation(); reverseStrip(s.id); }}>
                            ↔ Reverse
                          </button>
                          <button className="btn btn-ghost lw-btn-danger" style={{ flex: 1, fontSize: 'var(--fs-xs)' }}
                                  onClick={e => { e.stopPropagation(); removeStrip(s.id); }}>
                            Remove
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {strips.length > 0 && (
          <details className="lw-patch-details" open>
            <summary>
              <span>Wire Path</span>
              <span>{strips.length} paths · visual order</span>
            </summary>
            <PatchBoardScreen
              embedded
              wireOverlayMode={wireOverlayMode}
              selectedWireCut={selectedWireCut}
              onNudgeSelectedCut={nudgeSelectedWireCut}
              onDeleteSelectedCut={deleteSelectedWireCut}
              onClearSelectedCut={() => setSelectedWireCut(null)}
            />
          </details>
        )}

        {/* ── Empty state ── */}
        {!svgText && !error && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                        justifyContent: 'center', gap: 14, padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.35">
              <rect x="6" y="4" width="32" height="36" rx="3"/>
              <path d="M14 14h16M14 22h16M14 30h10"/>
              <path d="M28 28l8 8M32 28h4v4" strokeLinecap="round"/>
            </svg>
            <div style={{ fontSize: 'var(--fs-md)' }}>Import an SVG to map LED strips</div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-4)', lineHeight: 1.5 }}>
              Works with Illustrator CC, Inkscape,<br/>and any SVG with layer groups.<br/>Drag and drop onto the canvas.
            </div>
            <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
              Import SVG
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
