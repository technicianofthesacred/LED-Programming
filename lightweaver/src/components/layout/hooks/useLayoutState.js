import { useState, useRef, useMemo, useEffect } from 'react';
import { samplePath as libSamplePath } from '../../../lib/mapper.js';
import { useProject } from '../../../state/ProjectContext.jsx';
import { createPrimitiveStripDefinition, DEFAULT_STARTER_PIXEL_COUNT } from '../../../lib/layoutPrimitives.js';
import {
  STRIP_COLORS,
  stripSourceKey,
  sampleStripPixels,
  clampLedCount,
} from '../../../lib/layoutGeometry.js';
import { scaleStripGeometry } from '../../../lib/stripScale.js';
import { orderedStripIdsFromChain } from '../../../lib/patchBoard.js';
import { isClosedPathData } from '../../../lib/pathClosure.js';

import { useLayoutSize } from './useLayoutSize.js';
import { useLayoutStrips } from './useLayoutStrips.js';
import { useLayoutArtwork } from './useLayoutArtwork.js';
import { useLayoutWire } from './useLayoutWire.js';
import { useLayoutCanvasInteraction } from './useLayoutCanvasInteraction.js';
import { useLayoutImport } from './useLayoutImport.js';

// Stable empty stand-ins so the derived selection views keep referential
// identity across renders when the selection is a different kind.
const NO_IDS = [];
const NO_ENTRIES = [];

// One flat bundle of all Layout screen state + behaviour. LayoutScreen consumes
// this and renders JSX only. This composer calls useProject() once, owns the
// shared refs/helpers, instantiates the concern hooks in a stable order, wires
// their cross-dependencies through explicit parameters, and returns everything
// the JSX tree reads.
export function useLayoutState() {
  const project = useProject();

  const {
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
    layoutStripCountOverrides:    stripCountOverrides,
    setLayoutStripCountOverrides: setStripCountOverrides,
    layoutStripDensities:         stripDensities,
    setLayoutStripDensities:      setStripDensities,
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
    activePatternId,
    palette,
    masterSpeed,
    masterBrightness,
    masterSaturation,
    masterHueShift,
    gammaEnabled,
    gammaValue,
    patternParams,
    bpm,
    symSettings,
    usbLedConnected,
    usbLedStatus,
    wiring,
    starterPending,
    replaceLayoutGeometry,
  } = project;

  const usbLedMaxPixels = usbLedStatus?.maxPixels || 300;

  // Per-strip detail expander (ephemeral view state — stays local to the screen)
  const [expandedStrips, setExpandedStrips] = useState({});

  // ── Shared refs ────────────────────────────────────────────────────────────
  const svgRef      = useRef(null);
  const artworkRef  = useRef(null);
  const vpRef       = useRef(null);
  const stripListRef = useRef(null);
  const stripsRef   = useRef([]);
  const pxPerMmRef  = useRef(3.7795);
  const colorIdxRef = useRef(0);
  const nextColor   = () => STRIP_COLORS[colorIdxRef.current++ % STRIP_COLORS.length];

  // Keep the drag/geometry refs in sync with the reducer-owned state (these are
  // read synchronously inside pointer handlers, so they must not lag a render).
  useEffect(() => { stripsRef.current = strips; }, [strips]);
  useEffect(() => { pxPerMmRef.current = pxPerMm; }, [pxPerMm]);

  // ── Selection: derived views over the reducer's single selection object ────
  const selectedStripIds = selection.kind === 'strip' ? selection.ids : NO_IDS;
  const selStripId = selection.kind === 'strip' && selection.ids.length === 1 ? selection.ids[0] : null;
  const pathSel = selection.kind === 'path' ? selection.entries : NO_ENTRIES;
  const pathSelName = selection.kind === 'path' ? selection.name : '';
  const stripSelectionName = selection.kind === 'strip' ? selection.name : '';
  const selectedStrip = selStripId ? strips.find(s => s.id === selStripId) : null;
  const selLayerId = selection.kind === 'layer'
    ? (selection.ids[0] ?? null)
    : (selectedStrip ? stripSourceKey(selectedStrip) : null);

  // Prune the strip selection when selected strips disappear through any
  // mutation path (strip/layer/path deletes, loads).
  useEffect(() => {
    if (selection.kind !== 'strip') return;
    const missing = selection.ids.filter(id => !strips.some(s => s.id === id));
    missing.forEach(id => toggleStripSel(id));
  }, [strips, selection, toggleStripSel]);

  // ── Wire order comes from the patch-board chain ────────────────────────────
  const orderedStrips = useMemo(() => {
    const byId = new Map(strips.map(s => [s.id, s]));
    return orderedStripIdsFromChain(patchBoard, strips).map(id => byId.get(id)).filter(Boolean);
  }, [patchBoard, strips]);

  // ── Shared entity helpers ──────────────────────────────────────────────────
  const rebuildStrip = (stripData) => ({
    ...stripData,
    closed: isClosedPathData(stripData.pathData, stripData.closed ?? stripData.isClosed),
    pixels: sampleStripPixels(stripData.pathData, stripData.pixelCount, stripData.reversed, stripData.x || 0, stripData.y || 0),
  });

  const makeStrip = (layer, count, id) => {
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.setAttribute('d', layer.pathData);
    const pixels = libSamplePath(pathEl, count);
    return {
      id, name: layer.name,
      sourceLayerId: layer.layerId, sourcePathId: null,
      pathData: layer.pathData, pixelCount: count,
      closed: isClosedPathData(layer.pathData, layer.closed ?? layer.isClosed),
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

  // Undo/redo aliases (single snapshot stack in ProjectContext).
  const doUndo = undoLayout;
  const doRedo = redoLayout;

  // ── Derived layout entities the JSX + hooks read ───────────────────────────
  const selLayer = layers.find(l => l.layerId === selLayerId) ?? null;
  const existingStrip = selLayer ? strips.find(s => stripSourceKey(s) === selLayer.layerId) : null;

  const totalLeds = strips.reduce((n, s) => n + s.pixelCount, 0);
  const starterLayoutActive = starterPending && !svgText && layers.length === 0 && !wiring.locked;
  const selectedStrips = useMemo(() => {
    const selected = new Set(selectedStripIds);
    return orderedStrips.filter(s => selected.has(s.id));
  }, [orderedStrips, selectedStripIds]);

  // ── Shared bundle passed to every concern hook ─────────────────────────────
  const ctx = {
    // reducer-owned state + dispatchers
    strips, setStrips,
    viewBox, setViewBox,
    svgText, setSvgText,
    hidden, setHidden,
    layers, setLayers,
    density, setDensity,
    pxPerMm, setPxPerMm,
    editCounts, setEditCounts,
    stripCountOverrides, setStripCountOverrides,
    stripDensities, setStripDensities,
    layerGroups, setLayerGroups,
    layerOrder, setLayerOrder,
    projectRevision,
    patchBoard, setPatchBoard, updatePatchBoard,
    pushLayoutHistory, undoLayout, redoLayout,
    selection,
    selectStrip, selectStrips, toggleStripSel, selectLayer,
    selectPaths, togglePathSel, clearLayoutSelection, renameLayoutSelection,
    serializeProject, loadProject,
    // pattern state for the preview frame
    activePatternId, palette, bpm,
    masterSpeed, masterBrightness, masterSaturation, masterHueShift,
    gammaEnabled, gammaValue, patternParams, symSettings,
    // selection derived views
    selectedStripIds, selStripId, pathSel, pathSelName, stripSelectionName, selLayerId,
    selLayer, existingStrip,
    orderedStrips,
    // shared refs + helpers
    svgRef, artworkRef, vpRef, stripListRef, stripsRef, pxPerMmRef,
    colorIdxRef, nextColor, scrollToStrip, rebuildStrip, makeStrip, stripGroupMember,
    doUndo, doRedo,
  };

  // ── Concern hooks (stable call order) ──────────────────────────────────────
  const size = useLayoutSize(ctx);
  const stripsApi = useLayoutStrips(ctx);
  const artworkApi = useLayoutArtwork(ctx, { getLedCount: size.getLedCount });
  const wireApi = useLayoutWire(ctx);
  const canvas = useLayoutCanvasInteraction(ctx, { stripsApi, artworkApi, wireApi });
  const importApi = useLayoutImport(ctx, {
    resetView: canvas.resetView,
    setDrawMode: canvas.setDrawMode,
    setWaypoints: canvas.setWaypoints,
  });

  const createStarterPrimitive = (type, requestedCount, requestedDensity, requestedLengthM) => {
    const count = clampLedCount(requestedCount ?? (totalLeds || DEFAULT_STARTER_PIXEL_COUNT));
    const reelDensity = Number.isFinite(Number(requestedDensity)) && Number(requestedDensity) > 0
      ? Number(requestedDensity)
      : density;
    const definition = createPrimitiveStripDefinition({
      type,
      viewBox,
      pixelCount: count,
      color: nextColor(),
    });
    const physicalLength = Number.isFinite(Number(requestedLengthM)) && Number(requestedLengthM) > 0
      ? Number(requestedLengthM)
      : count / reelDensity;
    const targetLength = physicalLength * 1000 * pxPerMm;
    const sized = definition.svgLength > 0 && Number.isFinite(targetLength)
      ? scaleStripGeometry(definition, targetLength / definition.svgLength)
      : definition;
    const strip = rebuildStrip({ ...sized, pixelCount: count });
    replaceLayoutGeometry([strip]);
    setStripDensities({ [strip.id]: reelDensity });
    selectStrip(strip.id);
    setExpandedStrips(current => ({ ...current, [strip.id]: true }));
  };

  const clearStarterLayout = () => {
    replaceLayoutGeometry([]);
    clearLayoutSelection();
  };

  // ── Flat bundle ────────────────────────────────────────────────────────────
  return {
    // context passthroughs the JSX reads directly
    strips, layers, hidden, setHidden,
    viewBox, svgText, density, pxPerMm,
    editCounts, setEditCounts, layerGroups, layerOrder, setLayers,
    patchBoard,
    selectStrip, selectLayer, selectPaths, toggleStripSel,
    clearLayoutSelection, renameLayoutSelection,
    layoutHistLen, layoutFutLen,
    usbLedConnected,

    // composer-level derived + shared
    doUndo, doRedo,
    selLayer, existingStrip,
    selStripId, selLayerId, selectedStripIds,
    pathSel, pathSelName, stripSelectionName,
    orderedStrips, selectedStrips,
    totalLeds, starterLayoutActive, usbLedMaxPixels,
    createStarterPrimitive, clearStarterLayout,
    expandedStrips, setExpandedStrips,
    svgRef, artworkRef, vpRef, stripListRef,

    // concern hooks
    ...size,
    ...stripsApi,
    ...artworkApi,
    ...wireApi,
    ...canvas,
    ...importApi,
  };
}
