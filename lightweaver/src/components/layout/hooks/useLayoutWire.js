import { useState, useRef, useCallback } from 'react';
import { svgPt } from '../../../lib/layoutGeometry.js';
import { useProject } from '../../../state/ProjectContext.jsx';

export function useLayoutWire(ctx) {
  const { strips, selectStrip, svgRef } = ctx;
  const { wiring, updateWiring } = useProject();
  const [wireOverlayMode, setWireOverlayMode] = useState('idle');
  const [selectedWireCut, setSelectedWireCut] = useState(null);
  const [selectedWirePatchId, setSelectedWirePatchId] = useState(null);
  const [linkRouteIds, setLinkRouteIds] = useState([]);
  const linkRouteStartedRef = useRef(false);

  const nearestLedIndex = useCallback((event, strip) => {
    if (!svgRef.current || !strip?.pixels?.length) return null;
    const point = svgPt(svgRef.current, event.clientX, event.clientY);
    let nearestIndex = 0;
    let distance = Infinity;
    strip.pixels.forEach((pixel, index) => {
      const next = Math.hypot(point.x - pixel.x, point.y - pixel.y);
      if (next < distance) { distance = next; nearestIndex = index; }
    });
    return Math.max(0, Math.min(strip.pixels.length - 2, nearestIndex));
  }, [svgRef]);

  const chopStripAtEvent = useCallback((event, strip) => {
    if (!strip || wiring.locked) return;
    const cutLed = nearestLedIndex(event, strip);
    if (cutLed == null) return;
    const result = updateWiring(draft => {
      const run = draft.runs.find(item => item.type === 'strip' && item.source.stripId === strip.id && cutLed >= item.source.from && cutLed < item.source.to);
      if (!run) throw new Error('Choose a point inside a physical run.');
      const left = { ...run, id: `${run.id}-a-${cutLed}`, source: { ...run.source, to: cutLed }, verified: false };
      const right = { ...run, id: `${run.id}-b-${cutLed + 1}`, source: { ...run.source, from: cutLed + 1 }, verified: false };
      draft.runs.splice(draft.runs.indexOf(run), 1, left, right);
      draft.outputs.forEach(output => {
        const index = output.runIds.indexOf(run.id);
        if (index >= 0) output.runIds.splice(index, 1, left.id, right.id);
      });
    }, { changeKind: 'seam' });
    if (!result.ok) return;
    selectStrip(strip.id);
    setSelectedWireCut({ stripId: strip.id, cutLed });
  }, [nearestLedIndex, selectStrip, updateWiring, wiring.locked]);

  const deleteSelectedWireCut = useCallback(() => {
    if (!selectedWireCut || wiring.locked) return;
    const { stripId, cutLed } = selectedWireCut;
    updateWiring(draft => {
      const left = draft.runs.find(run => run.type === 'strip' && run.source.stripId === stripId && run.source.to === cutLed);
      const right = draft.runs.find(run => run.type === 'strip' && run.source.stripId === stripId && run.source.from === cutLed + 1);
      if (!left || !right) throw new Error('The selected split no longer exists.');
      const merged = { ...left, id: `run-${stripId}-${left.source.from}-${right.source.to}`, source: { ...left.source, to: right.source.to }, verified: false };
      draft.runs = draft.runs.filter(run => run.id !== left.id && run.id !== right.id);
      draft.runs.push(merged);
      draft.outputs.forEach(output => {
        const index = output.runIds.indexOf(left.id);
        output.runIds = output.runIds.filter(id => id !== left.id && id !== right.id);
        if (index >= 0) output.runIds.splice(index, 0, merged.id);
      });
    }, { changeKind: 'seam' });
    setSelectedWireCut(null);
  }, [selectedWireCut, updateWiring, wiring.locked]);

  const nudgeSelectedWireCut = useCallback(delta => {
    if (!selectedWireCut || wiring.locked) return;
    const next = selectedWireCut.cutLed + Math.sign(delta);
    updateWiring(draft => {
      const left = draft.runs.find(run => run.type === 'strip' && run.source.stripId === selectedWireCut.stripId && run.source.to === selectedWireCut.cutLed);
      const right = draft.runs.find(run => run.type === 'strip' && run.source.stripId === selectedWireCut.stripId && run.source.from === selectedWireCut.cutLed + 1);
      if (!left || !right || next < left.source.from || next >= right.source.to) throw new Error('Split cannot move beyond its neighboring run.');
      left.source.to = next;
      right.source.from = next + 1;
    }, { changeKind: 'seam' });
    setSelectedWireCut({ ...selectedWireCut, cutLed: next });
  }, [selectedWireCut, updateWiring, wiring.locked]);

  const toggleRoutePatch = useCallback(runId => {
    if (wireOverlayMode !== 'link' || wiring.locked) return;
    setLinkRouteIds(previous => {
      const route = linkRouteStartedRef.current ? previous : [];
      const next = route.includes(runId) ? route.filter(id => id !== runId) : [...route, runId];
      linkRouteStartedRef.current = true;
      updateWiring(draft => {
        const output = draft.outputs.find(item => item.runIds.includes(runId)) || draft.outputs[0];
        const rest = output.runIds.filter(id => !next.includes(id));
        output.runIds = [...next, ...rest];
      }, { changeKind: 'route' });
      setSelectedWirePatchId(runId);
      return next;
    });
  }, [updateWiring, wireOverlayMode, wiring.locked]);

  return {
    wireOverlayMode, setWireOverlayMode,
    selectedWireCut, setSelectedWireCut,
    selectedWirePatchId, setSelectedWirePatchId,
    linkRouteIds, setLinkRouteIds, linkRouteStartedRef,
    nearestLedIndex, chopStripAtEvent, toggleRoutePatch,
    nudgeSelectedWireCut, deleteSelectedWireCut,
  };
}
