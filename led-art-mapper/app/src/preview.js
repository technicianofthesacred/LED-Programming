/**
 * preview.js — Canvas 2D LED preview with additive glow
 *
 * Coordinate system: pixels have x,y in SVG viewBox units.
 * Call setViewBox(w, h) whenever the SVG viewBox changes so the canvas
 * maps SVG coordinates → physical canvas pixels correctly.
 */

const TAU = Math.PI * 2;

function _hexRgb(hex) {
  const n = parseInt((hex || '#00ffc8').replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class PreviewRenderer {
  /** @param {HTMLElement} wrapperEl — the .canvas-wrapper div */
  constructor(wrapperEl) {
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position:      'absolute',
      inset:         '0',
      pointerEvents: 'none',
      display:       'block',
    });
    wrapperEl.appendChild(this.canvas);

    this.ctx      = this.canvas.getContext('2d');
    this.pixels   = [];
    this.dpr      = Math.min(window.devicePixelRatio || 1, 2);
    this.dotR     = 6;    // visual dot radius in CSS pixels
    this.glowMult = 1.0;  // bloom radius multiplier (user-controlled)
    this.enabled  = true;
    this.dotMode        = false; // solid pixels vs glow bloom
    this.glowMode       = 'center'; // 'center' | 'outward' | 'inward'
    this.directedMode   = false;   // use per-strip emit angles for elongated glow
    this._emitAngles    = null;    // Map<stripId, degrees|null> — from compass
    this.heatMap     = false; // accumulate brightness per LED
    this._heatData   = null;  // Float32Array, one entry per pixel
    this._heatFrames = 0;
    this._frozenColorFn   = null;  // last colorFn — shown even when stopped
    this._coverageColorMap = null; // Map<stripId, hexColor> — non-null when coverage is active
    this._coverageAngleMap = null; // Map<stripId, number|null> — emit angle in degrees (0=up)
    this._vbX     = 0;     // SVG viewBox origin x
    this._vbY     = 0;     // SVG viewBox origin y
    this._vbW     = 0;     // SVG viewBox width  (0 = match canvas CSS width)
    this._vbH     = 0;     // SVG viewBox height

    const ro = new ResizeObserver(() => this._resize());
    ro.observe(wrapperEl);
    this._resize();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  /** Compute per-pixel normals (perpendicular to strip path tangent). */
  _computeNormals(pixels) {
    const N = pixels.length;
    const nx = new Float32Array(N);
    const ny = new Float32Array(N);
    const byStrip = new Map();
    for (let i = 0; i < N; i++) {
      const sid = pixels[i].stripId ?? 0;
      if (!byStrip.has(sid)) byStrip.set(sid, []);
      byStrip.get(sid).push(i);
    }
    for (const indices of byStrip.values()) {
      for (let j = 0; j < indices.length; j++) {
        const i    = indices[j];
        const prev = indices[Math.max(0, j - 1)];
        const next = indices[Math.min(indices.length - 1, j + 1)];
        const dx   = pixels[next].x - pixels[prev].x;
        const dy   = pixels[next].y - pixels[prev].y;
        const len  = Math.hypot(dx, dy) || 1;
        nx[i] = -dy / len;
        ny[i] =  dx / len;
      }
    }
    return { nx, ny };
  }

  _resize() {
    const wrapper = this.canvas.parentElement;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width  = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    if (!this._animating) this.renderStatic();
  }

  /**
   * Compute the canvas transform matching SVG's preserveAspectRatio xMidYMid meet.
   * Returns { scale, offsetX, offsetY, vbX, vbY } — apply as:
   *   ctx.translate(offsetX, offsetY); ctx.scale(scale, scale);
   *   then draw at (px.x - vbX, px.y - vbY)
   */
  _svgTransform() {
    const cw   = this.canvas.width;
    const ch   = this.canvas.height;
    const vbW  = this._vbW > 0 ? this._vbW : cw / this.dpr;
    const vbH  = this._vbH > 0 ? this._vbH : ch / this.dpr;
    const scale   = this._vbW > 0
      ? Math.min(cw / vbW, ch / vbH)   // uniform meet — matches SVG rendering
      : this.dpr;
    const offsetX = (cw - vbW * scale) / 2;
    const offsetY = (ch - vbH * scale) / 2;
    return { scale, offsetX, offsetY, vbX: this._vbX, vbY: this._vbY };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Teach the renderer the SVG coordinate space. Call after importSVG or clearCanvas. */
  setViewBox(vbX, vbY, vbW, vbH) {
    this._vbX = vbX || 0;
    this._vbY = vbY || 0;
    this._vbW = vbW || 0;
    this._vbH = vbH || 0;
    if (!this._animating) this.renderStatic();
  }

  /** Rebuild pixel set. Call after strips change. */
  init(pixels) {
    this.pixels    = pixels;
    this._animating = false;
    this.renderStatic();
  }

  /** Show layout dots. When a frozen frame exists, show it in full color instead. */
  renderStatic() {
    if (this._coverageColorMap) { this.renderCoverage(); return; }
    if (this._frozenColorFn && this.enabled && this.pixels.length) {
      this.render(this._frozenColorFn);
      return;
    }

    const { ctx, pixels } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);
    if (!this.enabled || !pixels.length) return;

    const { scale, offsetX, offsetY, vbX, vbY } = this._svgTransform();
    const glowR = this.dotR * this.dpr * 2.0 * this.glowMult / scale;
    const coreR = this.dotR * this.dpr * 0.55 / scale;
    const N = pixels.length;

    const useDir = this.glowMode !== 'center' && this.glowMode !== 'dots';
    const dir    = this.glowMode === 'inward' ? -1 : 1;
    const norms  = useDir ? this._computeNormals(pixels) : null;
    const off    = glowR * 0.4;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < N; i++) {
      const px = pixels[i].x - vbX;
      const py = pixels[i].y - vbY;
      const fx = norms ? px + norms.nx[i] * off * dir : px;
      const fy = norms ? py + norms.ny[i] * off * dir : py;
      const grad = ctx.createRadialGradient(fx, fy, 0, px, py, glowR);
      grad.addColorStop(0,    'rgba(80,100,200,0.45)');
      grad.addColorStop(0.35, 'rgba(60,80,160,0.15)');
      grad.addColorStop(1,    'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, glowR, 0, TAU);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(140,160,255,0.55)';
    for (let i = 0; i < N; i++) {
      ctx.beginPath();
      ctx.arc(pixels[i].x - vbX, pixels[i].y - vbY, coreR, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Render one animated frame.
   * colorFn(index, nx, ny, stripId) → { r, g, b } 0–255
   */
  render(colorFn) {
    if (!this.enabled) return;

    const { ctx, pixels } = this;
    const N = pixels.length;
    if (!N) return;

    const { scale, offsetX, offsetY, vbX, vbY } = this._svgTransform();
    const dpr         = this.dpr;
    const bloomR      = this.dotR * dpr * 3.5 * this.glowMult / scale;
    const innerBloomR = bloomR * 0.6;
    const coreR       = this.dotR * dpr * 0.9 / scale;
    const dotR        = this.dotR * dpr * 1.2 / scale;
    const w           = this.canvas.width;
    const h           = this.canvas.height;

    // Pre-compute all colors
    const R = new Uint8Array(N);
    const G = new Uint8Array(N);
    const B = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const px = pixels[i];
      const c  = colorFn(px.index, px.nx, px.ny, px.stripId);
      R[i] = c.r; G[i] = c.g; B[i] = c.b;
    }

    // Accumulate heat map data
    if (this.heatMap) {
      if (!this._heatData || this._heatData.length !== N) {
        this._heatData = new Float32Array(N);
        this._heatFrames = 0;
      }
      for (let i = 0; i < N; i++) {
        this._heatData[i] += (R[i] + G[i] + B[i]) / (3 * 255);
      }
      this._heatFrames++;
    }

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // ── Dot mode: solid flat circles, easy to read individual colors
    if (this.dotMode) {
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < N; i++) {
        const ri = R[i], gi = G[i], bi = B[i];
        ctx.fillStyle = (ri | gi | bi) ? `rgb(${ri},${gi},${bi})` : '#1e1e3a';
        ctx.globalAlpha = (ri | gi | bi) ? 1 : 0.5;
        ctx.beginPath();
        ctx.arc(pixels[i].x - vbX, pixels[i].y - vbY, dotR, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      return;
    }

    // ── Compute per-pixel normals for directional glow modes
    const norms = this.glowMode !== 'center' ? this._computeNormals(pixels) : null;
    const normX = norms?.nx ?? null;
    const normY = norms?.ny ?? null;

    const glowDir    = this.glowMode === 'inward' ? -1 : 1;
    const offset     = bloomR * 0.45;
    const useDirected = this.directedMode && this._emitAngles;

    // ── Pass 1: Wide bloom
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < N; i++) {
      const r = R[i], g = G[i], b = B[i];
      if ((r | g | b) === 0) continue;
      const px = pixels[i].x - vbX;
      const py = pixels[i].y - vbY;

      const emitDeg = useDirected ? this._emitAngles.get(pixels[i].stripId) : undefined;
      if (emitDeg != null) {
        // Directed: squish perpendicular, elongate in emit direction (5x ratio)
        const emitRad = (emitDeg - 90) * Math.PI / 180;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(emitRad);
        ctx.scale(2.8, 0.32);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, bloomR);
        grad.addColorStop(0,    `rgba(${r},${g},${b},0.30)`);
        grad.addColorStop(0.12, `rgba(${r},${g},${b},0.22)`);
        grad.addColorStop(0.30, `rgba(${r},${g},${b},0.13)`);
        grad.addColorStop(0.55, `rgba(${r},${g},${b},0.05)`);
        grad.addColorStop(0.80, `rgba(${r},${g},${b},0.01)`);
        grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, bloomR, 0, TAU);
        ctx.fill();
        ctx.restore();
      } else {
        const fx = normX ? px + normX[i] * offset * glowDir : px;
        const fy = normY ? py + normY[i] * offset * glowDir : py;
        const grad = ctx.createRadialGradient(fx, fy, 0, px, py, bloomR);
        grad.addColorStop(0,    `rgba(${r},${g},${b},0.30)`);
        grad.addColorStop(0.12, `rgba(${r},${g},${b},0.22)`);
        grad.addColorStop(0.30, `rgba(${r},${g},${b},0.13)`);
        grad.addColorStop(0.55, `rgba(${r},${g},${b},0.05)`);
        grad.addColorStop(0.80, `rgba(${r},${g},${b},0.01)`);
        grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, bloomR, 0, TAU);
        ctx.fill();
      }
    }

    // ── Pass 2: Inner bloom — tighter, more intense core halo
    for (let i = 0; i < N; i++) {
      const r = R[i], g = G[i], b = B[i];
      if ((r | g | b) === 0) continue;
      const px = pixels[i].x - vbX;
      const py = pixels[i].y - vbY;

      const emitDeg = useDirected ? this._emitAngles.get(pixels[i].stripId) : undefined;
      if (emitDeg != null) {
        const emitRad = (emitDeg - 90) * Math.PI / 180;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(emitRad);
        ctx.scale(2.0, 0.45);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, innerBloomR);
        grad.addColorStop(0,    `rgba(${r},${g},${b},0.80)`);
        grad.addColorStop(0.20, `rgba(${r},${g},${b},0.55)`);
        grad.addColorStop(0.45, `rgba(${r},${g},${b},0.22)`);
        grad.addColorStop(0.75, `rgba(${r},${g},${b},0.06)`);
        grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, innerBloomR, 0, TAU);
        ctx.fill();
        ctx.restore();
      } else {
        const fx = normX ? px + normX[i] * (innerBloomR * 0.5) * glowDir : px;
        const fy = normY ? py + normY[i] * (innerBloomR * 0.5) * glowDir : py;
        const grad = ctx.createRadialGradient(fx, fy, 0, px, py, innerBloomR);
        grad.addColorStop(0,    `rgba(${r},${g},${b},0.80)`);
        grad.addColorStop(0.20, `rgba(${r},${g},${b},0.55)`);
        grad.addColorStop(0.45, `rgba(${r},${g},${b},0.22)`);
        grad.addColorStop(0.75, `rgba(${r},${g},${b},0.06)`);
        grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, innerBloomR, 0, TAU);
        ctx.fill();
      }
    }

    // ── Pass 3: Core dots
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    for (let i = 0; i < N; i++) {
      const px = pixels[i];
      const r  = R[i], g = G[i], b = B[i];
      ctx.fillStyle = (r | g | b) === 0
        ? 'rgba(30,30,58,0.7)'
        : `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(px.x - vbX, px.y - vbY, coreR, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  /** Set per-strip emit angles. angleMap: Map<stripId, degrees|null> (0=up). */
  setEmitAngles(angleMap) { this._emitAngles = angleMap; }

  /** Toggle directed elongated-glow mode using per-strip emit angles. */
  setDirectedMode(v) {
    this.directedMode = !!v;
    if (!this._animating) this.renderStatic();
  }

  /** Set glow direction mode: 'center' | 'outward' | 'inward' */
  setGlowMode(mode) {
    this.glowMode = mode;
    if (!this._animating) this.renderStatic();
  }

  /** Resize dot radius (CSS pixels). */
  setDotRadius(r) {
    this.dotR = r;
    if (!this._animating) this.renderStatic();
  }

  /** Set bloom radius multiplier (1.0 = default). */
  setGlowAmount(mult) {
    this.glowMult = mult;
    if (!this._animating) this.renderStatic();
  }

  /** Mark animation running state (used by heat map accumulation). */
  setAnimating(v) { this._animating = v; }

  /** Sync CSS transform with SVG zoom/pan. */
  setTransform(panX, panY, zoom) {
    this.canvas.style.transformOrigin = '0 0';
    this.canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }

  /** Toggle LED preview visibility. */
  toggle() {
    this.enabled = !this.enabled;
    this.canvas.style.display = this.enabled ? 'block' : 'none';
    if (this.enabled && !this._animating) this.renderStatic();
    return this.enabled;
  }

  /** Toggle solid-dot vs glow rendering. */
  /** Cycle through glow modes: center → outward → inward → dots → center */
  cycleGlowMode() {
    const order = ['center', 'outward', 'inward', 'dots'];
    const cur   = this.dotMode ? 'dots' : this.glowMode;
    const next  = order[(order.indexOf(cur) + 1) % order.length];
    this.dotMode  = next === 'dots';
    this.glowMode = next === 'dots' ? 'center' : next;
    // Re-render whatever is currently visible
    if (this._heatData && this._heatFrames > 0 && !this.heatMap) {
      this.renderHeat();
    } else if (!this._animating) {
      this.renderStatic();
    }
    return next;
  }

  toggleDotMode() {
    this.dotMode = !this.dotMode;
    if (!this._animating) this.renderStatic();
    return this.dotMode;
  }

  /** Render the accumulated heat map with directional gradients. */
  renderHeat() {
    if (!this._heatData || !this._heatFrames || !this.pixels.length) return;
    const { ctx, pixels } = this;
    const N = pixels.length;
    const { scale, offsetX, offsetY, vbX, vbY } = this._svgTransform();
    const w = this.canvas.width;
    const h = this.canvas.height;
    const bloomR = this.dotR * this.dpr * 3.2 * this.glowMult / scale;
    const coreR  = this.dotR * this.dpr * 0.7  / scale;

    // Normalize heat values
    let maxHeat = 0;
    for (let i = 0; i < N; i++) if (this._heatData[i] > maxHeat) maxHeat = this._heatData[i];
    const normFactor = maxHeat > 0 ? 1 / maxHeat : 1;

    // Directional normals
    const useDir = this.glowMode !== 'center' && this.glowMode !== 'dots';
    const dir    = this.glowMode === 'inward' ? -1 : 1;
    const norms  = useDir ? this._computeNormals(pixels) : null;
    const off    = bloomR * 0.45;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < N; i++) {
      const heat = Math.min(this._heatData[i] * normFactor, 1);
      // heat colour: cold blue → cyan → green → yellow → hot red
      const r  = Math.round(heat > 0.5 ? (heat - 0.5) * 2 * 255 : 0);
      const g2 = Math.round(heat < 0.5 ? heat * 2 * 255 : (1 - (heat - 0.5) * 2) * 255);
      const b  = Math.round(heat < 0.5 ? (0.5 - heat) * 2 * 220 : 0);

      const px = pixels[i].x - vbX;
      const py = pixels[i].y - vbY;
      const fx = norms ? px + norms.nx[i] * off * dir : px;
      const fy = norms ? py + norms.ny[i] * off * dir : py;

      // Bloom gradient
      const grad = ctx.createRadialGradient(fx, fy, 0, px, py, bloomR);
      grad.addColorStop(0,    `rgba(${r},${g2},${b},0.6)`);
      grad.addColorStop(0.3,  `rgba(${r},${g2},${b},0.2)`);
      grad.addColorStop(0.7,  `rgba(${r},${g2},${b},0.05)`);
      grad.addColorStop(1,    `rgba(${r},${g2},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, bloomR, 0, TAU);
      ctx.fill();
    }

    // Core dots on top
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < N; i++) {
      const heat = Math.min(this._heatData[i] * normFactor, 1);
      const r  = Math.round(heat > 0.5 ? (heat - 0.5) * 2 * 255 : 0);
      const g2 = Math.round(heat < 0.5 ? heat * 2 * 255 : (1 - (heat - 0.5) * 2) * 255);
      const b  = Math.round(heat < 0.5 ? (0.5 - heat) * 2 * 220 : 0);
      ctx.fillStyle = `rgb(${r},${g2},${b})`;
      ctx.beginPath();
      ctx.arc(pixels[i].x - vbX, pixels[i].y - vbY, coreR, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Clear accumulated heat data. */
  clearHeat() {
    this._heatData = null;
    this._heatFrames = 0;
  }

  /** Coverage density view — teal directional gradient glow per pixel. */
  /** Activate coverage mode. colorMap: Map<stripId, hexColor>. angleMap: Map<stripId, degrees|null> (0=up, null=omni). */
  showCoverage(colorMap, angleMap) {
    this._coverageColorMap = colorMap;
    this._coverageAngleMap = angleMap ?? null;
    this.renderCoverage();
  }

  /** Deactivate coverage mode and return to normal rendering. */
  hideCoverage() {
    this._coverageColorMap = null;
    this._coverageAngleMap = null;
  }

  renderCoverage() {
    if (!this.pixels.length) return;
    const { ctx, pixels } = this;
    const colorMap = this._coverageColorMap;
    const angleMap = this._coverageAngleMap;
    const N = pixels.length;
    const { scale, offsetX, offsetY, vbX, vbY } = this._svgTransform();
    const bloomR = this.dotR * this.dpr * 5.0 / scale;
    const coreR  = this.dotR * this.dpr * 0.75 / scale;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.globalCompositeOperation = 'lighter';

    // Coverage halo: transparent at center (LED visible) → brightening → peak → fading
    for (let i = 0; i < N; i++) {
      const px  = pixels[i].x - vbX;
      const py  = pixels[i].y - vbY;
      const hex = colorMap?.get(pixels[i].stripId) ?? '#00ffc8';
      const [r, g, b] = _hexRgb(hex);
      const emitDeg = angleMap?.get(pixels[i].stripId);
      const hasDir  = emitDeg != null;

      // Bright at LED → fade to transparent outward
      const grad = ctx.createRadialGradient(px, py, 0, px, py, bloomR);
      grad.addColorStop(0,    `rgba(${r},${g},${b},0.9)`);
      grad.addColorStop(0.25, `rgba(${r},${g},${b},0.55)`);
      grad.addColorStop(0.55, `rgba(${r},${g},${b},0.18)`);
      grad.addColorStop(0.8,  `rgba(${r},${g},${b},0.04)`);
      grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;

      if (hasDir) {
        // Clip gradient to a directional cone (±60° = 120° total spread)
        const emitRad = (emitDeg - 90) * Math.PI / 180; // 0°=up in screen coords (y-down)
        const spread  = Math.PI / 3;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.arc(px, py, bloomR, emitRad - spread, emitRad + spread);
        ctx.closePath();
        ctx.clip();
        ctx.beginPath();
        ctx.arc(px, py, bloomR, 0, TAU);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(px, py, bloomR, 0, TAU);
        ctx.fill();
      }
    }

    // LED dots drawn on top — always visible, bright with white hotspot
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < N; i++) {
      const px  = pixels[i].x - vbX;
      const py  = pixels[i].y - vbY;
      const hex = colorMap?.get(pixels[i].stripId) ?? '#00ffc8';
      const [r, g, b] = _hexRgb(hex);
      const dotGrad = ctx.createRadialGradient(px, py, 0, px, py, coreR * 1.8);
      dotGrad.addColorStop(0,   'rgba(255,255,255,1)');
      dotGrad.addColorStop(0.35,`rgba(${r},${g},${b},1)`);
      dotGrad.addColorStop(1,   `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = dotGrad;
      ctx.beginPath();
      ctx.arc(px, py, coreR * 1.8, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  /** Toggle heat map accumulation mode. */
  toggleHeatMap() {
    this.heatMap = !this.heatMap;
    if (!this.heatMap && this._heatFrames > 0) {
      this.renderHeat();
    } else {
      this.clearHeat();
      if (!this._animating) this.renderStatic();
    }
    return this.heatMap;
  }
}
