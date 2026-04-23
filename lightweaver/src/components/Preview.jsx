import { useEffect, useRef, useMemo } from 'react';
import { compile, evalPixel } from '../lib/patterns.js';
import { PATTERNS } from '../lib/patterns-library.js';
import { applySymmetry } from '../lib/symmetry.js';
import { DEMO_STRIPS, PALETTE_DEFAULT, DEFAULT_PARAMS } from '../data.js';

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

// Pure canvas draw — no React, no DOM elements per LED, GPU shadowBlur for glow
function renderFrame(canvas, t, p) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  if (!W || !H || !p.vb) return [];

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const {
    visibleStrips, normBounds, medianSpacing, pixelCount,
    activeFn, blendFn, glow, dotSize, bpm, resolvedParams, paletteNorm,
    masterSpeed, masterBrightness, masterSaturation, masterHueShift,
    gammaLUT, symSettings, audioBands, blendAmount, blendType,
    perStripFns, vb,
  } = p;

  // ViewBox → canvas pixel mapping (letterbox, maintain aspect ratio)
  const scale = Math.min(W / vb.w, H / vb.h);
  const offX  = (W - vb.w * scale) / 2 - vb.x * scale;
  const offY  = (H - vb.h * scale) / 2 - vb.y * scale;
  const toX = x => x * scale + offX;
  const toY = y => y * scale + offY;

  const beat    = (t * bpm / 60) % 1;
  const beatSin = Math.sin(beat * Math.PI);
  const bass = audioBands?.bass ?? 0, mid = audioBands?.mid ?? 0, hi = audioBands?.hi ?? 0;

  let globalIdx = 0;
  const stripData   = [];
  const framePixels = [];

  for (const s of visibleStrips) {
    const stripT    = t * masterSpeed * (s.speed ?? 1);
    const stripTime = (stripT / 65.536) % 1;
    const stripFn   = (s.patternId ? perStripFns.get(s.patternId) : null) ?? activeFn;

    let rSum = 0, gSum = 0, bSum = 0;
    const leds = [];

    for (const pt of s.pts) {
      let nx = (pt.x - normBounds.minX) / normBounds.range;
      let ny = (pt.y - normBounds.minY) / normBounds.range;

      if (symSettings?.enabled) {
        const sym = applySymmetry(nx, ny, symSettings, t);
        nx = sym.x; ny = sym.y;
      }

      let r = 0, g = 0, b = 0;
      if (stripFn) {
        const colA = evalPixel(stripFn, globalIdx, nx, ny, stripT, stripTime, pixelCount, paletteNorm, beat, beatSin, resolvedParams, s.id, pt.p, bass, mid, hi);
        r = colA.r; g = colA.g; b = colA.b;

        if (blendFn && blendAmount > 0) {
          const colB = evalPixel(blendFn, globalIdx, nx, ny, stripT, stripTime, pixelCount, paletteNorm, beat, beatSin, resolvedParams, s.id, pt.p, bass, mid, hi);
          if (blendType === 'fade-black') {
            const a2 = blendAmount < 0.5 ? 1 - blendAmount * 2 : 0;
            const b2 = blendAmount > 0.5 ? (blendAmount - 0.5) * 2 : 0;
            r = colA.r * a2 + colB.r * b2; g = colA.g * a2 + colB.g * b2; b = colA.b * a2 + colB.b * b2;
          } else if (blendType === 'dissolve') {
            const a_ = 1 - blendAmount, b_ = blendAmount;
            r = Math.min(255, colA.r * a_ + colB.r * b_ + colA.r * colB.r * blendAmount / 255);
            g = Math.min(255, colA.g * a_ + colB.g * b_ + colA.g * colB.g * blendAmount / 255);
            b = Math.min(255, colA.b * a_ + colB.b * b_ + colA.b * colB.b * blendAmount / 255);
          } else {
            r = colA.r * (1 - blendAmount) + colB.r * blendAmount;
            g = colA.g * (1 - blendAmount) + colB.g * blendAmount;
            b = colA.b * (1 - blendAmount) + colB.b * blendAmount;
          }
        }
      }

      const bright = (s.brightness ?? 1) * masterBrightness;
      r *= bright; g *= bright; b *= bright;

      if (masterSaturation < 0.999) {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * masterSaturation;
        g = gray + (g - gray) * masterSaturation;
        b = gray + (b - gray) * masterSaturation;
      }

      r = Math.max(0, Math.min(255, r));
      g = Math.max(0, Math.min(255, g));
      b = Math.max(0, Math.min(255, b));

      if (gammaLUT) { r = gammaLUT[Math.round(r)]; g = gammaLUT[Math.round(g)]; b = gammaLUT[Math.round(b)]; }

      if (s.hueShift || masterHueShift) {
        const [h, sat, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h + (s.hueShift || 0) + masterHueShift, sat, l);
      }

      framePixels.push({ r: Math.round(r), g: Math.round(g), b: Math.round(b) });
      rSum += r; gSum += g; bSum += b;
      leds.push({ x: pt.x, y: pt.y, r: Math.round(r), g: Math.round(g), b: Math.round(b) });
      globalIdx++;
    }

    const n = leds.length;
    stripData.push({
      leds,
      avgR: n ? Math.round(rSum / n) : 0,
      avgG: n ? Math.round(gSum / n) : 0,
      avgB: n ? Math.round(bSum / n) : 0,
      spacing: s.spacing ?? medianSpacing,
    });
  }

  // ── Glow — offscreen dots + GPU blur ────────────────────────────────────
  // Draw all LEDs as solid dots onto one offscreen canvas, then composite
  // with blur. Gaussian blur of a solid dot ≈ radial gradient, at a fraction
  // of the cost. Two passes: wide halo + tight corona.
  if (glow > 0) {
    const sp    = medianSpacing * scale;
    const TAU   = Math.PI * 2;
    // Dot radius grows with glow so blur has real energy to spread
    const dotPx = Math.max(2, sp * dotSize * glow * 0.7);
    const wBlur = (sp * dotSize * glow * 1.6).toFixed(1);
    const tBlur = (sp * dotSize * glow * 0.28).toFixed(1);

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
    ctx.globalAlpha = 0.55;
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
  const coreR = Math.max(1, medianSpacing * scale * dotSize * 0.3);
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
}) {
  const canvasRef = useRef(null);
  const rafRef    = useRef(0);
  const tRef      = useRef(0);
  const fpsRef    = useRef({ count: 0, last: 0 });
  const propsRef  = useRef({});

  const paletteNorm = useMemo(
    () => paletteProp ? paletteProp.map(hexToNorm) : PALETTE_NORM,
    [paletteProp],
  );

  const resolvedParams = useMemo(() => {
    const defaults = Object.fromEntries((DEFAULT_PARAMS[patternId] || []).map(k => [k.name, k.value]));
    return { ...defaults, ...params };
  }, [patternId, params]);

  const activeFn = useMemo(() => {
    if (compiledFn) return compiledFn;
    const pat = PATTERNS.find(p => p.id === patternId);
    return pat ? compile(pat.code).fn : null;
  }, [patternId, compiledFn]);

  const blendFn = useMemo(() => {
    if (!blendPatternId) return null;
    if (blendCompiledFn) return blendCompiledFn;
    const pat = PATTERNS.find(p => p.id === blendPatternId);
    return pat ? compile(pat.code).fn : null;
  }, [blendPatternId, blendCompiledFn]);

  const gammaLUT = useMemo(() => {
    if (!gammaEnabled) return null;
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.pow(i / 255, gammaValue) * 255);
    return lut;
  }, [gammaEnabled, gammaValue]);

  const useRealStrips = !!(propStrips && propStrips.length > 0);

  const perStripFns = useMemo(() => {
    if (!useRealStrips) return new Map();
    const map = new Map();
    for (const s of (propStrips || [])) {
      if (s.patternId && !map.has(s.patternId)) {
        const pat = PATTERNS.find(p => p.id === s.patternId);
        if (pat) { const { fn } = compile(pat.code); if (fn) map.set(s.patternId, fn); }
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
    playing, speed, glow, dotSize, bpm, resolvedParams, paletteNorm,
    activeFn, blendFn, blendAmount, blendType,
    perStripFns, visibleStrips, normBounds, medianSpacing, pixelCount,
    masterSpeed, masterBrightness, masterSaturation, masterHueShift,
    gammaLUT, symSettings, audioBands, vb,
    onFrame, onFps, onTick,
  };

  // DPR-aware canvas sizing (fallback to offsetWidth for headless/zero-layout envs)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const setSize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth  || canvas.offsetWidth  || 800;
      const h = canvas.clientHeight || canvas.offsetHeight || 600;
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
    };
    setSize();
    const ro = new ResizeObserver(setSize);
    ro.observe(canvas);
    return () => ro.disconnect();
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
      if (canvas?.width && canvas?.height) {
        const pixels = renderFrame(canvas, tRef.current, p);
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
