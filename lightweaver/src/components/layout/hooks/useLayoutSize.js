import { useState, useCallback } from 'react';
import { recountStrips, svgPathLength } from '../../../lib/layoutGeometry.js';

// Size mode logic: artwork density / real-world scale / per-strip counts.
// `ctx` is the shared layout bundle assembled by useLayoutState.
export function useLayoutSize(ctx) {
  const {
    strips, setStrips,
    editCounts, setEditCounts,
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

  const resampleStrip = useCallback((id, newCount) => {
    setStrips(prev => prev.map(s => s.id === id ? rebuildStrip({ ...s, pixelCount: newCount }) : s));
  }, [setStrips, rebuildStrip]);

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

  return {
    scaleUnit, setScaleUnit,
    getLedCount,
    resampleStrip,
    handleDensityChange,
    handleScaleChange,
    calibrateScaleFromStrip,
  };
}
