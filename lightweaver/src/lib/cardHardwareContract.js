import manifest from '../../../packages/lightweaver-contract/card-hardware.json' with { type: 'json' };

export const CARD_HARDWARE_CONTRACT = Object.freeze({
  outputPins: Object.freeze([...manifest.outputPins]),
  maxOutputs: manifest.limits.maxOutputs,
  maxPixels: manifest.limits.maxPixels,
  maxZones: manifest.limits.maxZones,
  maxRangesPerZone: manifest.limits.maxRangesPerZone,
  configCapacityBytes: manifest.limits.configCapacityBytes,
});

// The card drives one chipset for every output: RuntimeConfig carries a single
// `ledType` (LightweaverTypes.h) and main.cpp's addLedsForOrder() branches on
// that one value for all four pins. validateRuntimeConfigJsonStrict()
// (LightweaverStorage.cpp) rejects any other value outright, so Studio must
// never offer or forward a third option.
export const CARD_LED_TYPES = Object.freeze(['WS2812B', 'WS2815']);

// Reel-facing hints so the owner can match what is printed on the strip.
export const CARD_LED_TYPE_HINTS = Object.freeze({
  WS2812B: '5V strip (also sold as WS2812/NeoPixel)',
  WS2815: '12V strip with a backup data line',
});

export function isCardLedType(value) {
  return CARD_LED_TYPES.includes(value);
}

export function normalizeCardLedType(value, fallback = CARD_LED_TYPES[0]) {
  const upper = String(value ?? '').trim().toUpperCase();
  if (isCardLedType(upper)) return upper;
  return isCardLedType(fallback) ? fallback : CARD_LED_TYPES[0];
}
