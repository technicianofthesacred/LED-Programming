/**
 * visualizer.js — full-screen LED visualization + mini-preview canvases
 *
 * The main canvas fills the entire viewport. LEDs are drawn as:
 *   1. Bloom rings — large, additive compositing ('lighter') so overlapping
 *      LEDs accumulate light the way real LEDs do.
 *   2. Inner bloom — tighter ring for intensity near the core.
 *   3. Core dot — small solid circle; dark "off" LEDs show as dim navy.
 *
 * Dot size and bloom radius scale with estimated LED spacing so sparse
 * and dense installations both look right without manual tuning.
 *
 * Cross-fade transitions: when switchScene() is called, old colors are
 * held and blended toward new colors over TRANSITION_FRAMES frames.
 *
 * Mini-previews: each scene card has a small <canvas>. The Visualizer
 * renders all of them at a lower rate so they animate without being
 * expensive. Each runs its own time offset for visual variety.
 */

const TAU  = Math.PI * 2;
const TRANSITION_FRAMES = 40; // ~0.67 s at 60 fps

export class Visualizer {
  /**
   * @param {HTMLCanvasElement} mainCanvas
   * @param {DOMRect|null}      [demoRect]   optional — only used for default layout
   */
  constructor(mainCanvas) {
    this.canvas = mainCanvas;
    this.ctx    = mainCanvas.getContext('2d');
    this.dpr    = Math.min(window.devicePixelRatio || 1, 2);

    // Layout — computed from ledmap, recalculated on resize
    this.leds      = []; // { x, y, nx, ny, index } in canvas pixels
    this.hasLedmap = false;

    // Color buffers
    this._R = new Uint8Array(0);
    this._G = new Uint8Array(0);
    this._B = new Uint8Array(0);

    // Cross-fade state
    this._oldR = null;
    this._oldG = null;
    this._oldB = null;
    this._fadeProgress = 1; // 1 = no fade in progress

    // Dot sizing — computed from LED density
    this._bloomR = 12;
    this._coreR  = 3;

    // Mini-preview canvases: sceneId → { canvas, ctx, t }
    this._previews  = new Map();
    this._previewFrame = 0; // frame counter for throttling

    // Vignette gradient (rebuilt on resize)
    this._vignette = null;

    this._resize();
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(mainCanvas);
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  /** Load a ledmap.json object and compute screen positions. */
  setLedmap(ledmap) {
    this.hasLedmap = true;
    this._computeLayout(ledmap.map, this.canvas.width, this.canvas.height);
    const N = this.leds.length;
    this._R = new Uint8Array(N);
    this._G = new Uint8Array(N);
    this._B = new Uint8Array(N);
    this._oldR = null;
    this._fadeProgress = 1;
  }

  _computeLayout(positions, cw, ch) {
    // positions: [[x,y], ...] already 0–1 normalised from the mapper
    const s = this.dpr;
    const W = cw, H = ch;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const [x, y] of positions) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const pad    = 0.12; // 12 % padding on each side

    const availW = W * (1 - 2 * pad);
    const availH = H * (1 - 2 * pad) - 120; // subtract control bar height
    const scale  = Math.min(availW / rangeX, availH / rangeY);

    const drawW  = rangeX * scale;
    const drawH  = rangeY * scale;
    const offX   = (W - drawW) / 2;
    const offY   = (H - 120 - drawH) / 2 + 50; // offset for top bar

    const normRange = Math.max(rangeX, rangeY); // contain mode

    this.leds = positions.map(([px, py], i) => ({
      x:  offX + (px - minX) * scale,
      y:  offY + (py - minY) * scale,
      nx: (px - minX) / normRange,
      ny: (py - minY) / normRange,
      index: i,
    }));

    // Estimate LED spacing → set dot sizes
    const area    = rangeX * rangeY * scale * scale;
    const spacing = Math.sqrt(area / Math.max(positions.length, 1));
    this._bloomR  = Math.max(4,  Math.min(spacing * 0.9, 28));
    this._coreR   = Math.max(1.5, Math.min(spacing * 0.13, 6));
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const s = this.dpr;
    this.canvas.width  = Math.round(w * s);
    this.canvas.height = Math.round(h * s);
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';

    // Rebuild vignette gradient
    const cx = this.canvas.width  / 2;
    const cy = this.canvas.height / 2;
    const r  = Math.sqrt(cx * cx + cy * cy);
    const grad = this.ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.55)');
    this._vignette = grad;

    // Re-layout if we have data
    if (this.hasLedmap && this.leds.length) {
      // Rebuild layout from existing nx/ny normalised coords
      // (re-derive positions[] from leds so we don't need to re-store the raw map)
      const positions = this.leds.map(l => [l.nx, l.ny]);
      this._computeLayout(positions, this.canvas.width, this.canvas.height);
    }
  }

  // ── Color input ───────────────────────────────────────────────────────────

  /**
   * Set colors for all LEDs from local pattern evaluation.
   * @param {(index,nx,ny)=>{r,g,b}} colorFn
   */
  computeColors(colorFn) {
    const { leds, _R, _G, _B } = this;
    for (let i = 0, N = leds.length; i < N; i++) {
      const { r, g, b } = colorFn(leds[i].index, leds[i].nx, leds[i].ny);
      _R[i] = r; _G[i] = g; _B[i] = b;
    }
  }

  /**
   * Set colors from raw live WLED frame data (Uint8Array of R,G,B bytes).
   * @param {Uint8Array} data
   * @param {number}     count  number of LEDs in the frame
   */
  setLiveColors(data, count) {
    const N = Math.min(count, this.leds.length);
    for (let i = 0; i < N; i++) {
      this._R[i] = data[i * 3];
      this._G[i] = data[i * 3 + 1];
      this._B[i] = data[i * 3 + 2];
    }
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  /** Call when switching scenes — stores current colors for cross-fade. */
  startTransition() {
    const N = this._R.length;
    this._oldR = this._R.slice();
    this._oldG = this._G.slice();
    this._oldB = this._B.slice();
    this._fadeProgress = 0;
  }

  _advanceFade() {
    if (this._fadeProgress >= 1) return;
    this._fadeProgress = Math.min(1, this._fadeProgress + 1 / TRANSITION_FRAMES);
    if (this._fadeProgress >= 1) { this._oldR = null; return; }

    // Blend old → new (ease-in-out)
    const t = smoothstep(this._fadeProgress);
    const N = this._R.length;
    for (let i = 0; i < N; i++) {
      this._R[i] = Math.round(this._oldR[i] + (this._R[i] - this._oldR[i]) * t);
      this._G[i] = Math.round(this._oldG[i] + (this._G[i] - this._oldG[i]) * t);
      this._B[i] = Math.round(this._oldB[i] + (this._B[i] - this._oldB[i]) * t);
    }
  }

  // ── Main render ───────────────────────────────────────────────────────────

  /** Draw one frame on the main canvas. */
  render() {
    this._advanceFade();

    const { ctx, leds, _R, _G, _B, dpr } = this;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const s  = dpr;
    const N  = leds.length;

    const bloomR  = this._bloomR * s;
    const bloom2R = bloomR * 0.32;
    const coreR   = this._coreR  * s;

    // ── Background ──────────────────────────────────────────────────────────
    ctx.fillStyle = '#010101';
    ctx.fillRect(0, 0, cw, ch);

    if (!N) {
      // No ledmap — subtle idle animation
      this._renderIdleBackground();
      return;
    }

    // ── Pass 1: Outer bloom (additive) ─────────────────────────────────────
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.13;
    for (let i = 0; i < N; i++) {
      const r = _R[i], g = _G[i], b = _B[i];
      if ((r | g | b) === 0) continue;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(leds[i].x * s, leds[i].y * s, bloomR, 0, TAU);
      ctx.fill();
    }

    // ── Pass 2: Inner bloom ─────────────────────────────────────────────────
    ctx.globalAlpha = 0.25;
    for (let i = 0; i < N; i++) {
      const r = _R[i], g = _G[i], b = _B[i];
      if ((r | g | b) === 0) continue;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(leds[i].x * s, leds[i].y * s, bloom2R, 0, TAU);
      ctx.fill();
    }

    // ── Pass 3: Core dots ──────────────────────────────────────────────────
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    for (let i = 0; i < N; i++) {
      const r = _R[i], g = _G[i], b = _B[i];
      ctx.fillStyle = (r | g | b) === 0
        ? 'rgba(18,18,40,0.7)'
        : `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(leds[i].x * s, leds[i].y * s, coreR, 0, TAU);
      ctx.fill();
    }

    // ── Vignette overlay ───────────────────────────────────────────────────
    if (this._vignette) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = this._vignette;
      ctx.fillRect(0, 0, cw, ch);
    }
  }

  // ── Idle background (no ledmap loaded) ───────────────────────────────────

  _idleT = 0;
  _renderIdleBackground() {
    this._idleT += 0.004;
    const { ctx } = this;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const cx = cw / 2, cy = ch / 2;

    // Slowly rotating colour wash
    const h1 = this._idleT % 1;
    const h2 = (this._idleT + 0.4) % 1;
    const [r1, g1, b1] = hsvArr(h1, 0.8, 0.08);
    const [r2, g2, b2] = hsvArr(h2, 0.8, 0.06);

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(cw, ch) * 0.6);
    grad.addColorStop(0, `rgb(${r1},${g1},${b1})`);
    grad.addColorStop(1, `rgb(${r2},${g2},${b2})`);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);
  }

  // ── Mini-preview canvases ─────────────────────────────────────────────────

  /**
   * Register a scene card's <canvas> element.
   * @param {string}            sceneId
   * @param {HTMLCanvasElement} canvas
   * @param {number}            timeOffset   offset so cards don't sync up
   */
  registerPreview(sceneId, canvas, timeOffset = 0) {
    const ctx = canvas.getContext('2d');
    this._previews.set(sceneId, { canvas, ctx, timeOffset, R: null, G: null, B: null });
  }

  /**
   * Render all registered mini-previews for one animation frame.
   * @param {Map<string, Function>} colorFns  sceneId → compiled pattern fn
   * @param {number} t     elapsed seconds
   * @param {number} time  0–1 cycling
   * @param {number} pixelCount
   */
  renderPreviews(colorFns, t, time, pixelCount) {
    // Throttle: update previews every 3 main frames (~20 fps)
    this._previewFrame++;
    if (this._previewFrame % 3 !== 0) return;

    this._previews.forEach((state, sceneId) => {
      const fn = colorFns.get(sceneId);
      if (!fn) return;

      const { canvas, ctx, timeOffset } = state;
      const cw = canvas.width;
      const ch = canvas.height;
      const N  = this.leds.length;
      if (!N) return;

      const localT    = t    + timeOffset;
      const localTime = ((time + timeOffset * 0.015) % 1 + 1) % 1;

      // Allocate buffers lazily
      if (!state.R || state.R.length !== N) {
        state.R = new Uint8Array(N);
        state.G = new Uint8Array(N);
        state.B = new Uint8Array(N);
      }

      for (let i = 0; i < N; i++) {
        const px = this.leds[i];
        const c  = safeEval(fn, px.index, px.nx, px.ny, localT, localTime, pixelCount);
        state.R[i] = c.r; state.G[i] = c.g; state.B[i] = c.b;
      }

      // Find the scale from LED positions to card canvas size
      // leds positions are in main canvas coords — we need to map them to card coords
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      for (const l of this.leds) {
        if (l.x < minX) minX = l.x; if (l.x > maxX) maxX = l.x;
        if (l.y < minY) minY = l.y; if (l.y > maxY) maxY = l.y;
      }
      const rangeX = maxX - minX || 1;
      const rangeY = maxY - minY || 1;
      const pad    = 0.1;
      const scale  = Math.min(
        cw * (1 - 2 * pad) / rangeX,
        ch * (1 - 2 * pad) / rangeY,
      );
      const oX = (cw - rangeX * scale) / 2;
      const oY = (ch - rangeY * scale) / 2;

      const bR = Math.max(2, Math.min(this._bloomR * 0.5 * (cw / (this.canvas.width / this.dpr)), 8));
      const cR = Math.max(0.8, bR * 0.2);

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);

      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.18;
      for (let i = 0; i < N; i++) {
        const r = state.R[i], g = state.G[i], b = state.B[i];
        if ((r | g | b) === 0) continue;
        const px = this.leds[i];
        const cx2 = oX + (px.x - minX) * scale;
        const cy2 = oY + (px.y - minY) * scale;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(cx2, cy2, bR, 0, TAU);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      for (let i = 0; i < N; i++) {
        const r = state.R[i], g = state.G[i], b = state.B[i];
        const px = this.leds[i];
        const cx2 = oX + (px.x - minX) * scale;
        const cy2 = oY + (px.y - minY) * scale;
        ctx.fillStyle = (r | g | b) === 0
          ? 'rgba(15,15,30,0.6)'
          : `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(cx2, cy2, cR, 0, TAU);
        ctx.fill();
      }
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function smoothstep(t) { return t * t * (3 - 2 * t); }

function safeEval(fn, index, x, y, t, time, pixelCount) {
  try {
    const r = fn(index, x, y, t, time, pixelCount);
    if (!r) return { r: 0, g: 0, b: 0 };
    return {
      r: clamp255(Math.round(r.r ?? 0)),
      g: clamp255(Math.round(r.g ?? 0)),
      b: clamp255(Math.round(r.b ?? 0)),
    };
  } catch { return { r: 20, g: 0, b: 0 }; }
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function hsvArr(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v*(1-s), q = v*(1-f*s), tt = v*(1-(1-f)*s);
  const c = [[v,tt,p],[q,v,p],[p,v,tt],[p,q,v],[tt,p,v],[v,p,q]][i%6];
  return [Math.round(c[0]*255), Math.round(c[1]*255), Math.round(c[2]*255)];
}
