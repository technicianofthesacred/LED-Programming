import { CARD_PATTERN_BANK } from './cardPatternBank.js';

export const CARD_RUNTIME_MODES = ['factory-flash', 'website-flash', 'sd-sequence', 'live-host'];
export const CARD_RUNTIME_MAX_ZONES = 10;

export const DEFAULT_CARD_PATTERN_BANK = CARD_PATTERN_BANK;

export const DEFAULT_CARD_CONTROLS = Object.freeze({
  encoder: {
    a: 4,
    b: 5,
    press: 0,
    alternatePress: 6,
    rotateDirection: 'clockwise-brighter',
    brightnessStep: 18,
    patternCycleIds: DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id),
  },
  previous: 7,
  next: 8,
  blackout: 9,
  brightness: -1,
  statusLed: 2,
});

export const DEFAULT_CARD_LED = Object.freeze({
  pixels: 44,
  outputs: [{ id: 'out1', name: 'Output 1', pin: 16, pixels: 44 }],
  colorOrder: 'RGB',
  brightnessLimit: 0.65,
});

export function normalizeCardRuntimeConfig(config = {}) {
  const mode = CARD_RUNTIME_MODES.includes(config.mode) ? config.mode : 'factory-flash';
  const requestedCycleIds = normalizePatternIds(config.controls?.encoder?.patternCycleIds);
  const led = normalizeLed(config.led);
  const totalPixels = led.pixels;
  const zones = normalizeZones(config.zones, totalPixels);
  const patterns = normalizePatterns(config.patterns);
  const looks = normalizeLooks(config.looks, patterns);
  const lookIds = looks.map(look => look.id);
  const patternIds = requestedCycleIds.length ? requestedCycleIds : lookIds;
  return {
    version: 1,
    mode,
    piece: {
      id: sanitizeId(config.piece?.id || config.projectId || config.projectName || 'lightweaver-piece'),
      name: String(config.piece?.name || config.projectName || 'Lightweaver Piece'),
    },
    led,
    controls: normalizeControls({
      ...config.controls,
      encoder: {
        ...(config.controls?.encoder || {}),
        patternCycleIds: patternIds.length ? patternIds : DEFAULT_CARD_CONTROLS.encoder.patternCycleIds,
      },
    }),
    patterns,
    looks,
    startupPatternId: sanitizeId(config.startupPatternId || config.startupLookId || patternIds[0] || DEFAULT_CARD_PATTERN_BANK[0].id),
    zones,
    syncZones: config.syncZones === undefined ? true : Boolean(config.syncZones),
  };
}

// Translate a designer-side PatchBoard (or raw zone list) into the firmware's
// zone wire format. Each patch becomes one zone with one pixel range.
// PatchBoard input shape: { patches: [{ id, name, source: { type: 'strip', stripId, startLed, endLed }, playback, output }] }
// Raw zones input shape: [{ id, label, patternId, brightness, ..., ranges: [{ start, count }] }]
export function patchBoardToZones(patchBoard, strips = []) {
  if (!patchBoard || !Array.isArray(patchBoard.patches)) return [];
  const stripPixelOffsets = new Map();
  let cursor = 0;
  for (const strip of strips) {
    stripPixelOffsets.set(strip.id, cursor);
    cursor += strip.pixelCount ?? strip.pixels?.length ?? 0;
  }
  return patchBoard.patches
    .filter(p => p?.source?.type === 'strip' && p.output?.mode !== 'off')
    .map(p => {
      const stripOffset = stripPixelOffsets.get(p.source.stripId) || 0;
      const start = stripOffset + (p.source.startLed || 0);
      const count = (p.source.endLed - p.source.startLed) + 1;
      const playback = p.playback || {};
      return {
        id: sanitizeId(p.id || `zone-${start}`),
        label: String(p.name || p.id || 'Zone'),
        patternId: sanitizeId(playback.patternId || ''),
        brightness: clampUnit(playback.brightness ?? 1.0),
        speed: Number.isFinite(playback.speed) ? playback.speed : 1.0,
        hueShift: Number.isFinite(playback.hueShift) ? playback.hueShift : 0,
        customHue: clampInt(playback.customHue, 32, 0, 255),
        customSaturation: clampInt(playback.customSaturation, 230, 0, 255),
        customBreathe: Boolean(playback.customBreathe),
        customDrift: Boolean(playback.customDrift),
        ranges: [{ start, count }],
      };
    });
}

function normalizeZones(zones, totalPixels) {
  if (!Array.isArray(zones) || zones.length === 0) return [];
  return zones
    .slice(0, CARD_RUNTIME_MAX_ZONES)
    .map((z, i) => ({
      id: sanitizeId(z.id || `zone-${i + 1}`),
      label: String(z.label || z.id || `Zone ${i + 1}`),
      patternId: sanitizeId(z.patternId || 'aurora'),
      brightness: clampUnit(z.brightness ?? 1.0),
      speed: clampSpeed(z.speed),
      hueShift: clampInt(z.hueShift, 0, -128, 128),
      customHue: clampInt(z.customHue, 32, 0, 255),
      customSaturation: clampInt(z.customSaturation, 230, 0, 255),
      customBreathe: Boolean(z.customBreathe),
      customDrift: Boolean(z.customDrift),
      ranges: Array.isArray(z.ranges) && z.ranges.length
        ? z.ranges.slice(0, 4).map(r => ({
            start: clampInt(r.start, 0, 0, Math.max(0, totalPixels - 1)),
            count: clampInt(r.count, 0, 0, totalPixels),
          })).filter(r => r.count > 0)
        : [{ start: 0, count: totalPixels }],
    }))
    .filter(z => z.ranges.length > 0);
}

function clampSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1.0;
  return Math.max(0.05, Math.min(3.0, n));
}

export function buildCardRuntimeConfig({
  projectId = '',
  projectName = 'Lightweaver Piece',
  mode = 'factory-flash',
  led = {},
  controls = {},
  patterns = DEFAULT_CARD_PATTERN_BANK,
  looks = [],
  startupPatternId = '',
  zones,
  syncZones,
} = {}) {
  return normalizeCardRuntimeConfig({
    projectId,
    mode,
    projectName,
    led,
    controls,
    patterns,
    looks,
    startupPatternId,
    zones,
    syncZones,
  });
}

export function makeCardRuntimePackage(options = {}) {
  return {
    app: 'Lightweaver',
    format: 'lightweaver-card-runtime-package',
    version: 1,
    config: buildCardRuntimeConfig(options),
  };
}

function normalizeLed(led = {}) {
  const requestedPixels = clampInt(led.pixels, DEFAULT_CARD_LED.pixels, 1, 4096);
  const configuredOutputs = Array.isArray(led.outputs)
    ? led.outputs.filter(output => Number(output?.pixels || output?.pixelCount || 0) > 0)
    : [];
  const outputs = configuredOutputs.length
    ? configuredOutputs
    : [{ ...DEFAULT_CARD_LED.outputs[0], pixels: requestedPixels }];
  const normalizedOutputs = outputs
    .slice(0, 4)
    .map((output, index) => ({
      id: sanitizeId(output.id || `out${index + 1}`),
      name: String(output.name || `Output ${index + 1}`),
      pin: clampInt(output.pin, [16, 17, 18, 21][index] || 16, 0, 48),
      pixels: clampInt(output.pixels ?? output.pixelCount, requestedPixels, 1, 2048),
    }));
  const pixels = clampInt(
    led.pixels,
    normalizedOutputs.reduce((sum, output) => sum + output.pixels, 0),
    1,
    4096,
  );
  return {
    pixels,
    outputs: normalizedOutputs,
    colorOrder: normalizeColorOrder(led.colorOrder),
    brightnessLimit: clampUnit(led.brightnessLimit ?? DEFAULT_CARD_LED.brightnessLimit),
  };
}

function normalizeControls(controls = {}) {
  const encoder = controls.encoder || {};
  return {
    encoder: {
      ...DEFAULT_CARD_CONTROLS.encoder,
      ...encoder,
      a: clampInt(encoder.a, DEFAULT_CARD_CONTROLS.encoder.a, 0, 48),
      b: clampInt(encoder.b, DEFAULT_CARD_CONTROLS.encoder.b, 0, 48),
      press: clampInt(encoder.press, DEFAULT_CARD_CONTROLS.encoder.press, 0, 48),
      alternatePress: clampInt(encoder.alternatePress, DEFAULT_CARD_CONTROLS.encoder.alternatePress, -1, 48),
      rotateDirection: encoder.rotateDirection === 'clockwise-dimmer'
        ? 'clockwise-dimmer'
        : 'clockwise-brighter',
      brightnessStep: clampInt(encoder.brightnessStep, DEFAULT_CARD_CONTROLS.encoder.brightnessStep, 1, 64),
      patternCycleIds: normalizePatternIds(encoder.patternCycleIds).length
        ? normalizePatternIds(encoder.patternCycleIds)
        : DEFAULT_CARD_CONTROLS.encoder.patternCycleIds,
    },
    previous: clampInt(controls.previous, DEFAULT_CARD_CONTROLS.previous, -1, 48),
    next: clampInt(controls.next, DEFAULT_CARD_CONTROLS.next, -1, 48),
    blackout: clampInt(controls.blackout, DEFAULT_CARD_CONTROLS.blackout, -1, 48),
    brightness: clampInt(controls.brightness, DEFAULT_CARD_CONTROLS.brightness, -1, 48),
    statusLed: clampInt(controls.statusLed, DEFAULT_CARD_CONTROLS.statusLed, -1, 48),
  };
}

function normalizePatterns(patterns = DEFAULT_CARD_PATTERN_BANK) {
  const input = Array.isArray(patterns) && patterns.length ? patterns : DEFAULT_CARD_PATTERN_BANK;
  return input.map((pattern, index) => {
    const id = sanitizeId(pattern.id || `pattern-${index + 1}`);
    return {
      id,
      label: String(pattern.label || titleFromId(id)),
      mode: pattern.mode === 'preset' ? 'preset' : 'procedural',
      ...(pattern.preset ? { preset: sanitizeId(pattern.preset) } : {}),
    };
  });
}

function normalizePatternIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map(id => sanitizeId(id))
    .filter(Boolean))];
}

function normalizeLooks(looks = [], patterns = normalizePatterns(DEFAULT_CARD_PATTERN_BANK)) {
  const input = Array.isArray(looks) && looks.length ? looks : patterns;
  return input.slice(0, 32).map((look, index) => {
    const preset = sanitizeId(look.preset || look.patternId || look.id || `look-${index + 1}`);
    const id = sanitizeId(look.id || preset || `look-${index + 1}`);
    const zones = normalizeLookZones(look.zones);
    const pattern = DEFAULT_CARD_PATTERN_BANK.find(item => item.id === preset);
    const requestedMode = String(look.mode || '').trim().toLowerCase();
    const mode = zones.length
      ? 'combo'
      : requestedMode === 'sequence'
        ? 'sequence'
        : requestedMode === 'preset' || pattern?.mode === 'preset'
          ? 'preset'
          : 'procedural';
    const normalized = {
      id,
      label: String(look.label || pattern?.label || titleFromId(id)),
      mode,
      preset,
      fps: clampInt(look.fps, 24, 1, 120),
      loop: look.loop ?? true,
      fadeOutMs: clampInt(look.fadeOutMs, 320, 0, 8000),
      fadeInMs: clampInt(look.fadeInMs, 420, 0, 8000),
      brightness: clampUnit(look.brightness ?? 0.65),
    };
    if (mode === 'sequence') {
      normalized.file = String(look.file || `/sequences/${String(index + 1).padStart(3, '0')}-${id}.lwseq`);
    }
    if (zones.length) {
      normalized.zones = zones;
    }
    return normalized;
  });
}

function normalizeLookZones(zones = []) {
  if (!Array.isArray(zones) || !zones.length) return [];
  return zones.slice(0, CARD_RUNTIME_MAX_ZONES).map((zone, index) => ({
    id: sanitizeId(zone.id || `zone-${index + 1}`),
    label: String(zone.label || zone.id || `Zone ${index + 1}`),
    patternId: sanitizeId(zone.patternId || 'aurora'),
    brightness: clampUnit(zone.brightness ?? 1.0),
    speed: clampSpeed(zone.speed),
    hueShift: clampInt(zone.hueShift, 0, -128, 128),
    customHue: clampInt(zone.customHue, 32, 0, 255),
    customSaturation: clampInt(zone.customSaturation, 230, 0, 255),
    customBreathe: Boolean(zone.customBreathe),
    customDrift: Boolean(zone.customDrift),
  })).filter(zone => zone.id && zone.patternId);
}

function normalizeColorOrder(value = 'RGB') {
  const upper = String(value || '').trim().toUpperCase();
  return ['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR'].includes(upper) ? upper : 'RGB';
}

function clampUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CARD_LED.brightnessLimit;
  return Math.max(0, Math.min(1, number));
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function sanitizeId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleFromId(id = '') {
  return String(id || '')
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
