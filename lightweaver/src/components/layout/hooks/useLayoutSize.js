import { useState, useCallback } from 'react';
import {
  clampLedCount,
  recountStrips,
  svgPathLength,
} from '../../../lib/layoutGeometry.js';
import { scaleStripGeometry } from '../../../lib/stripScale.js';

// Geometry clamps — keep in lockstep with useLayoutStrips.js (scaleStrip),
// which owns the same bounds for the Draw-mode − / + resize control.
const MIN_STRIP_SVG_LENGTH = 20;

// Size mode logic: the physical strips are the ground truth. Each strip has a
// real length (metres) and a reel density (LEDs/m, `stripDensities[id]`,
// falling back to the global `density` default); counts and drawn geometry
// derive from those. `ctx` is the shared layout bundle from useLayoutState.
export function useLayoutSize(ctx) {
  const {
    strips, setStrips,
    viewBox,
    editCounts, setEditCounts,
    stripCountOverrides, setStripCountOverrides,
    stripDensities, setStripDensities,
    density, setDensity,
    pxPerMm, setPxPerMm,
    pushLayoutHistory,
    rebuildStrip,
  } = ctx;

  // 'cm' | 'in' — display unit for the drawing-scale control
  const [scaleUnit, setScaleUnit] = useState('cm');

  const getLedCount = (layer) => {
    if (editCounts[layer.layerId] != null) return editCounts[layer.layerId];
    return Math.max(1, Math.round((layer.svgLength / pxPerMm) * density / 1000));
  };

  // The density a strip actually counts at: its own reel density if declared,
  // else the global default.
  const stripDensity = useCallback(
    (id) => (Number.isFinite(stripDensities[id]) && stripDensities[id] > 0 ? stripDensities[id] : density),
    [stripDensities, density],
  );

  // Compute a strip's LED count from its density + the current scale (canonical formula).
  const computeStripCount = useCallback((strip) => {
    const scale = Number.isFinite(pxPerMm) && pxPerMm > 0 ? pxPerMm : 3.7795;
    const len = (Number.isFinite(strip.svgLength) && strip.svgLength > 0)
      ? strip.svgLength : svgPathLength(strip.pathData);
    return { len, count: Math.max(1, Math.round((len / scale) * stripDensity(strip.id) / 1000)) };
  }, [pxPerMm, stripDensity]);

  // Re-sample a strip to `newCount` without touching the override map. Used by
  // the per-layer inspector (whose manual counts ride in `editCounts`, not the
  // per-strip override map).
  const resampleStrip = useCallback((id, newCount) => {
    setStrips(prev => prev.map(s => s.id === id ? rebuildStrip({ ...s, pixelCount: newCount }) : s));
  }, [setStrips, rebuildStrip]);

  // Manual per-strip count: re-sample the strip AND flag it overridden so that
  // density / scale / calibrate rescales leave its count alone. This is the
  // handler behind the per-strip count fine-tune controls in Size mode and
  // Draw mode's strip detail.
  const setStripCount = useCallback((id, newCount) => {
    pushLayoutHistory();
    resampleStrip(id, newCount);
    setStripCountOverrides(prev => (prev[id] ? prev : { ...prev, [id]: true }));
  }, [resampleStrip, setStripCountOverrides, pushLayoutHistory]);

  const setStripCounts = useCallback((updates = [], { recordHistory = true } = {}) => {
    const counts = new Map(updates.map(({ id, count }) => [id, Math.max(1, Math.round(Number(count) || 1))]));
    if (!counts.size) return;
    if (recordHistory) pushLayoutHistory();
    setStrips(prev => prev.map(strip => counts.has(strip.id)
      ? rebuildStrip({ ...strip, pixelCount: counts.get(strip.id) })
      : strip));
    setStripCountOverrides(prev => {
      const next = { ...prev };
      for (const id of counts.keys()) next[id] = true;
      return next;
    });
  }, [pushLayoutHistory, setStrips, rebuildStrip, setStripCountOverrides]);

  // Clear a strip's override and recompute its count from its density + scale.
  const resetStripCount = useCallback((id) => {
    pushLayoutHistory();
    setStripCountOverrides(prev => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setStrips(prev => prev.map(s => {
      if (s.id !== id) return s;
      const { len, count } = computeStripCount(s);
      return rebuildStrip({ ...s, svgLength: len, pixelCount: count });
    }));
  }, [setStrips, setStripCountOverrides, rebuildStrip, computeStripCount, pushLayoutHistory]);

  // ── The inverted sizing model ─────────────────────────────────────────────
  // Declare a strip's physical truth: how long the purchased strip is
  // (`lengthM`, metres) and/or the reel density it was cut from (`ledsPerM`).
  // The LED count derives (round(length × density)) and the drawn geometry is
  // rescaled about its own center so svgLength = lengthM · 1000 · pxPerMm.
  // An explicitly typed physical length is the maker's source of truth. Keep a
  // tiny lower bound so the path remains drawable, but do not cap it to the
  // imported artwork's dimensions: installations routinely extend beyond the
  // artwork used to plan them.
  const setStripPhysical = useCallback((id, { lengthM, ledsPerM } = {}) => {
    const strip = strips.find(s => s.id === id);
    if (!strip) return;
    const scale = Number.isFinite(pxPerMm) && pxPerMm > 0 ? pxPerMm : 3.7795;
    const nextDensity = Number.isFinite(ledsPerM) && ledsPerM > 0 ? ledsPerM : stripDensity(id);
    const currentLen = (Number.isFinite(strip.svgLength) && strip.svgLength > 0)
      ? strip.svgLength : svgPathLength(strip.pathData);
    if (!(currentLen > 0)) return;

    let targetLen = Number.isFinite(lengthM) && lengthM > 0 ? lengthM * 1000 * scale : currentLen;
    targetLen = Math.max(targetLen, MIN_STRIP_SVG_LENGTH);

    // Count follows the ACHIEVED length so length · density · count never
    // disagree, even when the geometry clamp bites.
    const count = clampLedCount(Math.round((targetLen / scale) * nextDensity / 1000));

    pushLayoutHistory();
    setStripDensities(prev => (prev[id] === nextDensity ? prev : { ...prev, [id]: nextDensity }));
    setStrips(prev => prev.map(s => {
      if (s.id !== id) return s;
      const len = (Number.isFinite(s.svgLength) && s.svgLength > 0)
        ? s.svgLength : svgPathLength(s.pathData);
      const factor = len > 0 ? targetLen / len : 1;
      const scaled = factor !== 1
        ? scaleStripGeometry({ ...s, svgLength: len }, factor)
        : { ...s, svgLength: len };
      return rebuildStrip({ ...scaled, pixelCount: count });
    }));
    // The physical declaration IS the count's source of truth — ride the
    // override path so global density / scale changes leave it alone.
    setStripCountOverrides(prev => (prev[id] ? prev : { ...prev, [id]: true }));
  }, [strips, pxPerMm, viewBox, stripDensity, pushLayoutHistory, setStripDensities, setStrips, rebuildStrip, setStripCountOverrides]);

  const handleDensityChange = useCallback((newDensity) => {
    pushLayoutHistory();
    setStrips(prev => recountStrips(prev, pxPerMm, newDensity, stripCountOverrides, stripDensities));
    setEditCounts({});
    setDensity(newDensity);
  }, [pxPerMm, stripCountOverrides, stripDensities, setStrips, setEditCounts, setDensity, pushLayoutHistory]);

  const handleScaleChange = useCallback((nextPxPerMm) => {
    pushLayoutHistory();
    setStrips(prev => recountStrips(prev, nextPxPerMm, density, stripCountOverrides, stripDensities));
    setEditCounts({});
    setPxPerMm(nextPxPerMm);
  }, [density, stripCountOverrides, stripDensities, setStrips, setEditCounts, setPxPerMm, pushLayoutHistory]);

  // Calibrate the whole piece's scale from one strip's counted LEDs. The
  // calibrating strip is NOT marked overridden: pxPerMm is back-solved so this
  // strip's count is stable through the recount that follows (exact by
  // construction — see below), so no override is needed to hold it. Existing
  // overrides on OTHER strips are honoured (they keep their manual counts).
  const calibrateScaleFromStrip = useCallback((stripId, realCount) => {
    const strip = strips.find(s => s.id === stripId);
    if (!strip) return;
    const len = (Number.isFinite(strip.svgLength) && strip.svgLength > 0)
      ? strip.svgLength : svgPathLength(strip.pathData);
    const count = Math.max(1, Math.round(Number(realCount)));
    if (!len || !Number.isFinite(count)) return;
    // nextPxPerMm = (len * density) / (count * 1000), with THIS strip's reel
    // density. Substituting back into the recount formula recovers exactly
    // `count` for this strip (round(count) === count), so its count never
    // drifts — no override required.
    const nextPxPerMm = (len * stripDensity(stripId)) / (count * 1000);
    if (!Number.isFinite(nextPxPerMm) || nextPxPerMm <= 0) return;
    pushLayoutHistory();
    setStrips(prev => recountStrips(prev, nextPxPerMm, density, stripCountOverrides, stripDensities));
    setPxPerMm(nextPxPerMm);
    setEditCounts({});
  }, [strips, density, stripDensity, stripCountOverrides, stripDensities, setStrips, setPxPerMm, setEditCounts, pushLayoutHistory]);

  return {
    scaleUnit, setScaleUnit,
    getLedCount,
    resampleStrip,
    setStripCount,
    setStripCounts,
    resetStripCount,
    stripCountOverrides,
    stripDensities,
    stripDensity,
    setStripPhysical,
    handleDensityChange,
    handleScaleChange,
    calibrateScaleFromStrip,
  };
}
