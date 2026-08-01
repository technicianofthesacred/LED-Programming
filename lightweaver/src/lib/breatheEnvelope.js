export const DEFAULT_BREATHE_SETTINGS = Object.freeze({
  breatheLowerPct: 85,
  breatheUpperPct: 100,
  breatheCycleSeconds: 9,
});

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function normalizeBreatheSettings(look = {}) {
  const lower = clampInt(look.breatheLowerPct, DEFAULT_BREATHE_SETTINGS.breatheLowerPct, 0, 100);
  const upper = clampInt(look.breatheUpperPct, DEFAULT_BREATHE_SETTINGS.breatheUpperPct, 0, 100);
  return {
    breatheLowerPct: Math.min(lower, upper),
    breatheUpperPct: upper,
    breatheCycleSeconds: clampInt(look.breatheCycleSeconds, DEFAULT_BREATHE_SETTINGS.breatheCycleSeconds, 4, 30),
  };
}

export function resolveBreatheScale(tMs, look = {}) {
  if (!look.customBreathe) return 255;
  const settings = normalizeBreatheSettings(look);
  const periodMs = settings.breatheCycleSeconds * 1000;
  const rawTime = Number(tMs);
  const nowMs = Number.isFinite(rawTime) ? (Math.trunc(rawTime) >>> 0) : 0;
  // Mirror the ESP32's float operations deliberately. Using JS doubles here
  // differs by one output byte near rounding thresholds, which makes the
  // Studio preview and card disagree despite sharing the same envelope.
  const phase = Math.fround((nowMs % periodMs) / periodMs);
  const angle = Math.fround(phase * Math.fround(Math.PI * 2));
  const cosine = Math.fround(Math.cos(angle));
  const eased = Math.fround(Math.fround(0.5) - Math.fround(Math.fround(0.5) * cosine));
  const span = Math.fround(settings.breatheUpperPct - settings.breatheLowerPct);
  const pct = Math.fround(Math.fround(settings.breatheLowerPct) + Math.fround(span * eased));
  const scaled = Math.fround(Math.fround(pct * Math.fround(255)) / Math.fround(100));
  return Math.round(scaled);
}
