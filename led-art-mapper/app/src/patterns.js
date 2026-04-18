/**
 * patterns.js — sandboxed pattern compiler + per-pixel evaluator
 *
 * Pattern code is a JS function body.  Available names:
 *
 *   index      — global LED index (0-based, draw order)
 *   x, y       — normalised position 0–1 (contain mode, preserves aspect ratio)
 *   t          — elapsed seconds since Run was pressed
 *   time       — 0–1 cycling, period ≈ 65.5 s (Pixelblaze-compatible)
 *   pixelCount — total LED count across all strips
 *
 *   + all helpers defined in BUILTINS below
 *
 * Return { r, g, b } each 0–255.
 *
 * Security: new Function() is eval-equivalent.
 * This is a local-only creative tool — that's fine.
 */

// ── Built-in helpers injected into every compiled pattern ─────────────────

const BUILTINS = /* js */ `
// ── Color ────────────────────────────────────────────────────────────────

/** Convert HSV to { r, g, b }. All inputs 0–1. */
function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), tt = v * (1 - (1 - f) * s);
  const c = [[v,tt,p],[q,v,p],[p,v,tt],[p,q,v],[tt,p,v],[v,p,q]][i % 6];
  return { r: _c(c[0]), g: _c(c[1]), b: _c(c[2]) };
}

/** Convert RGB (0–1 each) to { r, g, b } 0–255. */
function rgb(r, g, b) { return { r: _c(r), g: _c(g), b: _c(b) }; }

function _c(v) { return Math.round(v < 0 ? 0 : v > 1 ? 255 : v * 255); }

// ── Waves (all return 0–1) ────────────────────────────────────────────────

/** Sine wave. x: 0–1 = one full cycle. */
function wave(x)              { return (Math.sin(x * 6.28318) + 1) * 0.5; }

/** Triangle wave. */
function triangle(x)          { x = fract(x); return x < 0.5 ? x * 2 : 2 - x * 2; }

/** Square wave. duty 0–1 controls pulse width (default 0.5). */
function square(x, duty)      { return fract(x) < (duty === undefined ? 0.5 : duty) ? 1 : 0; }

// ── Math ─────────────────────────────────────────────────────────────────

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t)  { return a + (b - a) * t; }
function fract(x)        { return x - Math.floor(x); }
function abs(x)          { return x < 0 ? -x : x; }
function floor(x)        { return Math.floor(x); }
function ceil(x)         { return Math.ceil(x); }
function min(a, b)       { return a < b ? a : b; }
function max(a, b)       { return a > b ? a : b; }
function pow(a, b)       { return Math.pow(a, b); }
function sqrt(x)         { return Math.sqrt(x); }
function exp(x)          { return Math.exp(x); }
function log(x)          { return Math.log(x); }
function tan(x)              { return Math.tan(x); }
function atan2(y, x)         { return Math.atan2(y, x); }
function round(x)            { return Math.round(x); }
/** Map x from [inMin,inMax] to [outMin,outMax]. */
function map(x, inMin, inMax, outMin, outMax) {
  return outMin + (x - inMin) / (inMax - inMin) * (outMax - outMin);
}
/** Hermite smoothstep, output 0–1. */
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
/** Alias for lerp. */
function mix(a, b, t) { return a + (b - a) * t; }
const PI  = Math.PI;
const TAU = Math.PI * 2;
function sin(x)          { return Math.sin(x); }
function cos(x)          { return Math.cos(x); }

// ── Noise ─────────────────────────────────────────────────────────────────

/**
 * Smooth value noise, returns 0–1.
 * noise(x) — 1D.  noise(x, y) — 2D.
 */
function noise(x, y) {
  y = (y == null) ? 0 : +y;
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi,        yf = y - yi;
  function fade(t) { return t * t * (3 - 2 * t); }
  function h(nx, ny) {
    const n = Math.sin(nx * 127.1 + ny * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }
  const sx = fade(xf), sy = fade(yf);
  return lerp(lerp(h(xi, yi), h(xi+1, yi), sx),
              lerp(h(xi, yi+1), h(xi+1, yi+1), sx), sy);
}

/**
 * Deterministic pseudo-random 0–1 from a numeric seed.
 */
function randomF(seed) {
  const n = Math.sin(seed * 127.1) * 43758.5453;
  return n - Math.floor(n);
}

// ── Advanced Math ─────────────────────────────────────────────────────────

/** Pingpong wave: 0→1→0. Equivalent to triangle but symmetric alias. */
function ping(x) { x = fract(x); return x < 0.5 ? x * 2 : 2 - x * 2; }

/** Ease-in power curve. p=2 is quadratic, p=3 cubic. */
function easeIn(t, p)  { return pow(clamp(t, 0, 1), p || 2); }

/** Ease-out power curve. */
function easeOut(t, p) { return 1 - pow(1 - clamp(t, 0, 1), p || 2); }

/** Ease-in-out: smooth S-curve with configurable power. */
function easeInOut(t, p) { t = clamp(t,0,1); return t < 0.5 ? pow(t*2,p||2)*0.5 : 1-pow((1-t)*2,p||2)*0.5; }

/** Remap x from [a,b] to [0,1] clamped. */
function norm(x, a, b) { return clamp((x - a) / (b - a), 0, 1); }

// ── Polar ─────────────────────────────────────────────────────────────────

/**
 * Convert (x,y) to polar coords around center (cx,cy).
 * Returns { r: radius, a: angle 0–1 }.
 * cx/cy default to 0.5 (artwork center).
 */
function polar(px, py, cx, cy) {
  const dx = px - (cx == null ? 0.5 : cx);
  const dy = py - (cy == null ? 0.5 : cy);
  return { r: sqrt(dx*dx + dy*dy), a: fract(atan2(dy, dx) / TAU + 0.5) };
}

// ── Noise ─────────────────────────────────────────────────────────────────

/**
 * Fractal Brownian Motion — stacks oct octaves of value noise.
 * Returns 0-1. More octaves = richer organic texture.
 * fbm(x, y) = 2D with 4 octaves.  fbm(x, y, 6) = 6 octaves.
 */
function fbm(x, y, oct) {
  let v = 0, amp = 0.5, freq = 1;
  const n = oct || 4;
  for (let i = 0; i < n; i++) {
    v += noise(x * freq, (y || 0) * freq) * amp;
    freq *= 2.0; amp *= 0.5;
  }
  return v;
}

// ── Palette ───────────────────────────────────────────────────────────────

/**
 * Sample the palette at normalized position t (0–1), interpolating
 * smoothly between swatches.  Returns { r, g, b } with values 0–255.
 */
function samplePalette(t) {
  t = fract(t < 0 ? t + 1 : t);
  const last = palette.length - 1;
  const pos  = t * last;
  const i    = floor(pos);
  const f    = pos - i;
  const a    = palette[i];
  const b2   = palette[i >= last ? last : i + 1];
  return { r: lerp(a.r, b2.r, f) * 255, g: lerp(a.g, b2.g, f) * 255, b: lerp(a.b, b2.b, f) * 255 };
}
`;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Compile user code into a reusable function.
 *
 * @param {string} code — function body; may use index, x, y, t, time, pixelCount,
 *                        palette, beat, beatSin, params + builtins
 * @returns {{ fn: Function|null, error: string|null }}
 */
export function compile(code) {
  try {
    const fn = new Function(
      'index', 'x', 'y', 't', 'time', 'pixelCount', 'palette', 'beat', 'beatSin', 'params',
      'stripId', 'stripProgress',
      BUILTINS + '\n' + code,
    );
    return { fn, error: null };
  } catch (e) {
    return { fn: null, error: e.message };
  }
}

/**
 * Evaluate one pixel.  Safe — runtime errors return dim red.
 *
 * @param {Function}  fn
 * @param {number}    index
 * @param {number}    x          normalised 0–1
 * @param {number}    y          normalised 0–1
 * @param {number}    t          seconds
 * @param {number}    time       0–1 cycling
 * @param {number}    pixelCount total LEDs
 * @param {Array}     palette    array of {r,g,b} objects with values 0–1
 * @param {number}    beat       0→1 sawtooth per beat
 * @param {number}    beatSin    sine of beat 0→1
 * @param {Object}    params     pattern @param values keyed by name
 * @param {string}    stripId       strip identifier string
 * @param {number}    stripProgress 0–1 position along this strip only
 * @returns {{ r: number, g: number, b: number }}
 */
export function evalPixel(fn, index, x, y, t, time, pixelCount, palette, beat, beatSin, params, stripId, stripProgress) {
  try {
    const result = fn(index, x, y, t, time, pixelCount, palette, beat, beatSin, params, stripId || 0, stripProgress || 0);
    if (!result || typeof result !== 'object') return { r: 0, g: 0, b: 0 };
    return {
      r: _clamp255(Math.round(result.r ?? 0)),
      g: _clamp255(Math.round(result.g ?? 0)),
      b: _clamp255(Math.round(result.b ?? 0)),
    };
  } catch {
    return { r: 35, g: 0, b: 0 }; // dim red = runtime error indicator
  }
}

function _clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

if (import.meta.hot) import.meta.hot.accept();
