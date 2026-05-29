import { makeCardRuntimePackage, patchBoardToZones } from './cardRuntimeContract.js';
import { deriveStandaloneOutputsFromStrips } from './standaloneController.js';
import { normalizeCardVisualLook } from './cardVisualLook.js';

export function totalProjectPixels(strips = []) {
  return strips.reduce((sum, strip) => sum + (strip.pixels?.length || strip.pixelCount || strip.leds || 0), 0);
}

export function buildCardRuntimePackageFromProject({
  projectName = 'Lightweaver Piece',
  strips = [],
  patchBoard = null,
  standaloneController = {},
} = {}) {
  const outputs = deriveStandaloneOutputsFromStrips(strips, standaloneController?.outputs || []);
  const totalPixels = totalProjectPixels(strips);
  const resolvedPixels = totalPixels || outputs.reduce((sum, output) => sum + (output.pixels || 0), 0) || 44;
  const visualLook = normalizeCardVisualLook(standaloneController?.defaultLook);
  const zones = patchBoard ? patchBoardToZones(patchBoard, strips) : [];
  const runtimeZones = zones.length ? applyVisualLookDefaultsToZones(zones, patchBoard, visualLook) : [{
    id: 'full-piece',
    label: 'Full Piece',
    patternId: visualLook.patternId,
    brightness: visualLook.brightness,
    customHue: visualLook.customHue,
    customSaturation: visualLook.customSaturation,
    customBreathe: visualLook.customBreathe,
    customDrift: visualLook.customDrift,
    ranges: [{ start: 0, count: resolvedPixels }],
  }];

  return makeCardRuntimePackage({
    projectName,
    mode: 'website-flash',
    led: {
      pixels: resolvedPixels,
      colorOrder: standaloneController?.led?.colorOrder,
      brightnessLimit: standaloneController?.led?.brightnessLimit,
      outputs: outputs.length
        ? outputs.map((output, index) => ({
            id: output.id || `out${index + 1}`,
            name: output.name || `Output ${index + 1}`,
            pin: output.pin,
            pixels: output.pixels,
          }))
        : undefined,
    },
    controls: standaloneController?.controls,
    startupPatternId: visualLook.patternId,
    zones: runtimeZones,
    syncZones: runtimeZones.length <= 1,
  });
}

function applyVisualLookDefaultsToZones(zones, patchBoard, visualLook) {
  const playbackByPatchId = new Map((patchBoard?.patches || []).map(patch => [
    sanitizeId(patch.id || ''),
    patch.playback || {},
  ]));
  return zones.map(zone => {
    const playback = playbackByPatchId.get(zone.id) || {};
    return {
      ...zone,
      patternId: hasExplicit(playback.patternId) ? zone.patternId : visualLook.patternId,
      brightness: hasExplicit(playback.brightness) ? zone.brightness : visualLook.brightness,
      customHue: hasExplicit(playback.customHue) ? zone.customHue : visualLook.customHue,
      customSaturation: hasExplicit(playback.customSaturation) ? zone.customSaturation : visualLook.customSaturation,
      customBreathe: hasExplicit(playback.customBreathe) ? zone.customBreathe : visualLook.customBreathe,
      customDrift: hasExplicit(playback.customDrift) ? zone.customDrift : visualLook.customDrift,
    };
  });
}

function hasExplicit(value) {
  return value !== undefined && value !== null && value !== '';
}

function sanitizeId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
