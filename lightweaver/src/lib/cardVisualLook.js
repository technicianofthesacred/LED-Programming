import { DEFAULT_CARD_PATTERN_BANK } from './cardRuntimeContract.js';

const PATTERN_IDS = new Set(DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id));

export const DEFAULT_CARD_VISUAL_LOOK = Object.freeze({
  patternId: DEFAULT_CARD_PATTERN_BANK[0]?.id || 'aurora',
  brightness: 1,
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
    customHue: clampInt(look.customHue, DEFAULT_CARD_VISUAL_LOOK.customHue, 0, 255),
    customSaturation: clampInt(look.customSaturation, DEFAULT_CARD_VISUAL_LOOK.customSaturation, 0, 255),
    customBreathe: Boolean(look.customBreathe),
    customDrift: Boolean(look.customDrift),
  };
}

export function cardHueToDegrees(customHue = DEFAULT_CARD_VISUAL_LOOK.customHue) {
  return Math.round((clampInt(customHue, DEFAULT_CARD_VISUAL_LOOK.customHue, 0, 255) / 255) * 360);
}

export function cardSaturationToChroma(customSaturation = DEFAULT_CARD_VISUAL_LOOK.customSaturation) {
  const sat = clampInt(customSaturation, DEFAULT_CARD_VISUAL_LOOK.customSaturation, 0, 255) / 255;
  return (0.035 + sat * 0.18).toFixed(3);
}

function clampUnit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
