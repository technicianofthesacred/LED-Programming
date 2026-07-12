import { useState, useCallback } from 'react';
import { recountStrips, svgPathLength } from '../../../lib/layoutGeometry.js';

// Size mode logic: artwork density / real-world scale / per-strip counts.
// `ctx` is the shared layout bundle assembled by useLayoutState.
export function useLayoutSize(ctx) {
  const {
    strips, setStrips,
    editCounts, setEditCounts,
    stripCountOverrides, setStripCountOverrides,
    density, setDensity,
    pxPerMm, setPxPerMm,
    pushLayoutHistory,
    rebuildStrip,
  } = ctx;

  // 'cm' | 'in' — display unit for the artwork Size control
  const [scaleUnit, setScaleUnit] = useState('cm');

  const getLedCount = (layer) => {
    if (editCounts[layer.layerId] != null) return editCounts[layer.layerId];
    return Math.max(1, Math.round((layer.svgLength / pxPerMm) * density / 1000));
  };

  // Compute a strip's LED count from the current density/scale (canonical formula).
  const computeStripCount = useCallback((strip) => {
    const scale = Number.isFinite(pxPerMm) && pxPerMm > 0 ? pxPerMm : 3.7795;
    const len = (Number.isFinite(strip.svgLength) && strip.svgLength > 0)
      ? strip.svgLength : svgPathLength(strip.pathData);
    return { len, count: Math.max(1, Math.round((len / scale) * density / 1000)) };
  }, [pxPerMm, density]);

  // Re-sample a strip to `newCount` without touching the override map. Used by
  // the per-layer inspector (whose manual counts ride in `editCounts`, not the
  // per-strip override map).
  const resampleStrip = useCallback((id, newCount) => {
    setStrips(prev => prev.map(s => s.id === id ? rebuildStrip({ ...s, pixelCount: newCount }) : s));
  }, [setStrips, rebuildStrip]);

  // Manual per-strip count: re-sample the strip AND flag it overridden so that
  // density / scale / calibrate rescales leave its count alone. This is the
  // handler behind the per-strip count controls in Size mode and Draw mode's
  // strip detail.
  const setStripCount = useCallback((id, newCount) => {
    resampleStrip(id, newCount);
    setStripCountOverrides(prev => (prev[id] ? prev : { ...prev, [id]: true }));
  }, [resampleStrip, setStripCountOverrides]);

  // Clear a strip's override and recompute its count from the current density/scale.
  const resetStripCount = useCallback((id) => {
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
  }, [setStrips, setStripCountOverrides, rebuildStrip, computeStripCount]);

  const handleDensityChange = useCallback((newDensity) => {
    pushLayoutHistory();
    setStrips(prev => recountStrips(prev, pxPerMm, newDensity, stripCountOverrides));
    setEditCounts({});
    setDensity(newDensity);
  }, [pxPerMm, stripCountOverrides, setStrips, setEditCounts, setDensity, pushLayoutHistory]);

  const handleScaleChange = useCallback((nextPxPerMm) => {
    pushLayoutHistory();
    setStrips(prev => recountStrips(prev, nextPxPerMm, density, stripCountOverrides));
    setEditCounts({});
    setPxPerMm(nextPxPerMm);
  }, [density, stripCountOverrides, setStrips, setEditCounts, setPxPerMm, pushLayoutHistory]);

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
    // nextPxPerMm = (len * density) / (count * 1000). Substituting back into the
    // recount formula recovers exactly `count` for this strip (round(count) ===
    // count), so its count never drifts — no override required.
    const nextPxPerMm = (len * density) / (count * 1000);
    if (!Number.isFinite(nextPxPerMm) || nextPxPerMm <= 0) return;
    pushLayoutHistory();
    setStrips(prev => recountStrips(prev, nextPxPerMm, density, stripCountOverrides));
    setPxPerMm(nextPxPerMm);
    setEditCounts({});
  }, [strips, density, stripCountOverrides, setStrips, setPxPerMm, setEditCounts, pushLayoutHistory]);

  return {
    scaleUnit, setScaleUnit,
    getLedCount,
    resampleStrip,
    setStripCount,
    resetStripCount,
    stripCountOverrides,
    handleDensityChange,
    handleScaleChange,
    calibrateScaleFromStrip,
  };
}
