export const CARD_RUNTIME_MODES = ['factory-flash', 'website-flash', 'sd-sequence', 'live-host'];

export const DEFAULT_CARD_PATTERN_BANK = Object.freeze([
  { id: 'aurora', label: 'Aurora', mode: 'procedural' },
  { id: 'ember', label: 'Ember', mode: 'procedural' },
  { id: 'rainbow', label: 'Rainbow', mode: 'procedural' },
  { id: 'breathe', label: 'Breathe', mode: 'procedural' },
  { id: 'scanner', label: 'Scanner', mode: 'procedural' },
  { id: 'warm-white', label: 'Warm White', mode: 'preset' },
]);

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
  const patternIds = normalizePatternIds(config.controls?.encoder?.patternCycleIds);
  return {
    version: 1,
    mode,
    piece: {
      id: sanitizeId(config.piece?.id || config.projectName || 'lightweaver-piece'),
      name: String(config.piece?.name || config.projectName || 'Lightweaver Piece'),
    },
    led: normalizeLed(config.led),
    controls: normalizeControls({
      ...config.controls,
      encoder: {
        ...(config.controls?.encoder || {}),
        patternCycleIds: patternIds.length ? patternIds : DEFAULT_CARD_CONTROLS.encoder.patternCycleIds,
      },
    }),
    patterns: normalizePatterns(config.patterns),
    startupPatternId: sanitizeId(config.startupPatternId || patternIds[0] || DEFAULT_CARD_PATTERN_BANK[0].id),
  };
}

export function buildCardRuntimeConfig({
  projectName = 'Lightweaver Piece',
  mode = 'factory-flash',
  led = {},
  controls = {},
  patterns = DEFAULT_CARD_PATTERN_BANK,
  startupPatternId = '',
} = {}) {
  return normalizeCardRuntimeConfig({
    mode,
    projectName,
    led,
    controls,
    patterns,
    startupPatternId,
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
  const outputs = Array.isArray(led.outputs) && led.outputs.length
    ? led.outputs
    : DEFAULT_CARD_LED.outputs;
  const normalizedOutputs = outputs
    .slice(0, 4)
    .map((output, index) => ({
      id: sanitizeId(output.id || `out${index + 1}`),
      name: String(output.name || `Output ${index + 1}`),
      pin: clampInt(output.pin, [16, 17, 18, 21][index] || 16, 0, 48),
      pixels: clampInt(output.pixels, DEFAULT_CARD_LED.pixels, 1, 2048),
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
    };
  });
}

function normalizePatternIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map(id => sanitizeId(id))
    .filter(Boolean))];
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
