// Uniform scaling of strip path geometry — pure string/number math, no DOM.
//
// A strip renders as: on-screen point = path point + (strip.x, strip.y), where
// x/y are POST-sample translate offsets (see sampleStripPixels). We scale the
// pathData about the path's own intrinsic center and leave x/y untouched:
//
//   scaled path point = C + (p − C) · factor      (C = intrinsic path center)
//
// The intrinsic center C is a fixed point of that map, so the path's center in
// path coordinates does not move, and the on-screen center (C + x + y) stays
// exactly where it was. Compensating x/y would only be needed if we scaled
// about some other point.
//
// C is the bounding-box center of the path's on-path anchor endpoints. For the
// primitives the Studio generates this is exact: a line's endpoints straddle
// its midpoint, the square's anchors are its four corners, and the circle's
// two arc anchors are (cx±r, cy) whose bbox center is the true circle center.
// Free-drawn strips are pure polylines (M/L), where the anchor bbox is the
// path bbox. For imported curves the anchor bbox is an approximation of the
// curve bbox, which is fine — invariance only requires scaling about a center
// that is computed deterministically from the path itself.

const COORD_COUNTS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };

const tokenize = d =>
  String(d).match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:e[-+]?\d+)?/gi) || [];

const isCommand = token => /^[a-zA-Z]$/.test(token);

// Match translatePathData's output precision (3 decimals, trimmed).
const fmt = n => Number.parseFloat(Number(n).toFixed(3)).toString();

// Walk a path string, invoking visit(command, nums, isFirstMoveto) per
// coordinate group (implicit repeats included, M→L promotion applied).
function walkPath(d, visit) {
  const tokens = tokenize(d);
  let i = 0;
  let command = '';
  let started = false;
  while (i < tokens.length) {
    if (isCommand(tokens[i])) command = tokens[i++];
    if (!command) break;
    const upper = command.toUpperCase();
    if (upper === 'Z') {
      visit(command, [], false);
      command = '';
      continue;
    }
    const count = COORD_COUNTS[upper];
    if (!count) break;
    let emittedCommand = false;
    while (i < tokens.length && !isCommand(tokens[i])) {
      const nums = tokens.slice(i, i + count).map(Number);
      if (nums.length < count || nums.some(Number.isNaN)) return;
      visit(command, nums, !started && upper === 'M', !emittedCommand);
      emittedCommand = true;
      started = true;
      i += count;
      if (upper === 'M') command = command === 'M' ? 'L' : 'l';
    }
  }
}

// Bounding-box center of the on-path anchor endpoints of `d`.
// Returns { x: 0, y: 0 } for empty/invalid input.
export function pathDataCenter(d) {
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const record = () => {
    if (curX < minX) minX = curX;
    if (curX > maxX) maxX = curX;
    if (curY < minY) minY = curY;
    if (curY > maxY) maxY = curY;
  };
  walkPath(d, (cmd, nums) => {
    const upper = cmd.toUpperCase();
    const absolute = cmd === upper;
    if (upper === 'Z') { curX = startX; curY = startY; return; }
    if (upper === 'H') { curX = absolute ? nums[0] : curX + nums[0]; }
    else if (upper === 'V') { curY = absolute ? nums[0] : curY + nums[0]; }
    else {
      // Endpoint is the last coordinate pair of every remaining command
      // (M/L/T: only pair; C: 3rd pair; S/Q: 2nd pair; A: after the 5 params).
      const ex = nums[nums.length - 2];
      const ey = nums[nums.length - 1];
      // A leading relative 'm' starts from (0,0), so += is already absolute.
      if (absolute) { curX = ex; curY = ey; }
      else { curX += ex; curY += ey; }
      if (upper === 'M') { startX = curX; startY = curY; }
    }
    record();
  });
  if (minX === Infinity) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// Rewrite an SVG path string uniformly scaled by `factor` about `center`.
// Handles absolute AND relative M/L/H/V/C/S/Q/T/A/Z:
// - absolute coordinates map c' = center + (c − center) · factor
// - relative deltas (and relative h/v distances) multiply by factor
// - absolute H/V distances map about center.x / center.y respectively
// - A/a scale rx,ry by factor, keep x-axis-rotation and both flags, and treat
//   the endpoint like the other absolute/relative coordinates
// Degenerate input (empty string, non-string, bad factor) returns the input
// unchanged (empty string for nullish d).
export function scalePathData(d, factor, center = { x: 0, y: 0 }) {
  if (d == null) return '';
  if (typeof d !== 'string' || !d.trim()) return d;
  if (!Number.isFinite(factor) || factor <= 0) return d;
  const cx = Number(center?.x) || 0;
  const cy = Number(center?.y) || 0;
  const sx = v => cx + (v - cx) * factor;
  const sy = v => cy + (v - cy) * factor;
  const out = [];
  walkPath(d, (cmd, nums, firstMoveto, emitCommand) => {
    const upper = cmd.toUpperCase();
    if (emitCommand || upper === 'Z') out.push(cmd);
    if (upper === 'Z') return;
    const absolute = cmd === upper || firstMoveto; // leading 'm' pair is absolute per SVG spec
    let next;
    if (upper === 'H') next = [absolute ? sx(nums[0]) : nums[0] * factor];
    else if (upper === 'V') next = [absolute ? sy(nums[0]) : nums[0] * factor];
    else if (upper === 'A') {
      next = [
        nums[0] * factor,           // rx
        nums[1] * factor,           // ry
        nums[2],                    // x-axis-rotation
        nums[3],                    // large-arc-flag
        nums[4],                    // sweep-flag
        absolute ? sx(nums[5]) : nums[5] * factor,
        absolute ? sy(nums[6]) : nums[6] * factor,
      ];
    } else {
      next = nums.map((v, j) => {
        if (absolute) return j % 2 === 0 ? sx(v) : sy(v);
        return v * factor;
      });
    }
    out.push(...next.map(fmt));
  });
  return out.join(' ');
}

// Scale a whole strip's geometry uniformly about its own center.
// Returns a new strip with scaled pathData and svgLength × factor. The x/y
// translate offsets are deliberately kept as-is: because the path is scaled
// about its own intrinsic center, the path's center never moves in path
// coordinates, so the on-screen center (path center + x + y) stays fixed
// without touching the offsets. See module header.
export function scaleStripGeometry(strip, factor) {
  if (!strip || typeof strip !== 'object') return strip;
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return strip;
  const pathData = strip.pathData;
  if (typeof pathData !== 'string' || !pathData.trim()) return strip;
  const center = pathDataCenter(pathData);
  const scaledPath = scalePathData(pathData, factor, center);
  const svgLength = Number.isFinite(strip.svgLength) && strip.svgLength > 0
    ? strip.svgLength * factor
    : strip.svgLength;
  return {
    ...strip,
    pathData: scaledPath,
    svgLength,
    // x/y unchanged on purpose — see comment above.
    x: strip.x || 0,
    y: strip.y || 0,
  };
}
