import { useEffect, useRef, useMemo } from 'react';
import {
  buildGammaLut,
  compilePattern,
  normalizePalette,
  renderPixelFrame,
  resolvePatternParams,
} from '../lib/frameEngine.js';
import { DEMO_STRIPS, PALETTE_DEFAULT } from '../data.js';

function hexToNorm(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
const PALETTE_NORM = PALETTE_DEFAULT.map(hexToNorm);

function parseViewBox(vb) {
  const parts = (vb || '0 0 640 400').trim().split(/[\s,]+/).map(Number);
  return { x: parts[0] || 0, y: parts[1] || 0, w: parts[2] || 640, h: parts[3] || 400 };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  return [hue2rgb(p,q,h+1/3), hue2rgb(p,q,h), hue2rgb(p,q,h-1/3)].map(v => Math.round(v * 255));
}

function calcSpacing(pts) {
  if (pts.length < 2) return 8;
  let total = 0;
  const n = Math.min(pts.length - 1, 30);
  for (let i = 0; i < n; i++) {
    const dx = pts[i+1].x - pts[i].x, dy = pts[i+1].y - pts[i].y;
    total += Math.sqrt(dx*dx + dy*dy);
  }
  return total / n;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Pure canvas draw — no React, no DOM elements per LED, GPU shadowBlur for glow
function renderFrame(canvas, t, p) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  if (!W || !H || !p.vb) return [];

  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--preview-bg').trim() || '#050608';
  ctx.fillRect(0, 0, W, H);

  const {
    visibleStrips, normBounds, medianSpacing, pixelCount,
    activeFn, blendFn, glow, dotSize, bpm, resolvedParams, paletteNorm,
    masterSpeed, masterBrightness, masterSaturation, masterHueShift,
    gammaLUT, symSettings, audioBands, blendAmount, blendType,
    perStripFns, vb, heat,
  } = p;

  // ViewBox → canvas pixel mapping (letterbox, maintain aspect ratio)
  const scale = Math.min(W / vb.w, H / vb.h);
  const offX  = (W - vb.w * scale) / 2 - vb.x * scale;
  const offY  = (H - vb.h * scale) / 2 - vb.y * scale;
  const toX = x => x * scale + offX;
  const toY = y => y * scale + offY;

  const frame = renderPixelFrame({
    t, strips: visibleStrips, patternId: p.patternId, activeFn, blendFn,
    blendAmount, blendType, params: resolvedParams, paletteNorm, bpm,
    masterSpeed, masterBrightness, masterSaturation, masterHueShift,
    gammaLUT, symSettings, audioBands, normBounds, perStripFns,
  });
  const framePixels = frame.pixels;
  const stripData = frame.stripFrames.map(s => ({ ...s, spacing: s.spacing ?? medianSpacing }));

  // ── Glow — offscreen dots + GPU blur ────────────────────────────────────
  // Draw all LEDs as solid dots onto one offscreen canvas, then composite
  // with blur. Gaussian blur of a solid dot ≈ radial gradient, at a fraction
  // of the cost. Two passes: wide halo + tight corona.
  if (glow > 0) {
    const sp    = clamp(medianSpacing * scale, 2, 18);
    const TAU   = Math.PI * 2;
    const dotPx = clamp(sp * dotSize * 0.36, 1.5, 5.5);
    const wBlur = clamp(sp * glow * 0.95, 2, 16).toFixed(1);
    const tBlur = clamp(sp * glow * 0.24, 1, 5).toFixed(1);

    // Reuse offscreen canvas across frames
    if (!canvas._glow || canvas._glow.width !== W || canvas._glow.height !== H) {
      canvas._glow = document.createElement('canvas');
      canvas._glow.width  = W;
      canvas._glow.height = H;
    }
    const off  = canvas._glow;
    const octx = off.getContext('2d');

    octx.clearRect(0, 0, W, H);
    for (const sd of stripData) {
      for (const l of sd.leds) {
        if ((l.r | l.g | l.b) === 0) continue;
        octx.fillStyle = `rgb(${l.r},${l.g},${l.b})`;
        octx.beginPath();
        octx.arc(toX(l.x), toY(l.y), dotPx, 0, TAU);
        octx.fill();
      }
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Wide ambient halo
    ctx.globalAlpha = clamp(glow * 0.30, 0.10, 0.42);
    ctx.filter = `blur(${wBlur}px)`;
    ctx.drawImage(off, 0, 0);

    // Tight corona
    ctx.globalAlpha = 1.0;
    ctx.filter = `blur(${tBlur}px)`;
    ctx.drawImage(off, 0, 0);

    ctx.filter = 'none';
    ctx.restore();
  }

  // ── Core dots — individual LED colors ────────────────────────────────────
  if (heat) {
    const heatR = clamp(medianSpacing * scale * Math.max(0.5, dotSize) * 0.95, 3, 18);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const sd of stripData) {
      for (const l of sd.leds) {
        ctx.fillStyle = 'rgba(255, 180, 70, 0.10)';
        ctx.beginPath();
        ctx.arc(toX(l.x), toY(l.y), heatR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  const coreR = clamp(medianSpacing * scale * dotSize * 0.28, 1, 5);
  ctx.save();
  for (const sd of stripData) {
    for (const l of sd.leds) {
      ctx.fillStyle = `rgb(${l.r},${l.g},${l.b})`;
      ctx.beginPath();
      ctx.arc(toX(l.x), toY(l.y), coreR, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  return framePixels;
}

// ── Component ─────────────────────────────────────────────────────────────

export function LEDPreview({
  patternId, playing,
  glow = 1, dotSize = 2.5, speed = 1,
  params = {}, bpm = 120,
  strips: propStrips, viewBox: propViewBox, svgText,
  masterSpeed = 1, masterBrightness = 1, masterSaturation = 1, masterHueShift = 0,
  gammaEnabled = false, gammaValue = 2.2,
  hidden = {},
  compiledFn = null, onTick = null, onFrame = null,
  blendPatternId = null, blendAmount = 0, blendCompiledFn = null, blendType = 'crossfade',
  symSettings = null, audioBands = null, onFps = null,
  palette: paletteProp = null,
  heat = false,
}) {
  const canvasRef = useRef(null);
  const rafRef    = useRef(0);
  const tRef      = useRef(0);
  const fpsRef    = useRef({ count: 0, last: 0 });
  const staticRenderRef = useRef(0);
  const propsRef  = useRef({});

  const paletteNorm = useMemo(
    () => paletteProp ? normalizePalette(paletteProp) : PALETTE_NORM,
    [paletteProp],
  );

  const resolvedParams = useMemo(() => {
    return resolvePatternParams(patternId, params);
  }, [patternId, params]);

  const activeFn = useMemo(() => {
    if (compiledFn) return compiledFn;
    return compilePattern(patternId);
  }, [patternId, compiledFn]);

  const blendFn = useMemo(() => {
    if (!blendPatternId) return null;
    if (blendCompiledFn) return blendCompiledFn;
    return compilePattern(blendPatternId);
  }, [blendPatternId, blendCompiledFn]);

  const gammaLUT = useMemo(() => {
    return buildGammaLut(gammaEnabled, gammaValue);
  }, [gammaEnabled, gammaValue]);

  const useRealStrips = !!(propStrips && propStrips.length > 0);

  const perStripFns = useMemo(() => {
    if (!useRealStrips) return new Map();
    const map = new Map();
    for (const s of (propStrips || [])) {
      if (s.patternId && !map.has(s.patternId)) {
        const fn = compilePattern(s.patternId);
        if (fn) map.set(s.patternId, fn);
      }
    }
    return map;
  }, [propStrips, useRealStrips]);

  const realStripData = useMemo(() => {
    if (!useRealStrips) return [];
    return propStrips.map(s => {
      const pts = (s.pixels || []).map((px, i) => ({
        x: px.x, y: px.y,
        p: s.pixels.length > 1 ? i / (s.pixels.length - 1) : 0.5, i,
      }));
      return { id: s.id, color: s.color, speed: s.speed, brightness: s.brightness, hueShift: s.hueShift, pts, spacing: calcSpacing(pts) };
    });
  }, [propStrips, useRealStrips]);

  const demoStripData = useMemo(() => {
    if (useRealStrips) return [];
    return DEMO_STRIPS.map(s => {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', s.path);
      const len = pathEl.getTotalLength ? pathEl.getTotalLength() : 100;
      const pts = [];
      for (let i = 0; i < s.leds; i++) {
        const frac = s.leds === 1 ? 0.5 : i / (s.leds - 1);
        const p = pathEl.getPointAtLength(frac * len);
        pts.push({ x: p.x, y: p.y, p: frac, i });
      }
      return { id: s.id, color: '#88aaff', pts, spacing: calcSpacing(pts) };
    });
  }, [useRealStrips]);

  const activeStrips = useMemo(
    () => useRealStrips ? realStripData : demoStripData,
    [useRealStrips, realStripData, demoStripData],
  );

  const artworkViewBox = useMemo(() => {
    if (!svgText) return null;
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    return doc.querySelector('svg')?.getAttribute('viewBox') || null;
  }, [svgText]);

  const svgViewBox = artworkViewBox || (useRealStrips ? propViewBox : '0 0 640 400');
  const vb = useMemo(() => parseViewBox(svgViewBox), [svgViewBox]);

  const visibleStrips = useMemo(
    () => activeStrips.filter(s => !hidden[s.id]),
    [activeStrips, hidden],
  );

  const normBounds = useMemo(() => {
    const allPts = activeStrips.flatMap(s => s.pts);
    if (!allPts.length) return { minX: 0, minY: 0, range: 1 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of allPts) {
      if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
    }
    return { minX, minY, range: Math.max(maxX - minX, maxY - minY, 0.001) };
  }, [activeStrips]);

  const medianSpacing = useMemo(() => {
    const vals = activeStrips.map(s => s.spacing).filter(Boolean).sort((a, b) => a - b);
    return vals.length ? vals[Math.floor(vals.length / 2)] : 8;
  }, [activeStrips]);

  const pixelCount = useMemo(
    () => visibleStrips.reduce((sum, s) => sum + s.pts.length, 0),
    [visibleStrips],
  );

  // Refresh propsRef every render — RAF closure always reads fresh values
  propsRef.current = {
    patternId, playing, speed, glow, dotSize, bpm, resolvedParams, paletteNorm,
    activeFn, blendFn, blendAmount, blendType,
    perStripFns, visibleStrips, normBounds, medianSpacing, pixelCount,
    masterSpeed, masterBrightness, masterSaturation, masterHueShift,
    gammaLUT, symSettings, audioBands, vb, heat,
    onFrame, onFps, onTick,
  };

  // DPR-aware canvas sizing (fallback to offsetWidth for headless/zero-layout envs)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const setSize = () => {
      const dprCap = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--preview-dpr')) || 1;
      const dpr = Math.max(0.5, Math.min(window.devicePixelRatio || 1, dprCap));
      const w = canvas.clientWidth  || canvas.offsetWidth  || 800;
      const h = canvas.clientHeight || canvas.offsetHeight || 600;
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
    };
    setSize();
    const ro = new ResizeObserver(setSize);
    ro.observe(canvas);
    window.addEventListener('lw-preview-settings', setSize);
    return () => {
      ro.disconnect();
      window.removeEventListener('lw-preview-settings', setSize);
    };
  }, []);

  // Single persistent RAF loop — never restarts, reads fresh propsRef each tick
  useEffect(() => {
    let last = performance.now();
    const tick = (now) => {
      const p = propsRef.current;
      const dt = Math.min((now - last) / 1000, 0.1); last = now;

      if (p.playing) {
        tRef.current += dt * (p.speed ?? 1);
        p.onTick?.(tRef.current);
      }

      fpsRef.current.count++;
      if (now - fpsRef.current.last >= 500) {
        const elapsed = (now - fpsRef.current.last) / 1000;
        const fps = Math.round(fpsRef.current.count / elapsed);
        fpsRef.current = { count: 0, last: now };
        p.onFps?.(fps);
      }

      const canvas = canvasRef.current;
      const shouldRender = p.playing || now - staticRenderRef.current > 250;
      if (canvas?.width && canvas?.height && shouldRender) {
        const pixels = renderFrame(canvas, tRef.current, p);
        staticRenderRef.current = now;
        if (p.playing) p.onFrame?.(pixels);
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    fpsRef.current.last = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }}/>;
}
