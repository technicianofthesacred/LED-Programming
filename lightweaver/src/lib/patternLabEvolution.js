export const PATTERN_LAB_EVOLUTION_CHARACTERS = Object.freeze([
  'slow-bloom',
  'wandering',
  'tidal',
  'breathing',
  'gather-release',
  'rare-surprises',
]);

function definePreset(ranges) {
  return Object.freeze(Object.fromEntries(
    Object.entries(ranges).map(([name, range]) => [name, Object.freeze([...range])]),
  ));
}

export const PATTERN_LAB_EVOLUTION_PRESETS = Object.freeze({
  'slow-bloom': definePreset({ brightness: [0.35, 0.78], color: [0.25, 0.7], movement: [0.12, 0.38], shape: [0.35, 0.7], texture: [0.18, 0.5] }),
  wandering: definePreset({ brightness: [0.3, 0.72], color: [0.2, 0.82], movement: [0.28, 0.68], shape: [0.2, 0.75], texture: [0.22, 0.62] }),
  tidal: definePreset({ brightness: [0.28, 0.76], color: [0.28, 0.72], movement: [0.2, 0.62], shape: [0.32, 0.72], texture: [0.18, 0.55] }),
  breathing: definePreset({ brightness: [0.3, 0.75], color: [0.32, 0.62], movement: [0.12, 0.46], shape: [0.38, 0.66], texture: [0.2, 0.48] }),
  'gather-release': definePreset({ brightness: [0.25, 0.78], color: [0.24, 0.68], movement: [0.2, 0.64], shape: [0.25, 0.8], texture: [0.16, 0.58] }),
  'rare-surprises': definePreset({ brightness: [0.3, 0.78], color: [0.3, 0.76], movement: [0.14, 0.58], shape: [0.34, 0.7], texture: [0.18, 0.68] }),
});

const TAU = Math.PI * 2;
const DEFAULT_DURATION_SECONDS = 600;
const DEFAULT_CHANGE = 0.35;
const DEFAULT_SEED = 1;
const DEFAULT_DYNAMIC_RANGE = 0.55;
const DEFAULT_RARE_EVENT_STRENGTH = 0.4;

function clamp(value, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.min(maximum, Math.max(minimum, number));
}

function bounded(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function uint32Seed(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) >>> 0 : DEFAULT_SEED;
}

function fract(value) {
  return value - Math.floor(value);
}

function smooth(value) {
  const amount = clamp(value);
  return amount * amount * (3 - 2 * amount);
}

function hash01(seed, index) {
  let value = (Math.trunc(Number(seed) || 0) ^ Math.imul(Math.trunc(index), 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

export function seededNoise1D(seed, position) {
  const safePosition = Number.isFinite(Number(position)) ? Number(position) : 0;
  const index = Math.floor(safePosition);
  const amount = smooth(fract(safePosition));
  const first = hash01(seed, index);
  const second = hash01(seed, index + 1);
  return first + (second - first) * amount;
}

function smoothCycle(phase, character) {
  const progress = fract(phase);
  const riseAndFall = 0.5 - Math.cos(progress * TAU) * 0.5;
  switch (character) {
    case 'slow-bloom': return smooth(riseAndFall);
    case 'wandering': return clamp(0.5 + Math.sin(progress * TAU) * 0.28 + Math.sin(progress * TAU * 3 + 1.2) * 0.14);
    case 'tidal': return clamp(0.5 + Math.sin(progress * TAU - Math.PI / 2) * 0.38 + Math.sin(progress * TAU * 2 - 0.4) * 0.12);
    case 'breathing': return riseAndFall * riseAndFall;
    case 'gather-release': return progress < 0.72 ? smooth(progress / 0.72) : 1 - smooth((progress - 0.72) / 0.28);
    case 'rare-surprises': return clamp(0.42 + Math.sin(progress * TAU - 0.7) * 0.12);
    default: throw new RangeError(`Unknown evolution character: ${character}`);
  }
}

function sampleRareEvents(seed, elapsedSeconds, change, strength) {
  if (strength <= 0) return 0;
  const interval = 43;
  const bucket = Math.floor(elapsedSeconds / interval);
  const chance = hash01(seed, bucket);
  const threshold = 0.92 - change * 0.34;
  if (chance < threshold) return 0;
  const phase = fract(elapsedSeconds / interval);
  const attack = smooth(Math.min(1, phase / 0.12));
  const release = 1 - smooth(Math.max(0, (phase - 0.12) / 0.88));
  return clamp(
    attack * release * (0.45 + hash01(seed + 101, bucket) * 0.55) * (strength / 0.8),
  );
}

function rangeValue(range, signal, change) {
  const midpoint = (range[0] + range[1]) / 2;
  const destination = range[0] + (range[1] - range[0]) * clamp(signal);
  return midpoint + (destination - midpoint) * change;
}

function relativeBrightnessRange(presetRange, dynamicRange) {
  return presetRange.map(value => Math.round((1 - (1 - value) * dynamicRange) * 1e12) / 1e12);
}

export function sampleEvolution(recipe, elapsedSeconds) {
  const character = String(recipe?.evolution?.character || 'slow-bloom');
  const preset = PATTERN_LAB_EVOLUTION_PRESETS[character];
  if (!preset) throw new RangeError(`Unknown evolution character: ${character}`);

  const enabled = recipe?.evolution?.enabled === undefined
    ? true
    : Boolean(recipe.evolution.enabled);
  const duration = bounded(recipe?.evolution?.durationSeconds, 300, 900, DEFAULT_DURATION_SECONDS);
  const elapsed = Math.max(0, Number.isFinite(Number(elapsedSeconds)) ? Number(elapsedSeconds) : 0);
  const change = bounded(recipe?.evolution?.change, 0, 1, DEFAULT_CHANGE);
  const dynamicRange = bounded(
    recipe?.evolution?.dynamics?.dynamicRange,
    0.1,
    1,
    DEFAULT_DYNAMIC_RANGE,
  );
  const rareEventStrength = bounded(
    recipe?.evolution?.dynamics?.rareEventStrength,
    0,
    0.8,
    DEFAULT_RARE_EVENT_STRENGTH,
  );
  const seed = uint32Seed(recipe?.seed);
  const effectiveBrightnessRange = relativeBrightnessRange(preset.brightness, dynamicRange);
  const dynamics = { dynamicRange, rareEventStrength };

  if (!enabled) {
    return {
      enabled: false,
      character,
      durationSeconds: duration,
      change,
      seed,
      arc: 0,
      spatial: 0,
      texture: 0,
      rare: 0,
      dynamics,
      effectiveBrightnessRange,
      destinations: null,
    };
  }

  const arc = smoothCycle(elapsed / duration, character);
  const spatial = seededNoise1D(seed + 11, elapsed / 137);
  const texture = seededNoise1D(seed + 23, elapsed / 17);
  const rare = sampleRareEvents(seed + 47, elapsed, change, rareEventStrength);

  const destinations = {
    brightness: rangeValue(effectiveBrightnessRange, clamp(arc * 0.72 + texture * 0.18 + rare * 0.1), change),
    color: rangeValue(preset.color, clamp(arc * 0.68 + spatial * 0.32), change),
    movement: rangeValue(preset.movement, clamp(spatial * 0.82 + rare * 0.18), change),
    shape: rangeValue(preset.shape, clamp(arc * 0.55 + spatial * 0.45), change),
    texture: rangeValue(preset.texture, clamp(texture * 0.88 + rare * 0.12), change),
  };

  return {
    enabled: true,
    character,
    durationSeconds: duration,
    change,
    seed,
    arc,
    spatial,
    texture,
    rare,
    dynamics,
    effectiveBrightnessRange,
    destinations,
  };
}
