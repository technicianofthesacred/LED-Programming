import { useState, useRef, useCallback } from 'react';
import { svgPt } from '../../../lib/layoutGeometry.js';
import {
  applyPatchRouteOrder,
  cutsForStrip,
  deleteStripCut,
  normalizePatchBoard,
  nudgeStripCut,
  sliceStripIntoPatchesPreservingRoute,
} from '../../../lib/patchBoard.js';

// Wire-mode overlay: chop (split), link (route order), cut selection + nudge.
// Reads the shared layout bundle (patchBoard, strips, svgRef, updatePatchBoard).
export function useLayoutWire(ctx) {
  const {
    strips,
    patchBoard,
    updatePatchBoard,
    selectStrip,
    svgRef,
  } = ctx;

  const [wireOverlayMode, setWireOverlayMode] = useState('idle');
  const [selectedWireCut, setSelectedWireCut] = useState(null);
  const [selectedWirePatchId, setSelectedWirePatchId] = useState(null);
  const [linkRouteIds, setLinkRouteIds] = useState([]);
  const linkRouteStartedRef = useRef(false);

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
  }, [svgRef]);

  const chopStripAtEvent = useCallback((event, strip) => {
    if (!strip || patchBoard?.physicalLocked) return;
    const cutLed = nearestLedIndex(event, strip);
    if (cutLed === null) return;
    const currentCuts = cutsForStrip(normalizePatchBoard(patchBoard, strips), strip.id);
    const nextCuts = [...new Set([...currentCuts, cutLed])].sort((a, b) => a - b);
    updatePatchBoard(next => sliceStripIntoPatchesPreservingRoute(next, strip, nextCuts));
    selectStrip(strip.id);
    setSelectedWireCut({ stripId: strip.id, cutLed });
    setSelectedWirePatchId(null);
  }, [nearestLedIndex, patchBoard, strips, updatePatchBoard, selectStrip]);

  const toggleRoutePatch = useCallback((patchId) => {
    if (wireOverlayMode !== 'link' || patchBoard?.physicalLocked) return;
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
  }, [patchBoard, updatePatchBoard, wireOverlayMode]);

  const nudgeSelectedWireCut = useCallback((delta) => {
    if (!selectedWireCut) return;
    const strip = strips.find(item => item.id === selectedWireCut.stripId);
    if (!strip) return;
    const step = Math.sign(Number(delta) || 0);
    if (!step) return;
    const board = normalizePatchBoard(patchBoard, strips);
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
  }, [patchBoard, selectedWireCut, strips, updatePatchBoard]);

  const deleteSelectedWireCut = useCallback(() => {
    if (!selectedWireCut) return;
    const strip = strips.find(item => item.id === selectedWireCut.stripId);
    if (!strip) return;
    updatePatchBoard(next => deleteStripCut(next, strip, selectedWireCut.cutLed));
    setSelectedWireCut(null);
  }, [selectedWireCut, strips, updatePatchBoard]);

  return {
    wireOverlayMode, setWireOverlayMode,
    selectedWireCut, setSelectedWireCut,
    selectedWirePatchId, setSelectedWirePatchId,
    linkRouteIds, setLinkRouteIds,
    linkRouteStartedRef,
    nearestLedIndex,
    chopStripAtEvent,
    toggleRoutePatch,
    nudgeSelectedWireCut,
    deleteSelectedWireCut,
  };
}
