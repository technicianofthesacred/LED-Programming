import {
  compileKaleidoscopePixelContext,
  normalizeKaleidoscope,
} from './kaleidoscope.js';

function plainContext(sourceProgress) {
  return {
    reflectionProgress: sourceProgress,
    kaleidoscopeProgress: sourceProgress,
    reflectionDistance: 1,
    reflectionSegment: 0,
    reflectionPoint: null,
    isReflectionPoint: false,
  };
}

export function normalizeProjectRenderStrips(strips, { hidden = {}, includeHidden = false } = {}) {
  return (Array.isArray(strips) ? strips : []).flatMap(strip => {
    if (!strip) return [];
    const isHidden = Boolean(hidden?.[strip.id] || strip.hidden);
    if (isHidden && !includeHidden) return [];
    const pixels = Array.isArray(strip.pixels)
      ? strip.pixels
      : Array.isArray(strip.pts)
        ? strip.pts
        : [];
    if (!pixels.length) return [];
    const pixelCount = pixels.length;
    const normalized = normalizeKaleidoscope(strip.kaleidoscope, pixelCount);
    const kaleidoscopeContext = normalized.enabled
      ? compileKaleidoscopePixelContext(normalized.value, pixelCount)
      : null;
    const pts = pixels.map((pixel, index) => {
      const sourceProgress = pixelCount > 1 ? index / (pixelCount - 1) : 0.5;
      const reflection = kaleidoscopeContext
        ? kaleidoscopeContext.pixelContexts[index]
        : plainContext(sourceProgress);
      return {
        ...pixel,
        x: Number(pixel?.x) || 0,
        y: Number(pixel?.y) || 0,
        i: index,
        p: sourceProgress,
        sourceProgress,
        hasKaleidoscope: Boolean(kaleidoscopeContext),
        kaleidoscopePoints: kaleidoscopeContext?.points || normalized.points,
        ...reflection,
      };
    });
    return [{
      ...strip,
      hidden: isHidden,
      pts,
      kaleidoscopeContext,
    }];
  });
}
