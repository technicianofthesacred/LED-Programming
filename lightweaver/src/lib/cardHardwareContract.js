import manifest from '../../../packages/lightweaver-contract/card-hardware.json' with { type: 'json' };

export const CARD_HARDWARE_CONTRACT = Object.freeze({
  outputPins: Object.freeze([...manifest.outputPins]),
  maxOutputs: manifest.limits.maxOutputs,
  maxPixels: manifest.limits.maxPixels,
  maxZones: manifest.limits.maxZones,
  maxRangesPerZone: manifest.limits.maxRangesPerZone,
  configCapacityBytes: manifest.limits.configCapacityBytes,
});
