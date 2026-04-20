import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { samplePath as libSamplePath } from '../lib/mapper.js';
import { WledBar } from './WledBar.jsx';
import { useProject } from '../state/ProjectContext.jsx';
import { PATTERNS } from '../data.js';

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

function sampleForViz(pathData, maxPts = 40) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', pathData);
  const len = p.getTotalLength ? p.getTotalLength() : 100;
  const n = Math.min(maxPts, Math.max(2, Math.ceil(len / 20)));
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
  const rect = svgEl.getBoundingClientRect();
  const vb   = svgEl.viewBox.baseVal;
  return {
    x: vb.x + (clientX - rect.left) * (vb.width  / rect.width),
    y: vb.y + (clientY - rect.top)  * (vb.height / rect.height),
  };
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
const MAX_HISTORY = 50;
const LS_KEY = 'lw-layout-autosave';
const GLOW_MODES = ['center', 'outward', 'inward', 'dots'];

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
  const px = cx + Math.cos(a - Math.PI / 2) * reach;
  const py = cy + Math.sin(a - Math.PI / 2) * reach;
  const qx = cx + Math.cos(a + Math.PI / 2) * reach;
  const qy = cy + Math.sin(a + Math.PI / 2) * reach;
  return (
    <>
      <defs>
        <radialGradient id={gid} cx={cx} cy={cy} r={reach} gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor={color} stopOpacity={0.85 * intensity}/>
          <stop offset="30%"  stopColor={color} stopOpacity={0.3 * intensity}/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </radialGradient>
      </defs>
      <path d={`M ${px} ${py} A ${reach} ${reach} 0 0 1 ${qx} ${qy} Z`}
            fill={`url(#${gid})`} style={{ mixBlendMode: 'screen' }}/>
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
  const [viewBox, setViewBox]       = useState('0 0 640 400');
  const [svgText, setSvgText]       = useState(null);
  const [layers, setLayers]         = useState([]);
  const [strips, setStrips]         = useState([]);
  const [density, setDensity]       = useState(60);
  const [pxPerMm, setPxPerMm]       = useState(3.7795);
  const [selLayerId, setSelLayerId] = useState(null);
  const [selStripId, setSelStripId] = useState(null);
  const [hidden, setHidden]         = useState({});
  const [showLight, setShowLight]   = useState(true);
  const [showLeds, setShowLeds]     = useState(true);
  const [glowMode, setGlowMode]     = useState('center');
  const [directedGlow, setDirectedGlow] = useState(false);
  const [showHeat, setShowHeat]     = useState(false);
  const [editCounts, setEditCounts] = useState({});
  const [error, setError]           = useState(null);

  // Layer panel state
  const [expandedLayers, setExpandedLayers] = useState({});
  const [pathSel, setPathSel]       = useState([]);
  const [pathSelName, setPathSelName] = useState('');

  // Draw tool state
  const [drawMode, setDrawMode]     = useState(false);
  const [waypoints, setWaypoints]   = useState([]);
  const [ghostPt, setGhostPt]       = useState(null);

  // Inline draw naming panel (replaces browser prompt)
  const [pendingDraw, setPendingDraw] = useState(null); // { pathData, svgLength }
  const [pendingDrawName, setPendingDrawName] = useState('');
  const [pendingDrawCount, setPendingDrawCount] = useState(0);
  const pendingDrawNameRef = useRef(null);

  // Rubber-band lasso select
  const [rubberBand, setRubberBand] = useState(null); // {x1,y1,x2,y2} SVG coords
  const rubberBandRef          = useRef(null);
  const justFinishedLassoRef   = useRef(false);

  // Canvas pan / zoom
  const [zoom, setZoom]   = useState(1.0);
  const [panX, setPanX]   = useState(0);
  const [panY, setPanY]   = useState(0);
  const spaceRef          = useRef(false);
  const isPanningRef      = useRef(false);
  const panAnchorRef      = useRef(null);
  const [isPanning, setIsPanning] = useState(false);

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
  const [layerGroups, setLayerGroups]     = useState([]);  // [{groupId,name,_hidden,_expanded,members:[{layerId,pathId,pathData,name,svgLength}]}]
  const [layerOrder, setLayerOrder]       = useState([]);  // [{type:'layer'|'group', id}]
  const [layerDragging, setLayerDragging] = useState(null);
  const [layerDragOver, setLayerDragOver] = useState(null);

  // Refs so snapshot/save always capture latest values without dependency churn
  const layerGroupsRef = useRef(layerGroups);
  const layerOrderRef  = useRef(layerOrder);
  useEffect(() => { layerGroupsRef.current = layerGroups; }, [layerGroups]);
  useEffect(() => { layerOrderRef.current  = layerOrder;  }, [layerOrder]);

  const fileRef     = useRef(null);
  const loadRef     = useRef(null);
  const svgRef      = useRef(null);
  const artworkRef  = useRef(null);
  const stripListRef = useRef(null);
  const [hoveredLayerId, setHoveredLayerId] = useState(null);
  const [hoveredSubPathId, setHoveredSubPathId] = useState(null);
  const colorIdxRef = useRef(0);
  const nextColor   = () => STRIP_COLORS[colorIdxRef.current++ % STRIP_COLORS.length];

  const { setStrips: setProjectStrips, setViewBox: setProjectViewBox, setSvgText: setProjectSvgText, setHidden: setProjectHidden } = useProject();

  useEffect(() => { setProjectStrips(strips); },    [strips, setProjectStrips]);
  useEffect(() => { setProjectViewBox(viewBox); },  [viewBox, setProjectViewBox]);
  useEffect(() => { setProjectSvgText(svgText); },  [svgText, setProjectSvgText]);
  useEffect(() => { setProjectHidden(hidden); },    [hidden, setProjectHidden]);

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
        version: 1,
        strips:      curStrips.map(({ pixels: _px, ...s }) => s),
        layers:      curLayers,
        editCounts:  curEditCounts,
        hidden:      curHidden,
        svgText:     curSvgText,
        viewBox:     curViewBox,
        density:     curDensity,
        layerGroups: layerGroupsRef.current,
        layerOrder:  layerOrderRef.current,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch {}
  }, []);

  // ── Restore strips from saved data ────────────────────────────────────────

  const rebuildStrip = (stripData) => {
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', stripData.pathData);
    let pixels = libSamplePath(pathEl, stripData.pixelCount);
    if (stripData.reversed) pixels = pixels.slice().reverse();
    return { ...stripData, pixels };
  };

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
    if (!svgText) return null;
    const doc2 = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const srcSvg2 = doc2.querySelector('svg');
    if (!srcSvg2) return null;
    let groups = Array.from(srcSvg2.children).filter(el => el.tagName === 'g' && el.hasAttribute('data-name'));
    if (!groups.length) groups = Array.from(srcSvg2.children).filter(el => el.tagName === 'g');
    if (groups.length === 1) {
      const inner = Array.from(groups[0].children).filter(el => el.tagName === 'g');
      if (inner.length > 1) groups = inner;
    }
    groups.forEach((g, i) => { if (!g.id) g.setAttribute('id', `layer-${i}`); });
    return srcSvg2.innerHTML;
  }, [svgText]);

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
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setStrips(newStrips);
    setEditCounts(newEditCounts);
    if (selStripId === id) setSelStripId(null);
    lsSave(newStrips, layers, newEditCounts, hidden, svgText, viewBox, density);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, selStripId, pushHistory, lsSave]);

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

  const selectLayer = (layerId) => { setSelLayerId(layerId); setSelStripId(null); };
  const selectStrip = (id) => {
    setSelStripId(id);
    const s = strips.find(st => st.id === id);
    if (s) setSelLayerId(s.id);
  };

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
    pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
    setLayers(prev => prev.filter(l => l.layerId !== layerId));
    setLayerOrder(prev => prev.filter(x => x.id !== layerId));
    setLayerGroups(prev => prev.map(g => ({ ...g, members: g.members.filter(m => m.layerId !== layerId) }))
                               .filter(g => g.members.length > 0));
    setStrips(prev => { const next = prev.filter(s => s.id !== layerId); lsSave(next, layers.filter(l=>l.layerId!==layerId), editCounts, hidden, svgText, viewBox, density); return next; });
    if (selLayerId === layerId) setSelLayerId(null);
    if (selStripId === layerId) setSelStripId(null);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, selLayerId, selStripId, pushHistory, lsSave]);

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
    if (pathSel.length < 2) return;
    const groupId = `grp-${Date.now()}`;
    const baseName = pathSel[0].name.split('·')[0].trim();
    const name = baseName || `Group ${layerGroups.length + 1}`;
    const newGroup = { groupId, name, _hidden: false, _expanded: true, members: pathSel.map(p => ({ ...p })) };
    setLayerGroups(prev => [...prev, newGroup]);
    setLayerOrder(prev => [{ type: 'group', id: groupId }, ...prev]);
    setPathSel([]);
    setPathSelName('');
  }, [pathSel, layerGroups.length]);

  const deleteLayerGroup = useCallback((groupId) => {
    setLayerGroups(prev => prev.filter(g => g.groupId !== groupId));
    setLayerOrder(prev => prev.filter(x => x.id !== groupId));
  }, []);

  const toggleGroupExpanded = (groupId) =>
    setLayerGroups(prev => prev.map(g => g.groupId === groupId ? { ...g, _expanded: !g._expanded } : g));

  const toggleGroupHidden = (groupId) =>
    setLayerGroups(prev => prev.map(g => g.groupId === groupId ? { ...g, _hidden: !g._hidden } : g));

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

  // ── Restore from localStorage on mount ────────────────────────────────────

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || data.version !== 1) return;
      if (data.svgText) {
        const doc = new DOMParser().parseFromString(data.svgText, 'image/svg+xml');
        const srcSvg = doc.querySelector('svg');
        if (srcSvg) {
          setSvgText(data.svgText);
          setViewBox(data.viewBox || '0 0 640 400');
          setPxPerMm(getPxPerMm(srcSvg));
        }
      }
      if (data.density) setDensity(data.density);
      if (data.layers?.length) {
        setLayers(data.layers);
        setLayerGroups(data.layerGroups || []);
        setLayerOrder(data.layerOrder || data.layers.map(l => ({ type: 'layer', id: l.layerId })));
      }
      if (data.editCounts) setEditCounts(data.editCounts);
      if (data.hidden) setHidden(data.hidden);
      if (data.strips?.length) setStrips(data.strips.map(rebuildStrip));
    } catch {}
  }, []); // mount only

  // ── Save / Load project ────────────────────────────────────────────────────

  const saveProject = () => {
    const date = new Date().toISOString().slice(0, 10);
    const data = {
      version: 1,
      strips: strips.map(({ pixels: _px, ...s }) => s),
      layers: layers.map(({ subPaths: _sp, ...l }) => l),
      svgText, viewBox, density, editCounts,
    };
    download(`lightweaver-layout-${date}.json`, JSON.stringify(data, null, 2));
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
      if (!data || data.version !== 1) { alert('Unrecognised file format.'); return; }
      pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
      if (data.svgText) {
        const doc = new DOMParser().parseFromString(data.svgText, 'image/svg+xml');
        const srcSvg = doc.querySelector('svg');
        if (srcSvg) {
          setSvgText(data.svgText);
          setViewBox(data.viewBox || '0 0 640 400');
          setPxPerMm(getPxPerMm(srcSvg));
        }
      }
      if (data.density) setDensity(data.density);
      const loadedLayers = data.layers || [];
      setLayers(loadedLayers);
      setEditCounts(data.editCounts || {});
      setHidden({});
      setSelLayerId(null);
      setSelStripId(null);
      setLayerGroups(data.layerGroups || []);
      setLayerOrder(data.layerOrder || loadedLayers.map(l => ({ type: 'layer', id: l.layerId })));
      if (data.strips?.length) setStrips(data.strips.map(rebuildStrip));
      else setStrips([]);
      resetView();
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
        else { setSelLayerId(null); setSelStripId(null); }
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
        case 'x':
        case 'Delete':
          if (selStripId) removeStrip(selStripId);
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
  }, [drawMode, pendingDraw, selStripId, selLayerId, removeStrip, doUndo, doRedo, layers, addAllStrips]);

  // ── Memoised visualisation data ────────────────────────────────────────────

  const stripSamples = useMemo(() =>
    Object.fromEntries(strips.map(s => [s.id, sampleForViz(s.pathData)])), [strips]);

  const stripArrows = useMemo(() =>
    Object.fromEntries(strips.map(s => [s.id, calcArrow(s.pathData, s.reversed ?? false)])), [strips]);

  const totalLeds = strips.reduce((n, s) => n + s.pixelCount, 0);

  // ── Viewport scale for adaptive sizing ────────────────────────────────────

  const vbScale = useMemo(() => {
    const vb = parsedVb(viewBox);
    return Math.max(vb.w, vb.h) / 600;
  }, [viewBox]);

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
        const pt = svgPt(svgRef.current, e.clientX, e.clientY);
        rubberBandRef.current = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
        setRubberBand({ ...rubberBandRef.current });
        e.preventDefault();
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
      // Update rubber-band
      if (rubberBandRef.current) {
        rubberBandRef.current = { ...rubberBandRef.current, x2: pt.x, y2: pt.y };
        setRubberBand({ ...rubberBandRef.current });
      }
    }
  };

  const handleSvgMouseUp = (e) => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      setIsPanning(false);
    }
    // Finish rubber-band lasso
    const rb = rubberBandRef.current;
    if (rb) {
      rubberBandRef.current = null;
      setRubberBand(null);
      const minX = Math.min(rb.x1, rb.x2);
      const maxX = Math.max(rb.x1, rb.x2);
      const minY = Math.min(rb.y1, rb.y2);
      const maxY = Math.max(rb.y1, rb.y2);
      // Only act if the rect has meaningful size
      if (maxX - minX > 4 || maxY - minY > 4) {
        const hits = [];
        layers.forEach(l => {
          if (hidden[l.layerId] || !l.pathData) return;
          const targets = l.subPaths?.length > 0
            ? l.subPaths
            : [{ pathId: l.layerId, pathData: l.pathData, name: l.name, svgLength: l.svgLength }];
          targets.forEach(t => {
            if (!hidden[t.pathId] && pathIntersectsRect(t.pathData, minX, minY, maxX, maxY)) {
              const isSub = l.subPaths?.length > 0;
              hits.push({ layerId: l.layerId, pathId: t.pathId, pathData: t.pathData,
                          name: isSub ? `${l.name} · ${t.name}` : l.name,
                          svgLength: t.svgLength });
            }
          });
        });
        if (hits.length > 0) {
          justFinishedLassoRef.current = true;
          setPathSel(prev => e.shiftKey
            ? [...prev, ...hits.filter(h => !prev.some(p => p.pathId === h.pathId))]
            : hits);
          setSelLayerId(null);
        }
      }
    }
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

  // ── Render ─────────────────────────────────────────────────────────────────

  const glowStdDev = glowMode === 'outward' ? 5 : glowMode === 'inward' ? 1 : 2.5;

  return (
    <div className="lw-layout-screen">

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
            onClick={() => { setDrawMode(m => !m); setWaypoints([]); setGhostPt(null); }}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 10 L8 2 M8 2 L10 4 M5 8 L10 4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {drawMode ? 'Drawing…' : 'Draw'}
          </button>

          <span className="tbar-divider"/>

          {/* Undo / Redo */}
          <button className="btn btn-ghost" onClick={doUndo} disabled={histLen === 0}
                  title={`Undo (⌘Z) · ${histLen} step${histLen !== 1 ? 's' : ''}`}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 5 L5 2 M2 5 L5 8 M2 5 Q6 2 10 6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {histLen > 0 && <span style={{ fontSize: 9, fontFamily: 'var(--mono-font)', opacity: 0.7 }}>{histLen}</span>}
          </button>
          <button className="btn btn-ghost" onClick={doRedo} disabled={futLen === 0}
                  title={`Redo (⌘⇧Z) · ${futLen} step${futLen !== 1 ? 's' : ''}`}>
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M10 5 L7 2 M10 5 L7 8 M10 5 Q6 2 2 6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {futLen > 0 && <span style={{ fontSize: 9, fontFamily: 'var(--mono-font)', opacity: 0.7 }}>{futLen}</span>}
          </button>

          <span className="tbar-divider"/>
          <span className="tbar-label">Density</span>
          <div style={{ display: 'flex', gap: 2 }}>
            {DENSITY_OPTIONS.map(d => (
              <button key={d} className={`btn ${density === d ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ padding: '3px 8px', fontSize: 11 }}
                      onClick={() => setDensity(d)}>{d}/m</button>
            ))}
          </div>

          <div style={{ flex: 1 }}/>

          {/* Zoom controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button className="btn btn-ghost" style={{ padding: '3px 7px', fontSize: 11 }}
                    onClick={() => setZoom(z => Math.min(40, z * 1.25))} title="Zoom in (+)">+</button>
            <button className="btn btn-ghost" style={{ padding: '3px 5px', fontSize: 9, fontFamily: 'var(--mono-font)', minWidth: 38, textAlign: 'center' }}
                    onClick={resetView} title="Reset view (F)">
              {Math.round(zoom * 100)}%
            </button>
            <button className="btn btn-ghost" style={{ padding: '3px 7px', fontSize: 11 }}
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
                  title="Toggle light visualization">
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
                  onClick={() => setDirectedGlow(v => !v)}
                  title="Directed glow — elongate bloom along strip direction">
            ◈
          </button>
          <button className="btn btn-ghost"
                  onClick={() => setGlowMode(m => GLOW_MODES[(GLOW_MODES.indexOf(m) + 1) % GLOW_MODES.length])}
                  title="Cycle glow mode">
            ◉ {glowMode}
          </button>
        </div>

        {/* Viewport */}
        <div
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
              <span style={{ color: 'var(--accent)', fontSize: 13, fontWeight: 500 }}>Drop SVG here</span>
            </div>
          )}
          <svg
            ref={svgRef}
            viewBox={computedViewBox}
            style={{
              width: '92%', height: '92%',
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
              {/* Single stable bloom filter — stdDeviation changes dynamically */}
              {glowMode !== 'dots' && (
                <filter id="lw-led-bloom" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation={glowStdDev}/>
                </filter>
              )}
              <radialGradient id="heat-grad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="oklch(80% 0.2 30)" stopOpacity="1"/>
                <stop offset="100%" stopColor="oklch(80% 0.2 30)" stopOpacity="0"/>
              </radialGradient>
            </defs>

            {/* ── Artwork background ── */}
            {artworkHTML && (
              <g ref={artworkRef}
                 style={{ pointerEvents: 'none', filter: 'saturate(3) brightness(1.4)', transition: 'opacity 0.2s' }}
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
            {selLayer && pathSel.length === 0 && (() => {
              const glowPaths = selLayer.subPaths?.length > 0
                ? selLayer.subPaths.map(sp => ({ id: sp.pathId, d: sp.pathData }))
                : [{ id: selLayer.layerId, d: selLayer.pathData }];
              return glowPaths.filter(p => p.d).map(p => (
                <g key={p.id} style={{ pointerEvents: 'none' }}>
                  <path d={p.d} stroke={selLayer._color} strokeWidth="2" strokeOpacity={0.5} fill="none" strokeLinecap="round"/>
                  <path d={p.d} stroke="#4cc9f0" strokeWidth="10" strokeOpacity={0.15} fill="none" strokeLinecap="round"/>
                  <path d={p.d} stroke="#4cc9f0" strokeWidth="4"  strokeOpacity={0.6}  fill="none" strokeLinecap="round"/>
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
                        fill="rgba(0,0,0,0)" stroke="#fff" strokeOpacity="0"
                        strokeWidth="16" strokeLinecap="round" pointerEvents="all"
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
                        stroke="oklch(74% 0.13 210)" strokeWidth="3" strokeOpacity={0.4}
                        strokeLinecap="round" pointerEvents="none"/>
                );
              }
              return null;
            })()}

            {/* ── Rubber-band lasso ── */}
            {rubberBand && (
              <rect
                x={Math.min(rubberBand.x1, rubberBand.x2)}
                y={Math.min(rubberBand.y1, rubberBand.y2)}
                width={Math.abs(rubberBand.x2 - rubberBand.x1)}
                height={Math.abs(rubberBand.y2 - rubberBand.y1)}
                fill="oklch(74% 0.13 210 / 0.08)"
                stroke="oklch(74% 0.13 210)"
                strokeWidth="1"
                strokeDasharray="5 3"
                pointerEvents="none"/>
            )}

            {/* ── Path selection highlight ── */}
            {pathSel.map((p, idx) => {
              const midEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
              midEl.setAttribute('d', p.pathData);
              const len = midEl.getTotalLength ? midEl.getTotalLength() : 100;
              const midPt = midEl.getPointAtLength ? midEl.getPointAtLength(len * 0.5) : { x: 0, y: 0 };
              return (
                <g key={'sel-' + p.pathId} style={{ pointerEvents: 'none' }}>
                  <path d={p.pathData} stroke="#4cc9f0" strokeWidth="10" fill="none" opacity={0.18} strokeLinecap="round"/>
                  <path d={p.pathData} stroke="#4cc9f0" strokeWidth="5"  fill="none" opacity={0.55} strokeLinecap="round"/>
                  <path d={p.pathData} stroke="white"   strokeWidth="2"  fill="none" opacity={1}    strokeLinecap="round"/>
                  <circle cx={midPt.x} cy={midPt.y} r={vbScale * 9} fill="#4cc9f0" opacity={0.85}/>
                  <text x={midPt.x} y={midPt.y + vbScale * 4} textAnchor="middle" fill="white" fontSize={vbScale * 9}
                        fontWeight="bold" style={{ userSelect: 'none' }}>{idx + 1}</text>
                </g>
              );
            })}

            {/* ── Light visualization ── */}
            {showLight && strips.map(s =>
              !hidden[s.id] && (stripSamples[s.id] || []).map((pt, i) => (
                s.emit === 'omni'
                  ? <OmniHalo key={i} uid={`${s.id}-${i}`} cx={pt.x} cy={pt.y} color={s.color} reach={vbScale * 50} intensity={0.5}/>
                  : <LightCone key={i} uid={`${s.id}-${i}`} cx={pt.x} cy={pt.y}
                               angle={Math.atan2(pt.tx, -pt.ty) * 180 / Math.PI + 90 + (s.angle || 0)}
                               color={s.color}
                               reach={vbScale * (directedGlow ? 90 * 1.3 : 90)}
                               intensity={directedGlow ? 0.7 : 0.5}/>
              ))
            )}

            {/* ── Strip paths ── */}
            {strips.map(s => {
              const isSel = s.id === selStripId;
              const isHid = !!hidden[s.id];
              return (
                <path key={s.id} d={s.pathData}
                      stroke={isHid ? 'oklch(40% 0.01 260)' : s.color}
                      strokeWidth={isSel ? 3.5 : 1.8} fill="none"
                      opacity={isHid ? 0.25 : isSel ? 1 : 0.7}
                      style={{ cursor: 'pointer', filter: isSel ? `drop-shadow(0 0 6px ${s.color})` : 'none' }}
                      onClick={e => { e.stopPropagation(); selectStrip(s.id); }}/>
              );
            })}

            {/* ── LED dots ── */}
            {showLeds && strips.filter(s => !hidden[s.id]).map(s => (
              glowMode === 'dots' ? (
                <g key={s.id + '-dots'}>
                  {s.pixels.map((px, i) => (
                    <circle key={i} cx={px.x} cy={px.y}
                            r={s.id === selStripId ? vbScale * 3.5 : vbScale * 3}
                            fill={s.color} opacity={1}/>
                  ))}
                </g>
              ) : (
                <g key={s.id + '-dots'} filter="url(#lw-led-bloom)">
                  {s.pixels.map((px, i) => (
                    <circle key={i} cx={px.x} cy={px.y}
                            r={s.id === selStripId ? vbScale * 3 : vbScale * 2.5}
                            fill={s.color}
                            opacity={glowMode === 'outward'
                              ? (s.id === selStripId ? 0.7 : 0.63)
                              : (s.id === selStripId ? 1 : 0.9)}/>
                  ))}
                </g>
              )
            ))}

            {/* ── Strip mid-path labels (selected strip only) ── */}
            {strips.filter(s => !hidden[s.id] && s.pixels?.length > 0 && s.id === selStripId).map(s => {
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
            {strips.filter(s => !hidden[s.id]).map(s => {
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

      {/* ── Right panel ────────────────────────────────────────────── */}
      <div style={{ borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>

        {error && (
          <div style={{ padding: '10px 14px', background: 'oklch(25% 0.08 30)', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'oklch(80% 0.12 30)', lineHeight: 1.5, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button style={{ color: 'oklch(60% 0.10 30)', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                    onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {/* Draw mode hint */}
        {drawMode && (
          <div style={{ padding: '8px 14px', background: 'oklch(22% 0.06 210)', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'oklch(78% 0.12 210)', lineHeight: 1.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <strong>Drawing mode</strong>
              <button style={{ fontSize: 10, color: 'oklch(60% 0.10 210)', padding: '0 4px' }}
                      onClick={() => { setDrawMode(false); setWaypoints([]); setGhostPt(null); }}>
                Cancel (Esc)
              </button>
            </div>
            <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, display: 'block' }}>
              {waypoints.length} point{waypoints.length !== 1 ? 's' : ''}
              {waypoints.length >= 2 && ` · ~${drawEstimatedLeds} LEDs · double-click to finish`}
              {waypoints.length < 2 && ' · click to place, ⌫ undo, right-click cancel'}
            </span>
          </div>
        )}

        {/* Pending draw naming panel */}
        {pendingDraw && (
          <div style={{ padding: '12px 14px', background: 'oklch(20% 0.06 210)', borderBottom: '1px solid var(--border)', flex: '0 0 auto' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', marginBottom: 8 }}>
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
                style={{ fontSize: 12, background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 4, padding: '5px 9px', color: 'var(--text)', width: '100%' }}
                autoFocus
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                <span style={{ color: 'var(--text-3)', width: 72, flexShrink: 0 }}>LED count</span>
                <input type="number" min="1" max="2000"
                       value={pendingDrawCount}
                       onChange={e => setPendingDrawCount(Math.max(1, +e.target.value))}
                       style={{ width: 72, fontFamily: 'var(--mono-font)', fontSize: 12, textAlign: 'right',
                                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
                                padding: '3px 8px', color: 'var(--text)' }}/>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" style={{ flex: 1, fontSize: 11 }} onClick={confirmDraw}>
                  + Add Strip
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={cancelDraw}>
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
                <button style={{ fontSize: 10, color: 'var(--text-4)', padding: '0 4px' }} title="Show all"
                        onClick={() => setHidden(h => { const n={...h}; layers.forEach(l=>{n[l.layerId]=false;}); return n; })}>
                  <EyeIcon/>
                </button>
                <button style={{ fontSize: 10, color: 'var(--text-4)', padding: '0 4px' }} title="Hide all"
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
                    const isDragTarget = layerDragOver === group.groupId;
                    return (
                      <div key={group.groupId}
                           draggable
                           onDragStart={e => { e.dataTransfer.effectAllowed='move'; setLayerDragging(group.groupId); }}
                           onDragOver={e => { e.preventDefault(); setLayerDragOver(group.groupId); }}
                           onDrop={e => { e.preventDefault(); if (layerDragging) reorderLayerOrder(layerDragging, group.groupId); setLayerDragging(null); setLayerDragOver(null); }}
                           onDragEnd={() => { setLayerDragging(null); setLayerDragOver(null); }}>
                        <div className="lw-layer-row"
                             style={{ background: isDragTarget ? 'oklch(74% 0.13 210 / 0.08)' : undefined,
                                      borderLeft: `3px solid oklch(80% 0.14 270 / 0.6)`,
                                      opacity: isGroupHidden ? 0.45 : 1 }}>
                          <span style={{ cursor: 'grab', color: 'var(--text-4)', display:'flex', alignItems:'center', paddingRight: 2 }}>
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
                                        className="lw-layer-name" style={{ fontSize: 12, flex: 1 }}/>
                          <span style={{ fontSize: 9, color: 'var(--text-4)', fontFamily: 'var(--mono-font)', flexShrink: 0 }}>
                            {group.members.length}p
                          </span>
                          <button title="Ungroup" onClick={e => { e.stopPropagation(); deleteLayerGroup(group.groupId); }}
                                  style={{ fontSize: 11, color: 'var(--text-4)', padding: '0 3px', lineHeight:1, flexShrink:0 }}
                                  className="lw-btn-danger-hover">⊠</button>
                        </div>
                        {group._expanded && group.members.map((m, mi) => (
                          <div key={m.pathId} className="lw-subpath-row"
                               style={{ paddingLeft: 32, background: 'oklch(80% 0.14 270 / 0.04)' }}>
                            <span style={{ fontFamily:'var(--mono-font)', fontSize:9, color:'oklch(80% 0.14 270)', fontWeight:'bold', width:14, flexShrink:0, textAlign:'center' }}>{mi+1}</span>
                            <button className="lw-layer-eye" style={{ marginLeft:2 }}
                                    onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [m.pathId]: !h[m.pathId] })); }}>
                              {hidden[m.pathId] ? <EyeOffIcon/> : <EyeIcon/>}
                            </button>
                            <span style={{ flex:1, fontSize:11, color:'var(--text-2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.name}</span>
                            {m.svgLength > 0 && (
                              <span style={{ fontFamily:'var(--mono-font)', fontSize:10, color:'var(--text-4)', flexShrink:0 }}>
                                {Math.round(m.svgLength / pxPerMm)}mm
                              </span>
                            )}
                            <button style={{ fontSize:11, padding:'0 4px', color:'var(--text-4)', flexShrink:0 }}
                                    onClick={e => { e.stopPropagation(); setLayerGroups(prev => prev.map(g => g.groupId !== group.groupId ? g : { ...g, members: g.members.filter((_,i)=>i!==mi) })); }}>✕</button>
                          </div>
                        ))}
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
                         onDragStart={e => { e.dataTransfer.effectAllowed='move'; setLayerDragging(l.layerId); }}
                         onDragOver={e => { e.preventDefault(); setLayerDragOver(l.layerId); }}
                         onDrop={e => { e.preventDefault(); if (layerDragging) reorderLayerOrder(layerDragging, l.layerId); setLayerDragging(null); setLayerDragOver(null); }}
                         onDragEnd={() => { setLayerDragging(null); setLayerDragOver(null); }}>
                      <div className={`lw-layer-row${isSel?' lw-layer-row--sel':''}${isHidden?' lw-layer-row--hidden':''}`}
                           style={{ borderTop: isDragTarget ? '2px solid var(--accent)' : undefined }}
                           onClick={() => selectLayer(l.layerId)}
                           onMouseEnter={() => setHoveredLayerId(l.layerId)}
                           onMouseLeave={() => setHoveredLayerId(null)}>
                        <span style={{ cursor:'grab', color:'var(--text-4)', display:'flex', alignItems:'center', paddingRight:2 }}>
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
                                      className="lw-layer-name" style={{ fontSize: 12, flex: 1 }}/>
                        {canExpand && (
                          <span style={{ fontSize:9, color:'var(--text-4)', fontFamily:'var(--mono-font)', flexShrink:0 }}>
                            {l.subPaths.length}p
                          </span>
                        )}
                        {hasStrip && (
                          <button style={{ fontSize:9, color:'var(--mint)', fontFamily:'var(--mono-font)', flexShrink:0, lineHeight:1, padding:'0 2px' }}
                                  title="Select strip" onClick={e => { e.stopPropagation(); if (stripForLayer) selectStrip(stripForLayer.id); }}>●</button>
                        )}
                        {l.svgLength > 0 && (
                          <span className="lw-layer-len">{Math.round(l.svgLength / pxPerMm)}mm</span>
                        )}
                        <button title="Delete layer" onClick={e => { e.stopPropagation(); deleteLayer(l.layerId); }}
                                style={{ fontSize:13, color:'var(--text-4)', padding:'0 3px', lineHeight:1, flexShrink:0 }}
                                className="lw-btn-danger-hover">×</button>
                      </div>

                      {isExpanded && l.subPaths?.map(sp => {
                        const spHidden = !!hidden[sp.pathId];
                        const spSel    = pathSel.some(p => p.pathId === sp.pathId);
                        return (
                          <div key={sp.pathId}
                               className={`lw-subpath-row${hoveredSubPathId === sp.pathId ? ' lw-subpath-row--hover' : ''}`}
                               onMouseEnter={() => setHoveredSubPathId(sp.pathId)}
                               onMouseLeave={() => setHoveredSubPathId(null)}>
                            {/* Checkbox for path selection */}
                            <input type="checkbox" checked={spSel}
                                   style={{ margin:'0 2px 0 4px', accentColor:'var(--accent)', cursor:'pointer', flexShrink:0 }}
                                   onChange={e => {
                                     const entry = { layerId: l.layerId, pathId: sp.pathId, pathData: sp.pathData, name: `${l.name} · ${sp.name}`, svgLength: sp.svgLength };
                                     setPathSel(prev => e.target.checked ? [...prev, entry] : prev.filter(p => p.pathId !== sp.pathId));
                                   }}
                                   onClick={e => e.stopPropagation()}/>
                            <button className="lw-layer-eye" style={{ padding:'0 1px' }}
                                    onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [sp.pathId]: !h[sp.pathId] })); }}>
                              {spHidden ? <EyeOffIcon/> : <EyeIcon/>}
                            </button>
                            <InlineRename value={sp.name} onCommit={n => renameSubPath(l.layerId, sp.pathId, n)}
                                          style={{ flex:1, fontSize:11, color: spHidden ? 'var(--text-4)' : 'var(--text-2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}/>
                            <span style={{ fontFamily:'var(--mono-font)', fontSize:10, color:'var(--text-3)', flexShrink:0 }}>
                              {sp.svgLength > 0 ? `${Math.round(sp.svgLength / pxPerMm)}mm` : ''}
                            </span>
                            <button className="btn btn-primary" style={{ padding:'2px 7px', fontSize:10, flexShrink:0 }}
                                    onClick={e => { e.stopPropagation(); addSubPathStrip(sp, l); }}>+</button>
                          </div>
                        );
                      })}
                    </div>
                  );
                });
              })()}

              <div style={{ padding:'6px 12px', fontSize:10, color:'var(--text-4)', lineHeight:1.5 }}>
                Click to select · <strong style={{ color:'var(--text-3)' }}>⇧+click</strong> canvas paths · ☐ checkboxes to combine
              </div>
            </div>
          </>
        )}

        {/* ── Path selection panel ── */}
        {pathSel.length > 0 && (
          <div style={{ borderBottom: '1px solid var(--border)', padding: '10px 14px', background: 'oklch(18% 0.04 270)', flex: '0 0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)' }}>
                {pathSel.length} path{pathSel.length > 1 ? 's' : ''} selected
              </span>
              <button style={{ color: 'var(--text-4)', padding: '0 4px', fontSize: 12 }}
                      onClick={() => { setPathSel([]); setPathSelName(''); }}>✕</button>
            </div>
            <div style={{ maxHeight: 80, overflow: 'auto', marginBottom: 8 }}>
              {pathSel.map((p, i) => (
                <div key={p.pathId} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11,
                                              color: 'var(--text-3)', padding: '2px 0' }}>
                  <span style={{ fontFamily: 'var(--mono-font)', fontSize: 9, color: '#4cc9f0',
                                 fontWeight: 'bold', width: 14, flexShrink: 0, textAlign: 'center' }}>{i + 1}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  {p.svgLength > 0 && (
                    <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, flexShrink: 0, color: 'var(--text-4)' }}>
                      {Math.round(p.svgLength / pxPerMm)}mm
                    </span>
                  )}
                  <button disabled={i === 0} style={{ fontSize: 10, padding: '0 3px', color: 'var(--text-4)', opacity: i === 0 ? 0.3 : 1 }}
                          onClick={() => setPathSel(prev => {
                            const a = [...prev]; [a[i-1], a[i]] = [a[i], a[i-1]]; return a;
                          })}>↑</button>
                  <button disabled={i === pathSel.length - 1} style={{ fontSize: 10, padding: '0 3px', color: 'var(--text-4)', opacity: i === pathSel.length - 1 ? 0.3 : 1 }}
                          onClick={() => setPathSel(prev => {
                            const a = [...prev]; [a[i], a[i+1]] = [a[i+1], a[i]]; return a;
                          })}>↓</button>
                  <button style={{ fontSize: 11, padding: '0 4px', color: 'var(--text-4)' }}
                          onClick={() => setPathSel(prev => prev.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" value={pathSelName} onChange={e => setPathSelName(e.target.value)}
                     placeholder="Name…"
                     style={{ flex: 1, fontSize: 11, background: 'var(--bg)', border: '1px solid var(--border)',
                              borderRadius: 4, padding: '4px 8px', color: 'var(--text)' }}/>
              <button className="btn btn-primary" style={{ fontSize: 11 }}
                      onClick={() => {
                        if (!pathSel.length) return;
                        const combinedPathData = pathSel.map(p => p.pathData).join(' ');
                        const totalLen = pathSel.reduce((s, p) => s + p.svgLength, 0);
                        const count = Math.max(1, Math.round((totalLen / pxPerMm) * density / 1000));
                        const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                        pathEl.setAttribute('d', combinedPathData);
                        const pixels = libSamplePath(pathEl, count);
                        const name = pathSelName.trim() || `Strip ${strips.length + 1}`;
                        const newStrip = {
                          id: `sel-${Date.now()}`, name,
                          pathData: combinedPathData, pixelCount: count, pixels,
                          color: nextColor(), emit: 'dir', angle: 0, reversed: false,
                          speed: 1.0, brightness: 1.0, hueShift: 0, patternId: null,
                        };
                        const newStrips = [...strips, newStrip];
                        pushHistory(strips, layers, editCounts, hidden, svgText, viewBox, density);
                        setStrips(newStrips);
                        setSelStripId(newStrip.id);
                        lsSave(newStrips, layers, editCounts, hidden, svgText, viewBox, density);
                        setPathSel([]);
                        setPathSelName('');
                        scrollToStrip(newStrip.id);
                      }}>
                + Strip
              </button>
              {pathSel.length >= 2 && (
                <button className="btn" style={{ fontSize: 11, color: 'oklch(80% 0.14 270)', borderColor: 'oklch(80% 0.14 270 / 0.4)', background: 'oklch(80% 0.14 270 / 0.08)' }}
                        title="Group these paths in the layer panel (not a strip)"
                        onClick={createLayerGroup}>
                  <GroupIcon/> Group
                </button>
              )}
            </div>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-3)' }}>Length</span>
                <span style={{ fontFamily: 'var(--mono-font)' }}>
                  {selLayer.svgLength > 0 ? `${Math.round(selLayer.svgLength / pxPerMm)} mm` : '—'}
                </span>
              </div>
              {selLayer.subPaths?.length > 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-3)' }}>Sub-paths</span>
                  <span style={{ fontFamily: 'var(--mono-font)' }}>{selLayer.subPaths.length}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                <span style={{ color: 'var(--text-3)' }}>Density</span>
                <div style={{ display: 'flex', gap: 2 }}>
                  {DENSITY_OPTIONS.map(d => (
                    <button key={d}
                            className={`btn ${density === d ? 'btn-primary' : 'btn-ghost'}`}
                            style={{ padding: '2px 6px', fontSize: 10 }}
                            onClick={() => setDensity(d)}>{d}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                <span style={{ color: 'var(--text-3)' }}>LED count</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {editCounts[selLayer.layerId] != null && (
                    <button style={{ fontSize: 10, color: 'var(--text-4)', padding: '0 4px' }}
                            title="Reset to calculated"
                            onClick={() => setEditCounts(c => { const next = { ...c }; delete next[selLayer.layerId]; return next; })}>
                      ↺
                    </button>
                  )}
                  <input type="number" min="1" max="1500"
                         value={editCounts[selLayer.layerId] ?? getLedCount(selLayer)}
                         onChange={e => {
                           const val = Math.max(1, +e.target.value);
                           setEditCounts(c => ({ ...c, [selLayer.layerId]: val }));
                         }}
                         onKeyDown={e => {
                           if (e.key === 'Enter') addStrip();
                         }}
                         style={{ width: 72, fontFamily: 'var(--mono-font)', fontSize: 12, textAlign: 'right',
                                  background: 'var(--bg)', border: `1px solid ${editCounts[selLayer.layerId] != null ? 'var(--accent)' : 'var(--border)'}`,
                                  borderRadius: 4, padding: '3px 8px', color: 'var(--text)' }}/>
                </div>
              </div>
              {selLayer.svgLength > 0 && getLedCount(selLayer) > 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-3)' }}>Pitch</span>
                  <span style={{ fontFamily: 'var(--mono-font)' }}>
                    {((selLayer.svgLength / pxPerMm) / getLedCount(selLayer)).toFixed(1)} mm/LED
                  </span>
                </div>
              )}

              {/* Emit controls */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                <span style={{ color: 'var(--text-3)' }}>Emit</span>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', opacity: existingStrip ? 1 : 0.4 }}>
                  <button
                    className={`btn ${existingStrip?.emit === 'omni' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ padding: '2px 8px', fontSize: 10 }}
                    disabled={!existingStrip}
                    title={existingStrip ? 'Omnidirectional glow' : 'Add strip first'}
                    onClick={() => {
                      if (!existingStrip) return;
                      updateStrip(existingStrip.id, { emit: 'omni', angle: 0 });
                    }}>Omni</button>
                  <button
                    className={`btn ${existingStrip && existingStrip.emit !== 'omni' ? 'btn-primary' : 'btn-ghost'}`}
                    style={{ padding: '2px 8px', fontSize: 10 }}
                    disabled={!existingStrip}
                    title={existingStrip ? 'Directed emission' : 'Add strip first'}
                    onClick={() => {
                      if (!existingStrip) return;
                      updateStrip(existingStrip.id, { emit: 'dir' });
                    }}>Dir</button>
                </div>
              </div>

              {/* Angle slider — only when directed */}
              {existingStrip?.emit !== 'omni' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, opacity: existingStrip ? 1 : 0.4 }}>
                  <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Angle</span>
                  <input type="range" min="0" max="360" step="1"
                         value={existingStrip?.angle || 0}
                         style={{ flex: 1 }}
                         disabled={!existingStrip}
                         onChange={e => {
                           if (!existingStrip) return;
                           updateStrip(existingStrip.id, { angle: +e.target.value });
                         }}/>
                  <input type="number" min="0" max="360" value={existingStrip?.angle || 0}
                         disabled={!existingStrip}
                         style={{ width: 48, fontFamily: 'var(--mono-font)', fontSize: 11, textAlign: 'right',
                                  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 5px', color: 'var(--text)' }}
                         onChange={e => {
                           if (!existingStrip) return;
                           updateStrip(existingStrip.id, { angle: +e.target.value });
                         }}/>
                  <span style={{ color: 'var(--text-3)', fontSize: 10, flexShrink: 0 }}>°</span>
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
              <span className="meta">{strips.length} strips · {totalLeds.toLocaleString()} LEDs</span>
            </div>
            <div ref={stripListRef} style={{ flex: 1, overflow: 'auto' }}>
              {strips.map((s, i) => {
                const isSel = s.id === selStripId;
                return (
                  <div key={s.id}
                       data-strip-id={s.id}
                       className={`lw-strip-row${isSel ? ' lw-strip-row--sel' : ''}`}
                       style={{ opacity: hidden[s.id] ? 0.4 : 1 }}
                       onClick={() => selectStrip(s.id)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-4)', width: 16, flexShrink: 0, textAlign: 'right' }}>{i + 1}</span>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.color, flexShrink: 0,
                                     boxShadow: isSel ? `0 0 8px ${s.color}` : 'none' }}/>
                      <InlineRename value={s.name} onCommit={n => renameStrip(s.id, n)}
                                    style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}/>
                      {s.reversed && (
                        <span style={{ fontSize: 9, fontFamily: 'var(--mono-font)', color: 'var(--accent-2)',
                                       background: 'oklch(80% 0.13 70 / 0.15)', border: '1px solid oklch(80% 0.13 70 / 0.3)',
                                       borderRadius: 3, padding: '1px 4px', flexShrink: 0 }}>REV</span>
                      )}
                      <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-3)', flexShrink: 0 }}>{s.pixelCount}</span>
                      <button style={{ color: 'var(--text-4)', padding: '0 3px', fontSize: 12, lineHeight: 1, flexShrink: 0 }}
                              title={hidden[s.id] ? 'Show (H)' : 'Hide (H)'}
                              onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [s.id]: !h[s.id] })); }}>
                        {hidden[s.id] ? <EyeOffIcon/> : <EyeIcon/>}
                      </button>
                      <button style={{ color: 'var(--text-4)', padding: '0 3px', fontSize: 11, lineHeight: 1, flexShrink: 0 }}
                              title="Duplicate strip"
                              onClick={e => { e.stopPropagation(); duplicateStrip(s.id); }}>⧉</button>
                      <button className="lw-btn-danger-hover" style={{ color: 'var(--text-4)', padding: '0 3px', fontSize: 15, lineHeight: 1, flexShrink: 0 }}
                              title="Delete strip (X)"
                              onClick={e => { e.stopPropagation(); removeStrip(s.id); }}>×</button>
                    </div>
                    {isSel && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 0 2px 0', borderTop: '1px solid var(--border)', marginTop: 6 }}>
                        {/* Speed */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                          <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Speed</span>
                          <input type="range" min="0.1" max="4" step="0.05" value={s.speed ?? 1}
                                 style={{ flex: 1 }}
                                 onChange={e => updateStrip(s.id, { speed: +e.target.value })}
                                 onPointerUp={e => updateStripWithHistory(s.id, { speed: +e.target.value })}
                                 onDoubleClick={() => updateStrip(s.id, { speed: 1 })}/>
                          <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-3)', width: 32, textAlign: 'right' }}>{(s.speed ?? 1).toFixed(2)}×</span>
                        </div>
                        {/* Brightness */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                          <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Bright</span>
                          <input type="range" min="0" max="1" step="0.01" value={s.brightness ?? 1}
                                 style={{ flex: 1 }}
                                 onChange={e => updateStrip(s.id, { brightness: +e.target.value })}
                                 onPointerUp={e => updateStripWithHistory(s.id, { brightness: +e.target.value })}
                                 onDoubleClick={() => updateStrip(s.id, { brightness: 1 })}/>
                          <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-3)', width: 32, textAlign: 'right' }}>{Math.round((s.brightness ?? 1) * 100)}%</span>
                        </div>
                        {/* Hue shift */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                          <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Hue</span>
                          <input type="range" min="-180" max="180" step="1" value={s.hueShift ?? 0}
                                 style={{ flex: 1 }}
                                 onChange={e => updateStrip(s.id, { hueShift: +e.target.value })}
                                 onPointerUp={e => updateStripWithHistory(s.id, { hueShift: +e.target.value })}
                                 onDoubleClick={() => updateStrip(s.id, { hueShift: 0 })}/>
                          <span style={{ fontFamily: 'var(--mono-font)', fontSize: 10, color: 'var(--text-3)', width: 32, textAlign: 'right' }}>{s.hueShift ?? 0}°</span>
                        </div>
                        {/* Per-strip pattern override */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                          <span style={{ color: 'var(--text-3)', width: 52, flexShrink: 0 }}>Pattern</span>
                          <select value={s.patternId ?? ''}
                                  style={{ flex: 1, fontSize: 10, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text)', padding: '2px 4px' }}
                                  onChange={e => {
                                    const v = e.target.value || null;
                                    updateStrip(s.id, { patternId: v });
                                  }}>
                            <option value="">Inherited</option>
                            {PATTERNS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </div>
                        {/* Strip actions */}
                        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                          <button className="btn btn-ghost" style={{ flex: 1, fontSize: 10 }}
                                  onClick={e => { e.stopPropagation(); reverseStrip(s.id); }}>
                            ↔ Reverse
                          </button>
                          <button className="btn btn-ghost lw-btn-danger" style={{ flex: 1, fontSize: 10 }}
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

        {/* ── Empty state ── */}
        {!svgText && !error && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                        justifyContent: 'center', gap: 14, padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.35">
              <rect x="6" y="4" width="32" height="36" rx="3"/>
              <path d="M14 14h16M14 22h16M14 30h10"/>
              <path d="M28 28l8 8M32 28h4v4" strokeLinecap="round"/>
            </svg>
            <div style={{ fontSize: 13 }}>Import an SVG to map LED strips</div>
            <div style={{ fontSize: 11, color: 'var(--text-4)', lineHeight: 1.5 }}>
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
