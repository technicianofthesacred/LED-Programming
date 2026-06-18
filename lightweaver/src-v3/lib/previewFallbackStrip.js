export function makePreviewFallbackStrip(viewBox = '0 0 640 400', { pixelCount = 30 } = {}) {
  const rect = parseViewBox(viewBox);
  const count = clampInt(pixelCount, 30, 1, 300);
  const y = rect.y + rect.h / 2;
  const startX = rect.x + rect.w * 0.12;
  const endX = rect.x + rect.w * 0.88;
  const pixels = Array.from({ length: count }, (_, index) => {
    const t = count > 1 ? index / (count - 1) : 0.5;
    return {
      x: startX + (endX - startX) * t,
      y,
      index,
      stripProgress: t,
    };
  });

  return {
    id: 'preview-fallback',
    name: 'Preview strip',
    pixelCount: count,
    pixels,
    pathData: `M${startX} ${y} L${endX} ${y}`,
    color: 'var(--accent)',
    previewOnly: true,
  };
}

function parseViewBox(viewBox) {
  const parts = String(viewBox || '').trim().split(/[\s,]+/).map(Number);
  const [x, y, w, h] = parts;
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    w: Number.isFinite(w) && w > 0 ? w : 640,
    h: Number.isFinite(h) && h > 0 ? h : 400,
  };
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
