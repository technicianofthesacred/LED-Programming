export const SPEED_MIN = 0.02;
export const SPEED_MAX = 4;
export const SPEED_SLIDER_MIN = 0;
export const SPEED_SLIDER_MAX = 1000;

export const LED_COUNT_MIN = 1;
export const LED_COUNT_MAX = 3000;
export const LED_COUNT_SLIDER_MIN = 0;
export const LED_COUNT_SLIDER_MAX = 1000;
export const LED_COUNT_GEAR_POINTS = Object.freeze([
  { slider: 0, count: LED_COUNT_MIN },
  { slider: 700, count: 150 },
  { slider: 850, count: 600 },
  { slider: 950, count: 1500 },
  { slider: LED_COUNT_SLIDER_MAX, count: LED_COUNT_MAX },
]);

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

export function sliderValueToSpeed(value) {
  const pos = clamp(value, SPEED_SLIDER_MIN, SPEED_SLIDER_MAX) / SPEED_SLIDER_MAX;
  const speed = SPEED_MIN * ((SPEED_MAX / SPEED_MIN) ** pos);
  return Math.round(speed * 1000) / 1000;
}

export function speedToSliderValue(speed) {
  const normalizedSpeed = clamp(speed, SPEED_MIN, SPEED_MAX);
  const pos = Math.log(normalizedSpeed / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
  return Math.round(pos * SPEED_SLIDER_MAX);
}

export function formatControlSpeed(speed) {
  const value = clamp(speed, SPEED_MIN, SPEED_MAX);
  if (value < 0.1) return `${value.toFixed(3).replace(/0$/, '')}x`;
  if (value < 1) return `${value.toFixed(2)}x`;
  return `${value.toFixed(2)}x`;
}

export function sliderValueToLedCount(value) {
  const normalizedSlider = clamp(value, LED_COUNT_SLIDER_MIN, LED_COUNT_SLIDER_MAX);
  const upperIndex = LED_COUNT_GEAR_POINTS.findIndex(point => normalizedSlider <= point.slider);
  if (upperIndex <= 0) return LED_COUNT_MIN;

  const lower = LED_COUNT_GEAR_POINTS[upperIndex - 1];
  const upper = LED_COUNT_GEAR_POINTS[upperIndex];
  const pos = (normalizedSlider - lower.slider) / (upper.slider - lower.slider);
  return Math.round(lower.count + (upper.count - lower.count) * pos);
}

export function ledCountToSliderValue(count) {
  const normalizedCount = clamp(count, LED_COUNT_MIN, LED_COUNT_MAX);
  const upperIndex = LED_COUNT_GEAR_POINTS.findIndex(point => normalizedCount <= point.count);
  if (upperIndex <= 0) return LED_COUNT_SLIDER_MIN;

  const lower = LED_COUNT_GEAR_POINTS[upperIndex - 1];
  const upper = LED_COUNT_GEAR_POINTS[upperIndex];
  const pos = (normalizedCount - lower.count) / (upper.count - lower.count);
  return Math.round(lower.slider + (upper.slider - lower.slider) * pos);
}

export function sliderValueToCurvedRange(value, { min = 0, max = 1, steps = 1000, precision = 3 } = {}) {
  const rangeMin = Number(min);
  const rangeMax = Number(max);
  if (!Number.isFinite(rangeMin) || !Number.isFinite(rangeMax) || rangeMax <= rangeMin) return rangeMin || 0;
  const pos = clamp(value, 0, steps) / steps;
  const next = rangeMin + (rangeMax - rangeMin) * (pos ** 2);
  const factor = 10 ** precision;
  return Math.round(next * factor) / factor;
}

export function curvedRangeValueToSlider(value, { min = 0, max = 1, steps = 1000 } = {}) {
  const rangeMin = Number(min);
  const rangeMax = Number(max);
  if (!Number.isFinite(rangeMin) || !Number.isFinite(rangeMax) || rangeMax <= rangeMin) return 0;
  const normalized = clamp(value, rangeMin, rangeMax);
  const pos = Math.sqrt((normalized - rangeMin) / (rangeMax - rangeMin));
  return Math.round(pos * steps);
}
