import { DEFAULT_CARD_PATTERN_BANK } from './cardRuntimeContract.js';

const PATTERN_IDS = new Set(DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id));

export const DEFAULT_CARD_VISUAL_LOOK = Object.freeze({
  patternId: DEFAULT_CARD_PATTERN_BANK[0]?.id || 'aurora',
  brightness: 1,
  speed: 1,
  hueShift: 0,
  customHue: 32,
  customSaturation: 230,
  customBreathe: false,
  customDrift: false,
});

export function normalizeCardVisualLook(look = {}) {
  const patternId = PATTERN_IDS.has(look.patternId) ? look.patternId : DEFAULT_CARD_VISUAL_LOOK.patternId;
  return {
    patternId,
    brightness: clampUnit(look.brightness ?? DEFAULT_CARD_VISUAL_LOOK.brightness),
    speed: clampSpeed(look.speed ?? DEFAULT_CARD_VISUAL_LOOK.speed),
    hueShift: clampInt(look.hueShift, DEFAULT_CARD_VISUAL_LOOK.hueShift, -128, 128),
    customHue: clampInt(look.customHue, DEFAULT_CARD_VISUAL_LOOK.customHue, 0, 255),
    customSaturation: clampInt(look.customSaturation, DEFAULT_CARD_VISUAL_LOOK.customSaturation, 0, 255),
    customBreathe: Boolean(look.customBreathe),
    customDrift: Boolean(look.customDrift),
  };
}

export function cardHueToDegrees(customHue = DEFAULT_CARD_VISUAL_LOOK.customHue) {
  return Math.round((clampInt(customHue, DEFAULT_CARD_VISUAL_LOOK.customHue, 0, 255) / 255) * 360);
}

export function cardHueDeltaToDegrees(delta = 0) {
  const n = Number(delta);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / 255) * 360);
}

export function cardSaturationToChroma(customSaturation = DEFAULT_CARD_VISUAL_LOOK.customSaturation) {
  const sat = clampInt(customSaturation, DEFAULT_CARD_VISUAL_LOOK.customSaturation, 0, 255) / 255;
  return (0.035 + sat * 0.18).toFixed(3);
}

export function cardColorToHex(
  customHue = DEFAULT_CARD_VISUAL_LOOK.customHue,
  customSaturation = DEFAULT_CARD_VISUAL_LOOK.customSaturation,
) {
  const hue = cardHueToDegrees(customHue);
  const sat = clampInt(customSaturation, DEFAULT_CARD_VISUAL_LOOK.customSaturation, 0, 255) / 255;
  const [r, g, b] = hslToRgb(hue, Math.max(0, Math.min(1, sat * 0.95)), 0.56);
  return rgbToHex(r, g, b);
}

export function hexToCardColor(hex, fallback = DEFAULT_CARD_VISUAL_LOOK) {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return {
      customHue: normalizeCardVisualLook(fallback).customHue,
      customSaturation: normalizeCardVisualLook(fallback).customSaturation,
    };
  }
  const [hue, saturation] = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return {
    customHue: clampInt(Math.round((hue / 360) * 255), DEFAULT_CARD_VISUAL_LOOK.customHue, 0, 255),
    customSaturation: clampInt(Math.round(saturation * 255), DEFAULT_CARD_VISUAL_LOOK.customSaturation, 0, 255),
  };
}

function clampUnit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function clampSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.05, Math.min(3, n));
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (p2, q2, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p2 + (q2 - p2) * 6 * t;
    if (t < 1 / 2) return q2;
    if (t < 2 / 3) return p2 + (q2 - p2) * (2 / 3 - t) * 6;
    return p2;
  };
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hexToRgb(hex) {
  const raw = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(raw)) return null;
  const n = Number.parseInt(raw, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map(value => clampInt(value, 0, 0, 255).toString(16).padStart(2, '0')).join('')}`;
}
