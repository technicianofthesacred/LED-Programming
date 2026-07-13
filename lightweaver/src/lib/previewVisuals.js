import { createConnectedSpatialTemplate } from './showSpatialTemplate.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function createProjectPreviewStrip({ strips = [], hidden = {}, patchBoard = null } = {}) {
  const samples = createConnectedSpatialTemplate({ strips, hidden, patchBoard });
  return {
    id: 'project-preview',
    pts: samples.map((sample, index) => ({ x: sample.x, y: sample.y, p: samples.length > 1 ? index / (samples.length - 1) : 0.5 })),
    offIndexes: samples.map((sample, index) => sample.stripId === null ? index : -1).filter(index => index >= 0),
    order: samples.map(sample => sample.stripId ?? 'off'),
    brightness: 1,
    speed: 1,
  };
}

export function ledRgb(led = {}) {
  return {
    r: Math.max(0, Math.min(255, Math.round(Number(led.r ?? led.avgR ?? 0) || 0))),
    g: Math.max(0, Math.min(255, Math.round(Number(led.g ?? led.avgG ?? 0) || 0))),
    b: Math.max(0, Math.min(255, Math.round(Number(led.b ?? led.avgB ?? 0) || 0))),
  };
}

export function ledIntensity(led = {}) {
  const { r, g, b } = ledRgb(led);
  return clamp(Math.max(r, g, b) / 255, 0, 1);
}

export function restingLedAlpha(led = {}, { selected = false } = {}) {
  const intensity = ledIntensity(led);
  const selectedBoost = selected ? 0.035 : 0;
  return clamp(0.075 + intensity * 0.115 + selectedBoost, 0.06, selected ? 0.22 : 0.18);
}

export function activeLedCoreAlpha(led = {}, { selected = false } = {}) {
  const intensity = ledIntensity(led);
  if (intensity <= 0.015) return 0;
  const selectedBoost = selected ? 0.12 : 0;
  return clamp(0.28 + intensity * 0.42 + selectedBoost, 0.3, selected ? 0.86 : 0.74);
}

export function activeLedCoronaAlpha(led = {}) {
  const intensity = ledIntensity(led);
  if (intensity <= 0.015) return 0;
  return clamp(0.05 + intensity * 0.1, 0.05, 0.16);
}

export function restingLedColor(led = {}) {
  const intensity = ledIntensity(led);
  const alpha = restingLedAlpha(led).toFixed(3);
  if (intensity <= 0.015) return `rgba(70, 90, 118, ${alpha})`;
  const { r, g, b } = ledRgb(led);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function ledCssColor(led = {}, fallback = 'oklch(58% 0.035 240)') {
  if (ledIntensity(led) <= 0.015) return fallback;
  const { r, g, b } = ledRgb(led);
  return `rgb(${r} ${g} ${b})`;
}
