/**
 * visualizer.js — full-screen LED glow renderer for the web interface
 *
 * Stripped-down version of the controller visualizer (no mini-preview cards).
 * LEDs are drawn with a three-pass glow:
 *   1. Outer bloom (additive, 'lighter')
 *   2. Inner bloom (additive, 'lighter')
 *   3. Core dot   (source-over)
 *
 * When no ledmap is loaded, a slow colour wash plays as a placeholder.
 * Cross-fade transitions blend old → new colors over ~0.67s when
 * activateScene() triggers startTransition().
 */

const TAU               = Math.PI * 2;
const TRANSITION_FRAMES = 40; // ~0.67s at 60 fps

export class Visualizer {
  constructor(mainCanvas) {
    this.canvas = mainCanvas;
    this.ctx    = mainCanvas.getContext('2d');
    this.dpr    = Math.min(window.devicePixelRatio || 1, 2);

    this.leds      = [];
    this.hasLedmap = false;

    this._R = new Uint8Array(0);
    this._G = new Uint8Array(0);
    this._B = new Uint8Array(0);

    this._oldR = null;
    this._oldG = null;
    this._oldB = null;
    this._fadeProgress = 1;

    this._bloomR = 12;
    this._coreR  = 3;
    this._vignette = null;
    this._idleT    = 0;

    this._resize();
    new ResizeObserver(() => this._resize()).observe(mainCanvas);
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  setLedmap(ledmap) {
    if (!ledmap?.map?.length) return;
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
    const s = this.dpr;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const [x, y] of positions) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const pad    = 0.1;

    // Reserve space for header (~80px) and footer (~130px) in device pixels
    const headerH = 80  * s;
    const footerH = 130 * s;
    const availW  = cw  * (1 - 2 * pad);
    const availH  = ch  * (1 - 2 * pad) - headerH - footerH;
    const scale   = Math.min(availW / rangeX, Math.max(1, availH) / rangeY);

    const drawW = rangeX * scale;
    const drawH = rangeY * scale;
    const offX  = (cw - drawW) / 2;
    const offY  = headerH + (ch - headerH - footerH - drawH) / 2;

    const normRange = Math.max(rangeX, rangeY); // contain mode

    this.leds = positions.map(([px, py], i) => ({
      x:  offX + (px - minX) * scale,
      y:  offY + (py - minY) * scale,
      nx: (px - minX) / normRange,
      ny: (py - minY) / normRange,
      index: i,
    }));

    const area    = rangeX * rangeY * scale * scale;
    const spacing = Math.sqrt(area / Math.max(positions.length, 1));
    this._bloomR  = Math.max(4,   Math.min(spacing * 0.9, 28));
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

    const cx = this.canvas.width  / 2;
    const cy = this.canvas.height / 2;
    const r  = Math.sqrt(cx * cx + cy * cy);
    const g  = this.ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.6)');
    this._vignette = g;

    if (this.hasLedmap && this.leds.length) {
      const positions = this.leds.map(l => [l.nx, l.ny]);
      this._computeLayout(positions, this.canvas.width, this.canvas.height);
    }
  }

  // ── Color input ───────────────────────────────────────────────────────────

  computeColors(colorFn) {
    const { leds, _R, _G, _B } = this;
    for (let i = 0, N = leds.length; i < N; i++) {
      const { r, g, b } = colorFn(leds[i].index, leds[i].nx, leds[i].ny);
      _R[i] = r; _G[i] = g; _B[i] = b;
    }
  }

  setLiveColors(data, count) {
    const N = Math.min(count, this.leds.length);
    for (let i = 0; i < N; i++) {
      this._R[i] = data[i * 3];
      this._G[i] = data[i * 3 + 1];
      this._B[i] = data[i * 3 + 2];
    }
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  startTransition() {
    this._oldR = this._R.slice();
    this._oldG = this._G.slice();
    this._oldB = this._B.slice();
    this._fadeProgress = 0;
  }

  _advanceFade() {
    if (this._fadeProgress >= 1) return;
    this._fadeProgress = Math.min(1, this._fadeProgress + 1 / TRANSITION_FRAMES);
    if (this._fadeProgress >= 1) { this._oldR = null; return; }

    const t = smoothstep(this._fadeProgress);
    const N = this._R.length;
    for (let i = 0; i < N; i++) {
      this._R[i] = Math.round(this._oldR[i] + (this._R[i] - this._oldR[i]) * t);
      this._G[i] = Math.round(this._oldG[i] + (this._G[i] - this._oldG[i]) * t);
      this._B[i] = Math.round(this._oldB[i] + (this._B[i] - this._oldB[i]) * t);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render() {
    this._advanceFade();

    const { ctx, leds, _R, _G, _B, dpr: s } = this;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const N  = leds.length;

    ctx.fillStyle = '#010101';
    ctx.fillRect(0, 0, cw, ch);

    if (!N) {
      this._renderIdleBackground();
      return;
    }

    const bloomR  = this._bloomR * s;
    const bloom2R = bloomR * 0.32;
    const coreR   = this._coreR  * s;

    // Pass 1: outer bloom (additive)
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

    // Pass 2: inner bloom (additive)
    ctx.globalAlpha = 0.25;
    for (let i = 0; i < N; i++) {
      const r = _R[i], g = _G[i], b = _B[i];
      if ((r | g | b) === 0) continue;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(leds[i].x * s, leds[i].y * s, bloom2R, 0, TAU);
      ctx.fill();
    }

    // Pass 3: core dots
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

    // Vignette
    if (this._vignette) {
      ctx.fillStyle = this._vignette;
      ctx.fillRect(0, 0, cw, ch);
    }
  }

  // ── Idle background ───────────────────────────────────────────────────────

  _renderIdleBackground() {
    this._idleT += 0.003;
    const { ctx } = this;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const cx = cw / 2, cy = ch / 2;

    const h1 = this._idleT % 1;
    const h2 = (this._idleT + 0.4) % 1;
    const [r1, g1, b1] = hsvArr(h1, 0.7, 0.06);
    const [r2, g2, b2] = hsvArr(h2, 0.7, 0.04);

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(cw, ch) * 0.6);
    grad.addColorStop(0, `rgb(${r1},${g1},${b1})`);
    grad.addColorStop(1, `rgb(${r2},${g2},${b2})`);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function smoothstep(t) { return t * t * (3 - 2 * t); }

function hsvArr(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v*(1-s), q = v*(1-f*s), tt = v*(1-(1-f)*s);
  const c = [[v,tt,p],[q,v,p],[p,v,tt],[p,q,v],[tt,p,v],[v,p,q]][i%6];
  return [Math.round(c[0]*255), Math.round(c[1]*255), Math.round(c[2]*255)];
}
