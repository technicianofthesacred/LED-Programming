import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { samplePath as libSamplePath } from '../../../lib/mapper.js';
import {
  buildGammaLut,
  compilePattern,
  normalizePalette,
  renderPixelFrame,
} from '../../../lib/frameEngine.js';
import {
  nextStripId,
  stripSourceKey,
  measurePathLen,
  translateStripFromStart,
  offsetSamplePoints,
  offsetArrow,
  calcArrow,
  sampleForViz,
  ptsToD,
  svgPt,
  parsedVb,
  pathIntersectsRect,
} from '../../../lib/layoutGeometry.js';
import { isClosedPathData } from '../../../lib/pathClosure.js';
import { useProject } from '../../../state/ProjectContext.jsx';

// Draw | Size | Wire — deep-linked via `#screen=layout&mode=<x>`.
const LAYOUT_MODES = ['draw', 'size', 'wire'];

function parseModeFromHash() {
  if (typeof window === 'undefined') return 'draw';
  const params = new URLSearchParams(window.location.hash.slice(1));
  const raw = params.get('mode');
  return LAYOUT_MODES.includes(raw) ? raw : 'draw';
}

// Merges `mode=<x>` into whatever's already in the hash (e.g. `screen=layout`)
// instead of overwriting it — Shell (src/v3/app.jsx) owns `screen=` writes and
// re-derives its `view` state only from that key, so this never fights it.
function mergeModeIntoHash(nextMode) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.set('mode', nextMode);
  const nextHash = `#${params.toString()}`;
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
  }
}

function measureSelectedPathDecoration(pathData) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  const length = path.getTotalLength ? path.getTotalLength() : 100;
  const midpoint = path.getPointAtLength ? path.getPointAtLength(length * 0.5) : { x: 0, y: 0 };
  return { midpoint: { x: midpoint.x, y: midpoint.y } };
}

// Canvas: pan/zoom/wheel, lasso, strip move + nudge, draw mode + waypoints,
// keyboard shortcuts, hover state, preview toggles, and every derived
// visualisation memo the <svg> tree renders. Cross-hook mutators arrive via
// `deps` from the composer (no hook reaches into another's internals).
export function useLayoutCanvasInteraction(ctx, deps) {
  const { wiring, compiledWiring } = useProject();
  const {
    strips, setStrips,
    hidden, setHidden,
    layers, editCounts, svgText, viewBox, density, pxPerMm,
    pushLayoutHistory,
    selection,
    selectStrip, selectStrips, toggleStripSel, selectPaths, clearLayoutSelection,
    projectRevision,
    // selection views
    selectedStripIds, selStripId, pathSel, selLayerId,
    // shared refs + helpers
    svgRef, artworkRef, vpRef, stripsRef,
    nextColor, scrollToStrip,
    doUndo, doRedo,
    // pattern state for the preview frame
    activePatternId, patternParams, palette, bpm,
    masterSpeed, masterBrightness, masterSaturation, masterHueShift,
    gammaEnabled, gammaValue, symSettings,
  } = ctx;

  const {
    stripsApi, artworkApi, wireApi,
  } = deps;

  const { removeStrip, removeSelectedStrips, groupSelectedStrips, mergeSelectedStrips, setStripOffset } = stripsApi;
  const { deleteSelectedVectorPaths, deleteLayer, createLayerGroup, addAllStrips, artworkHTML } = artworkApi;
  const {
    wireOverlayMode, selectedWireCut,
    setWireOverlayMode, setSelectedWireCut, setLinkRouteIds,
    deleteSelectedWireCut,
  } = wireApi;

  // ── Preview toggles ────────────────────────────────────────────────────────
  const [showLight, setShowLight]   = useState(false);
  const [showLeds, setShowLeds]     = useState(true);
  const [glowMode, setGlowMode]     = useState('dots');
  const [directedGlow, setDirectedGlow] = useState(false);
  const [showHeat, setShowHeat]     = useState(false);
  const [lightMenuOpen, setLightMenuOpen] = useState(false);   // Light disclosure popover

  // ── Draw tool state ────────────────────────────────────────────────────────
  const [drawMode, setDrawMode]     = useState(false);
  const [waypoints, setWaypoints]   = useState([]);
  const [ghostPt, setGhostPt]       = useState(null);
  const [pendingDraw, setPendingDraw] = useState(null); // { pathData, svgLength }
  const [pendingDrawName, setPendingDrawName] = useState('');
  const [pendingDrawCount, setPendingDrawCount] = useState(0);
  const pendingDrawNameRef = useRef(null);

  // ── Mode (Draw | Size | Wire) — ephemeral, never in undo/autosave ──────────
  // Deep-linked via `#screen=layout&mode=<x>`; the initial read tolerates a
  // missing/invalid param (falls back to 'draw'). Writes only happen on an
  // explicit mode change (setMode), merging into whatever hash already exists
  // so Shell's own `#screen=` writes (src/v3/app.jsx) are never fought.
  const [mode, setModeState] = useState(() => parseModeFromHash());

  // Clears every in-progress tool's ephemeral state (draw waypoints/ghost/
  // pending-name panel + the wire chop/link overlay) without touching any
  // persisted/undoable state. Called before every mode switch, and by the
  // Escape handler's draw-cancel branch.
  const cancelActiveTool = useCallback(() => {
    setDrawMode(false);
    setWaypoints([]);
    setGhostPt(null);
    setPendingDraw(null);
    setWireOverlayMode('idle');
    setLinkRouteIds([]);
    setSelectedWireCut(null);
  }, [setWireOverlayMode, setLinkRouteIds, setSelectedWireCut]);

  const setMode = useCallback((nextMode) => {
    if (!LAYOUT_MODES.includes(nextMode) || nextMode === mode) return;
    // Mode visits suspend the freehand tool without discarding its waypoints.
    // Escape / Cancel remain the explicit destructive action.
    setDrawMode(false);
    setGhostPt(null);
    setWireOverlayMode('idle');
    setLinkRouteIds([]);
    setSelectedWireCut(null);
    setModeState(nextMode);
    mergeModeIntoHash(nextMode);
  }, [mode, setWireOverlayMode, setLinkRouteIds, setSelectedWireCut]);

  // ── Rubber-band lasso — coords stored in CLIENT (viewport px), not SVG ──────
  const [rubberBand, setRubberBand] = useState(null); // {x1,y1,x2,y2} client px
  const rubberBandRef          = useRef(null);
  const justFinishedLassoRef   = useRef(false);
  const lassoFinishRef         = useRef(null);

  // ── Canvas pan / zoom ──────────────────────────────────────────────────────
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
  const [movingStripIds, setMovingStripIds] = useState([]);

  // ── Canvas cursor + hover state ────────────────────────────────────────────
  const [cursorSvgPt, setCursorSvgPt] = useState(null);
  const [hoveredLayerId, setHoveredLayerId] = useState(null);
  const [hoveredSubPathId, setHoveredSubPathId] = useState(null);
  const selectedPathDecorationCacheRef = useRef(new Map());

  const selectedPathGeometryKey = JSON.stringify(pathSel.map(path => [path.pathId, path.pathData]));
  const selectedPathDecorations = useMemo(() => {
    const activeKeys = new Set();
    const decorations = pathSel.map((path, index) => {
      const cacheKey = JSON.stringify([path.pathId, path.pathData]);
      activeKeys.add(cacheKey);
      let geometry = selectedPathDecorationCacheRef.current.get(cacheKey);
      if (!geometry) {
        geometry = measureSelectedPathDecoration(path.pathData);
        selectedPathDecorationCacheRef.current.set(cacheKey, geometry);
      }
      return { ...path, ...geometry, order: index + 1 };
    });
    for (const key of selectedPathDecorationCacheRef.current.keys()) {
      if (!activeKeys.has(key)) selectedPathDecorationCacheRef.current.delete(key);
    }
    return decorations;
  }, [selectedPathGeometryKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Computed viewBox with pan/zoom ─────────────────────────────────────────
  const computedViewBox = useMemo(() => {
    const vb = parsedVb(viewBox);
    const w = vb.w / zoom;
    const h = vb.h / zoom;
    const cx = vb.x + vb.w / 2;
    const cy = vb.y + vb.h / 2;
    return `${(cx - w / 2 + panX).toFixed(2)} ${(cy - h / 2 + panY).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`;
  }, [viewBox, zoom, panX, panY]);

  const resetView = () => { setZoom(1); setPanX(0); setPanY(0); };

  // Loading a project resets only EPHEMERAL view state.
  useEffect(() => {
    resetView();
  }, [projectRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  const enableLightPreview = useCallback(() => {
    setShowLight(true);
    setGlowMode(mode => mode === 'dots' ? 'center' : mode);
  }, []);

  // ── Strip move (drag on canvas) ────────────────────────────────────────────
  const startStripMove = useCallback((event, strip) => {
    if (event.button !== 0 || drawMode || !svgRef.current) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      toggleStripSel(strip.id);
      return;
    }
    // Positional strip-drag is a Draw-mode gesture (canvas behavior matrix,
    // docs/layout-redesign-plan.md step 11). In Size/Wire a strip mousedown
    // selects the strip but never starts a move.
    if (mode !== 'draw') { selectStrip(strip.id); return; }

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

    pushLayoutHistory();
    // Dragging a strip that isn't part of the current selection selects it;
    // dragging inside an existing multi-selection keeps the selection intact.
    if (!selectedStripIds.includes(strip.id)) selectStrip(strip.id);
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
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (stripDragFrameRef.current) {
        cancelAnimationFrame(stripDragFrameRef.current);
        stripDragFrameRef.current = 0;
      }
      const finalPoint = stripDragPointRef.current ?? { clientX: upEvent.clientX, clientY: upEvent.clientY };
      applyStripDragPoint(finalPoint.clientX, finalPoint.clientY, true);
      stripDragPointRef.current = null;
      stripDragRef.current = null;
      setMovingStripIds([]);
      setTimeout(() => { stripDragSuppressClickRef.current = false; }, 0);
    };

    event.currentTarget?.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [mode, drawMode, selectedStripIds, strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, toggleStripSel, selectStrip]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Per-layer artwork opacity ──────────────────────────────────────────────
  useEffect(() => {
    const bg = artworkRef.current;
    if (!bg) return;

    // Collect every layer ID that should be "active" (highlighted)
    const activeIds = new Set();
    if (hoveredLayerId) activeIds.add(hoveredLayerId);
    if (selLayerId)     activeIds.add(selLayerId);
    if (selStripId) {
      const s = strips.find(st => st.id === selStripId);
      if (s) activeIds.add(stripSourceKey(s));
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
  }, [hoveredLayerId, selection, strips, layers, artworkHTML]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Draw tool ──────────────────────────────────────────────────────────────
  const finishDraw = useCallback((pts) => {
    if (pts.length < 2) return;
    const pathData = ptsToD(pts);
    const tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tempPath.setAttribute('d', pathData);
    const svgLength = tempPath.getTotalLength ? tempPath.getTotalLength() : 0;
    // Density is the fixed physical fact of the strip: the drawn length
    // dictates the count (length(m) × density(LEDs/m)); the naming panel then
    // allows ± nudges for cut-strip fine-tuning.
    const scale = Number.isFinite(pxPerMm) && pxPerMm > 0 ? pxPerMm : 3.7795;
    const autoCount = Math.max(1, Math.round((svgLength / scale) * density / 1000));
    const defaultName = `Strip ${strips.length + 1}`;
    setPendingDraw({ pathData, svgLength });
    setPendingDrawName(defaultName);
    setPendingDrawCount(autoCount);
    setTimeout(() => pendingDrawNameRef.current?.select(), 50);
  }, [strips.length, pxPerMm, density]);

  // Single terminator for every finish affordance (double-click, Enter, the
  // Finish path button) so they all yield IDENTICAL geometry from the same
  // clicks. A double-click's own first click has already appended a waypoint
  // on top of the previous one — drop that trailing near-duplicate (within
  // ~8 screen px at the current zoom) before building the path. Returns true
  // when a path was actually finished.
  const completeDraw = useCallback((pts = waypoints) => {
    let cleaned = pts;
    if (cleaned.length >= 2) {
      const a = cleaned[cleaned.length - 2];
      const b = cleaned[cleaned.length - 1];
      let tol = 1; // SVG units — floor for exact/near-exact duplicates
      const svg = svgRef.current;
      if (svg) {
        const rect = svg.getBoundingClientRect();
        const vb = parsedVb(viewBox);
        if (rect.width > 0) tol = Math.max(tol, (vb.w / zoom / rect.width) * 8);
      }
      if (Math.hypot(b.x - a.x, b.y - a.y) <= tol) cleaned = cleaned.slice(0, -1);
    }
    if (cleaned.length < 2) return false;
    setDrawMode(false);
    setWaypoints([]);
    setGhostPt(null);
    finishDraw(cleaned);
    return true;
  }, [waypoints, viewBox, zoom, finishDraw]); // eslint-disable-line react-hooks/exhaustive-deps

  const confirmDraw = useCallback(() => {
    if (!pendingDraw) return;
    const { pathData, svgLength } = pendingDraw;
    const count = Math.max(1, pendingDrawCount);
    const name = pendingDrawName.trim() || `Strip ${strips.length + 1}`;
    const color = nextColor();
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', pathData);
    const pixels = libSamplePath(pathEl, count);
    const newStrip = {
      id: nextStripId(strips),
      // Freehand strip: no artwork source. svgLength rides along so the
      // physical Size readout and resize-recount work without re-measuring.
      sourceLayerId: null, sourcePathId: null,
      name,
      pathData, svgLength, closed: isClosedPathData(pathData), pixelCount: count, pixels, color,
      x: 0, y: 0,
      emit: 'dir', angle: 0, reversed: false,
      speed: 1.0, brightness: 1.0, hueShift: 0, patternId: null,
    };
    const newStrips = [...strips, newStrip];
    pushLayoutHistory();
    setStrips(newStrips);
    selectStrip(newStrip.id);
    setPendingDraw(null);
    scrollToStrip(newStrip.id);
  }, [pendingDraw, pendingDrawCount, pendingDrawName, strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrip]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelDraw = () => { setPendingDraw(null); };

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

      // Draw mode: Enter finishes the path (≥2 points) — same terminator as
      // double-click / the Finish path button. Never fires while the naming
      // panel's input is focused (input targets bail out above), and once the
      // panel is open drawMode is already false.
      if (drawMode && e.key === 'Enter') {
        e.preventDefault();
        if (waypoints.length >= 2) completeDraw();
        return;
      }

      if (e.key === 'Escape') {
        if (drawMode) { cancelActiveTool(); }
        else if (pendingDraw) { cancelDraw(); }
        else { clearLayoutSelection(); }
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        if (!e.shiftKey && e.key === 'z') { e.preventDefault(); doUndo(); return; }
        if ((e.shiftKey && e.key === 'z') || (!e.shiftKey && e.key === 'y')) { e.preventDefault(); doRedo(); return; }
        return;
      }

      // Arrow keys nudge the selected strip one pixel (Shift = ×10) — Draw only
      // (canvas behavior matrix, docs/layout-redesign-plan.md step 11).
      if (mode === 'draw' && selStripId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        const strip = strips.find(s => s.id === selStripId);
        if (strip) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          setStripOffset(strip.id, (strip.x || 0) + dx, (strip.y || 0) + dy, true);
          return;
        }
      }

      // Delete/Backspace is mode-specific (canvas behavior matrix, step 11):
      // Wire deletes the selected cut (or does nothing); Size does nothing;
      // Draw deletes the selected path/strip/layer.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        if (mode === 'wire') {
          if (selectedWireCut) deleteSelectedWireCut();
          return;
        }
        if (mode !== 'draw') return;   // Size: nothing to delete on canvas
        if (pathSel.length > 0) deleteSelectedVectorPaths();
        else if (selectedStripIds.length > 1) removeSelectedStrips();
        else if (selStripId) {
          // Deleting a whole-layer-backed strip deletes its source layer (and
          // with it the strip); any other strip is just removed.
          const selStrip = strips.find(s => s.id === selStripId);
          const sourceLayer = selStrip && layers.some(layer => layer.layerId === stripSourceKey(selStrip))
            ? stripSourceKey(selStrip) : null;
          if (sourceLayer) deleteLayer(sourceLayer);
          else removeStrip(selStripId);
        }
        else if (selLayerId) deleteLayer(selLayerId);
        return;
      }

      // Global shortcuts (all modes): mode switch, reset view.
      switch (e.key) {
        case '1': setMode('draw'); return;
        case '2': setMode('size'); return;
        case '3': setMode('wire'); return;
        case 'f': resetView(); return;
        default: break;
      }

      // Draw-mode-only editing shortcuts (matrix: g/m/h/a/d gated to Draw; the
      // draw-tool keys d/s only mean anything while drawing).
      if (mode !== 'draw') return;
      switch (e.key) {
        case 's': setDrawMode(false); setWaypoints([]); setGhostPt(null); break;
        case 'd': setDrawMode(m => !m); setWaypoints([]); setGhostPt(null); break;
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
  }, [mode, drawMode, waypoints, completeDraw, pendingDraw, selection, selectedWireCut, deleteSelectedWireCut, removeStrip, removeSelectedStrips, deleteSelectedVectorPaths, deleteLayer, groupSelectedStrips, mergeSelectedStrips, createLayerGroup, clearLayoutSelection, doUndo, doRedo, layers, addAllStrips, strips, setStripOffset, setHidden, cancelActiveTool, setMode]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const stripsById = new Map(strips.map(strip => [strip.id, strip]));
    const rowOrder = new Map(compiledWiring.runs.map((run, order) => [run.id, order]));
    const segmentRuns = wiring.runs.filter(run => run.type === 'strip').map(run => ({ run, order: rowOrder.get(run.id), linked: rowOrder.has(run.id) }));
    const patchCountsByStrip = segmentRuns.reduce((counts, { run }) => {
      const stripId = run.source.stripId;
      counts.set(stripId, (counts.get(stripId) || 0) + 1);
      return counts;
    }, new Map());

    const segments = [];
    segmentRuns.forEach(({ run, order, linked }) => {
      const stripId = run.source.stripId;
      if (hidden[stripId]) return;
      const strip = stripsById.get(stripId);
      if (!strip?.pixels?.length) return;
      const start = Number(run.source.from);
      const end = Number(run.source.to);
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
        id: run.id,
        patchId: run.id,
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
  }, [wiring, compiledWiring, strips, hidden]);

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
    return strips
      .filter(strip => !hidden[strip.id] && strip.pixels?.length)
      .flatMap(strip => [...new Set([
        ...wiring.runs.filter(run => run.type === 'strip' && run.source.stripId === strip.id && run.source.to < strip.pixels.length - 1).map(run => run.source.to),
        ...(selectedWireCut?.stripId === strip.id ? [selectedWireCut.cutLed] : []),
      ])]
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
  }, [wiring, strips, hidden, selectedWireCut]);

  // ── Viewport scale for adaptive sizing ─────────────────────────────────────
  const vbScale = useMemo(() => {
    const vb = parsedVb(viewBox);
    return Math.max(vb.w, vb.h) / 600;
  }, [viewBox]);

  // ── Lasso hit-test (runs on global mouseup, uses latest layers/hidden) ──────
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
      // Shift extends an existing path selection; otherwise the hits replace it
      // (path selection clears strip/layer selection in the reducer).
      const current = ev.shiftKey && selection.kind === 'path' ? selection.entries : [];
      selectPaths([...current, ...hits.filter(h => !current.some(p => p.pathId === h.pathId))]);
    }
  }, [layers, hidden, selection, selectPaths]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { lassoFinishRef.current = finishLasso; }, [finishLasso]);

  // ── Draw mode SVG events ───────────────────────────────────────────────────
  const handleSvgMouseDown = (e) => {
    e.currentTarget?.setPointerCapture?.(e.pointerId);
    if (spaceRef.current) {
      isPanningRef.current = true;
      setIsPanning(true);
      panAnchorRef.current = { clientX: e.clientX, clientY: e.clientY, panX, panY };
      e.preventDefault();
      return;
    }
    // Start rubber-band lasso when clicking on empty canvas (not on a path
    // element). Lasso is a Draw-mode gesture only (canvas behavior matrix,
    // docs/layout-redesign-plan.md step 11); Size/Wire don't rubber-band.
    if (mode === 'draw' && !drawMode && svgRef.current) {
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
          window.removeEventListener('pointermove', onWinMove);
          window.removeEventListener('pointerup', onWinUp);
          lassoFinishRef.current?.(ev);
        };
        window.addEventListener('pointermove', onWinMove);
        window.addEventListener('pointerup', onWinUp);
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
      clearLayoutSelection();
    }
  };

  const handleSvgDblClick = (e) => {
    if (!drawMode) return;
    e.preventDefault();
    // completeDraw drops the double-click's own duplicate waypoint and opens
    // the naming panel — identical geometry to Enter / the Finish button.
    if (!completeDraw()) {
      // Fewer than 2 usable points: a double-click just leaves draw mode.
      setDrawMode(false);
      setWaypoints([]);
      setGhostPt(null);
    }
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
    if (!svgRef.current) return;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextZoom = Math.max(0.15, Math.min(40, zoom * factor));
    if (nextZoom === zoom) return;

    const point = svgPt(svgRef.current, e.clientX, e.clientY);
    const vb = parsedVb(viewBox);
    const currentCenterX = vb.x + vb.w / 2 + panX;
    const currentCenterY = vb.y + vb.h / 2 + panY;
    const anchorRatio = 1 - zoom / nextZoom;

    setPanX(panX + (point.x - currentCenterX) * anchorRatio);
    setPanY(panY + (point.y - currentCenterY) * anchorRatio);
    setZoom(nextZoom);
  };

  // Ghost path for draw mode
  const ghostD = useMemo(() => {
    if (!drawMode) return null;
    const pts = ghostPt ? [...waypoints, ghostPt] : waypoints;
    if (pts.length < 1) return null;
    return ptsToD(pts.length === 1 ? [pts[0], pts[0]] : pts);
  }, [drawMode, waypoints, ghostPt]);

  // Live physical readout while drawing: path length so far + the LED count
  // it would need at the (fixed) density. Waypoints only — the ghost point is
  // deliberately excluded so the numbers update per click, not per mousemove.
  // Same length source (measured path) as finishDraw.
  const drawStats = useMemo(() => {
    if (!drawMode || waypoints.length < 1) return null;
    if (waypoints.length < 2) return { meters: 0, leds: 0 };
    const len = measurePathLen(ptsToD(waypoints));
    const scale = Number.isFinite(pxPerMm) && pxPerMm > 0 ? pxPerMm : 3.7795;
    const meters = len / scale / 1000;
    return { meters, leds: Math.max(1, Math.round(meters * density)) };
  }, [drawMode, waypoints, pxPerMm, density]);

  // ── Render-time derived preview flags ──────────────────────────────────────
  const effectiveGlowMode = isEditingGesture ? 'dots' : glowMode;
  const effectiveShowLight = showLight && !isEditingGesture && effectiveGlowMode !== 'dots';
  const glowStdDev = effectiveGlowMode === 'outward' ? 2.8 : effectiveGlowMode === 'inward' ? 0.8 : 1.6;

  return {
    // mode
    mode, setMode, cancelActiveTool,
    // preview
    showLight, setShowLight,
    showLeds, setShowLeds,
    glowMode, setGlowMode,
    directedGlow, setDirectedGlow,
    showHeat, setShowHeat,
    lightMenuOpen, setLightMenuOpen,
    enableLightPreview,
    effectiveGlowMode, effectiveShowLight, glowStdDev,
    // draw
    drawMode, setDrawMode,
    waypoints, setWaypoints,
    ghostPt, setGhostPt,
    pendingDraw, setPendingDraw,
    pendingDrawName, setPendingDrawName,
    pendingDrawCount, setPendingDrawCount,
    pendingDrawNameRef,
    finishDraw, confirmDraw, cancelDraw, completeDraw,
    drawStats, ghostD,
    selectedPathDecorations,
    // pan/zoom
    zoom, setZoom,
    panX, panY,
    isPanning,
    spaceRef,
    resetView,
    computedViewBox, vbScale,
    // lasso
    rubberBand,
    // hover / cursor
    cursorSvgPt,
    hoveredLayerId, setHoveredLayerId,
    hoveredSubPathId, setHoveredSubPathId,
    // strip move
    startStripMove,
    movingStripIds,
    stripDragSuppressClickRef,
    // svg handlers
    handleSvgMouseDown,
    handleSvgClick,
    handleSvgDblClick,
    handleSvgMouseMove,
    handleSvgMouseUp,
    handleSvgMouseLeave,
    handleContextMenu,
    handleWheel,
    // viz
    isEditingGesture,
    layoutPatternFrame,
    stripSamples,
    stripArrows,
    visibleWirePathCanvasSegments,
    wireRouteJumps,
    wireCutMarkers,
  };
}
