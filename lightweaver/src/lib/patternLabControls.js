import { sampleEvolution } from './patternLabEvolution.js';
import { resolvePatternLabMacros } from './patternLabMacros.js';
import { normalizePatternLabRecipe } from './patternLabRecipe.js';

const TAU = Math.PI * 2;
const MOVEMENT_ANCHORS = Object.freeze([
  ['drift', 0],
  ['flow', 0.33],
  ['pulse', 0.67],
  ['surge', 1],
]);

function clamp(value, minimum, maximum, fallback = minimum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function mix(first, second, amount) {
  return first + (second - first) * amount;
}

function movementWeights(value) {
  const movement = clamp(value, 0, 1, 0.5);
  const weights = { drift: 0, flow: 0, pulse: 0, surge: 0 };
  if (movement === 1) {
    weights.surge = 1;
    return weights;
  }
  const upperIndex = MOVEMENT_ANCHORS.findIndex(([, anchor]) => movement <= anchor);
  if (upperIndex <= 0) {
    weights.drift = 1;
    return weights;
  }
  const [lowerName, lowerAnchor] = MOVEMENT_ANCHORS[upperIndex - 1];
  const [upperName, upperAnchor] = MOVEMENT_ANCHORS[upperIndex];
  const amount = (movement - lowerAnchor) / (upperAnchor - lowerAnchor);
  weights[lowerName] = 1 - amount;
  weights[upperName] = amount;
  return weights;
}

function zeroedWave(time, period, phase) {
  return Math.sin(time / period * TAU + phase) - Math.sin(phase);
}

function compositeMotionWarp(time, duration, seed, weights, modulationDepth) {
  const phase = ((seed % 4093) / 4093) * TAU;
  const waves = {
    drift: (
      zeroedWave(time, duration * Math.SQRT2, phase) * 0.62
      + zeroedWave(time, duration * Math.sqrt(5), phase + 1.7) * 0.38
    ),
    flow: (
      zeroedWave(time, duration * 0.73, phase + 0.4) * 0.58
      + zeroedWave(time, duration * Math.sqrt(3), phase + 2.1) * 0.42
    ),
    pulse: (
      zeroedWave(time, duration * 0.47, phase + 1.1) * 0.72
      + zeroedWave(time, duration * Math.sqrt(2 / 3), phase + 2.8) * 0.28
    ),
    surge: (
      zeroedWave(time, duration * 0.31, phase + 2.4) * 0.67
      + zeroedWave(time, duration / Math.sqrt(7), phase + 0.8) * 0.33
    ),
  };
  const blended = Object.entries(weights)
    .reduce((sum, [name, weight]) => sum + waves[name] * weight, 0);
  return blended * modulationDepth * 4;
}

function evolutionRateClock(recipe, evolution, elapsed) {
  if (!evolution.enabled || evolution.change === 0) {
    return { factor: 1, time: elapsed };
  }
  const characterIndex = [
    'slow-bloom',
    'wandering',
    'tidal',
    'breathing',
    'gather-release',
    'rare-surprises',
  ].indexOf(evolution.character);
  const phase = ((recipe.seed % 8191) / 8191) * TAU + characterIndex * 0.41;
  const firstPeriod = evolution.durationSeconds * (Math.SQRT2 + characterIndex * 0.071);
  const secondPeriod = evolution.durationSeconds * (Math.sqrt(5) + characterIndex * 0.053);
  const amplitude = evolution.change * (
    evolution.dynamics.dynamicRange * 0.16
    + evolution.dynamics.rareEventStrength / 0.8 * 0.04
  );
  const firstWeight = 0.63;
  const secondWeight = 1 - firstWeight;
  const firstAngle = elapsed / firstPeriod * TAU + phase;
  const secondAngle = elapsed / secondPeriod * TAU + phase + 1.9;
  const signal = Math.cos(firstAngle) * firstWeight + Math.cos(secondAngle) * secondWeight;
  const integral = (
    (Math.sin(firstAngle) - Math.sin(phase)) * firstPeriod / TAU * firstWeight
    + (Math.sin(secondAngle) - Math.sin(phase + 1.9)) * secondPeriod / TAU * secondWeight
  );
  return {
    factor: 1 + signal * amplitude,
    time: elapsed + integral * amplitude,
  };
}

export function resolvePatternLabControls(recipe, elapsedSeconds = 0) {
  const normalized = normalizePatternLabRecipe(recipe);
  const elapsed = Math.max(0, Number.isFinite(Number(elapsedSeconds)) ? Number(elapsedSeconds) : 0);
  const technical = resolvePatternLabMacros(normalized);
  const evolution = sampleEvolution(normalized, elapsed);
  const destinations = evolution.destinations;
  const evolutionMix = evolution.enabled ? evolution.change : 0;
  const motionWeights = movementWeights(normalized.macros.movement);
  const masterBrightness = normalized.playback.brightness;
  const masterSpeed = normalized.playback.speed;
  const evolutionBrightnessFactor = evolutionMix > 0
    ? clamp(destinations.brightness, 0, 1, 1)
    : 1;
  const evolutionClock = evolutionRateClock(normalized, evolution, elapsed);
  const evolutionRateFactor = evolutionClock.factor;
  const effectiveBrightness = masterBrightness * evolutionBrightnessFactor;
  const effectiveSpeed = clamp(masterSpeed * evolutionRateFactor, 0.1, 3, masterSpeed);
  const masterSaturation = clamp(mix(
    technical.color.saturation,
    0.55 + (destinations?.color ?? 0.5) * 0.45,
    evolutionMix,
  ), 0.25, 1, technical.color.saturation);
  const masterHueShift = technical.color.warmth * 18
    + ((destinations?.color ?? 0.5) - 0.5) * 72 * evolutionMix;
  const shapeScale = mix(
    technical.shape.spatialScale,
    0.5 + (destinations?.shape ?? 0.5) * 2,
    evolutionMix,
  );
  const texture = clamp(mix(
    technical.texture.crispness,
    destinations?.texture ?? technical.texture.crispness,
    evolutionMix,
  ), 0, 1, technical.texture.crispness);
  const unscaledRenderTime = Math.max(0, evolutionClock.time + compositeMotionWarp(
    evolutionClock.time,
    normalized.evolution.durationSeconds,
    normalized.seed,
    motionWeights,
    technical.movement.modulationDepth,
  ));
  const renderTime = unscaledRenderTime * masterSpeed;

  return {
    technical,
    motionWeights,
    masterBrightness,
    masterSpeed,
    evolutionBrightnessFactor,
    evolutionRateFactor,
    effectiveBrightness,
    effectiveSpeed,
    masterSaturation,
    masterHueShift,
    shapeScale,
    texture,
    renderTime,
  };
}
