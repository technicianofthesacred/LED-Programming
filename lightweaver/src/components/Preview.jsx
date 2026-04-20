import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { compile, evalPixel } from '../lib/patterns.js';
import { PATTERNS } from '../lib/patterns-library.js';
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

// ── Color helpers ──────────────────────────────────────────────────────────

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
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
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)].map(v => Math.round(v * 255));
}

// ── Component ──────────────────────────────────────────────────────────────

export function LEDPreview({
  patternId, playing,
  glow = 1, dotSize = 2.5, speed = 1,
  params = {}, bpm = 120,
  strips: propStrips, viewBox: propViewBox, svgText,
  // Master controls
  masterSpeed = 1,
  masterBrightness = 1,
  masterSaturation = 1,
  gammaEnabled = false,
  gammaValue = 2.2,
  hidden = {},
  compiledFn = null,   // custom compiled function from code editor (overrides library lookup)
  onTick = null,       // callback(t) called each frame — for PatternScreen time display
}) {
  const resolvedParams = useMemo(() => {
    const defaults = Object.fromEntries((DEFAULT_PARAMS[patternId] || []).map(k => [k.name, k.value]));
    return { ...defaults, ...params };
  }, [patternId, params]);

  const [t, setT] = useState(0);
  const tRef = useRef(0);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000; last = now;
      tRef.current += dt * speed;
      if (onTick) onTick(tRef.current);
      setT(tRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, speed, onTick]);

  // Use compiledFn prop if provided, otherwise look up from library
  const activeFn = useMemo(() => {
    if (compiledFn) return compiledFn;
    const pat = PATTERNS.find(p => p.id === patternId);
    if (!pat) return null;
    const { fn } = compile(pat.code);
    return fn;
  }, [patternId, compiledFn]);

  const { artworkHTML, artworkViewBox } = useMemo(() => {
    if (!svgText) return { artworkHTML: null, artworkViewBox: null };
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const srcSvg = doc.querySelector('svg');
    if (!srcSvg) return { artworkHTML: null, artworkViewBox: null };
    return {
      artworkHTML:  srcSvg.innerHTML,
      artworkViewBox: srcSvg.getAttribute('viewBox') || null,
    };
  }, [svgText]);

  // Gamma LUT
  const gammaLUT = useMemo(() => {
    if (!gammaEnabled) return null;
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = Math.round(Math.pow(i / 255, gammaValue) * 255);
    }
    return lut;
  }, [gammaEnabled, gammaValue]);

  // Use real strips from layout if available, otherwise fall back to DEMO_STRIPS
  const useRealStrips = propStrips && propStrips.length > 0;
  const vb = parseViewBox(propViewBox);

  // For real strips: pixels are already sampled — use them directly
  const realStripData = useMemo(() => {
    if (!useRealStrips) return [];
    return propStrips.map(s => ({
      id: s.id,
      color: s.color,
      speed: s.speed,
      brightness: s.brightness,
      hueShift: s.hueShift,
      pts: (s.pixels || []).map((px, i) => ({
        x: px.x,
        y: px.y,
        p: s.pixels.length > 1 ? i / (s.pixels.length - 1) : 0.5,
        i,
      })),
    }));
  }, [propStrips, useRealStrips]);

  // For demo strips: sample from paths
  const demoStripData = useMemo(() => {
    if (useRealStrips) return [];
    return DEMO_STRIPS.map(s => {
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', s.path);
      const len = pathEl.getTotalLength ? pathEl.getTotalLength() : 100;
      const count = Math.min(s.leds, 60);
      const pts = [];
      for (let i = 0; i < count; i++) {
        const frac = count === 1 ? 0.5 : i / (count - 1);
        const p = pathEl.getPointAtLength(frac * len);
        pts.push({ x: p.x, y: p.y, p: frac, i });
      }
      return { id: s.id, color: '#88aaff', pts };
    });
  }, [useRealStrips]);

  const activeStrips = useRealStrips ? realStripData : demoStripData;
  // Use artwork's own viewBox when available — its inner paths are in that coordinate space.
  // Fall back to propViewBox for real strips, then demo default.
  const svgViewBox = artworkViewBox || (useRealStrips ? propViewBox : '0 0 640 400');

  // Global pixel normalization — single bounding box across all strips
  const normBounds = useMemo(() => {
    const allPts = activeStrips.flatMap(s => s.pts);
    if (allPts.length === 0) return { minX: 0, minY: 0, range: 1 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of allPts) {
      if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
    }
    const range = Math.max(maxX - minX, maxY - minY, 0.001);
    return { minX, minY, range };
  }, [activeStrips]);

  // Filter out hidden strips
  const visibleStrips = activeStrips.filter(s => !hidden[s.id]);

  const pixelCount = visibleStrips.reduce((sum, s) => sum + s.pts.length, 0);
  const beat = (tRef.current * bpm / 60) % 1;
  const beatSin = Math.sin(beat * Math.PI);

  let globalIdx = 0;
  // Map from strip id → array of led objects for rendering
  const stripLeds = new Map();

  for (const s of visibleStrips) {
    // Per-strip time using strip.speed if available
    const stripT = tRef.current * masterSpeed * (s.speed ?? 1);
    const stripTime = (stripT / 65.536) % 1;

    const leds = [];
    for (const pt of s.pts) {
      const nx = (pt.x - normBounds.minX) / normBounds.range;
      const ny = (pt.y - normBounds.minY) / normBounds.range;
      let color = { r: 0, g: 0, b: 0 };
      if (activeFn) {
        color = evalPixel(activeFn, globalIdx, nx, ny, stripT, stripTime, pixelCount, PALETTE_NORM, beat, beatSin, resolvedParams, s.id, pt.p);
      }

      let { r, g, b } = color;

      // Per-strip brightness × master brightness
      const stripBright = (s.brightness ?? 1) * masterBrightness;
      r = r * stripBright; g = g * stripBright; b = b * stripBright;

      // Master saturation
      if (masterSaturation < 0.999) {
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        r = gray + (r - gray) * masterSaturation;
        g = gray + (g - gray) * masterSaturation;
        b = gray + (b - gray) * masterSaturation;
      }

      // Clamp
      r = Math.max(0, Math.min(255, r));
      g = Math.max(0, Math.min(255, g));
      b = Math.max(0, Math.min(255, b));

      // Gamma
      if (gammaLUT) {
        r = gammaLUT[Math.round(r)]; g = gammaLUT[Math.round(g)]; b = gammaLUT[Math.round(b)];
      }

      // Per-strip hue shift (in color math, not SVG filters)
      if (s.hueShift) {
        const [h, sat, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h + s.hueShift, sat, l);
      }

      const intensity = (r + g + b) / (255 * 3);
      leds.push({ x: pt.x, y: pt.y, color: `rgb(${r},${g},${b})`, intensity });
      globalIdx++;
    }
    stripLeds.set(s.id, leds);
  }

  // Flatten for rendering
  const allLeds = visibleStrips.flatMap(s => stripLeds.get(s.id) || []);

  return (
    <svg viewBox={svgViewBox} className="lw-preview-svg" style={{ width: '100%', height: '100%' }} overflow="visible">
      <rect width="100%" height="100%" fill="#050505"/>
      <defs>
        <filter id="lw-bloom" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={3 * glow} />
        </filter>
      </defs>
      {artworkHTML && (
        <g dangerouslySetInnerHTML={{ __html: artworkHTML }}
           style={{ opacity: 0.35, filter: 'saturate(2) brightness(1.2)', pointerEvents: 'none' }}/>
      )}
      {visibleStrips.map(s => {
        if (useRealStrips && s.pts.length >= 2) {
          const d = 'M ' + s.pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ');
          return <path key={s.id} d={d} stroke="oklch(34% 0.012 260)" strokeWidth="0.6" fill="none" strokeDasharray="2 3" />;
        }
        return null;
      })}
      {!useRealStrips && DEMO_STRIPS.map(s => (
        <path key={s.id} d={s.path} stroke="oklch(34% 0.012 260)" strokeWidth="0.6" fill="none" strokeDasharray="2 3" />
      ))}
      <g filter="url(#lw-bloom)" opacity={glow > 0 ? 0.7 : 0}>
        {allLeds.map((l, i) => (
          <circle key={i} cx={l.x} cy={l.y} r={dotSize * 1.4} fill={l.color} opacity={l.intensity} />
        ))}
      </g>
      <g>
        {allLeds.map((l, i) => (
          <circle key={i} cx={l.x} cy={l.y} r={dotSize} fill={l.color} />
        ))}
      </g>
    </svg>
  );
}
