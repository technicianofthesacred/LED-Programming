export const WLED_BASIC_TIER_ID = 'wled-basic';
export const ADVANCED_ARTNET_TIER_ID = 'advanced-artnet';

export const PATTERN_TARGETS = Object.freeze({
  WLED_PRESET: 'wled-preset',
  WLED_CUSTOM_EFFECT: 'wled-custom-effect',
  LIVE_FRAME_STREAM: 'live-frame-stream',
  ARTNET_STREAM: 'artnet-stream',
  STANDALONE_PROCEDURAL: 'standalone-procedural',
  STANDALONE_SEQUENCE: 'standalone-sequence',
});

const BASIC_WLED_PATTERN_IDS = new Set([
  'aurora',
  'breathe',
  'candle',
  'fire',
  'gradient',
  'lava',
  'meteor',
  'ocean',
  'rainbow',
  'scanner',
  'sparkle',
  'twinkle',
]);

const WLED_PRESET_PATTERN_IDS = new Set([
  'breathe',
  'candle',
  'gradient',
  'rainbow',
  'twinkle',
]);

export const LIGHTWEAVER_RUNTIME_TIERS = Object.freeze({
  [WLED_BASIC_TIER_ID]: Object.freeze({
    id: WLED_BASIC_TIER_ID,
    label: 'Lightweaver Basic - WLED',
    shortLabel: 'Basic WLED',
    controllerFirmware: 'WLED',
    runtimeHardware: 'ESP32-S3 running WLED only',
    requiresPiAtRuntime: false,
    lookStorage: 'WLED presets, playlists, segments, and Lightweaver custom WLED effects stored in ESP32 flash',
    operatorControl: 'WLED UI, Lightweaver phone UI, physical button macros, or preset playlists',
    capabilities: Object.freeze([
      PATTERN_TARGETS.WLED_PRESET,
      PATTERN_TARGETS.WLED_CUSTOM_EFFECT,
      PATTERN_TARGETS.LIVE_FRAME_STREAM,
    ]),
    bestFor: Object.freeze([
      'entry-level pieces',
      'stored ambient looks',
      'phone-controlled preset cycling',
      'simple installs with no Pi, Mac, or Madrix at runtime',
    ]),
    constraints: Object.freeze([
      'arbitrary browser JavaScript patterns must be ported to WLED custom effects before they live on the chip',
      'exact long-form timeline playback is not the default WLED-basic path',
      'large per-pixel recordings should use the advanced sequence path',
    ]),
  }),
  [ADVANCED_ARTNET_TIER_ID]: Object.freeze({
    id: ADVANCED_ARTNET_TIER_ID,
    label: 'Lightweaver Advanced - Art-Net / Custom',
    shortLabel: 'Advanced Art-Net',
    controllerFirmware: 'WLED Art-Net receiver or Lightweaver standalone firmware',
    runtimeHardware: 'ESP32-S3 plus optional Raspberry Pi, Madrix host, or microSD sequence controller',
    requiresPiAtRuntime: 'optional',
    lookStorage: 'Madrix/Lightweaver project files, Art-Net streams, or Lightweaver .lwseq packages on microSD',
    operatorControl: 'Lightweaver pro UI, Madrix, Art-Net source, or standalone physical controls',
    capabilities: Object.freeze([
      PATTERN_TARGETS.ARTNET_STREAM,
      PATTERN_TARGETS.LIVE_FRAME_STREAM,
      PATTERN_TARGETS.STANDALONE_PROCEDURAL,
      PATTERN_TARGETS.STANDALONE_SEQUENCE,
    ]),
    bestFor: Object.freeze([
      'high-end commissioned pieces',
      'Madrix-authored shows',
      'exact recorded playback',
      'multi-output controllers and long sequences',
    ]),
    constraints: Object.freeze([
      'live Art-Net requires a running Art-Net source at runtime',
      'exact offline playback needs the Lightweaver standalone firmware and storage',
      'more commissioning discipline is required than WLED-basic presets',
    ]),
  }),
});

export function getRuntimeTier(id = WLED_BASIC_TIER_ID) {
  const tier = LIGHTWEAVER_RUNTIME_TIERS[id];
  if (!tier) {
    throw new RangeError(`Unknown Lightweaver runtime tier: ${id}`);
  }
  return tier;
}

export function recommendRuntimeTier({
  wantsStoredLooks = true,
  needsExactTimeline = false,
  needsLiveArtNet = false,
  needsMadrix = false,
  needsMultiOutputSequence = false,
  patternTargets = [],
} = {}) {
  const targets = new Set(patternTargets);
  const canStoreOnWled =
    targets.has(PATTERN_TARGETS.WLED_PRESET) ||
    targets.has(PATTERN_TARGETS.WLED_CUSTOM_EFFECT);
  const explicitlyNeedsAdvanced =
    needsExactTimeline ||
    needsLiveArtNet ||
    needsMadrix ||
    needsMultiOutputSequence;
  const hasOnlyAdvancedPatternTarget =
    targets.size > 0 &&
    !canStoreOnWled &&
    (
      targets.has(PATTERN_TARGETS.ARTNET_STREAM) ||
      targets.has(PATTERN_TARGETS.STANDALONE_SEQUENCE)
    );

  if (explicitlyNeedsAdvanced || hasOnlyAdvancedPatternTarget) {
    return getRuntimeTier(ADVANCED_ARTNET_TIER_ID);
  }

  if (wantsStoredLooks && canStoreOnWled) {
    return getRuntimeTier(WLED_BASIC_TIER_ID);
  }

  if (
    targets.has(PATTERN_TARGETS.ARTNET_STREAM) ||
    targets.has(PATTERN_TARGETS.STANDALONE_SEQUENCE)
  ) {
    return getRuntimeTier(ADVANCED_ARTNET_TIER_ID);
  }

  if (wantsStoredLooks) return getRuntimeTier(WLED_BASIC_TIER_ID);
  return getRuntimeTier(WLED_BASIC_TIER_ID);
}

export function inferPatternTargets(pattern = {}) {
  const declared = normalizeDeclaredTargets(pattern.runtimeTargets || pattern.targets);
  if (declared.length) return declared;

  const targets = new Set([
    PATTERN_TARGETS.LIVE_FRAME_STREAM,
    PATTERN_TARGETS.ARTNET_STREAM,
    PATTERN_TARGETS.STANDALONE_SEQUENCE,
  ]);
  const id = String(pattern.id || '').trim().toLowerCase();
  const code = String(pattern.code || '');
  const beatDriven = /\bbeat\b/.test(code);
  const audioDriven = /\b(bass|mid|treble|audio)\b/i.test(code);

  if (!beatDriven && !audioDriven && BASIC_WLED_PATTERN_IDS.has(id)) {
    targets.add(PATTERN_TARGETS.WLED_CUSTOM_EFFECT);
    targets.add(PATTERN_TARGETS.STANDALONE_PROCEDURAL);
  }

  if (!beatDriven && !audioDriven && WLED_PRESET_PATTERN_IDS.has(id)) {
    targets.add(PATTERN_TARGETS.WLED_PRESET);
  }

  return [...targets];
}

export function patternSupportsRuntimeTier(pattern = {}, tierId = WLED_BASIC_TIER_ID) {
  const tier = getRuntimeTier(tierId);
  const targets = new Set(inferPatternTargets(pattern));
  return tier.capabilities.some(target => targets.has(target));
}

export function describePatternCompatibility(pattern = {}) {
  const targets = inferPatternTargets(pattern);
  const canStoreOnWled =
    targets.includes(PATTERN_TARGETS.WLED_PRESET) ||
    targets.includes(PATTERN_TARGETS.WLED_CUSTOM_EFFECT);
  const bestTier = canStoreOnWled
    ? getRuntimeTier(WLED_BASIC_TIER_ID)
    : getRuntimeTier(ADVANCED_ARTNET_TIER_ID);
  const name = pattern.name || pattern.id || 'Pattern';
  const summary = canStoreOnWled
    ? `${name} can be stored on WLED as a preset or Lightweaver custom effect, then cycled without a Pi or Mac.`
    : `${name} needs Lightweaver rendering, Art-Net streaming, or a standalone sequence export before it can run without the editor.`;

  return {
    patternId: pattern.id || '',
    targets,
    bestTier,
    canStoreOnWled,
    summary,
  };
}

function normalizeDeclaredTargets(targets = []) {
  const knownTargets = new Set(Object.values(PATTERN_TARGETS));
  return Array.isArray(targets)
    ? [...new Set(targets.filter(target => knownTargets.has(target)))]
    : [];
}
