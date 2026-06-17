/**
 * export.js — serialise pixel maps to WLED / Coordinate / FastLED / CSV formats
 *
 * Two distinct JSON shapes are produced:
 *
 *  1. WLED ledmap.json (stock WLED 0.15) — an INDEX-based map:
 *       { "width": W, "height": H, "map": [i0, i1, ...] }
 *     `map` is a flat W*H array where the POSITION is the virtual/grid cell
 *     (row-major) and the VALUE is the physical LED index, or -1 for a gap.
 *     Upload via WLED web UI → Config → LED Preferences → 2D matrix → Custom
 *     ledmap (or place /ledmap.json on the controller filesystem).
 *
 *  2. Coordinate map (Lightweaver / Pixelblaze) — a normalized coordinate map:
 *       { "n": <totalLEDs>, "map": [[x,y], [x,y], ...] }
 *     One [x,y] pair per physical LED in draw order. This is NOT a valid stock
 *     WLED ledmap; it is consumed by Lightweaver firmware / Pixelblaze-style
 *     coordinate mappers.
 *
 * Coordinates are in draw order (strip 0 pixel 0, strip 0 pixel 1, ... strip 1 pixel 0, ...)
 */

/**
 * @typedef {{ x: number, y: number, index: number }} Pixel
 * @typedef {{ normalize?: boolean, scaleX?: number, scaleY?: number, offsetX?: number, offsetY?: number }} ExportOpts
 */

/**
 * Coordinate map (Lightweaver / Pixelblaze): normalized [x,y] pairs in draw order.
 *
 * @param {Pixel[]} pixels
 * @param {ExportOpts} opts
 * @returns {string}  pretty-printed JSON
 */
export function toCoordinateMap(pixels, opts = {}) {
  const {
    normalize = true,
    scaleX  = 1, scaleY  = 1,
    offsetX = 0, offsetY = 0,
  } = opts;

  // Sort by index to guarantee order
  const sorted = [...pixels].sort((a, b) => a.index - b.index);
  let coords = sorted.map(px => [px.x, px.y]);

  if (normalize && coords.length > 0) {
    const xs = coords.map(c => c[0]);
    const ys = coords.map(c => c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const rangeX = maxX - minX || 1; // avoid /0 for collinear vertical/horizontal strips
    const rangeY = maxY - minY || 1;
    coords = coords.map(([x, y]) => [
      (x - minX) / rangeX,
      (y - minY) / rangeY,
    ]);
  }

  const map = coords.map(([x, y]) => [
    r2(x * scaleX + offsetX),
    r2(y * scaleY + offsetY),
  ]);

  return JSON.stringify({ n: pixels.length, map }, null, 2);
}

/**
 * Backwards-compatible alias. Historically `toWLEDLedmap` emitted the
 * coordinate map, which is NOT a valid stock WLED ledmap. Kept so existing
 * imports/tests don't break; new code should call `toCoordinateMap` or
 * `toWLEDIndexMap` explicitly.
 * @deprecated use toCoordinateMap (coordinate) or toWLEDIndexMap (true WLED)
 */
export const toWLEDLedmap = toCoordinateMap;

/**
 * True stock-WLED ledmap.json — quantizes physical LED coordinates onto a
 * W×H grid and emits a flat index map (value = physical LED index, -1 = gap).
 *
 * Grid sizing: we fit the LARGER physical dimension to a target of ~64 cells
 * (a sensible default density for a single ESP32-S3 install that keeps the
 * grid well under WLED's matrix limits), and derive the other dimension from
 * the artwork aspect ratio. The grid is also capped so total cells never
 * wildly exceed the LED count (a grid much larger than needed just wastes
 * matrix slots), and is never smaller than what's needed to hold every LED.
 *
 * Collision handling: each LED is placed in its nearest cell; if that cell is
 * already taken, we spiral outward to the nearest FREE cell so no LED is lost.
 *
 * @param {Pixel[]} pixels
 * @param {ExportOpts & { targetCells?: number }} opts
 * @returns {string}  pretty-printed JSON
 */
export function toWLEDIndexMap(pixels, opts = {}) {
  const sorted = [...pixels].sort((a, b) => a.index - b.index);
  const n = sorted.length;
  if (n === 0) return JSON.stringify({ width: 0, height: 0, map: [] }, null, 2);

  const xs = sorted.map(p => p.x);
  const ys = sorted.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = (maxX - minX) || 1;
  const rangeY = (maxY - minY) || 1;

  // Choose grid size from aspect ratio. Fit the larger dimension to ~64 cells
  // by default; derive the shorter side from the aspect ratio.
  const TARGET = Math.max(2, opts.targetCells || 64);
  let W, H;
  if (rangeX >= rangeY) {
    W = TARGET;
    H = Math.max(1, Math.round(TARGET * (rangeY / rangeX)));
  } else {
    H = TARGET;
    W = Math.max(1, Math.round(TARGET * (rangeX / rangeY)));
  }

  // Guarantee enough cells to hold every LED (handles dense strips on a
  // near-1D layout where one axis collapses to a single row/column).
  while (W * H < n) {
    if (W <= H) W++; else H++;
  }

  const total = W * H;
  const map = new Array(total).fill(-1);

  // Quantize a physical coordinate to a grid cell (col,row).
  const cellOf = (x, y) => {
    const gx = Math.round(((x - minX) / rangeX) * (W - 1));
    const gy = Math.round(((y - minY) / rangeY) * (H - 1));
    return [clamp(gx, 0, W - 1), clamp(gy, 0, H - 1)];
  };

  // Find nearest free cell by spiralling outward from (cx,cy).
  const nearestFree = (cx, cy) => {
    if (map[cy * W + cx] === -1) return cy * W + cx;
    const maxR = W + H;
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // only inspect the ring at Chebyshev distance r
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const idx = ny * W + nx;
          if (map[idx] !== -1) continue;
          const d = dx * dx + dy * dy; // euclidean² — prefer truly nearest
          if (d < bestD) { bestD = d; best = idx; }
        }
      }
      if (best !== -1) return best;
    }
    return -1; // grid full (shouldn't happen: total >= n)
  };

  sorted.forEach((px, ledIndex) => {
    const [cx, cy] = cellOf(px.x, px.y);
    const slot = nearestFree(cx, cy);
    if (slot !== -1) map[slot] = ledIndex;
  });

  return JSON.stringify({ width: W, height: H, map }, null, 2);
}

/**
 * @param {Pixel[]} pixels
 * @param {ExportOpts} opts
 * @returns {string}  C++ header snippet
 */
export function toFastLED(pixels, opts = {}) {
  const data  = JSON.parse(toCoordinateMap(pixels, opts));
  // Whole numbers must still serialise as valid C++ floats (e.g. "1.0000f",
  // never "1f" which is not a valid float literal).
  const fmt   = v => v.toFixed(4) + 'f';
  const lines = data.map.map((pt, i) => `  {${fmt(pt[0])}, ${fmt(pt[1])}},  // LED ${i}`);
  return [
    `// FastLED 2D coordinate map — ${pixels.length} LEDs`,
    `// Generated by Light Weaver`,
    ``,
    `struct Point { float x, y; };`,
    `const Point ledCoords[${pixels.length}] PROGMEM = {`,
    ...lines,
    `};`,
  ].join('\n');
}

/**
 * @param {Pixel[]} pixels
 * @returns {string}  CSV with header row
 */
export function toCSV(pixels) {
  const sorted = [...pixels].sort((a, b) => a.index - b.index);
  const rows   = sorted.map(px => `${px.index},${px.x.toFixed(3)},${px.y.toFixed(3)}`);
  return `index,x,y\n${rows.join('\n')}`;
}

/**
 * Trigger a browser file download.
 * @param {string} content
 * @param {string} filename
 * @param {string} mimeType
 */
export function download(content, filename, mimeType = 'application/json') {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/** Round to 2 decimal places */
function r2(n) { return Math.round(n * 100) / 100; }

/** Clamp n into [lo, hi] */
function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

if (import.meta.hot) import.meta.hot.accept();
