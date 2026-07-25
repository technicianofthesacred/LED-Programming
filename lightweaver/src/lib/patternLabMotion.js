const TAU = Math.PI * 2;
const MOTION_NAMES = Object.freeze(['drift', 'flow', 'pulse', 'surge']);

export const DEFAULT_PATTERN_LAB_MOTION_WEIGHTS = Object.freeze({
  drift: 0,
  flow: 0.5,
  pulse: 0.5,
  surge: 0,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value, fallback = 0) {
  return Math.min(1, Math.max(0, finite(value, fallback)));
}

function fract(value) {
  return value - Math.floor(value);
}

function phaseForSeed(seed) {
  let value = Number(seed) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (((value ^ (value >>> 15)) >>> 0) / 0x100000000) * TAU;
}

export function normalizePatternLabMotionWeights(source) {
  const weights = Object.fromEntries(MOTION_NAMES.map(name => [
    name,
    clamp01(source?.[name], DEFAULT_PATTERN_LAB_MOTION_WEIGHTS[name]),
  ]));
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return DEFAULT_PATTERN_LAB_MOTION_WEIGHTS;
  return Object.freeze(Object.fromEntries(
    Object.entries(weights).map(([name, weight]) => [name, weight / total]),
  ));
}

export function patternLabMotionCoordinate(value, {
  elapsedSeconds = 0,
  seed = 0,
  motionWeights = DEFAULT_PATTERN_LAB_MOTION_WEIGHTS,
} = {}) {
  const position = clamp01(value);
  const elapsed = Math.max(0, finite(elapsedSeconds));
  const phase = phaseForSeed(seed);
  const suppliedWeights = MOTION_NAMES.map(name => Number(motionWeights?.[name]));
  const suppliedTotal = suppliedWeights.reduce((sum, weight) => sum + weight, 0);
  const weights = suppliedWeights.every(weight => (
    Number.isFinite(weight) && weight >= 0 && weight <= 1
  )) && Math.abs(suppliedTotal - 1) <= 1e-9
    ? motionWeights
    : normalizePatternLabMotionWeights(motionWeights);
  const drift = fract(
    position
    + Math.sin(elapsed * 0.31 + phase) * 0.075
    + Math.sin(elapsed * 0.113 + phase * 1.7) * 0.03
    + 1
  );
  const flow = fract(position - elapsed * 0.08 + 1);
  const pulse = clamp01(
    0.5 + (position - 0.5) * (
      0.55 + (Math.sin(elapsed * 0.9 + phase) * 0.5 + 0.5) * 0.4
    ),
    position,
  );
  const surge = fract(
    position
    + Math.sin(TAU * (position * 1.5 - elapsed * 0.38) + phase) * 0.16
    + 1
  );
  return clamp01(
    drift * weights.drift
      + flow * weights.flow
      + pulse * weights.pulse
      + surge * weights.surge,
    position,
  );
}

export function applyPatternLabMotionToStrips(strips, {
  elapsedSeconds = 0,
  seed = 0,
  motionWeights,
  bounds,
} = {}) {
  if (!motionWeights || !bounds || !Number.isFinite(bounds.minX)
    || !Number.isFinite(bounds.minY) || !Number.isFinite(bounds.range)
    || bounds.range <= 0) return strips;
  const normalizedWeights = normalizePatternLabMotionWeights(motionWeights);
  return (strips || []).map(strip => ({
    ...strip,
    pts: (strip.pts || []).map(point => ({
      ...point,
      x: bounds.minX + patternLabMotionCoordinate(
        (finite(point.x) - bounds.minX) / bounds.range,
        { elapsedSeconds, seed, motionWeights: normalizedWeights },
      ) * bounds.range,
      y: bounds.minY + patternLabMotionCoordinate(
        (finite(point.y) - bounds.minY) / bounds.range,
        {
          elapsedSeconds,
          seed: (Number(seed) >>> 0) ^ 0x9e3779b9,
          motionWeights: normalizedWeights,
        },
      ) * bounds.range,
      p: patternLabMotionCoordinate(point.p, {
        elapsedSeconds,
        seed: (Number(seed) >>> 0) ^ 0x85ebca6b,
        motionWeights: normalizedWeights,
      }),
    })),
  }));
}
