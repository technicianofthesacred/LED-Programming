import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { samplePath as libSamplePath } from '../lib/mapper.js';
import { useProject } from '../state/ProjectContext.jsx';
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
import { shouldRebuildStripPixels } from '../lib/stripPixels.js';
import {
  LED_COUNT_MAX,
  LED_COUNT_SLIDER_MAX,
  LED_COUNT_SLIDER_MIN,
  ledCountToSliderValue,
  sliderValueToLedCount,
} from '../lib/controlScale.js';
import { PatchBoardScreen } from './PatchBoardScreen.jsx';
import {
  applyPatchRouteOrder,
  cutsForStrip,
  deleteStripCut,
  mainChain,
  moveStripRowsInChain,
  nudgeStripCut,
  normalizePatchBoard,
  orderedStripIdsFromChain,
  sliceStripIntoPatchesPreservingRoute,
} from '../lib/patchBoard.js';
import { isDefaultCircleLayout } from '../lib/defaultCircleLayout.js';
import {
  STRIP_COLORS,
  DENSITY_OPTIONS,
  GLOW_MODES,
  stripSourceKey,
  nextStripId,
  clampLedCount,
  recountStrips,
  rgbCss,
  measureLayers,
  getPxPerMm,
  sampleStripPixels,
  svgPathLength,
  translateStripFromStart,
  translatePathData,
  pathIntersectsRect,
  offsetPixels,
  offsetSamplePoints,
  offsetArrow,
  pointsAttr,
  escapeAttr,
  layerArtworkMarkup,
  actionablePolylinePoints,
  calcArrow,
  sampleForViz,
  ptsToD,
  svgPt,
  parsedVb,
} from '../lib/layoutGeometry.js';
import {
  EyeIcon,
  EyeOffIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  DragHandleIcon,
  GroupIcon,
  TbIcon,
  EmitCompass,
  InlineRename,
  LightCone,
  OmniHalo,
} from './layout/shared/InspectorPrimitives.jsx';

// Stable empty stand-ins so the derived selection views keep referential
// identity across renders when the selection is a different kind.
const NO_IDS = [];
const NO_ENTRIES = [];

function startedFromDragHandle(e) {
  return !!e.target?.closest?.('[data-drag-handle="true"]');
}

function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  a.click();
}

const SCALE_BASE_PX_PER_MM = 3.7795;            // 96 DPI, the current default
const SCALE_OPTIONS = [
  { label: 'S',  mult: 0.5 },
  { label: 'M',  mult: 1 },
  { label: 'L',  mult: 2 },
  { label: 'XL', mult: 4 },
];
const LED_COUNT_PRESETS = [30, 43, 60, 100, 150, 300, 600, 1000, 1500, 3000];

// ── Main component ─────────────────────────────────────────────────────────

export function LayoutScreen() {
  const project = useProject();
  // Mockup .la uses a fixed 320px side panel (no resize handle).
  // Persisted+undoable layout state now lives in the reducer behind context;
  // this component READS it directly (no local mirror copies).
  const [scaleUnit, setScaleUnit]   = useState('cm'); // 'cm' | 'in' — display unit for the artwork Size control
  const [showLight, setShowLight]   = useState(false);
  const [showLeds, setShowLeds]     = useState(true);
  const [glowMode, setGlowMode]     = useState('dots');
  const [directedGlow, setDirectedGlow] = useState(false);
  const [showHeat, setShowHeat]     = useState(false);
  const [error, setError]           = useState(null);

  // Layer panel state (selection itself lives in the reducer — see the derived
  // selection views right after the `project` destructure below)
  const [expandedLayers, setExpandedLayers] = useState({});

  // v3 layout-screen live-only UI state
  const [lightMenuOpen, setLightMenuOpen] = useState(false);   // Light disclosure popover
  const [expandedStrips, setExpandedStrips] = useState({});     // per-strip detail expander

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
  // Initialised empty and synced from the reducer state via effects below
  // (declared before the `project` destructure, so they can't read it here).
  const stripsRef         = useRef([]);
  const pxPerMmRef = useRef(3.7795);
  const [movingStripIds, setMovingStripIds] = useState([]);

  // Drag-and-drop
  const [dragOver, setDragOver] = useState(false);

  // Canvas cursor position overlay
  const [cursorSvgPt, setCursorSvgPt] = useState(null);

  // Layer-list drag state (ephemeral view state — stays local)
  const [layerDragging, setLayerDragging] = useState(null);
  const [layerDragOver, setLayerDragOver] = useState(null);
  const [stripGroupDragOver, setStripGroupDragOver] = useState(null);

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
    // Persisted+undoable layout state, read straight from the reducer. Local
    // aliases match the names the rest of this component already uses, and the
    // setters are the context's history-aware compat dispatchers.
    strips,             setStrips,
    viewBox,            setViewBox,
    svgText,            setSvgText,
    hidden,             setHidden,
    layoutLayers:       layers,
    setLayoutLayers:    setLayers,
    layoutDensity:      density,
    setLayoutDensity:   setDensity,
    layoutPxPerMm:      pxPerMm,
    setLayoutPxPerMm:   setPxPerMm,
    layoutEditCounts:   editCounts,
    setLayoutEditCounts: setEditCounts,
    layoutLayerGroups:  layerGroups,
    setLayoutLayerGroups: setLayerGroups,
    layoutLayerOrder:   layerOrder,
    setLayoutLayerOrder: setLayerOrder,
    projectRevision,
    patchBoard,
    setPatchBoard,
    updatePatchBoard,
    pushLayoutHistory,
    undoLayout,
    redoLayout,
    layoutHistLen,
    layoutFutLen,
    // Selection — the single reducer-owned selection object + its dispatchers
    selection,
    selectStrip,
    selectStrips,
    toggleStripSel,
    selectLayer,
    selectPaths,
    togglePathSel,
    clearLayoutSelection,
    renameLayoutSelection,
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

  // Keep the drag/geometry refs in sync with the reducer-owned state (these are
  // read synchronously inside pointer handlers, so they must not lag a render).
  useEffect(() => { stripsRef.current = strips; }, [strips]);
  useEffect(() => { pxPerMmRef.current = pxPerMm; }, [pxPerMm]);

  // ── Selection: derived views over the reducer's single selection object ────
  // selection = { kind: 'none'|'strip'|'layer'|'path', ids, entries, name }.
  // These consts keep the old local names so the JSX below reads unchanged.
  const selectedStripIds = selection.kind === 'strip' ? selection.ids : NO_IDS;
  const selStripId = selection.kind === 'strip' && selection.ids.length === 1 ? selection.ids[0] : null;
  const pathSel = selection.kind === 'path' ? selection.entries : NO_ENTRIES;
  const pathSelName = selection.kind === 'path' ? selection.name : '';
  const stripSelectionName = selection.kind === 'strip' ? selection.name : '';
  // Selecting a strip also "selects" its source layer for the inspector and
  // artwork highlight (parity with the old selectStrip, which set selLayerId).
  const selectedStrip = selStripId ? strips.find(s => s.id === selStripId) : null;
  const selLayerId = selection.kind === 'layer'
    ? (selection.ids[0] ?? null)
    : (selectedStrip ? stripSourceKey(selectedStrip) : null);

  // Prune the strip selection when selected strips disappear through any
  // mutation path (strip/layer/path deletes, loads). Toggling a missing id
  // removes exactly that id; an emptied selection collapses to 'none'.
  useEffect(() => {
    if (selection.kind !== 'strip') return;
    const missing = selection.ids.filter(id => !strips.some(s => s.id === id));
    missing.forEach(id => toggleStripSel(id));
  }, [strips, selection, toggleStripSel]);

  // ── Wire order comes from the patch-board chain ────────────────────────────
  // The strips[] array is an unordered entity store; the chain (rowIds) is the
  // single wire-order truth the list, exports and firmware all share.
  const orderedStrips = useMemo(() => {
    const byId = new Map(strips.map(s => [s.id, s]));
    return orderedStripIdsFromChain(patchBoard, strips).map(id => byId.get(id)).filter(Boolean);
  }, [patchBoard, strips]);

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

  // ── Restore strips from saved data ────────────────────────────────────────
  // Undo history + autosave are owned by ProjectContext now. This component
  // calls `pushLayoutHistory()` before a mutation and `undoLayout/redoLayout`
  // for undo; autosave runs off the reducer state via serializeProject.

  const rebuildStrip = (stripData) => {
    return {
      ...stripData,
      pixels: sampleStripPixels(stripData.pathData, stripData.pixelCount, stripData.reversed, stripData.x || 0, stripData.y || 0),
    };
  };

  // Loading a project resets only EPHEMERAL view state — the persisted layout
  // data now lives in the reducer and is already replaced by `applyProject`.
  useEffect(() => {
    // Selection was already reset by the project load (layout/reset clears it);
    // only the ephemeral view state needs resetting here.
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
      return;
    }
    const newLayers = parsed.map(l => ({ ...l, _color: nextColor(), _emit: 'dir', _angle: 0 }));
    const newLayerOrder = parsed.map(l => ({ type: 'layer', id: l.layerId }));
    pushLayoutHistory();
    setViewBox(vb);
    setPxPerMm(newPxPerMm);
    setSvgText(text);
    setLayers(newLayers);
    setStrips([]);
    setPatchBoard(normalizePatchBoard(null, []));
    setEditCounts({});
    setHidden({});
    setLayerGroups([]);
    setLayerOrder(newLayerOrder);
    clearLayoutSelection();
    setDrawMode(false);
    setWaypoints([]);
    resetView();
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, setPatchBoard, clearLayoutSelection]);

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

  const makeStrip = (layer, count, id) => {
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', layer.pathData);
    const pixels = libSamplePath(pathEl, count);
    return {
      id, name: layer.name,
      sourceLayerId: layer.layerId, sourcePathId: null,
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
    pathId: stripSourceKey(s),
    layerId: stripSourceKey(s),
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
    pushLayoutHistory();
    setLayerGroups(prev => [...prev, newGroup]);
    setLayerOrder(prev => [{ type: 'group', id: groupId }, ...prev]);
    selectPaths(unique);
  }, [layerGroups.length, strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectPaths]);

  const addPathsToGroup = useCallback((groupId, entries) => {
    const group = layerGroups.find(g => g.groupId === groupId);
    if (!group || group.type === 'strip') return;
    const incoming = entries.filter(entry => entry?.pathId && entry?.pathData);
    if (!incoming.length) return;
    pushLayoutHistory();
    setLayerGroups(prev => prev.map(g => {
      if (g.groupId !== groupId) return g;
      const existingIds = new Set(g.members.map(m => m.pathId));
      const nextMembers = [...g.members];
      incoming.forEach(entry => {
        if (!existingIds.has(entry.pathId)) nextMembers.push({ ...entry });
      });
      return { ...g, _expanded: true, members: nextMembers };
    }));
    selectPaths(incoming);
  }, [layerGroups, strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectPaths]);

  const togglePathSelection = useCallback((entry, additive = false) => {
    // Path selection replaces any strip/layer selection (single selection kind).
    if (additive) togglePathSel(entry);
    else selectPaths([entry]);
  }, [togglePathSel, selectPaths]);

  // Drag a strip row onto another to change the physical wire order. Only the
  // patch-board chain moves — the strips[] array order is never touched by
  // reordering. moveStripRowsInChain moves each dragged strip's patches as one
  // contiguous block (splits preserved, off rows pinned to their slots). One
  // gesture = one undo entry (updatePatchBoard pushes history exactly once).
  const reorderStripRows = useCallback((draggedIds, targetId) => {
    const ids = (draggedIds || []).filter(Boolean);
    if (!ids.length || ids.includes(targetId)) return;
    updatePatchBoard(board => {
      // moveStripRowsInChain returns a normalized copy; write its result back
      // onto the mutable board `updatePatchBoard` hands us.
      const moved = moveStripRowsInChain(board, ids, targetId);
      board.patches = moved.patches;
      board.chains = moved.chains;
      board.groups = moved.groups;
      board.physicalLocked = moved.physicalLocked;
    });
  }, [updatePatchBoard]);

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

    pushLayoutHistory();
    setLayerGroups(prev => [
      ...prev
        .map(g => ({ ...g, members: g.members.filter(m => !pickedIds.has(m.stripId || m.pathId)) }))
        .filter(g => g.members.length > 0),
      newGroup,
    ]);
    setLayerOrder(prev => [{ type: 'group', id: groupId }, ...prev.filter(item => item.id !== groupId && !emptiedGroupIds.has(item.id))]);
    selectStrips(picked.map(s => s.id));
  }, [strips, layerGroups, stripSelectionName, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrips]);

  const addStripsToGroup = useCallback((groupId, stripIds) => {
    const group = layerGroups.find(g => g.groupId === groupId);
    if (!group || group.type !== 'strip') return;
    const ids = [...new Set(stripIds)].filter(Boolean);
    const picked = strips.filter(s => ids.includes(s.id));
    if (!picked.length) return;
    const pickedIds = new Set(picked.map(s => s.id));

    pushLayoutHistory();
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
    selectStrips(picked.map(s => s.id));
  }, [layerGroups, strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrips]);

  const addStrip = () => {
    if (!selLayer) return;
    // Re-sampling an existing whole-layer strip keeps its id (so patches, wiring
    // and selection survive the update); a brand-new strip gets a fresh id.
    const existing = strips.find(s => stripSourceKey(s) === selLayer.layerId);
    const id = existing ? existing.id : nextStripId(strips);
    const newStrip = makeStrip(selLayer, getLedCount(selLayer), id);
    const newStrips = [...strips.filter(s => s.id !== id), newStrip];
    pushLayoutHistory();
    setStrips(newStrips);
    selectStrip(newStrip.id);
    scrollToStrip(newStrip.id);
  };

  const addSubPathStrip = (sp, layer) => {
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', sp.pathData);
    const count = Math.max(1, Math.round((sp.svgLength / pxPerMm) * density / 1000));
    const pixels = libSamplePath(pathEl, count);
    const existing = strips.find(s => stripSourceKey(s) === sp.pathId);
    const id = existing ? existing.id : nextStripId(strips);
    const newStrip = {
      id,
      sourceLayerId: layer.layerId,
      sourcePathId: sp.pathId,
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
    const newStrips = [...strips.filter(s => s.id !== id), newStrip];
    pushLayoutHistory();
    setStrips(newStrips);
    selectStrip(newStrip.id);
    scrollToStrip(newStrip.id);
  };

  const addSelectedPathsAsStrips = useCallback((mode = 'merged') => {
    if (!pathSel.length) return;

    if (mode === 'merged') {
      const combinedPathData = pathSel.map(p => p.pathData).join(' ');
      const totalLen = pathSel.reduce((s, p) => s + p.svgLength, 0);
      const count = Math.max(1, Math.round((totalLen / pxPerMm) * density / 1000));
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', combinedPathData);
      const pixels = libSamplePath(pathEl, count);
      const name = pathSelName.trim() || `Strip ${strips.length + 1}`;
      const newStrip = {
        id: nextStripId(strips), name,
        // Merged from several paths: no single artwork source.
        sourceLayerId: null, sourcePathId: null,
        pathData: combinedPathData, pixelCount: count, pixels,
        x: 0, y: 0,
        color: nextColor(), emit: 'dir', angle: 0, reversed: false,
        speed: 1.0, brightness: 1.0, hueShift: 0, patternId: null,
      };
      const newStrips = [...strips, newStrip];
      pushLayoutHistory();
      setStrips(newStrips);
      selectStrip(newStrip.id);
      scrollToStrip(newStrip.id);
      return;
    }

    let running = strips;
    const created = pathSel.map((p) => {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', p.pathData);
      const count = Math.max(1, Math.round((p.svgLength / pxPerMm) * density / 1000));
      const pixels = libSamplePath(pathEl, count);
      const layerColor = layers.find(l => l.layerId === p.layerId)?._color;
      const strip = {
        id: nextStripId(running),
        sourceLayerId: p.layerId ?? null,
        sourcePathId: p.pathId ?? null,
        name: p.name,
        pathData: p.pathData,
        pixelCount: count,
        pixels,
        x: 0, y: 0,
        color: layerColor || nextColor(),
        emit: 'dir', angle: 0, reversed: false,
        speed: 1.0, brightness: 1.0, hueShift: 0, patternId: null,
      };
      running = [...running, strip];
      return strip;
    });
    const newStrips = [...strips, ...created];
    pushLayoutHistory();
    setStrips(newStrips);
    selectStrips(created.map(s => s.id));

    if (mode === 'grouped' && created.length > 1) {
      const groupId = `strip-grp-${Date.now()}`;
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

    scrollToStrip(created[0]?.id);
  }, [pathSel, pathSelName, strips, layers, editCounts, hidden, svgText, viewBox, density, pxPerMm, layerGroups.length, pushLayoutHistory, selectStrip, selectStrips]);

  const addAllStrips = useCallback(() => {
    if (strips.length > 0 &&
        typeof window !== 'undefined' &&
        !window.confirm(`Replace all ${strips.length} drawn strip(s) with auto-generated strips from every layer? This cannot be undone except via Undo.`)) {
      return;
    }
    const newStrips = [];
    for (const l of layers.filter(l => l.pathData)) {
      newStrips.push(makeStrip(l, getLedCount(l), nextStripId(newStrips)));
    }
    pushLayoutHistory();
    setStrips(newStrips);
    if (newStrips.length > 0) selectStrip(newStrips[0].id);
    scrollToStrip(newStrips[0]?.id);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrip]);

  const removeStrip = useCallback((id) => {
    const newStrips = strips.filter(s => s.id !== id);
    const newEditCounts = { ...editCounts };
    delete newEditCounts[id];
    // Drop the strip's own hidden flag so a reused strip-<n> id can't inherit a
    // stale "hidden" state.
    const newHidden = { ...hidden };
    delete newHidden[id];
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => (m.stripId || m.pathId) === id))
      .map(g => g.groupId));
    pushLayoutHistory();
    setStrips(newStrips);
    setLayerGroups(prev => prev
      .map(g => ({ ...g, members: g.members.filter(m => (m.stripId || m.pathId) !== id) }))
      .filter(g => g.members.length > 0));
    setLayerOrder(prev => prev.filter(item => !emptiedGroupIds.has(item.id)));
    setEditCounts(newEditCounts);
    setHidden(newHidden);
    // Selection pruning happens in the strips-change effect above.
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, layerGroups, pushLayoutHistory]);

  const reverseStrip = (id) => {
    const newStrips = strips.map(s => {
      if (s.id !== id) return s;
      const reversed = !s.reversed;
      const pixels = s.pixels.slice().reverse();
      return { ...s, reversed, pixels };
    });
    pushLayoutHistory();
    setStrips(newStrips);
  };

  // selectLayer / selectStrip / toggleStripSel come straight from the context
  // (reducer dispatchers) — selecting one kind clears the others in the reducer.

  const startStripMove = useCallback((event, strip) => {
    if (event.button !== 0 || drawMode || !svgRef.current) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      toggleStripSel(strip.id);
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
      setTimeout(() => { stripDragSuppressClickRef.current = false; }, 0);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [drawMode, selectedStripIds, strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, toggleStripSel, selectStrip]);

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
    pushLayoutHistory();
    const nextLayers = layers.filter(l => l.layerId !== layerId);
    const removedStrips = strips.filter(s => relatedPathIds.has(stripSourceKey(s)));
    const removedStripIds = new Set(removedStrips.map(s => s.id));
    const nextStrips = strips.filter(s => !removedStripIds.has(s.id));
    const nextEditCounts = { ...editCounts };
    const nextHidden = { ...hidden };
    relatedPathIds.forEach(id => {
      delete nextEditCounts[id];
      delete nextHidden[id];
    });
    // Drop the deleted strips' own hidden flags so a reused strip-<n> id can't
    // inherit a stale "hidden" state.
    removedStripIds.forEach(id => { delete nextHidden[id]; });
    setLayers(nextLayers);
    setLayerOrder(prev => prev.filter(x => x.id !== layerId));
    setLayerGroups(prev => prev.map(g => ({ ...g, members: g.members.filter(m => m.layerId !== layerId) }))
                               .filter(g => g.members.length > 0));
    setStrips(nextStrips);
    setEditCounts(nextEditCounts);
    setHidden(nextHidden);
    // Removed strips are pruned from the selection by the strips-change effect;
    // an explicitly selected (deleted) layer clears here.
    if (selection.kind === 'layer' && selection.ids.includes(layerId)) clearLayoutSelection();
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, selection, clearLayoutSelection, pushLayoutHistory]);

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
    const removedStrips = strips.filter(strip =>
      removedIds.has(stripSourceKey(strip)) ||
      selectedPathData.has(strip.pathData));
    const removedStripIds = new Set(removedStrips.map(s => s.id));
    const nextStrips = strips.filter(strip => !removedStripIds.has(strip.id));
    const nextEditCounts = { ...editCounts };
    const nextHidden = { ...hidden };
    removedIds.forEach(id => {
      delete nextEditCounts[id];
      delete nextHidden[id];
    });
    // Drop the deleted strips' own hidden flags so a reused strip-<n> id can't
    // inherit a stale "hidden" state.
    removedStripIds.forEach(id => { delete nextHidden[id]; });

    const nextLayerGroups = layerGroups
      .map(group => ({
        ...group,
        members: group.members.filter(member =>
          // member.pathId carries the strip's source key (or a path id for path
          // members), so this prunes both eras identically as the artwork is cut.
          !removedIds.has(member.pathId) &&
          !deletedLayerIds.has(member.layerId)),
      }))
      .filter(group => group.members.length > 0);
    const liveGroupIds = new Set(nextLayerGroups.map(group => group.groupId));
    const liveLayerIds = new Set(nextLayers.map(layer => layer.layerId));
    const nextLayerOrder = layerOrder.filter(item =>
      item.type === 'group'
        ? liveGroupIds.has(item.id)
        : liveLayerIds.has(item.id));

    pushLayoutHistory();
    setLayers(nextLayers);
    setStrips(nextStrips);
    setEditCounts(nextEditCounts);
    setHidden(nextHidden);
    setLayerGroups(nextLayerGroups);
    setLayerOrder(nextLayerOrder);
    // The current selection is the just-deleted paths — clear it.
    clearLayoutSelection();
  }, [pathSel, layers, strips, editCounts, hidden, svgText, viewBox, density, layerGroups, layerOrder, clearLayoutSelection, pushLayoutHistory]);

  // ── Duplicate strip ────────────────────────────────────────────────────────

  const duplicateStrip = useCallback((id) => {
    const s = strips.find(st => st.id === id);
    if (!s) return;
    const newId = nextStripId(strips);
    // A duplicate is a free copy: it does not own the original's artwork source,
    // so it never counts as the whole-layer strip for that layer.
    const newStrip = {
      ...s, id: newId, name: `${s.name} copy`,
      sourceLayerId: null, sourcePathId: null,
      pixels: s.pixels.slice(),
    };
    const newStrips = strips.flatMap(st => st.id === id ? [st, newStrip] : [st]);
    pushLayoutHistory();
    setStrips(newStrips);
    selectStrip(newId);
    scrollToStrip(newId);
  }, [strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrip]);

  // ── Layer group management ─────────────────────────────────────────────────

  const createLayerGroup = useCallback(() => {
    createLayerGroupFromEntries(pathSel);
    clearLayoutSelection();
  }, [pathSel, createLayerGroupFromEntries, clearLayoutSelection]);

  const groupSelectedStrips = useCallback(() => {
    createStripGroupFromIds(selectedStripIds);
  }, [selectedStripIds, createStripGroupFromIds]);

  const mergeSelectedStrips = useCallback(() => {
    const selected = new Set(selectedStripIds);
    // Merge in displayed wire (chain) order — the list order the user sees.
    const picked = orderedStrips.filter(s => selected.has(s.id));
    if (picked.length < 2) return;

    const first = picked[0];
    const pickedIds = new Set(picked.map(s => s.id));
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => pickedIds.has(m.stripId || m.pathId)))
      .map(g => g.groupId));
    const mergedId = nextStripId(strips);
    const mergedName = stripSelectionName.trim() || `Merged Strip ${strips.length - picked.length + 1}`;
    const pixels = picked.flatMap(s => s.pixels?.length ? s.pixels : []);
    const mergedStrip = {
      ...first,
      id: mergedId,
      // Merged from several strips: no single artwork source.
      sourceLayerId: null, sourcePathId: null,
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

    pushLayoutHistory();
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
    selectStrip(mergedId);
    scrollToStrip(mergedId);
  }, [selectedStripIds, strips, orderedStrips, stripSelectionName, layerGroups, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrip]);

  const removeSelectedStrips = useCallback(() => {
    const selected = new Set(selectedStripIds);
    if (selected.size < 2) return;
    const newStrips = strips.filter(s => !selected.has(s.id));
    const emptiedGroupIds = new Set(layerGroups
      .filter(g => g.members.length > 0 && g.members.every(m => selected.has(m.stripId || m.pathId)))
      .map(g => g.groupId));
    pushLayoutHistory();
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
    clearLayoutSelection();
  }, [selectedStripIds, strips, layers, editCounts, hidden, svgText, viewBox, density, layerGroups, pushLayoutHistory, clearLayoutSelection]);

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
    setStrips(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
  }, [setStrips]);

  const updateStripWithHistory = useCallback((id, patch) => {
    pushLayoutHistory();
    setStrips(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
  }, [setStrips, pushLayoutHistory]);

  const setStripOffset = useCallback((id, nextX, nextY, withHistory = false) => {
    if (withHistory) pushLayoutHistory();
    setStrips(prev => prev.map(s => {
      if (s.id !== id) return s;
      return {
        ...s,
        x: nextX,
        y: nextY,
        pixels: sampleStripPixels(s.pathData, s.pixelCount, s.reversed, nextX, nextY),
      };
    }));
  }, [setStrips, pushLayoutHistory]);

  // `updatePatchBoard` is provided by ProjectContext (it snapshots history first,
  // so patch-board edits are undoable). No local definition — pulled from context.

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
    selectStrip(strip.id);
    setSelectedWireCut({ stripId: strip.id, cutLed });
    setSelectedWirePatchId(null);
  }, [nearestLedIndex, project.patchBoard, strips, updatePatchBoard, selectStrip]);

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
    setStrips(prev => prev.map(s => s.id === id ? rebuildStrip({ ...s, pixelCount: newCount }) : s));
  }, [setStrips]);

  const handleDensityChange = useCallback((newDensity) => {
    pushLayoutHistory();
    setStrips(prev => recountStrips(prev, pxPerMm, newDensity));
    setEditCounts({});
    setDensity(newDensity);
  }, [pxPerMm, setStrips, setEditCounts, setDensity, pushLayoutHistory]);

  const handleScaleChange = useCallback((nextPxPerMm) => {
    pushLayoutHistory();
    setStrips(prev => recountStrips(prev, nextPxPerMm, density));
    setEditCounts({});
    setPxPerMm(nextPxPerMm);
  }, [density, setStrips, setEditCounts, setPxPerMm, pushLayoutHistory]);

  const calibrateScaleFromStrip = useCallback((stripId, realCount) => {
    const strip = strips.find(s => s.id === stripId);
    if (!strip) return;
    const len = (Number.isFinite(strip.svgLength) && strip.svgLength > 0)
      ? strip.svgLength : svgPathLength(strip.pathData);
    const count = Math.max(1, Math.round(Number(realCount)));
    if (!len || !Number.isFinite(count)) return;
    const nextPxPerMm = (len * density) / (count * 1000);
    if (!Number.isFinite(nextPxPerMm) || nextPxPerMm <= 0) return;
    pushLayoutHistory();
    setStrips(prev => recountStrips(prev, nextPxPerMm, density));
    setPxPerMm(nextPxPerMm);
    setEditCounts({});
  }, [strips, density, setStrips, setPxPerMm, setEditCounts, pushLayoutHistory]);

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
      id: nextStripId(strips),
      // Freehand strip: no artwork source.
      sourceLayerId: null, sourcePathId: null,
      name,
      pathData, pixelCount: count, pixels, color,
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
  }, [pendingDraw, pendingDrawCount, pendingDrawName, strips, layers, editCounts, hidden, svgText, viewBox, density, pushLayoutHistory, selectStrip]);

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
  }, [hoveredLayerId, selection, strips, layers, artworkHTML]);

  // (pathSelName auto-fill now lives in the reducer: SELECT_PATHS/TOGGLE_PATH
  // name a single-path selection after the path and blank multi-selections.)

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
  // Owned by ProjectContext's single snapshot stack (strip + patch-board edits
  // share it). These thin wrappers keep the existing call sites/keyboard code.

  const doUndo = undoLayout;
  const doRedo = redoLayout;

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
        else { clearLayoutSelection(); }
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        if (!e.shiftKey && e.key === 'z') { e.preventDefault(); doUndo(); return; }
        if ((e.shiftKey && e.key === 'z') || (!e.shiftKey && e.key === 'y')) { e.preventDefault(); doRedo(); return; }
        return;
      }

      // Arrow keys nudge the selected strip one pixel (Shift = ×10)
      if (selStripId && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
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

      // Single-key shortcuts
      switch (e.key) {
        case 's': setDrawMode(false); setWaypoints([]); setGhostPt(null); break;
        case 'd': setDrawMode(m => !m); setWaypoints([]); setGhostPt(null); break;
        case 'Backspace':
        case 'Delete':
          e.preventDefault();
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
  }, [drawMode, pendingDraw, selection, removeStrip, removeSelectedStrips, deleteSelectedVectorPaths, deleteLayer, groupSelectedStrips, mergeSelectedStrips, createLayerGroup, clearLayoutSelection, doUndo, doRedo, layers, addAllStrips, strips, setStripOffset, setHidden]);

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
  const defaultCircleLayoutActive = !svgText && layers.length === 0 && isDefaultCircleLayout(strips);
  const selectedStrips = useMemo(() => {
    const selected = new Set(selectedStripIds);
    return orderedStrips.filter(s => selected.has(s.id));
  }, [orderedStrips, selectedStripIds]);

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
      // Shift extends an existing path selection; otherwise the hits replace it
      // (path selection clears strip/layer selection in the reducer).
      const current = ev.shiftKey && selection.kind === 'path' ? selection.entries : [];
      selectPaths([...current, ...hits.filter(h => !current.some(p => p.pathId === h.pathId))]);
    }
  }, [layers, hidden, selection, selectPaths]);
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
      clearLayoutSelection();
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

  const existingStrip = selLayer ? strips.find(s => stripSourceKey(s) === selLayer.layerId) : null;

  const enableLightPreview = useCallback(() => {
    setShowLight(true);
    setGlowMode(mode => mode === 'dots' ? 'center' : mode);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  const effectiveGlowMode = isEditingGesture ? 'dots' : glowMode;
  const effectiveShowLight = showLight && !isEditingGesture && effectiveGlowMode !== 'dots';
  const glowStdDev = effectiveGlowMode === 'outward' ? 2.8 : effectiveGlowMode === 'inward' ? 0.8 : 1.6;

  return (
    <div className="screen">
      <div className="la">

      {/* ── Hidden file inputs ─────────────────────────────────────── */}
      <input ref={fileRef} type="file" accept=".svg"  style={{ display: 'none' }} onChange={handleFile}/>
      <input ref={loadRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoad}/>

      {/* ── Toolbar (mockup .toolbar) ──────────────────────────────── */}
        <div className="toolbar">
          <button className="tb-btn solid" onClick={() => fileRef.current?.click()}
                  title="Import an SVG to map LED strips">
            {TbIcon.import}Import SVG
          </button>

          {layers.length > 0 && (
            <button className="tb-btn" onClick={addAllStrips}
                    title={`Add all ${layers.length} layers as strips (A)`}>
              + All ({layers.length})
            </button>
          )}

          <div className="tb-div"/>

          {/* Draw / Chop / Link tools */}
          <button
            className={`tb-btn${drawMode ? ' active' : ''}`}
            title="Draw a new LED strip path on the artwork."
            onClick={() => { setDrawMode(m => !m); setWireOverlayMode('idle'); setWaypoints([]); setGhostPt(null); }}>
            {TbIcon.draw}{drawMode ? 'Drawing…' : 'Draw'}
          </button>
          <button
            className={`tb-btn${wireOverlayMode === 'chop' ? ' active' : ''}`}
            title="Split one physical strip where the wire jumps to a new spot."
            onClick={() => {
              setDrawMode(false);
              setWaypoints([]);
              setGhostPt(null);
              setWireOverlayMode(mode => mode === 'chop' ? 'idle' : 'chop');
            }}>
            Split
          </button>
          <button
            className={`tb-btn${wireOverlayMode === 'link' ? ' active' : ''}`}
            title="Join two strips into one continuous run."
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

          {/* Undo / Redo */}
          <button className="tb-btn icon" onClick={doUndo} disabled={layoutHistLen === 0}
                  title={`Undo (⌘Z) · ${layoutHistLen} step${layoutHistLen !== 1 ? 's' : ''}`}>
            {TbIcon.undo}{layoutHistLen > 0 && <span className="cnt">{layoutHistLen}</span>}
          </button>
          <button className="tb-btn icon" onClick={doRedo} disabled={layoutFutLen === 0}
                  title={`Redo (⌘⇧Z) · ${layoutFutLen} step${layoutFutLen !== 1 ? 's' : ''}`}>
            {TbIcon.redo}{layoutFutLen > 0 && <span className="cnt">{layoutFutLen}</span>}
          </button>

          <div className="tb-div"/>

          {/* Density segmented control */}
          <div className="seg">
            <span className="seg-label" title="LEDs per metre — count = size × density.">Density</span>
            {DENSITY_OPTIONS.map(d => (
              <button key={d} className={density === d ? 'on' : ''}
                      onClick={() => handleDensityChange(d)}>{d}</button>
            ))}
          </div>

          <div className="tb-div"/>
          {/* Size — the loaded artwork's real-world dimensions. Type a width to
              rescale everything; LED counts follow size × density. */}
          {(() => {
            const vb = parsedVb(viewBox);
            const per = scaleUnit === 'in' ? 25.4 : 10;      // mm per display unit
            const wDisp = (vb.w / pxPerMm) / per;
            const hDisp = (vb.h / pxPerMm) / per;
            const applyWidth = (raw) => {
              const val = parseFloat(raw);
              if (!(val > 0)) return;
              handleScaleChange(vb.w / (val * per));          // pxPerMm = svgWidth / targetWidthMm
            };
            return (
              <div className="seg" title="Real-world size of the loaded artwork. Type a width to scale it — LED counts follow size × density.">
                <span className="seg-label">Size</span>
                <input type="number" min="0.1" step="0.1" inputMode="decimal"
                       key={`sz-${scaleUnit}-${wDisp.toFixed(2)}`}
                       defaultValue={wDisp.toFixed(1)}
                       aria-label={`Artwork width in ${scaleUnit}`}
                       style={{ width: 64, height: 24, textAlign: 'right', fontVariantNumeric: 'tabular-nums', background: 'var(--bg-app)',
                                border: '1px solid var(--border-soft)', borderRadius: 4, color: 'var(--text-hi)',
                                fontFamily: 'var(--font-mono)', fontSize: 12, padding: '0 6px' }}
                       onFocus={e => e.target.select()}
                       onBlur={e => applyWidth(e.target.value)}
                       onKeyDown={e => { if (e.key === 'Enter') { applyWidth(e.target.value); e.target.blur(); } }}/>
                <span style={{ color: 'var(--text-faint)', fontSize: 12, whiteSpace: 'nowrap' }}>× {hDisp.toFixed(1)}</span>
                <button title="Toggle centimetres / inches"
                        onClick={() => setScaleUnit(u => (u === 'cm' ? 'in' : 'cm'))}>{scaleUnit}</button>
              </div>
            );
          })()}

          <div className="tb-spring"/>

          {/* Zoom cluster */}
          <div className="la-zoom">
            <button onClick={() => setZoom(z => Math.max(0.15, z / 1.25))} title="Zoom out (-)">−</button>
            <button className="zv" onClick={resetView} title="Reset view (F)">{Math.round(zoom * 100)}%</button>
            <button onClick={() => setZoom(z => Math.min(40, z * 1.25))} title="Zoom in (+)">+</button>
          </div>

          <div className="tb-div"/>

          {/* Save / Load */}
          <button className="tb-btn" onClick={saveProject} title="Save project file">
            {TbIcon.save}Save
          </button>
          <button className="tb-btn" onClick={() => loadRef.current?.click()} title="Load project file">
            {TbIcon.load}Load
          </button>

          <div className="tb-div"/>

          {/* Render toggles — LEDs + Heat top-level; Directed-glow + glow-mode tuck under Light */}
          <div className="la-light-wrap">
            <button className={`tb-btn${showLight ? ' active' : ''}`}
                    onClick={() => setShowLight(v => !v)}
                    onContextMenu={e => { e.preventDefault(); setLightMenuOpen(o => !o); }}
                    title="Toggle ambient light preview (click). Right-click or use ▾ for glow options.">
              {TbIcon.bulb}Light
            </button>
            <button className="tb-btn icon" title="Light glow options"
                    onClick={() => setLightMenuOpen(o => !o)}>▾</button>
            {lightMenuOpen && (
              <>
                <div className="la-light-pop-backdrop" onClick={() => setLightMenuOpen(false)}/>
                <div className="la-light-pop" role="menu">
                  <button className={`la-light-item${directedGlow ? ' on' : ''}`}
                          onClick={() => { setDirectedGlow(v => !v); enableLightPreview(); }}
                          title="Directed glow — elongate bloom along strip direction">
                    <span>Directed glow</span>
                    <span className="st">{directedGlow ? 'on' : 'off'}</span>
                  </button>
                  <div className="la-light-sep"/>
                  <button className="la-light-item"
                          onClick={() => setGlowMode(m => GLOW_MODES[(GLOW_MODES.indexOf(m) + 1) % GLOW_MODES.length])}
                          title="Cycle glow mode (dots is fastest for editing)">
                    <span>Glow mode</span>
                    <span className="st">{glowMode}</span>
                  </button>
                </div>
              </>
            )}
          </div>
          <button className={`tb-btn${showLeds ? ' active' : ''}`} onClick={() => setShowLeds(v => !v)}
                  title="Toggle LED dots">
            {TbIcon.grid}LEDs
          </button>
          <button className={`tb-btn${showHeat ? ' active' : ''}`} onClick={() => setShowHeat(v => !v)}
                  title="Coverage heatmap">
            {TbIcon.heat}Heat
          </button>
        </div>

        {/* Body (mockup .body) — dotgrid + stage SVG + overlays */}
        <main className="body">
        <div className="dotgrid"/>
        <div className="stage">
        {/* Viewport */}
        <div
          ref={vpRef}
          className={`lw-viewport${dragOver ? ' lw-viewport--drop' : ''}`}
          style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', cursor: isPanning ? 'grabbing' : 'default' }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {dragOver && (
            <div style={{
              position: 'absolute', inset: 12, border: '2px dashed var(--accent)',
              borderRadius: 8, pointerEvents: 'none', zIndex: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--accent-soft)',
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
                  <path d={p.d} stroke="oklch(0.553 0.109 56)" strokeWidth="7" strokeOpacity={0.14} fill="none" strokeLinecap="round"/>
                  <path d={p.d} stroke="oklch(0.615 0.112 57)" strokeWidth="3" strokeOpacity={0.6} fill="none" strokeLinecap="round"/>
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
                          // Shift-click toggles this path in/out of the selection;
                          // plain click selects only it. Path selection clears
                          // strip/layer selection in the reducer.
                          togglePathSelection(entry, e.shiftKey);
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
                        stroke="oklch(0.615 0.112 57)" strokeWidth="3" strokeOpacity={0.55}
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
                  <path d={p.pathData} stroke="oklch(0.615 0.112 57)" strokeWidth="8" fill="none" opacity={0.16} strokeLinecap="round"/>
                  <path d={p.pathData} stroke="oklch(0.615 0.112 57)" strokeWidth="2.5" fill="none" opacity={0.95}
                        strokeDasharray="10 5" strokeLinecap="round"
                        style={{ animation: 'lw-march 0.5s linear infinite' }}/>
                  <circle cx={midPt.x} cy={midPt.y} r={vbScale * 9} fill="oklch(0.615 0.112 57)" opacity={0.95}/>
                  <text x={midPt.x} y={midPt.y + vbScale * 4} textAnchor="middle" fill="oklch(0.190 0.018 52)" fontSize={vbScale * 9}
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
              // Schematic at rest = warm identity color; only let the (possibly
              // cool) pattern frame tint the strand when light preview is on.
              const stripColor = effectiveShowLight ? rgbCss(stripFrame, s.color) : (s.color || 'var(--accent)');
              // The physical strip RAIL is neutral hardware — decoupled from the
              // LED colour so the lit pixels (warm dots) read as distinct from the
              // rail they sit on. Only the live pattern preview tints the rail.
              const railColor = isHid
                ? 'oklch(40% 0.01 75)'
                : (effectiveShowLight ? stripColor : 'oklch(62% 0.012 75)');
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
                          if (e.shiftKey || e.metaKey || e.ctrlKey) toggleStripSel(s.id);
                          else selectStrip(s.id);
                        }}/>
                  <path d={s.pathData}
                        stroke={railColor}
                        strokeWidth={isSel ? 5 : 3} fill="none"
                        strokeOpacity={isHid ? 0 : isSel ? 0.16 : 0.09}
                        strokeLinecap="round"
                        pointerEvents="none"/>
                  <path d={s.pathData}
                        stroke={railColor}
                        strokeWidth={isSel ? 1.6 : 1} fill="none"
                        pointerEvents="none"
                        opacity={isHid ? 0.25 : isMoving ? 0.95 : isSel ? 0.9 : 0.55}
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
                    // Warm identity color at rest; pattern-driven tint only when lit.
                    const ledColor = effectiveShowLight ? ledCssColor(ledFrame, s.color || 'oklch(58% 0.04 70)') : (s.color || 'oklch(58% 0.04 70)');
                    // Keep unlit LEDs clearly visible so the strip's pixels are countable at rest.
                    const shellOpacity = Math.max(selected ? 0.85 : 0.62, restingLedAlpha(ledFrame, { selected }));
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
                    // Warm identity color at rest; pattern-driven tint only when lit.
                    const ledColor = effectiveShowLight ? ledCssColor(ledFrame, s.color || 'oklch(58% 0.04 70)') : (s.color || 'oklch(58% 0.04 70)');
                    const coreOpacity = activeLedCoreAlpha(ledFrame, { selected });
                    const restOpacity = Math.max(selected ? 0.72 : 0.5, restingLedAlpha(ledFrame, { selected }));
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
                  <circle cx={arrow.start.x} cy={arrow.start.y} r={vbScale * 4} fill="oklch(0.745 0.095 150)" opacity={0.9}/>
                </g>
              );
            })}

            {/* ── Selection frame — mockup clay corner-tick frame (not a blue/green box) ── */}
            {selStripId && !isEditingGesture && (() => {
              const s = strips.find(st => st.id === selStripId);
              if (!s || !s.pixels?.length) return null;
              const xs = s.pixels.map(p => p.x);
              const ys = s.pixels.map(p => p.y);
              const pad = vbScale * 14;
              const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
              const w = (Math.max(...xs) - Math.min(...xs)) + pad * 2;
              const h = (Math.max(...ys) - Math.min(...ys)) + pad * 2;
              const t = Math.min(w, h) * 0.18 || vbScale * 13;
              const corners = [
                [x, y, x + t, y, x, y + t],
                [x + w, y, x + w - t, y, x + w, y + t],
                [x, y + h, x + t, y + h, x, y + h - t],
                [x + w, y + h, x + w - t, y + h, x + w, y + h - t],
              ];
              return (
                <g key="sel-frame" style={{ pointerEvents: 'none' }}>
                  <rect x={x} y={y} width={w} height={h} rx={vbScale * 6} fill="none"
                        stroke="var(--accent-line)" strokeWidth={vbScale} strokeDasharray={`${vbScale * 2} ${vbScale * 5}`}/>
                  {corners.map((c, i) => (
                    <path key={i} d={`M${c[2]} ${c[3]} L${c[0]} ${c[1]} L${c[4]} ${c[5]}`} fill="none"
                          stroke="var(--accent)" strokeWidth={vbScale * 2} strokeLinecap="round"/>
                  ))}
                </g>
              );
            })()}

            {/* ── Head/tail connectors on selected strip ── */}
            {selStripId && (() => {
              const s = strips.find(st => st.id === selStripId);
              if (!s || !s.pixels?.length) return null;
              const first = s.pixels[0];
              const last  = s.pixels[s.pixels.length - 1];
              return (
                <g key="strip-connectors" style={{ pointerEvents: 'none' }}>
                  <circle cx={first.x} cy={first.y} r={vbScale * 5}  fill="oklch(0.745 0.095 150)" opacity={0.95}/>
                  <circle cx={first.x} cy={first.y} r={vbScale * 9}  fill="none" stroke="oklch(0.745 0.095 150)" strokeWidth={1.5} opacity={0.35}/>
                  <circle cx={last.x}  cy={last.y}  r={vbScale * 7}  fill="none" stroke="oklch(0.800 0.130 72)" strokeWidth={2} opacity={0.9}/>
                  <circle cx={last.x}  cy={last.y}  r={vbScale * 11} fill="none" stroke="oklch(0.800 0.130 72)" strokeWidth={1} opacity={0.3}/>
                </g>
              );
            })()}

            {/* ── Draw mode ghost ── */}
            {drawMode && ghostD && (
              <path d={ghostD} stroke="oklch(0.615 0.112 57)" strokeWidth="1.5" fill="none"
                    strokeDasharray="5 3" strokeLinecap="round" pointerEvents="none"/>
            )}
            {drawMode && waypoints.map((pt, i) => (
              <circle key={i} cx={pt.x} cy={pt.y} r={vbScale * 4} fill="oklch(0.615 0.112 57)"
                      opacity={0.9} pointerEvents="none"/>
            ))}
            {/* Draw cursor dot before first waypoint */}
            {drawMode && ghostPt && waypoints.length === 0 && (
              <circle cx={ghostPt.x} cy={ghostPt.y} r={vbScale * 3}
                      fill="oklch(0.615 0.112 57)" opacity={0.5} pointerEvents="none"/>
            )}

            {/* ── Empty state ── */}
            {!svgText && strips.length === 0 && (
              <>
                <rect x="1" y="1" width="638" height="398" rx="4" fill="none"
                      stroke="oklch(30% 0.01 75)" strokeDasharray="6 4"/>
                <text x="320" y="185" textAnchor="middle" fill="oklch(55% 0.04 70)"
                      fontSize="14" fontFamily="var(--ui-font)">
                  Drop an SVG or click Import SVG
                </text>
                <text x="320" y="205" textAnchor="middle" fill="oklch(48% 0.03 70)"
                      fontSize="11" fontFamily="var(--ui-font)">
                  Illustrator: File → Export As → SVG (layers preserved)
                </text>
                <text x="320" y="222" textAnchor="middle" fill="oklch(42% 0.025 70)"
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
              border: '1px dashed var(--accent)',
              background: 'var(--accent-soft)',
              pointerEvents: 'none',
              zIndex: 9999,
              userSelect: 'none',
            }}/>
          )}
        </div>
        </div>{/* .stage */}

        {/* ── Canvas corner readouts (mockup .la-overlay) ── */}
        <div className="la-overlay tl">
          <div><span className="k">artwork</span><span className="v">{parsedVb(viewBox).w} × {parsedVb(viewBox).h}</span></div>
          <div><span className="k">layers</span><span className="v">{layers.length} · {strips.length} strips</span></div>
          <div><span className="k">leds</span><span className="v">{totalLeds.toLocaleString()}</span></div>
        </div>
        <div className="la-overlay br">
          <div><span className="k">emit</span><span className="v">{existingStrip ? (existingStrip.emit === 'omni' ? 'omni' : `dir ${existingStrip.angle || 0}°`) : '—'}</span></div>
          {cursorSvgPt && (
            <div><span className="k">cursor</span><span className="v">{cursorSvgPt.x.toFixed(0)} · {cursorSvgPt.y.toFixed(0)}</span></div>
          )}
          <div><span className="k">zoom</span><span className="v">{Math.round(zoom * 100)}%</span></div>
        </div>
      </main>{/* .body */}

      {/* ── Right panel (mockup .side) ─────────────────────────────── */}
      <aside className="side">

        {error && (
          <div className="la-error-banner">
            <span style={{ flex: 1 }}>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {/* Draw mode hint */}
        {drawMode && (
          <div className="la-draw-hint">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <strong style={{ color: 'var(--text-hi)' }}>Drawing mode</strong>
              <button style={{ fontSize: 11, color: 'var(--accent)', padding: '0 4px' }}
                      onClick={() => { setDrawMode(false); setWaypoints([]); setGhostPt(null); }}>
                Cancel (Esc)
              </button>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-faint)', display: 'block' }}>
              {waypoints.length} point{waypoints.length !== 1 ? 's' : ''}
              {waypoints.length >= 2 && ` · ~${drawEstimatedLeds} LEDs · double-click to finish`}
              {waypoints.length < 2 && ' · click to place, ⌫ undo, right-click cancel'}
            </span>
          </div>
        )}

        {/* Pending draw naming panel */}
        {pendingDraw && (
          <div className="la-pending">
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', marginBottom: 8 }}>
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
                autoFocus
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ color: 'var(--text-mid)', width: 72, flexShrink: 0 }}>LED count</span>
                <input className="lw" type="range" min={LED_COUNT_SLIDER_MIN} max={LED_COUNT_SLIDER_MAX} step="1"
                       value={ledCountToSliderValue(pendingDrawCount)}
                       aria-label="New strip LED count slider"
                       onChange={e => setPendingDrawCount(sliderValueToLedCount(e.target.value))}
                       style={{ flex: 1, minWidth: 0 }}/>
                <input type="number" min="1" max={LED_COUNT_MAX}
                       value={pendingDrawCount}
                       aria-label="New strip LED count"
                       inputMode="numeric"
                       onFocus={e => e.target.select()}
                       onChange={e => setPendingDrawCount(clampLedCount(e.target.value))}/>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} onClick={confirmDraw}>
                  + Add Strip
                </button>
                <button className="btn" onClick={cancelDraw}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Layer list ── */}
        {layers.length > 0 && (
          <>
            <div className="panel-head">
              <span className="ttl">Artwork layers</span>
              <div className="la-head-tools">
                <span className="meta">{layers.length} · {totalLeds.toLocaleString()} LEDs</span>
                <button title="Show all layers"
                        onClick={() => setHidden(h => { const n={...h}; layers.forEach(l=>{n[l.layerId]=false;}); return n; })}>
                  <EyeIcon/>
                </button>
                <button title="Hide all layers"
                        onClick={() => setHidden(h => { const n={...h}; layers.forEach(l=>{n[l.layerId]=true;}); return n; })}>
                  <EyeOffIcon/>
                </button>
              </div>
            </div>

            <div className="layers" style={{ overflow: 'auto', flex: '0 0 auto', maxHeight: '42%' }}>
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
	                        <div className="la-group-row"
	                             style={{ background: stripGroupDragOver === group.groupId ? 'color-mix(in oklab, var(--accent) 16%, transparent)' : isDragTarget ? 'var(--accent-soft)' : undefined,
	                                      opacity: isGroupHidden ? 0.45 : 1 }}>
                          <span data-drag-handle="true" className="la-grip"><DragHandleIcon/></span>
                          <button onClick={e => { e.stopPropagation(); toggleGroupHidden(group.groupId); }}>
                            {isGroupHidden ? <EyeOffIcon/> : <EyeIcon/>}
                          </button>
                          <button onClick={e => { e.stopPropagation(); toggleGroupExpanded(group.groupId); }}>
                            {group._expanded ? <ChevronDownIcon/> : <ChevronRightIcon/>}
                          </button>
                          <span style={{ color: 'var(--accent)', display:'flex', alignItems:'center' }}><GroupIcon/></span>
	                          <InlineRename value={group.name} onCommit={n => renameGroup(group.groupId, n)}
	                                        className="nm"/>
	                          <span className="ct">
	                            {group.members.length}{isStripGroup ? 's' : 'p'}
	                          </span>
                          <button title="Ungroup" onClick={e => { e.stopPropagation(); deleteLayerGroup(group.groupId); }}>⊠</button>
                        </div>
	                        {group._expanded && group.members.map((m, mi) => {
	                          const memberId = m.stripId || m.pathId;
	                          const memberHidden = !!hidden[memberId];
	                          return (
	                          <div key={memberId} className="la-subrow"
	                               style={{ cursor: isStripGroup ? 'pointer' : 'default' }}
	                               onClick={() => { if (isStripGroup) selectStrip(memberId); }}>
	                            <span className="n">{mi+1}</span>
	                            <button className="la-eye" style={{ opacity: 1 }}
	                                    onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [memberId]: !h[memberId] })); }}>
	                              {memberHidden ? <EyeOffIcon/> : <EyeIcon/>}
	                            </button>
	                            {isStripGroup && (
	                              <span className="layer-swatch" style={{ background: m.color || 'var(--accent)' }}/>
	                            )}
	                            <span className="nm">{m.name}</span>
	                            {isStripGroup ? (
	                              <span className="len">{(m.pixelCount || 0).toLocaleString()}px</span>
	                            ) : m.svgLength > 0 && (
	                              <span className="len">{Math.round(m.svgLength / pxPerMm)}mm</span>
	                            )}
	                            <button className="add" style={{ color: 'var(--text-faint)' }}
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
                  const hasStrip   = strips.some(s => stripSourceKey(s) === l.layerId);
                  const isSel      = l.layerId === selLayerId;
                  const canExpand  = l.subPaths?.length > 1;
                  const isExpanded = !!expandedLayers[l.layerId];
                  const stripForLayer = strips.find(s => stripSourceKey(s) === l.layerId);
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
                      <div className={`layer-row${isSel?' sel':''}${isHidden?' hidden':''}`}
                           style={{ borderTop: isDragTarget ? '2px solid var(--accent)' : undefined }}
                           onClick={() => selectLayer(l.layerId)}
                           onMouseEnter={() => setHoveredLayerId(l.layerId)}
                           onMouseLeave={() => setHoveredLayerId(null)}>
                        <span data-drag-handle="true" className="la-grip">
                          <DragHandleIcon/>
                        </span>
                        <button className="la-eye" title={isHidden?'Show':'Hide'}
                                onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [l.layerId]: !h[l.layerId] })); }}>
                          {isHidden ? <EyeOffIcon/> : <EyeIcon/>}
                        </button>
                        {canExpand
                          ? <button className="la-eye" title={isExpanded?'Collapse':'Expand'}
                                    onClick={e => { e.stopPropagation(); setExpandedLayers(ex => ({ ...ex, [l.layerId]: !ex[l.layerId] })); }}
                                    style={{ opacity: 1 }}>
                              {isExpanded ? <ChevronDownIcon/> : <ChevronRightIcon/>}
                            </button>
                          : <span style={{ width:16, flexShrink:0 }}/>
                        }
                        <span className="layer-swatch" style={{ background: l._color }}/>
                        <InlineRename value={l.name} onCommit={n => renameLayer(l.layerId, n)}
                                      className="layer-name"/>
                        {hasStrip && (
                          <span className="la-stripdot" title="Select LED strip" style={{ cursor: 'pointer' }}
                                onClick={e => { e.stopPropagation(); if (stripForLayer) selectStrip(stripForLayer.id); }}/>
                        )}
                        {canExpand && (
                          <span style={{ fontSize:10, color:'var(--text-faint)', fontFamily:'var(--font-mono)', flexShrink:0 }}>
                            {l.subPaths.length}p
                          </span>
                        )}
                        {l.svgLength > 0 && (
                          <span className="layer-len">{Math.round(l.svgLength / pxPerMm)}mm</span>
                        )}
                        <button className="la-del" title="Delete layer"
                                onClick={e => { e.stopPropagation(); deleteLayer(l.layerId); }}>×</button>
                      </div>

	                      {isExpanded && l.subPaths?.map(sp => {
	                        const spHidden = !!hidden[sp.pathId];
	                        const spSel    = pathSel.some(p => p.pathId === sp.pathId);
	                        const entry = { layerId: l.layerId, pathId: sp.pathId, pathData: sp.pathData, name: `${l.name} · ${sp.name}`, svgLength: sp.svgLength };
	                        return (
	                          <div key={sp.pathId}
	                               draggable
	                               className={`la-subrow${spSel ? ' sel' : ''}`}
	                               onClick={e => togglePathSelection(entry, e.shiftKey || e.metaKey || e.ctrlKey)}
	                               onDragStart={e => {
	                                 if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
	                                 const payload = spSel && pathSel.length > 0 ? pathSel : [entry];
	                                 e.dataTransfer.effectAllowed = 'move';
	                                 e.dataTransfer.setData('application/x-lightweaver-path', JSON.stringify(payload));
	                                 e.dataTransfer.setData('text/plain', payload.map(p => p.name).join(', '));
	                                 if (!spSel) selectPaths([entry]);
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
	                            <span data-drag-handle="true" className="la-grip" style={{ color: spSel ? 'var(--accent)' : 'var(--text-faint)', flexShrink: 0 }}>
	                              <DragHandleIcon/>
	                            </span>
	                            <button className="la-eye" style={{ opacity: 1 }}
	                                    onClick={e => { e.stopPropagation(); setHidden(h => ({ ...h, [sp.pathId]: !h[sp.pathId] })); }}>
	                              {spHidden ? <EyeOffIcon/> : <EyeIcon/>}
	                            </button>
                            <InlineRename value={sp.name} onCommit={n => renameSubPath(l.layerId, sp.pathId, n)}
                                          className="nm" style={{ color: spHidden ? 'var(--text-faint)' : 'var(--text-mid)' }}/>
                            <span className="len">
                              {sp.svgLength > 0 ? `${Math.round(sp.svgLength / pxPerMm)}mm` : ''}
                            </span>
                            <button className="add"
                                    onClick={e => { e.stopPropagation(); addSubPathStrip(sp, l); }}>+</button>
                          </div>
                        );
                      })}
                    </div>
                  );
                });
              })()}

	              <div className="la-hint">
	                Click rows to select · <strong>⇧/⌘ click</strong> adds · drag rows into groups
	              </div>
            </div>
          </>
        )}

        {/* ── Path selection panel (mockup .la-pathsel) ── */}
        {pathSel.length > 0 && (
          <div className="la-pathsel">
            <div className="la-sub-h">
              <span>{pathSel.length} path{pathSel.length > 1 ? 's' : ''} selected</span>
              <button className="meta" style={{ color: 'var(--text-faint)' }}
                      onClick={clearLayoutSelection}>✕</button>
            </div>
            <div style={{ maxHeight: 80, overflow: 'auto', marginBottom: 8 }}>
              {pathSel.map((p, i) => (
                <div key={p.pathId} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12,
                                              color: 'var(--text-mid)', padding: '2px 0' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--accent)',
                                 fontWeight: 'bold', width: 14, flexShrink: 0, textAlign: 'center' }}>{i + 1}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  {p.svgLength > 0 && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, flexShrink: 0, color: 'var(--text-faint)' }}>
                      {Math.round(p.svgLength / pxPerMm)}mm
                    </span>
                  )}
                  <button disabled={i === 0} style={{ fontSize: 11, padding: '0 3px', color: 'var(--text-faint)', opacity: i === 0 ? 0.3 : 1 }}
                          onClick={() => {
                            const a = [...pathSel]; [a[i-1], a[i]] = [a[i], a[i-1]];
                            selectPaths(a);
                            if (pathSelName) renameLayoutSelection(pathSelName); // keep the typed name across reorders
                          }}>↑</button>
                  <button disabled={i === pathSel.length - 1} style={{ fontSize: 11, padding: '0 3px', color: 'var(--text-faint)', opacity: i === pathSel.length - 1 ? 0.3 : 1 }}
                          onClick={() => {
                            const a = [...pathSel]; [a[i], a[i+1]] = [a[i+1], a[i]];
                            selectPaths(a);
                            if (pathSelName) renameLayoutSelection(pathSelName); // keep the typed name across reorders
                          }}>↓</button>
                  <button style={{ fontSize: 12, padding: '0 4px', color: 'var(--text-faint)' }}
                          onClick={() => {
                            const next = pathSel.filter((_, j) => j !== i);
                            selectPaths(next);
                            // Dropping to one path auto-names after it (reducer);
                            // otherwise keep whatever the user typed.
                            if (next.length > 1 && pathSelName) renameLayoutSelection(pathSelName);
                          }}>✕</button>
                </div>
              ))}
            </div>
            <input type="text" className="pm-input" style={{ height: 30, marginBottom: 8 }}
                   value={pathSelName} onChange={e => renameLayoutSelection(e.target.value)}
                   placeholder="Name…"/>
            <div className="la-merge">
              <button className="btn primary" style={{ flex: 1 }}
                      title="Create one composite strip from the selected paths"
                      onClick={() => addSelectedPathsAsStrips('merged')}>
                Merge strip
              </button>
              {pathSel.length >= 2 && (
                <>
                  <button className="btn"
                          title="Create separate LED strips from the selected paths"
                          onClick={() => addSelectedPathsAsStrips('separate')}>
                    Separate
                  </button>
                  <button className="btn"
                          title="Create separate LED strips and place them in one strip group"
                          onClick={() => addSelectedPathsAsStrips('grouped')}>
                    Strip group
                  </button>
                </>
              )}
            </div>
            {pathSel.length >= 2 && (
              <button className="btn ghost-sm" style={{ width: '100%', marginTop: 6, justifyContent: 'center' }}
                      title="Group the source artwork paths without creating LED strips"
                      onClick={createLayerGroup}>
                Layer group
              </button>
            )}
          </div>
        )}

        {/* ── Layer inspector (mockup .inspector) ── */}
        {selLayer && (() => {
          const isOmni = existingStrip?.emit === 'omni';
          const ledVal = editCounts[selLayer.layerId] ?? getLedCount(selLayer);
          const pitch = (selLayer.svgLength > 0 && ledVal > 1)
            ? ((selLayer.svgLength / pxPerMm) / ledVal).toFixed(1) : '—';
          return (
          <>
          <div className="panel-divider"/>
          <div className="inspector">
            <div className="insp-head">
              <span className="sw" style={{ background: selLayer._color }}/>
              <span className="nm">{selLayer.name}</span>
              <span className="tag">Inspector</span>
            </div>
            <div className="insp-body">
              <div className="field">
                <span className="k">Length</span>
                <span className="v"><span className="inspector-value">{selLayer.svgLength > 0 ? Math.round(selLayer.svgLength / pxPerMm) : '—'}<span className="u">mm</span></span></span>
              </div>
              {selLayer.subPaths?.length > 1 && (
                <div className="field">
                  <span className="k">Sub-paths</span>
                  <span className="v"><span className="inspector-value">{selLayer.subPaths.length}</span></span>
                </div>
              )}
              <div className="field">
                <span className="k">Density</span>
                <span className="v">
                  <div className="mini-seg">
                    {DENSITY_OPTIONS.map(d => (
                      <button key={d} className={density === d ? 'on' : ''} onClick={() => handleDensityChange(d)}>{d}</button>
                    ))}
                  </div>
                </span>
              </div>
              <div className="field-sep"/>

              {/* LED count — slider + number (live resample) */}
              <div className="la-ledrow">
                <span className="k">LED count</span>
                <div className="la-ledctrl">
                  {editCounts[selLayer.layerId] != null && (
                    <button style={{ color: 'var(--text-faint)', padding: '0 3px' }} title="Reset to calculated"
                            onClick={() => setEditCounts(c => { const next = { ...c }; delete next[selLayer.layerId]; return next; })}>↺</button>
                  )}
                  <input className="lw" type="range" min={LED_COUNT_SLIDER_MIN} max={LED_COUNT_SLIDER_MAX} step="1"
                         value={ledCountToSliderValue(ledVal)}
                         aria-label="Layer LED count slider"
                         onChange={e => {
                           const val = sliderValueToLedCount(e.target.value);
                           setEditCounts(c => ({ ...c, [selLayer.layerId]: val }));
                           if (existingStrip) resampleStrip(existingStrip.id, val);
                         }}/>
                  <input className="num-input" type="number" min="1" max={LED_COUNT_MAX}
                         value={ledVal}
                         aria-label="Layer LED count"
                         inputMode="numeric"
                         onFocus={e => e.target.select()}
                         onChange={e => {
                           const val = clampLedCount(e.target.value);
                           setEditCounts(c => ({ ...c, [selLayer.layerId]: val }));
                           if (existingStrip) resampleStrip(existingStrip.id, val);
                         }}
                         onBlur={() => { if (existingStrip) resampleStrip(existingStrip.id, getLedCount(selLayer)); }}
                         onKeyDown={e => {
                           if (e.key === 'Enter') {
                             if (existingStrip) resampleStrip(existingStrip.id, getLedCount(selLayer));
                             else addStrip();
                           }
                         }}
                         style={{ borderColor: editCounts[selLayer.layerId] != null ? 'var(--accent)' : undefined }}/>
                </div>
              </div>
              <div className="field">
                <span className="k">Pitch</span>
                <span className="v"><span className="inspector-value">{pitch}<span className="u">mm/LED</span></span></span>
              </div>
              <div className="field-sep"/>

              {/* Emit — Omni / Directed */}
              <div className="field" style={{ opacity: existingStrip ? 1 : 0.5 }}>
                <span className="k">Emit</span>
                <span className="v">
                  <div className="mini-seg">
                    <button className={isOmni ? 'on' : ''} disabled={!existingStrip}
                            title={existingStrip ? 'Omnidirectional glow' : 'Add strip first'}
                            onClick={() => { if (existingStrip) updateStrip(existingStrip.id, { emit: 'omni', angle: 0 }); }}>Omni</button>
                    <button className={existingStrip && !isOmni ? 'on' : ''} disabled={!existingStrip}
                            title={existingStrip ? 'Directed emission' : 'Add strip first'}
                            onClick={() => {
                              if (!existingStrip) return;
                              setDirectedGlow(true); enableLightPreview();
                              updateStrip(existingStrip.id, { emit: 'dir' });
                            }}>Directed</button>
                  </div>
                </span>
              </div>

              {/* Compass — directed angle dial */}
              <EmitCompass
                angle={existingStrip?.angle || 0}
                omni={isOmni || !existingStrip}
                setAngle={a => {
                  if (!existingStrip) return;
                  setDirectedGlow(true); enableLightPreview();
                  updateStrip(existingStrip.id, { angle: a });
                }}/>

              <div className="field-sep"/>

              {/* Color tag */}
              <div className="field">
                <span className="k">Color tag</span>
                <span className="v">
                  <div className="la-tags">
                    {STRIP_COLORS.slice(0, 5).map(c => (
                      <button key={c} className={`la-tag${selLayer._color === c ? ' on' : ''}`}
                              style={{ background: c }}
                              title="Set layer color"
                              onClick={() => {
                                setLayers(prev => prev.map(l => l.layerId === selLayer.layerId ? { ...l, _color: c } : l));
                                if (existingStrip) updateStrip(existingStrip.id, { color: c });
                              }}/>
                    ))}
                  </div>
                </span>
              </div>

              {/* Brightness */}
              {existingStrip && (
                <div className="slider-row" style={{ marginTop: 6 }}>
                  <div className="lab">
                    <span className="k">Brightness</span>
                    <span className="v">{Math.round((existingStrip.brightness ?? 1) * 100)}%</span>
                  </div>
                  <input className="lw" type="range" min="0" max="100"
                         value={Math.round((existingStrip.brightness ?? 1) * 100)}
                         aria-label="Strip brightness"
                         onChange={e => updateStrip(existingStrip.id, { brightness: parseInt(e.target.value, 10) / 100 })}/>
                </div>
              )}

              {/* Add / Update CTA */}
              {existingStrip
                ? <button className="insp-cta" style={{ color: 'var(--ok)', borderColor: 'color-mix(in oklch, var(--ok) 40%, var(--border))' }}
                          onClick={addStrip} title="Re-sample this strip with current settings">{TbIcon.check}Strip added · update</button>
                : <button className="insp-cta" onClick={addStrip}>{TbIcon.strip}Add as strip</button>}

              {existingStrip && (
                <div className="la-insp-actions">
                  <button className="btn" onClick={() => reverseStrip(existingStrip.id)} title="Flip pixel 0 from start to end">↔ Reverse</button>
                  <button className="btn danger" onClick={() => removeStrip(existingStrip.id)}>Remove</button>
                </div>
              )}
            </div>
          </div>
          </>
          );
        })()}

        {/* ── Strips list ── */}
        {strips.length > 0 && (
	          <>
	            <div className="panel-divider"/>
	            <div className="panel-head">
	              <span className="ttl">LED strips</span>
	              <span className="meta">
	                {selectedStrips.length > 1 ? `${selectedStrips.length} sel · ` : ''}
	                {strips.length} · {totalLeds.toLocaleString()} LEDs · wiring order
	              </span>
	            </div>
	            {selectedStrips.length > 1 && (
	              <div className="la-batch">
	                <div className="la-batch-head">
	                  <span>{selectedStrips.length} strips selected</span>
	                  <button title="Clear strip selection" onClick={clearLayoutSelection}>✕</button>
	                </div>
	                <div className="la-batch-list">
	                  {selectedStrips.map((s, i) => (
	                    <span key={s.id} className="la-batch-chip" title={s.name}>
	                      <span className="layer-swatch" style={{ background: s.color, width: 8, height: 8 }}/>
	                      {i + 1}. {s.name}
	                    </span>
	                  ))}
	                </div>
	                <div className="la-batch-actions">
	                  <input
	                    type="text"
	                    value={stripSelectionName}
	                    onChange={e => renameLayoutSelection(e.target.value)}
	                    placeholder="Group or merged strip name..."
	                  />
	                  <button className="btn" title="Organize selected strips as one expandable group (G)" onClick={groupSelectedStrips}>
	                    <GroupIcon/> Group
	                  </button>
	                  <button className="btn primary" title="Paste selected strips into one composite strip (M)" onClick={mergeSelectedStrips}>
	                    Merge
	                  </button>
	                </div>
	              </div>
	            )}
	            <div ref={stripListRef} className="layers" style={{ flex: '0 0 auto', minHeight: 0, paddingBottom: 4 }}>
	              {/* List order = chain order; the row badge is the strip's chain position. */}
	              {orderedStrips.map((s, i) => {
	                const isSel = s.id === selStripId;
	                const isBatchSel = selectedStripIds.includes(s.id);
	                const isOpen = !!expandedStrips[s.id];
	                return (
	                  <div key={s.id} data-strip-id={s.id}>
	                  <div
	                       className={`la-strip-row${isSel ? ' sel' : ''}`}
	                       draggable
	                       onDragStart={e => {
	                         if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
	                         const ids = selectedStripIds.includes(s.id) ? selectedStripIds : [s.id];
	                         e.dataTransfer.effectAllowed = 'move';
	                         e.dataTransfer.setData('application/x-lightweaver-strip', JSON.stringify(ids));
	                         e.dataTransfer.setData('text/plain', ids.join(','));
	                         // Do NOT setState here — re-rendering the row during dragstart
	                         // cancels the native HTML5 drag. The ids ride in dataTransfer.
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
	                         reorderStripRows(draggedStripIds, s.id);
	                         setStripGroupDragOver(null);
	                       }}
	                       onDragEnd={() => setStripGroupDragOver(null)}
	                       style={{ opacity: hidden[s.id] ? 0.4 : 1,
	                                outline: stripGroupDragOver === `strip:${s.id}` ? '1px solid var(--accent)' : undefined,
	                                outlineOffset: -1 }}
	                       onClick={e => {
	                         if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleStripSel(s.id); return; }
	                         selectStrip(s.id);
	                         setExpandedStrips(ex => ({ ...ex, [s.id]: !ex[s.id] }));
	                       }}>
	                      <span data-drag-handle="true" className="la-wire-n" title="Drag to reorder" style={{ flexShrink: 0, cursor: 'grab', color: isBatchSel ? 'var(--accent)' : undefined }}>{String(i + 1).padStart(2, '0')}</span>
                      <span className="layer-swatch" style={{ borderRadius: '50%', background: s.color,
                                     boxShadow: isSel ? `0 0 8px ${s.color}` : undefined }}/>
                      <InlineRename value={s.name} onCommit={n => renameStrip(s.id, n)}
                                    className="layer-name" style={{ cursor: 'pointer', flex: 1, minWidth: 0 }}/>
                      {s.reversed && <span className="la-strip-rev">REV</span>}
                      <span className="layer-len">{s.pixelCount} px</span>
                    </div>
                    {isOpen && (
                      <div className="la-strip-detail" onClick={e => e.stopPropagation()}>
	                        <div className="hint">Drag on canvas to move · click, then arrow keys to nudge (Shift = ×10).</div>
                        {/* LED count */}
                        <div className="row">
                          <span className="k">LEDs</span>
                          <input className="lw" type="range" min={LED_COUNT_SLIDER_MIN} max={LED_COUNT_SLIDER_MAX} step="1"
                                 value={ledCountToSliderValue(s.pixelCount)}
                                 aria-label="Strip LED count slider"
                                 onChange={e => resampleStrip(s.id, sliderValueToLedCount(e.target.value))}/>
                          <input type="number" min="1" max={LED_COUNT_MAX} step="1"
                                 value={s.pixelCount}
                                 aria-label="Strip LED count"
                                 inputMode="numeric"
                                 style={{ width: 72 }}
                                 onFocus={e => e.target.select()}
                                 onChange={e => resampleStrip(s.id, clampLedCount(e.target.value))}
                                 onBlur={e => resampleStrip(s.id, clampLedCount(e.target.value))}
                                 onKeyDown={e => { if (e.key === 'Enter') resampleStrip(s.id, clampLedCount(e.target.value)); }}/>
                          <button className="btn" style={{ padding: '0 6px' }}
                                  title="I physically counted this strip's LEDs — set this count as ground truth and calibrate the overall scale to match."
                                  onClick={() => calibrateScaleFromStrip(s.id, s.pixelCount)}>Set real count</button>
                        </div>
                        {usbLedConnected && (
                          <div className="hint" style={{ color: s.pixelCount > usbLedMaxPixels ? 'var(--accent)' : 'var(--text-faint)' }}>
                            USB direct cap {usbLedMaxPixels} LEDs.
                          </div>
                        )}
                        {/* Strip actions */}
                        <div className="actions">
                          <button className="btn" style={{ flex: 1, justifyContent: 'center' }}
                                  onClick={() => reverseStrip(s.id)}>
                            ↔ Reverse
                          </button>
                          <button className="btn" style={{ flex: 1, justifyContent: 'center' }}
                                  onClick={() => setHidden(h => ({ ...h, [s.id]: !h[s.id] }))}>
                            {hidden[s.id] ? 'Show' : 'Hide'}
                          </button>
                          <button className="btn" style={{ flex: 1, justifyContent: 'center' }}
                                  onClick={() => duplicateStrip(s.id)}>
                            Duplicate
                          </button>
                          <button className="btn" style={{ flex: 1, justifyContent: 'center' }}
                                  onClick={() => removeStrip(s.id)}>
                            Remove
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
	              })}
	            </div>
              {defaultCircleLayoutActive && (
                <div
                  data-testid="default-circle-layout-panel"
                  style={{ margin: '2px 12px 8px', fontSize: 'var(--fs-xs)', color: 'var(--text-faint)', lineHeight: 1.45 }}
                >
                  <strong style={{ fontWeight: 500, color: 'var(--text-3)', letterSpacing: 0 }}>Default two-circle hardware</strong>
                  {' '}— starter layout; import an SVG or open a project to replace it.
                </div>
              )}
	          </>
        )}

        {strips.length > 0 && (() => {
          const wireStrips = strips.filter(st => !hidden[st.id]);
          return (
          <>
            <div className="panel-divider"/>
            {/* Live wire editor — chop / link / route order (function preserved) */}
            <details className="la-wire-editor">
              <summary>
                <span className="ttl">Advanced</span>
                <span className="meta">split a strip into runs</span>
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
          </>
          );
        })()}

        {/* ── Empty state ── */}
        {!svgText && !error && !defaultCircleLayoutActive && (
          <div className="la-empty">
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="6" y="4" width="32" height="36" rx="3"/>
              <path d="M14 14h16M14 22h16M14 30h10"/>
              <path d="M28 28l8 8M32 28h4v4" strokeLinecap="round"/>
            </svg>
            <div style={{ fontSize: 13, color: 'var(--text-hi)' }}>Import an SVG to map LED strips</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              Works with Illustrator CC, Inkscape,<br/>and any SVG with layer groups.<br/>Drag and drop onto the canvas.
            </div>
            <button className="cta" onClick={() => fileRef.current?.click()}>
              {TbIcon.import}Import SVG
            </button>
          </div>
        )}
      </aside>
      </div>{/* .la */}
    </div>
  );
}
