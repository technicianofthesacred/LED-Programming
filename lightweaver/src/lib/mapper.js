/**
 * mapper.js — SVG path → equidistant pixel coordinates
 *
 * Uses the browser's native SVGPathElement API:
 *   getTotalLength()      arc length of the path
 *   getPointAtLength(t)   point at distance t along the path
 *
 * The path element must be live in the document for these to work
 * (which is always true since CanvasManager keeps paths in the SVG).
 */

/**
 * Sample `pixelCount` evenly-spaced points along a live SVG path element.
 * Returns an array of { x, y, index } — index starts at 0, reassigned by
 * assignIndices() once all strips are known.
 *
 * @param {SVGPathElement} pathEl
 * @param {number} pixelCount
 * @returns {{ x: number, y: number, index: number }[]}
 */
export function samplePath(pathEl, pixelCount) {
  if (pixelCount < 1) return [];
  const totalLen = pathEl.getTotalLength();
  const pixels = [];
  for (let i = 0; i < pixelCount; i++) {
    // For a single pixel place it at the midpoint; otherwise distribute evenly
    const t  = pixelCount === 1 ? 0.5 : i / (pixelCount - 1);
    const pt = pathEl.getPointAtLength(t * totalLen);
    pixels.push({ x: pt.x, y: pt.y, index: 0 });
  }
  return pixels;
}

/**
 * Walk all strips in order and stamp sequential global indices onto every pixel.
 * Mutates in place. Call after any strip add/remove/reorder.
 *
 * @param {{ pixels: { index: number }[] }[]} strips
 */
export function assignIndices(strips) {
  let idx = 0;
  strips.forEach(strip => {
    strip.pixels.forEach(px => { px.index = idx++; });
  });
}

/**
 * Flatten all strip pixel arrays into a single ordered array.
 *
 * @param {{ pixels: object[] }[]} strips
 * @returns {object[]}
 */
export function getAllPixels(strips) {
  return strips.flatMap(s => s.pixels);
}

if (import.meta.hot) import.meta.hot.accept();
