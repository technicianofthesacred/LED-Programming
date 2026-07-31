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

/**
 * Build a physical RGB frame whose address space never changes when a section
 * is hidden. Unspecified LEDs remain black.
 *
 * @param {number} pixelCount
 * @param {{ index: number }[]} [visiblePixels]
 * @param {(pixel: object, visibleIndex: number) => {r:number,g:number,b:number}} [colorForPixel]
 */
export function createPhysicalFrame(pixelCount, visiblePixels = [], colorForPixel = () => ({ r: 0, g: 0, b: 0 })) {
  const frame = new Uint8Array(Math.max(0, pixelCount) * 3);
  visiblePixels.forEach((pixel, visibleIndex) => {
    const physicalIndex = Number(pixel?.index);
    if (!Number.isInteger(physicalIndex) || physicalIndex < 0 || physicalIndex >= pixelCount) return;
    const color = colorForPixel(pixel, visibleIndex) || {};
    const offset = physicalIndex * 3;
    frame[offset] = clampByte(color.r);
    frame[offset + 1] = clampByte(color.g);
    frame[offset + 2] = clampByte(color.b);
  });
  return frame;
}

function clampByte(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(255, Math.round(numeric)));
}

if (import.meta.hot) import.meta.hot.accept();
