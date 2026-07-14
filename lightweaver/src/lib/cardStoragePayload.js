export const CARD_CONFIG_STORAGE_LIMIT_BYTES = 3968;

export class CardConfigCapacityError extends Error {
  constructor(bytes, maxBytes) {
    super(
      `Card configuration is ${bytes} bytes, exceeding the ${maxBytes}-byte flash storage limit. ` +
      'Remove playlist looks or simplify combo zones, then try again.',
    );
    this.name = 'CardConfigCapacityError';
    this.reason = 'config-too-large';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export function compactCardStorageConfig(runtimePackageOrConfig = {}) {
  const source = runtimePackageOrConfig?.format === 'lightweaver-card-runtime-package' &&
    isObject(runtimePackageOrConfig?.config)
    ? runtimePackageOrConfig.config
    : runtimePackageOrConfig;
  const config = cloneValue(isObject(source) ? source : {});

  if (Array.isArray(config.looks) && config.looks.length > 0) {
    delete config.patterns;
    config.looks = config.looks.map(look => compactLook(look, config.mode));
  }

  if (Array.isArray(config.zones)) {
    config.zones = config.zones.map(compactZone);
  }

  if (isObject(config.controls?.encoder)) {
    delete config.controls.encoder.patternCycleIds;
  }

  return config;
}

export function prepareCardStoragePayload(
  runtimePackageOrConfig = {},
  { maxBytes = CARD_CONFIG_STORAGE_LIMIT_BYTES } = {},
) {
  const config = compactCardStorageConfig(runtimePackageOrConfig);
  const json = JSON.stringify(config);
  const bytes = new TextEncoder().encode(json).byteLength;

  if (bytes > maxBytes) {
    throw new CardConfigCapacityError(bytes, maxBytes);
  }

  return { config, json, bytes };
}

function compactLook(look, configMode) {
  if (!isObject(look)) return cloneValue(look);
  const compact = cloneValue(look);

  if (compact.fps === 24) delete compact.fps;
  if (compact.loop === true) delete compact.loop;
  if (compact.fadeOutMs === 320) delete compact.fadeOutMs;
  if (compact.fadeInMs === 420) delete compact.fadeInMs;
  if (compact.brightness === 0.65) delete compact.brightness;
  if (compact.preset === compact.id) delete compact.preset;
  if (compact.mode === 'procedural' && configMode !== 'sd-sequence') delete compact.mode;
  if (Array.isArray(compact.zones)) compact.zones = compact.zones.map(compactZone);

  return compact;
}

function compactZone(zone) {
  if (!isObject(zone)) return cloneValue(zone);
  const compact = cloneValue(zone);
  const defaults = {
    brightness: 1,
    speed: 1,
    hueShift: 0,
    customHue: 32,
    customSaturation: 230,
    customBreathe: false,
    customDrift: false,
    blackout: false,
  };

  for (const [field, defaultValue] of Object.entries(defaults)) {
    if (compact[field] === defaultValue) delete compact[field];
  }

  return compact;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
