export function normalizeStripPixelCount(strip = {}) {
  const parsed = Number.parseInt(strip.pixelCount, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (Array.isArray(strip.pixels) && strip.pixels.length > 0) return strip.pixels.length;
  return 1;
}

export function shouldRebuildStripPixels(strip = {}) {
  if (!strip.pathData) return false;
  const expected = normalizeStripPixelCount(strip);
  return !Array.isArray(strip.pixels) || strip.pixels.length !== expected;
}
