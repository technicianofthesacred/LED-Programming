import { useEffect, useRef, useMemo } from 'react';
import {
  buildGammaLut,
  compilePattern,
  normalizePalette,
  renderPixelFrame,
  resolvePatternParams,
} from '../lib/frameEngine.js';
import { smoothPixelFrame } from '../lib/motionSmoothing.js';
import {
  activeLedCoreAlpha,
  activeLedCoronaAlpha,
  restingLedColor,
} from '../lib/previewVisuals.js';
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

function whiteHighlightAlpha(r, g, b, brightness) {
  const max = Math.max(r, g, b);
  if (max <= 0) return 0;
  const min = Math.min(r, g, b);
  const saturationProxy = (max - min) / max;
  const nearWhite = clamp((0.42 - saturationProxy) / 0.42, 0, 1);
  return clamp(nearWhite * brightness * 0.18, 0, 0.18);
}

// Pure canvas draw — no React, no DOM elements per LED, GPU shadowBlur for glow
function renderFrame(canvas, t, p) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  if (!W || !H || !p.vb) return [];

  ctx.clearRect(0, 0, W, H);
  const bg = getComputedStyle(canvas).getPropertyValue('--preview-bg').trim();
  if (bg && bg !== 'transparent') {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
  } else {
    // Keep the canvas visually transparent over the viewport grid while avoiding
    // fully black transparent pixels that read as dark seams in glow analysis.
    ctx.fillStyle = 'rgba(20, 22, 28, 0.08)';
    ctx.fillRect(0, 0, W, H);
  }

  const {
    visibleStrips, normBounds, medianSpacing, pixelCount,
    activeFn, blendFn, glow, dotSize, bpm, resolvedParams, patternParamsById, paletteNorm,
    masterSpeed, masterBrightness, masterSaturation, masterHueShift,
    gammaLUT, symSettings, symOverlay, audioBands, blendAmount, blendType,
    perStripFns, vb, heat, motionSmoothing, previousPixels, frameDt,
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
    gammaLUT, symSettings, audioBands, normBounds, perStripFns, patternParamsById,
  });
  const framePixels = smoothPixelFrame(frame.pixels, previousPixels, {
    mode: motionSmoothing,
    dt: frameDt,
  });
  const stripMetaById = new Map(visibleStrips.map(s => [s.id, s]));
  let pixelOffset = 0;
  const stripData = frame.stripFrames.map(s => {
    const meta = stripMetaById.get(s.id) || {};
    const sourceLeds = s.leds || [];
    const leds = sourceLeds.map((led, i) => ({
      ...led,
      ...(framePixels[pixelOffset + i] || {}),
    }));
    pixelOffset += sourceLeds.length;
    return {
      ...s,
      leds,
      spacing: s.spacing ?? medianSpacing,
      pathData: meta.pathData || '',
      x: meta.x || 0,
      y: meta.y || 0,
    };
  });

  // ── Physical strip paths — visible structure, dim enough for patterns to read ─
  if (stripData.length) {
    const lineWidth = clamp(medianSpacing * scale * 0.17, 1.0, 3.4);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const sd of stripData) {
      const leds = sd.leds || [];
      if (leds.length < 2) continue;
      const strokeRail = () => {
        ctx.strokeStyle = 'rgba(70, 132, 164, 0.13)';
        ctx.lineWidth = lineWidth + 1.2;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(156, 196, 220, 0.18)';
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      };
      if (sd.pathData && typeof Path2D !== 'undefined') {
        let pathContextSaved = false;
        try {
          const path = new Path2D(sd.pathData);
          ctx.save();
          pathContextSaved = true;
          ctx.setTransform(scale, 0, 0, scale, offX + sd.x * scale, offY + sd.y * scale);
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.strokeStyle = 'rgba(70, 132, 164, 0.13)';
          ctx.lineWidth = (lineWidth + 1.2) / scale;
          ctx.stroke(path);
          ctx.strokeStyle = 'rgba(156, 196, 220, 0.18)';
          ctx.lineWidth = lineWidth / scale;
          ctx.stroke(path);
          ctx.restore();
          continue;
        } catch {
          if (pathContextSaved) ctx.restore();
        }
      }
      ctx.beginPath();
      ctx.moveTo(toX(leds[0].x), toY(leds[0].y));
      for (let i = 1; i < leds.length; i++) ctx.lineTo(toX(leds[i].x), toY(leds[i].y));
      strokeRail();
    }
    ctx.restore();
  }

  // ── Glow — offscreen dots + GPU blur ────────────────────────────────────
  // Draw all LEDs as solid dots onto one offscreen canvas, then composite
  // with blur. Gaussian blur of a solid dot ≈ radial gradient, at a fraction
  // of the cost. Two passes: wide halo + tight corona.
  if (glow > 0) {
    const sp    = clamp(medianSpacing * scale, 2, 18);
    const TAU   = Math.PI * 2;
    const dotPx = clamp(sp * dotSize * 0.40, 1.8, 6.8);
    const wBlur = clamp(sp * glow * 1.08, 3.0, 22).toFixed(1);
    const tBlur = clamp(sp * glow * 0.36, 1.2, 7.2).toFixed(1);

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
    ctx.globalAlpha = clamp(glow * 0.14, 0.04, 0.20);
    ctx.filter = `blur(${wBlur}px)`;
    ctx.drawImage(off, 0, 0);

    // Tight corona
    ctx.globalAlpha = clamp(0.24 + glow * 0.14, 0.26, 0.44);
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

  const sp = clamp(medianSpacing * scale, 2, 18);
  const beadR = clamp(sp * dotSize * 0.28, 1.2, 4.3);
  const coronaR = clamp(sp * dotSize * 0.42, 2.2, 7.5);
  const coreR = clamp(sp * dotSize * 0.34, 1.25, 6.5);
  const centerR = clamp(coreR * 0.38, 0.55, 2.1);
  const TAU = Math.PI * 2;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  for (const sd of stripData) {
    for (const l of sd.leds) {
      ctx.fillStyle = restingLedColor(l);
      ctx.beginPath();
      ctx.arc(toX(l.x), toY(l.y), beadR, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'screen';
  for (const sd of stripData) {
    for (const l of sd.leds) {
      if ((l.r | l.g | l.b) === 0) continue;
      ctx.fillStyle = `rgba(${l.r},${l.g},${l.b},${activeLedCoronaAlpha(l).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(toX(l.x), toY(l.y), coronaR, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  for (const sd of stripData) {
    for (const l of sd.leds) {
      const coreAlpha = activeLedCoreAlpha(l);
      if (!coreAlpha) continue;
      const brightness = Math.max(l.r, l.g, l.b) / 255;
      ctx.fillStyle = `rgba(${l.r},${l.g},${l.b},${clamp(0.78 + brightness * 0.18, 0.78, 0.96)})`;
      ctx.beginPath();
      ctx.arc(toX(l.x), toY(l.y), coreR, 0, TAU);
      ctx.fill();
      const whiteAlpha = whiteHighlightAlpha(l.r, l.g, l.b, brightness);
      if (whiteAlpha > 0.01) {
        ctx.fillStyle = `rgba(245, 250, 255, ${whiteAlpha})`;
        ctx.beginPath();
        ctx.arc(toX(l.x), toY(l.y), centerR, 0, TAU);
        ctx.fill();
      }
    }
  }
  ctx.restore();

  // ── Symmetry editor overlay — draggable hub + spokes ─────────────────────
  if (symOverlay && symSettings?.enabled && normBounds) {
    const type = symSettings.type;
    const center = symSettings.center || { x: 0.5, y: 0.5 };
    const cvbx = normBounds.minX + center.x * normBounds.range;
    const cvby = normBounds.minY + center.y * normBounds.range;
    const cxp = toX(cvbx), cyp = toY(cvby);
    const rvb = 0.46 * normBounds.range;
    const TAU2 = Math.PI * 2;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(120, 220, 255, 0.6)';

    if (type === 'radial' || type === 'kaleido') {
      const n = Math.max(2, type === 'kaleido' ? (symSettings.slices || 6) : (symSettings.count || 8));
      const base = (symSettings.phase || 0) * TAU2;
      ctx.setLineDash([5, 5]);
      for (let k = 0; k < n; k++) {
        const ang = base + k * TAU2 / n;
        ctx.beginPath();
        ctx.moveTo(cxp, cyp);
        ctx.lineTo(toX(cvbx + Math.cos(ang) * rvb), toY(cvby + Math.sin(ang) * rvb));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // Rotate handle at the first seam
      const hx = toX(cvbx + Math.cos(base) * rvb), hy = toY(cvby + Math.sin(base) * rvb);
      ctx.fillStyle = 'rgba(120, 220, 255, 0.95)';
      ctx.beginPath(); ctx.arc(hx, hy, 6.5, 0, TAU2); ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.beginPath(); ctx.arc(hx, hy, 6.5, 0, TAU2); ctx.stroke();
    } else if (typeof type === 'string' && type.startsWith('mirror')) {
      ctx.setLineDash([5, 5]);
      if (type === 'mirror-v' || type === 'mirror-hv') {
        ctx.beginPath(); ctx.moveTo(cxp, 0); ctx.lineTo(cxp, H); ctx.stroke();
      }
      if (type === 'mirror-h' || type === 'mirror-hv') {
        ctx.beginPath(); ctx.moveTo(0, cyp); ctx.lineTo(W, cyp); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Hub
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillStyle = 'rgba(120, 220, 255, 0.95)';
    ctx.beginPath(); ctx.arc(cxp, cyp, 9, 0, TAU2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cxp, cyp, 3.6, 0, TAU2); ctx.fill();
    ctx.restore();
  }

  return framePixels;
}

// ── Component ─────────────────────────────────────────────────────────────

export function PatternPreview({
  patternId, playing,
  glow = 1, dotSize = 2.5, speed = 1,
  params = {}, patternParamsById = {}, bpm = 120,
  strips: propStrips, viewBox: propViewBox, svgText,
  masterSpeed = 1, masterBrightness = 1, masterSaturation = 1, masterHueShift = 0,
  gammaEnabled = false, gammaValue = 2.2,
  hidden = {},
  compiledFn = null, onTick = null, onFrame = null,
  blendPatternId = null, blendAmount = 0, blendCompiledFn = null, blendType = 'crossfade',
  symSettings = null, symOverlay = false, onSymChange = null, audioBands = null, onFps = null,
  palette: paletteProp = null,
  motionSmoothing = 'soft',
  targetFps = 60,
  heat = false,
  controlledTime = null,
}) {
  const canvasRef = useRef(null);
  const rafRef    = useRef(0);
  const tRef      = useRef(0);
  const previousPixelsRef = useRef(null);
  const fpsRef    = useRef({ count: 0, last: 0 });
  const staticRenderRef = useRef(0);
  const lastRenderRef = useRef(0);
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

  const useRealStrips = Array.isArray(propStrips);

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
      return {
        id: s.id,
        color: s.color,
        speed: s.speed,
        brightness: s.brightness,
        hueShift: s.hueShift,
        patternId: s.patternId || null,
        pts,
        spacing: calcSpacing(pts),
        pathData: s.pathData || '',
        x: s.x || 0,
        y: s.y || 0,
      };
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
      return { id: s.id, color: '#88aaff', pts, spacing: calcSpacing(pts), pathData: s.path, x: 0, y: 0 };
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

  const svgViewBox = useRealStrips
    ? (propViewBox || artworkViewBox || '0 0 640 400')
    : (artworkViewBox || '0 0 640 400');
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
    patternId, playing, speed, glow, dotSize, bpm, resolvedParams, patternParamsById, paletteNorm,
    activeFn, blendFn, blendAmount, blendType,
    perStripFns, visibleStrips, normBounds, medianSpacing, pixelCount,
    masterSpeed, masterBrightness, masterSaturation, masterHueShift,
    gammaLUT, symSettings, symOverlay, audioBands, vb, heat,
    motionSmoothing, targetFps, controlledTime,
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

  useEffect(() => {
    previousPixelsRef.current = null;
    staticRenderRef.current = 0;
    lastRenderRef.current = 0;
  }, [patternId, blendPatternId, pixelCount, svgViewBox, motionSmoothing]);

  // Single persistent RAF loop — never restarts, reads fresh propsRef each tick
  useEffect(() => {
    let last = performance.now();
    const tick = (now) => {
      const p = propsRef.current;
      const dt = Math.min((now - last) / 1000, 0.1); last = now;

      const hasControlledTime = p.controlledTime !== null
        && p.controlledTime !== undefined
        && Number.isFinite(Number(p.controlledTime));
      if (p.playing && !hasControlledTime) {
        tRef.current += dt * (p.speed ?? 1);
        p.onTick?.(tRef.current);
      }
      const renderTime = hasControlledTime ? Number(p.controlledTime) : tRef.current;

      fpsRef.current.count++;
      if (now - fpsRef.current.last >= 500) {
        const elapsed = (now - fpsRef.current.last) / 1000;
        const fps = Math.round(fpsRef.current.count / elapsed);
        fpsRef.current = { count: 0, last: now };
        p.onFps?.(fps);
      }

      const canvas = canvasRef.current;
      const minFrameMs = p.targetFps > 0 ? 1000 / p.targetFps : 0;
      const shouldRender = p.playing
        ? now - staticRenderRef.current >= minFrameMs
        : now - staticRenderRef.current > 250;
      if (canvas?.width && canvas?.height && shouldRender) {
        const renderDt = lastRenderRef.current
          ? Math.min((now - lastRenderRef.current) / 1000, 0.25)
          : dt;
        const pixels = renderFrame(canvas, renderTime, {
          ...p,
          previousPixels: previousPixelsRef.current,
          frameDt: renderDt,
        });
        previousPixelsRef.current = pixels;
        staticRenderRef.current = now;
        lastRenderRef.current = now;
        if (p.playing) p.onFrame?.(pixels);
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    fpsRef.current.last = performance.now();
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Symmetry overlay dragging (hub = center, handle = rotate) ─────────────
  const dragRef = useRef(null);

  const pointerToNorm = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const W = canvas.width, H = canvas.height;
    const scale = Math.min(W / vb.w, H / vb.h);
    const offX = (W - vb.w * scale) / 2 - vb.x * scale;
    const offY = (H - vb.h * scale) / 2 - vb.y * scale;
    const rect = canvas.getBoundingClientRect();
    const dx = (e.clientX - rect.left) * (W / rect.width);
    const dy = (e.clientY - rect.top) * (H / rect.height);
    const vbX = (dx - offX) / scale;
    const vbY = (dy - offY) / scale;
    return {
      x: (vbX - normBounds.minX) / normBounds.range,
      y: (vbY - normBounds.minY) / normBounds.range,
    };
  };

  const handlePointerDown = (e) => {
    if (!symOverlay || !onSymChange || !symSettings?.enabled) return;
    const n = pointerToNorm(e);
    if (!n) return;
    const center = symSettings.center || { x: 0.5, y: 0.5 };
    const type = symSettings.type;
    const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

    if (type === 'radial' || type === 'kaleido') {
      const base = (symSettings.phase || 0) * Math.PI * 2;
      const hx = center.x + Math.cos(base) * 0.46;
      const hy = center.y + Math.sin(base) * 0.46;
      if (dist(n.x, n.y, hx, hy) < 0.08) {
        dragRef.current = 'rotate';
        e.currentTarget.setPointerCapture?.(e.pointerId);
        return;
      }
    }
    if (dist(n.x, n.y, center.x, center.y) < 0.1) {
      dragRef.current = 'center';
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };

  const handlePointerMove = (e) => {
    if (!dragRef.current || !onSymChange) return;
    const n = pointerToNorm(e);
    if (!n) return;
    if (dragRef.current === 'center') {
      onSymChange({ center: { x: clamp(n.x, 0, 1), y: clamp(n.y, 0, 1) } });
    } else if (dragRef.current === 'rotate') {
      const center = symSettings.center || { x: 0.5, y: 0.5 };
      const ang = Math.atan2(n.y - center.y, n.x - center.x);
      const phase = ((ang / (Math.PI * 2)) % 1 + 1) % 1;
      onSymChange({ phase });
    }
  };

  const endDrag = (e) => {
    if (dragRef.current) {
      e.currentTarget?.releasePointerCapture?.(e.pointerId);
      dragRef.current = null;
    }
  };

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={symOverlay ? handlePointerDown : undefined}
      onPointerMove={symOverlay ? handlePointerMove : undefined}
      onPointerUp={symOverlay ? endDrag : undefined}
      onPointerCancel={symOverlay ? endDrag : undefined}
      style={{
        width: '100%', height: '100%', display: 'block', '--preview-bg': 'transparent',
        touchAction: symOverlay ? 'none' : undefined,
        cursor: symOverlay ? 'grab' : undefined,
      }}
    />
  );
}
