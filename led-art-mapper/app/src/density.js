export const DEFAULT_LEDS_PER_METER = 60;

export function getStripDensity(strip) {
  const density = Number(strip?.ledsPerMeter);
  return Number.isFinite(density) && density > 0 ? density : DEFAULT_LEDS_PER_METER;
}

export function calculateStripLengthMeters(pixelCount, ledsPerMeter) {
  const count = Number(pixelCount);
  const density = Number(ledsPerMeter);
  if (!Number.isFinite(count) || count < 1 || !Number.isFinite(density) || density <= 0) return null;
  return count / density;
}
