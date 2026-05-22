export const MOTION_SMOOTHING_MODES = ['off', 'soft', 'silk'];

const HALF_LIFE_SECONDS = {
  off: 0,
  soft: 0.1,
  silk: 0.45,
};

export function normalizeMotionSmoothing(mode) {
  return MOTION_SMOOTHING_MODES.includes(mode) ? mode : 'soft';
}

export function smoothPixelFrame(targetPixels = [], previousPixels = null, { mode = 'soft', dt = 1 / 60 } = {}) {
  const normalized = normalizeMotionSmoothing(mode);
  if (normalized === 'off' || !Array.isArray(previousPixels) || previousPixels.length !== targetPixels.length) {
    return targetPixels.map(clonePixel);
  }

  const alpha = smoothingAlpha(normalized, dt);
  return targetPixels.map((target, i) => {
    const previous = previousPixels[i] || target;
    return {
      r: clampByte(previous.r + (target.r - previous.r) * alpha),
      g: clampByte(previous.g + (target.g - previous.g) * alpha),
      b: clampByte(previous.b + (target.b - previous.b) * alpha),
    };
  });
}

export function easeCrossfade(progress, curve = 'ease-in-out') {
  const t = clamp01(progress);
  switch (curve) {
    case 'linear':
      return t;
    case 'exp':
      return 1 - Math.pow(1 - t, 3);
    case 's-curve':
    case 'ease-in-out':
    default:
      return t * t * t * (t * (t * 6 - 15) + 10);
  }
}

export function formatMotionSpeed(speed) {
  const n = Number.isFinite(+speed) ? +speed : 0;
  return `${Math.abs(n) < 0.1 ? n.toFixed(2) : n.toFixed(1)}x`;
}

function smoothingAlpha(mode, dt) {
  const halfLife = HALF_LIFE_SECONDS[mode] || HALF_LIFE_SECONDS.soft;
  const seconds = Math.max(0, Number.isFinite(dt) ? dt : 1 / 60);
  return 1 - Math.pow(0.5, seconds / halfLife);
}

function clonePixel(pixel) {
  return {
    r: clampByte(pixel?.r ?? 0),
    g: clampByte(pixel?.g ?? 0),
    b: clampByte(pixel?.b ?? 0),
  };
}

function clampByte(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
