export const WLED_ENCODER_FIRMWARE_MODES = Object.freeze({
  STOCK_WLED: 'stock-wled',
  ROTARY_USERMOD: 'rotary-usermod',
  LIGHTWEAVER_WLED: 'lightweaver-wled',
});

export const WLED_ENCODER_ACTIONS = Object.freeze({
  BRIGHTNESS: 'brightness',
  NEXT_PRESET: 'next-preset',
  NONE: 'none',
});

export const DEFAULT_WLED_PHYSICAL_CONTROLS = Object.freeze({
  encoder: Object.freeze({
    enabled: true,
    firmware: WLED_ENCODER_FIRMWARE_MODES.ROTARY_USERMOD,
    pins: Object.freeze({ a: 4, b: 5, press: 6 }),
    rotateAction: WLED_ENCODER_ACTIONS.BRIGHTNESS,
    pressAction: WLED_ENCODER_ACTIONS.NEXT_PRESET,
    brightnessStep: 8,
    helperPresetLabel: 'LW Next Look',
  }),
});

const VALID_FIRMWARE_MODES = new Set(Object.values(WLED_ENCODER_FIRMWARE_MODES));
const VALID_ACTIONS = new Set(Object.values(WLED_ENCODER_ACTIONS));
const WLED_BUTTON_TYPE_PUSH = 2;

export function normalizeWledPhysicalControls(controls = {}) {
  const sourceEncoder = controls?.encoder || {};
  const defaults = DEFAULT_WLED_PHYSICAL_CONTROLS.encoder;
  return {
    encoder: {
      enabled: sourceEncoder.enabled ?? defaults.enabled,
      firmware: normalizeEnum(sourceEncoder.firmware, VALID_FIRMWARE_MODES, defaults.firmware),
      pins: {
        a: normalizeGpio(sourceEncoder.pins?.a ?? sourceEncoder.a ?? defaults.pins.a),
        b: normalizeGpio(sourceEncoder.pins?.b ?? sourceEncoder.b ?? defaults.pins.b),
        press: normalizeGpio(sourceEncoder.pins?.press ?? sourceEncoder.press ?? defaults.pins.press),
      },
      rotateAction: normalizeEnum(sourceEncoder.rotateAction, VALID_ACTIONS, defaults.rotateAction),
      pressAction: normalizeEnum(sourceEncoder.pressAction, VALID_ACTIONS, defaults.pressAction),
      brightnessStep: clampInt(sourceEncoder.brightnessStep, defaults.brightnessStep, 1, 64),
      helperPresetLabel: String(sourceEncoder.helperPresetLabel || defaults.helperPresetLabel).trim() || defaults.helperPresetLabel,
    },
  };
}

export function hasWledRotaryEncoderSupport(info = {}, cfg = {}) {
  const usermodNames = [
    ...Object.keys(info?.u || {}),
    ...Object.keys(cfg?.um || {}),
    ...Object.keys(info?.um || {}),
  ].join(' ');
  return /rotary|encoder/i.test(usermodNames);
}

export function makeWledPresetCycleCommand({ presetIds = [] } = {}) {
  const ids = uniquePositiveInts(presetIds);
  if (ids.length === 0) {
    return {
      firstPresetId: null,
      lastPresetId: null,
      presetIds: [],
      httpCommand: '',
      jsonCommand: {},
    };
  }
  const firstPresetId = Math.min(...ids);
  const lastPresetId = Math.max(...ids);
  return {
    firstPresetId,
    lastPresetId,
    presetIds: ids,
    httpCommand: `P1=${firstPresetId}&P2=${lastPresetId}&PL=~`,
    jsonCommand: { ps: `${firstPresetId}~ ${lastPresetId}~` },
  };
}

export function buildWledControlContract({
  physicalControls = DEFAULT_WLED_PHYSICAL_CONTROLS,
  wledPackage = {},
  info = {},
  cfg = {},
  helperPresetId = null,
} = {}) {
  const controls = normalizeWledPhysicalControls(physicalControls);
  const encoder = controls.encoder;
  const presetIds = Array.isArray(wledPackage?.presets)
    ? wledPackage.presets.map(preset => preset.presetId)
    : [];
  const cycle = makeWledPresetCycleCommand({ presetIds });
  const detectedRotary = hasWledRotaryEncoderSupport(info, cfg);
  const firmwareReady = encoder.firmware === WLED_ENCODER_FIRMWARE_MODES.LIGHTWEAVER_WLED
    || encoder.firmware === WLED_ENCODER_FIRMWARE_MODES.ROTARY_USERMOD
    || detectedRotary;
  const resolvedHelperPresetId = helperPresetId
    || nextPresetId([
      ...presetIds,
      wledPackage?.playlistPresetId,
    ]);
  const pressReady = encoder.pressAction === WLED_ENCODER_ACTIONS.NONE
    || (encoder.pressAction === WLED_ENCODER_ACTIONS.NEXT_PRESET && presetIds.length > 0);

  const presetEntries = {};
  if (encoder.enabled && encoder.pressAction === WLED_ENCODER_ACTIONS.NEXT_PRESET && cycle.jsonCommand.ps && resolvedHelperPresetId) {
    presetEntries[String(resolvedHelperPresetId)] = {
      n: encoder.helperPresetLabel,
      ql: '>>',
      ...cycle.jsonCommand,
    };
  }

  return {
    version: 1,
    runtimeOwner: 'wled-firmware',
    firmwareSupportDetected: detectedRotary,
    controls,
    presetEntries,
    encoder: {
      enabled: Boolean(encoder.enabled),
      firmware: encoder.firmware,
      pins: encoder.pins,
      rotate: {
        action: encoder.rotateAction,
        ready: !encoder.enabled
          || encoder.rotateAction === WLED_ENCODER_ACTIONS.NONE
          || (encoder.rotateAction === WLED_ENCODER_ACTIONS.BRIGHTNESS && firmwareReady),
        brightnessStep: encoder.brightnessStep,
        note: firmwareReady
          ? `Rotate controls WLED brightness on-device in ${encoder.brightnessStep}-point steps.`
          : 'Rotation needs a WLED rotary encoder usermod or Lightweaver WLED firmware; stock WLED button settings do not read encoder rotation.',
      },
      press: {
        action: encoder.pressAction,
        ready: !encoder.enabled || pressReady,
        helperPresetId: encoder.enabled && encoder.pressAction === WLED_ENCODER_ACTIONS.NEXT_PRESET ? resolvedHelperPresetId : null,
        firstPresetId: cycle.firstPresetId,
        lastPresetId: cycle.lastPresetId,
        httpCommand: cycle.httpCommand,
        jsonCommand: cycle.jsonCommand,
        note: pressReady
          ? `Press triggers the Lightweaver preset cycle ${cycle.firstPresetId || '-'}-${cycle.lastPresetId || '-'} on-device.`
          : 'Press needs at least one runnable WLED Basic preset before it can cycle Lightweaver looks.',
      },
    },
  };
}

export function summarizeWledControlContract(contract = {}) {
  const encoder = contract.encoder || {};
  if (!encoder.enabled) return 'Physical encoder is disabled for this controller profile.';
  const rotate = encoder.rotate?.ready
    ? 'rotate dims WLED brightness on-device'
    : 'rotate needs rotary encoder firmware';
  const press = encoder.press?.ready
    ? `press triggers preset ${encoder.press.helperPresetId}`
    : 'press has no runnable preset cycle yet';
  return `Encoder: ${rotate}; ${press}. Runtime owner: WLED firmware.`;
}

export function makeWledEncoderPressTestState(contract = {}) {
  const command = contract?.encoder?.press?.jsonCommand || {};
  return { ...command };
}

export function makeWledEncoderBrightnessState(contract = {}, direction = 'down') {
  const fallback = DEFAULT_WLED_PHYSICAL_CONTROLS.encoder.brightnessStep;
  const step = clampInt(contract?.encoder?.rotate?.brightnessStep, fallback, 1, 64);
  return { bri: direction === 'up' ? `~${step}` : `~-${step}` };
}

export function makeWledEncoderPressButtonConfig({ contract = {}, cfg = {} } = {}) {
  const encoder = contract?.encoder || {};
  const presetId = Number.parseInt(encoder.press?.helperPresetId, 10);
  const pin = normalizeGpio(encoder.pins?.press);
  if (!encoder.enabled || !Number.isFinite(presetId) || presetId <= 0 || pin == null) return null;

  const sourceButtons = Array.isArray(cfg?.hw?.btn?.ins) ? cfg.hw.btn.ins : [];
  const buttons = sourceButtons.map(normalizeButtonConfig);
  const matchingIndex = buttons.findIndex(button => (button.pin || []).includes(pin));
  const freeIndex = buttons.findIndex((button, index) => index > 0 && isFreeButtonConfig(button));
  const buttonIndex = matchingIndex >= 0
    ? matchingIndex
    : freeIndex >= 0
      ? freeIndex
      : buttons.length > 0
        ? buttons.length
        : 0;

  while (buttons.length <= buttonIndex) buttons.push(normalizeButtonConfig());
  buttons[buttonIndex] = {
    ...buttons[buttonIndex],
    type: WLED_BUTTON_TYPE_PUSH,
    pin: [pin],
    macros: [presetId, presetId, presetId],
  };

  const maxButtons = Number.parseInt(cfg?.hw?.btn?.max, 10);
  return {
    buttonIndex,
    pin,
    presetId,
    patch: {
      hw: {
        btn: {
          max: Math.max(Number.isFinite(maxButtons) ? maxButtons : 0, buttons.length),
          ins: buttons,
        },
      },
    },
  };
}

function normalizeEnum(value, validValues, fallback) {
  const normalized = String(value || '').trim();
  return validValues.has(normalized) ? normalized : fallback;
}

function normalizeGpio(value) {
  if (value === '' || value == null) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(48, parsed);
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function uniquePositiveInts(values = []) {
  return [...new Set(values
    .map(value => Number.parseInt(value, 10))
    .filter(value => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
}

function nextPresetId(values = []) {
  const ids = uniquePositiveInts(values);
  if (ids.length === 0) return 1;
  return Math.min(250, Math.max(...ids) + 1);
}

function normalizeButtonConfig(button = {}) {
  const pins = Array.isArray(button?.pin) ? button.pin.map(normalizeGpio).filter(pin => pin != null) : [];
  const macros = Array.isArray(button?.macros)
    ? button.macros.slice(0, 3).map(value => clampInt(value, 0, 0, 250))
    : [];
  while (macros.length < 3) macros.push(0);
  return {
    ...button,
    type: clampInt(button?.type, 0, 0, 255),
    pin: pins,
    macros,
  };
}

function isFreeButtonConfig(button = {}) {
  const pins = Array.isArray(button.pin) ? button.pin : [];
  const macros = Array.isArray(button.macros) ? button.macros : [];
  return pins.length === 0 || (button.type === 0 && macros.every(value => Number(value) === 0));
}
