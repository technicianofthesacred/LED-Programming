import { DEFAULT_CARD_CONTROLS, DEFAULT_CARD_LED, DEFAULT_CARD_PATTERN_BANK, makeCardRuntimePackage, patchBoardToZones } from './cardRuntimeContract.js';
import { DEFAULT_STANDALONE_OUTPUTS, deriveStandaloneOutputsFromStrips, normalizeStandaloneOutputs, totalStandalonePixels } from './standaloneController.js';
import { normalizeCardVisualLook } from './cardVisualLook.js';
import { getCardPatternById, getCardPatternRuntimeId, orderedCardPatterns } from './cardPatternBank.js';
import { applySavedLookToPatchBoard, normalizeSavedLooks } from './sectionLookModel.js';
import { chainAddressCount } from './patchBoard.js';
import {
  derivePlaylistLookIds,
  isDefaultPatternCycle,
  isImplicitDefaultPatternPlaylist,
  normalizeCardPlaylist,
} from './cardPlaylist.js';

export function totalProjectPixels(strips = []) {
  return strips.reduce((sum, strip) => sum + (strip.pixels?.length || strip.pixelCount || strip.leds || 0), 0);
}

export function totalPhysicalAddresses(patchBoard, strips = []) {
  const sourcePixels = totalProjectPixels(strips);
  return patchBoard ? Math.max(sourcePixels, chainAddressCount(patchBoard, strips)) : sourcePixels;
}

export function buildCardRuntimePackageFromProject({
  projectId = '',
  projectName = 'Lightweaver Piece',
  strips = [],
  patchBoard = null,
  standaloneController = {},
} = {}) {
  const totalPixels = totalPhysicalAddresses(patchBoard, strips);
  const configuredOutputs = standaloneController?.outputs || [];
  const configuredOutputPixels = totalStandalonePixels(configuredOutputs);
  const explicitOutputLayout = configuredOutputPixels > 0 && configuredOutputs.length >= DEFAULT_STANDALONE_OUTPUTS.length;
  const resolvedPixels = explicitOutputLayout
    ? configuredOutputPixels
    : (totalPixels || configuredOutputPixels || DEFAULT_CARD_LED.pixels);
  const outputs = resolveCardOutputs({
    strips,
    configuredOutputs,
    resolvedPixels,
  });
  const visualLook = normalizeCardVisualLook(standaloneController?.defaultLook);
  const savedLooks = normalizeSavedLooks(standaloneController?.looks);
  const legacyCycleIds = Array.isArray(standaloneController?.controls?.encoder?.patternCycleIds) &&
    !isDefaultPatternCycle(standaloneController.controls.encoder.patternCycleIds)
    ? standaloneController.controls.encoder.patternCycleIds
    : [];
  const rawPlaylist = isImplicitDefaultPatternPlaylist(standaloneController?.playlist)
    ? []
    : standaloneController?.playlist;
  const playlist = normalizeCardPlaylist(rawPlaylist, {
    savedLooks,
    fallbackPatternIds: [
      visualLook.patternId,
      ...legacyCycleIds,
    ],
  });
  const zones = patchBoard ? patchBoardToZones(patchBoard, strips) : [];
  const runtimeZones = zones.length ? applyVisualLookDefaultsToZones(zones, patchBoard, visualLook) : [{
    id: 'full-piece',
    label: 'Full Piece',
    patternId: getCardPatternRuntimeId(visualLook.patternId) || visualLook.patternId,
    brightness: visualLook.brightness,
    speed: visualLook.speed,
    hueShift: visualLook.hueShift,
    customHue: visualLook.customHue,
    customSaturation: visualLook.customSaturation,
    customBreathe: visualLook.customBreathe,
    customDrift: visualLook.customDrift,
    ranges: [{ start: 0, count: resolvedPixels }],
  }];
  const looks = buildRuntimeLooksFromPlaylist({
    playlist,
    savedLooks,
    patchBoard,
    strips,
    runtimeZones,
    visualLook,
  });
  const requestedPatternIds = [
    visualLook.patternId,
    ...runtimeZones.map(zone => zone.patternId),
    ...looks.flatMap(look => [look.preset, ...(look.zones || []).map(zone => zone.patternId)]),
  ];
  const patterns = resolvePackagePatterns(standaloneController, requestedPatternIds);

  return makeCardRuntimePackage({
    projectId,
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
    controls: cardSafeControls(standaloneController?.controls, playlist),
    patterns,
    looks,
    startupPatternId: looks[0]?.id || visualLook.patternId,
    zones: runtimeZones,
    syncZones: runtimeZones.length <= 1,
  });
}

function cardSafeControls(controls = {}, playlist = []) {
  const playlistLookIds = derivePlaylistLookIds(playlist);
  return {
    ...(controls || {}),
    brightness: DEFAULT_CARD_CONTROLS.brightness,
    encoder: {
      ...(controls?.encoder || {}),
      press: DEFAULT_CARD_CONTROLS.encoder.press,
      alternatePress: DEFAULT_CARD_CONTROLS.encoder.alternatePress,
      patternCycleIds: playlistLookIds.length
        ? playlistLookIds
        : (controls?.encoder?.patternCycleIds || DEFAULT_CARD_CONTROLS.encoder.patternCycleIds),
    },
  };
}

function resolveCardOutputs({ strips = [], configuredOutputs = [], resolvedPixels = DEFAULT_CARD_LED.pixels } = {}) {
  const normalizedConfigured = normalizeStandaloneOutputs(configuredOutputs);
  const configuredPixelTotal = normalizedConfigured.reduce((sum, output) => sum + output.pixels, 0);
  const pixels = Math.max(1, Math.floor(Number(resolvedPixels) || DEFAULT_CARD_LED.pixels));

  if (normalizedConfigured.length > 0 && configuredPixelTotal === pixels) {
    return normalizedConfigured;
  }

  const configuredPins = (configuredOutputs || []).map(output => ({ ...output, pixels: 0 }));
  const derivedOutputs = deriveStandaloneOutputsFromStrips(strips, configuredPins);
  const derivedPixelTotal = derivedOutputs.reduce((sum, output) => sum + output.pixels, 0);
  if (derivedOutputs.length > 0 && derivedPixelTotal === pixels) {
    return derivedOutputs;
  }

  const firstOutput = normalizedConfigured[0] || configuredOutputs[0] || DEFAULT_CARD_LED.outputs[0];
  return [{
    id: 'out1',
    name: 'Output 1',
    pin: firstOutput.pin ?? DEFAULT_CARD_LED.outputs[0].pin,
    pixels,
  }];
}

function resolvePackagePatterns(standaloneController = {}, requestedPatternIds = []) {
  const configuredCycle = standaloneController?.controls?.encoder?.patternCycleIds;
  const requested = Array.isArray(configuredCycle) &&
    configuredCycle.length &&
    !isDefaultPatternCycle(configuredCycle)
    ? configuredCycle
    : [];
  const ids = [
    ...requestedPatternIds,
    ...requested,
  ].filter(Boolean);
  return orderedCardPatterns(ids);
}

function buildRuntimeLooksFromPlaylist({
  playlist = [],
  savedLooks = [],
  patchBoard = null,
  strips = [],
  runtimeZones = [],
  visualLook = {},
} = {}) {
  const savedLookById = new Map(savedLooks.map(look => [look.id, look]));
  return (playlist || [])
    .filter(item => item?.enabled !== false)
    .map(item => {
      if (item.type === 'combo') {
        const savedLook = savedLookById.get(item.lookId);
        if (!savedLook) return null;
        const comboDefault = normalizeCardVisualLook(savedLook.defaultLook);
        const comboBoard = applySavedLookToPatchBoard({ patchBoard, strips, savedLook });
        const comboZones = patchBoardToZones(comboBoard, strips);
        const effectiveZones = comboZones.length
          ? applyVisualLookDefaultsToZones(comboZones, comboBoard, comboDefault)
          : runtimeZones.map(zone => applyLookFieldsToZone(zone, comboDefault));
        return {
          id: item.id,
          label: item.label || savedLook.label,
          mode: 'combo',
          preset: getCardPatternRuntimeId(comboDefault.patternId) || comboDefault.patternId,
          brightness: 1,
          zones: zoneLooksFromZones(effectiveZones),
        };
      }

      const pattern = getCardPatternById(item.patternId);
      if (!pattern) return null;
      const runtimePatternId = getCardPatternRuntimeId(pattern);
      return {
        id: item.id || pattern.id,
        label: item.label || pattern.label,
        mode: pattern.mode === 'preset' ? 'preset' : 'procedural',
        preset: runtimePatternId,
        brightness: 1,
      };
    })
    .filter(Boolean);
}

function applyLookFieldsToZone(zone, look) {
  return {
    ...zone,
    patternId: getCardPatternRuntimeId(look.patternId) || look.patternId,
    brightness: look.brightness,
    speed: look.speed,
    hueShift: look.hueShift,
    customHue: look.customHue,
    customSaturation: look.customSaturation,
    customBreathe: look.customBreathe,
    customDrift: look.customDrift,
  };
}

function zoneLooksFromZones(zones = []) {
  return zones.map(zone => ({
    id: zone.id,
    label: zone.label,
    patternId: zone.patternId,
    brightness: zone.brightness,
    speed: zone.speed,
    hueShift: zone.hueShift,
    customHue: zone.customHue,
    customSaturation: zone.customSaturation,
    customBreathe: zone.customBreathe,
    customDrift: zone.customDrift,
  }));
}

function applyVisualLookDefaultsToZones(zones, patchBoard, visualLook) {
  const playbackByPatchId = new Map((patchBoard?.patches || []).map(patch => [
    sanitizeId(patch.id || ''),
    patch.playback || {},
  ]));
  return zones.map(zone => {
    const playback = playbackByPatchId.get(zone.id) || {};
    const displayPatternId = hasExplicit(playback.patternId) ? zone.patternId : visualLook.patternId;
    return {
      ...zone,
      patternId: getCardPatternRuntimeId(displayPatternId) || displayPatternId,
      brightness: hasExplicit(playback.brightness) ? zone.brightness : visualLook.brightness,
      speed: hasExplicit(playback.speed) ? zone.speed : visualLook.speed,
      hueShift: hasExplicit(playback.hueShift) ? zone.hueShift : visualLook.hueShift,
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
