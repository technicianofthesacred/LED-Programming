import { makeCardRuntimePackage, patchBoardToZones } from './cardRuntimeContract.js';
import { deriveStandaloneOutputsFromStrips } from './standaloneController.js';

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
  const zones = patchBoard ? patchBoardToZones(patchBoard, strips) : [];
  const totalPixels = totalProjectPixels(strips);

  return makeCardRuntimePackage({
    projectName,
    mode: 'website-flash',
    led: {
      pixels: totalPixels || outputs.reduce((sum, output) => sum + (output.pixels || 0), 0) || undefined,
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
    zones: zones.length ? zones : undefined,
    syncZones: zones.length <= 1,
  });
}
