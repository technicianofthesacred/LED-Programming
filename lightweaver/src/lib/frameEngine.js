import { DEFAULT_PARAMS, PALETTE_DEFAULT } from '../data.js';
import { PATTERNS } from './patterns-library.js';
import { compile, evalPixel } from './patterns.js';
import { applySymmetry } from './symmetry.js';

export function hexToNorm(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToHsl(r, g, b) {
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

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const hue2rgb = (p2, q2, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p2 + (q2 - p2) * 6 * t;
    if (t < 1/2) return q2;
    if (t < 2/3) return p2 + (q2 - p2) * (2/3 - t) * 6;
    return p2;
  };
  return [hue2rgb(p,q,h+1/3), hue2rgb(p,q,h), hue2rgb(p,q,h-1/3)].map(v => Math.round(v * 255));
}

export function buildGammaLut(enabled, gammaValue = 2.2) {
  if (!enabled) return null;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.pow(i / 255, gammaValue) * 255);
  return lut;
}

export function compilePattern(patternId) {
  const pat = PATTERNS.find(p => p.id === patternId);
  if (!pat) return null;
  return compile(pat.code).fn;
}

export function normalizePalette(palette = PALETTE_DEFAULT) {
  return palette.map(hexToNorm);
}

export function resolvePatternParams(patternId, params = {}) {
  const defaults = Object.fromEntries((DEFAULT_PARAMS[patternId] || []).map(k => [k.name, k.value]));
  return { ...defaults, ...params };
}

export function renderPixelFrame({
  t = 0,
  strips = [],
  patternId = 'aurora',
  activeFn = null,
  blendPatternId = null,
  blendFn = null,
  blendAmount = 0,
  blendType = 'crossfade',
  params = {},
  paletteNorm = normalizePalette(),
  bpm = 120,
  masterSpeed = 1,
  masterBrightness = 1,
  masterSaturation = 1,
  masterHueShift = 0,
  gammaLUT = null,
  symSettings = null,
  audioBands = null,
  normBounds = null,
  perStripFns = new Map(),
}) {
  const visibleStrips = strips.filter(s => s && !s.hidden);
  const allPts = visibleStrips.flatMap(s => s.pts || []);
  const bounds = normBounds || getNormBounds(allPts);
  const pixelCount = allPts.length;
  const fnA = activeFn || compilePattern(patternId);
  const fnB = blendFn || (blendPatternId ? compilePattern(blendPatternId) : null);
  const resolvedParams = resolvePatternParams(patternId, params);
  const beat = (t * bpm / 60) % 1;
  const beatSin = Math.sin(beat * Math.PI);
  const bass = audioBands?.bass ?? 0, mid = audioBands?.mid ?? 0, hi = audioBands?.hi ?? 0;
  const framePixels = [];
  const stripFrames = [];
  let globalIdx = 0;

  for (const s of visibleStrips) {
    const stripT = t * masterSpeed * (s.speed ?? 1);
    const stripTime = (stripT / 65.536) % 1;
    const stripFn = (s.patternId ? perStripFns.get(s.patternId) : null) ?? fnA;
    const leds = [];
    let rSum = 0, gSum = 0, bSum = 0;

    for (const pt of s.pts || []) {
      let nx = (pt.x - bounds.minX) / bounds.range;
      let ny = (pt.y - bounds.minY) / bounds.range;

      if (symSettings?.enabled) {
        const sym = applySymmetry(nx, ny, symSettings, t);
        nx = sym.x; ny = sym.y;
      }

      let r = 0, g = 0, b = 0;
      if (stripFn) {
        const colA = evalPixel(stripFn, globalIdx, nx, ny, stripT, stripTime, pixelCount, paletteNorm, beat, beatSin, resolvedParams, s.id, pt.p, bass, mid, hi);
        r = colA.r; g = colA.g; b = colA.b;

        if (fnB && blendAmount > 0) {
          const colB = evalPixel(fnB, globalIdx, nx, ny, stripT, stripTime, pixelCount, paletteNorm, beat, beatSin, resolvedParams, s.id, pt.p, bass, mid, hi);
          if (blendType === 'fade-black') {
            const a2 = blendAmount < 0.5 ? 1 - blendAmount * 2 : 0;
            const b2 = blendAmount > 0.5 ? (blendAmount - 0.5) * 2 : 0;
            r = colA.r * a2 + colB.r * b2;
            g = colA.g * a2 + colB.g * b2;
            b = colA.b * a2 + colB.b * b2;
          } else if (blendType === 'dissolve') {
            const a = 1 - blendAmount, bAmt = blendAmount;
            r = Math.min(255, colA.r * a + colB.r * bAmt + colA.r * colB.r * blendAmount / 255);
            g = Math.min(255, colA.g * a + colB.g * bAmt + colA.g * colB.g * blendAmount / 255);
            b = Math.min(255, colA.b * a + colB.b * bAmt + colA.b * colB.b * blendAmount / 255);
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

      r = clamp255(r); g = clamp255(g); b = clamp255(b);
      if (gammaLUT) { r = gammaLUT[Math.round(r)]; g = gammaLUT[Math.round(g)]; b = gammaLUT[Math.round(b)]; }

      if (s.hueShift || masterHueShift) {
        const [h, sat, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h + (s.hueShift || 0) + masterHueShift, sat, l);
      }

      const color = { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
      framePixels.push(color);
      leds.push({ x: pt.x, y: pt.y, ...color });
      rSum += r; gSum += g; bSum += b;
      globalIdx++;
    }

    const n = leds.length;
    stripFrames.push({
      id: s.id,
      leds,
      avgR: n ? Math.round(rSum / n) : 0,
      avgG: n ? Math.round(gSum / n) : 0,
      avgB: n ? Math.round(bSum / n) : 0,
      spacing: s.spacing,
    });
  }

  return { pixels: framePixels, stripFrames };
}

function getNormBounds(pts) {
  if (!pts.length) return { minX: 0, minY: 0, range: 1 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const pt of pts) {
    if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, range: Math.max(maxX - minX, maxY - minY, 0.001) };
}

function clamp255(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
