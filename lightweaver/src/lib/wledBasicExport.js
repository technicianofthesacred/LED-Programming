import { PATTERNS } from './patterns-library.js';
import {
  PATTERN_COMPATIBILITY_GATES,
  auditPatternCompatibility,
  getPatternCompatibilityGate,
  summarizePatternCompatibility,
} from './patternCompatibility.js';
import {
  PATTERN_TARGETS,
  WLED_BASIC_TIER_ID,
  inferPatternTargets,
} from './runtimeTargets.js';
import { WLED_BASIC_EFFECT_ID_SOURCE, WLED_STOCK_LOOKS } from './wledStockLooks.js';
import {
  buildWledControlContract,
  normalizeWledPhysicalControls,
} from './wledControlContract.js';

export const WLED_BASIC_PACKAGE_VERSION = 1;
export const WLED_BASIC_DEFAULT_PRESET_START = 1;
export const WLED_BASIC_DEFAULT_PLAYLIST_SECONDS = 20;
export const WLED_BASIC_DEFAULT_TRANSITION_MS = 1000;

export const WLED_BASIC_DEFAULT_BANK = Object.freeze([
  'candle',
  'breathe',
  'aurora',
  'fire',
  'rainbow',
  'gradient',
  'twinkle',
  'sparkle',
  'meteor',
  'ocean',
  'scanner',
  'lava',
]);

export function collectWledBasicPatternIds({
  activePatternId = '',
  showClips = [],
  strips = [],
  patterns = PATTERNS,
  patternIds = null,
  minBankSize = 8,
} = {}) {
  const requested = Array.isArray(patternIds)
    ? patternIds
    : [
        activePatternId,
        ...showClips.map(clip => clip.patternId),
        ...strips.map(strip => strip.patternId),
      ];
  const ordered = uniqueIds(requested).filter(id => isWledBasicCompatible(patternById(patterns, id)));

  if (Array.isArray(patternIds)) return ordered;

  for (const id of WLED_BASIC_DEFAULT_BANK) {
    if (stockPresetCount(ordered) >= minBankSize && ordered.includes(activePatternId)) break;
    if (!ordered.includes(id) && isWledBasicCompatible(patternById(patterns, id))) {
      ordered.push(id);
    }
  }
  return ordered;
}

export function buildWledBasicPackage({
  projectName = 'Untitled Project',
  activePatternId = '',
  showClips = [],
  strips = [],
  patterns = PATTERNS,
  patternIds = null,
  palette = [],
  duration = 0,
  presetStart = WLED_BASIC_DEFAULT_PRESET_START,
  playlistName = 'Lightweaver Basic Cycle',
  playlistPresetId = null,
  presetDurationSeconds = WLED_BASIC_DEFAULT_PLAYLIST_SECONDS,
  transitionMs = WLED_BASIC_DEFAULT_TRANSITION_MS,
  brightness = 128,
  loop = true,
  maxSegments = 16,
  physicalControls = null,
} = {}) {
  const requestedIds = uniqueIds([
    activePatternId,
    ...showClips.map(clip => clip.patternId),
    ...strips.map(strip => strip.patternId),
    ...(Array.isArray(patternIds) ? patternIds : []),
  ]);
  const exportPatternIds = collectWledBasicPatternIds({
    activePatternId,
    showClips,
    strips,
    patterns,
    patternIds,
  });
  const segments = makeWledBasicSegments(strips, { maxSegments });
  const compatibilityAudit = auditPatternCompatibility(patterns);
  const requestedCompatibilityAudit = requestedIds
    .map(id => compatibilityAudit.find(item => item.patternId === id))
    .filter(Boolean);
  const gateSummary = summarizePatternCompatibility(compatibilityAudit);
  const warnings = [];
  if (strips.filter(strip => pixelCountForStrip(strip) > 0).length > maxSegments) {
    warnings.push(`WLED on ESP32 supports a limited segment count; this export collapsed ${strips.length} strips into one full-piece segment.`);
  }

  const presets = [];
  const customEffectPorts = [];
  exportPatternIds.forEach((id) => {
    const pattern = patternById(patterns, id);
    const stock = WLED_STOCK_LOOKS[id];
    if (!pattern) return;
    if (!stock) {
      customEffectPorts.push(makeCustomEffectPort(pattern));
      return;
    }
    presets.push(makeWledBasicPreset({
      pattern,
      stock,
      presetId: presetStart + presets.length,
      segments,
      palette,
      brightness,
      transitionMs,
    }));
  });

  const unsupportedPatterns = requestedIds
    .map(id => patternById(patterns, id) || { id, name: titleFromId(id) })
    .filter(pattern => pattern.id && !isWledBasicCompatible(pattern))
    .map((pattern) => {
      const gate = getPatternCompatibilityGate(pattern);
      return {
        patternId: pattern.id,
        name: pattern.name || titleFromId(pattern.id),
        gate: gate.gate,
        gateLabel: gate.label,
        reason: gate.reason,
        allowedRuntimes: gate.allowedRuntimes,
        targets: inferPatternTargets(pattern),
      };
    });

  const resolvedPlaylistPresetId = playlistPresetId || presetStart + presets.length;
  const controlContract = buildWledControlContract({
    physicalControls: normalizeWledPhysicalControls(physicalControls || { encoder: { enabled: false } }),
    wledPackage: {
      presets,
      playlistPresetId: resolvedPlaylistPresetId,
    },
  });
  const presetsJson = makeWledBasicPresetsJson({
    presets,
    playlistName,
    playlistPresetId: resolvedPlaylistPresetId,
    presetDurationSeconds,
    transitionMs,
    repeat: loop ? 0 : 1,
    extraEntries: controlContract.presetEntries,
  });

  return {
    app: 'Lightweaver',
    format: 'wled-basic-package',
    version: WLED_BASIC_PACKAGE_VERSION,
    runtimeTier: WLED_BASIC_TIER_ID,
    exportedAt: new Date().toISOString(),
    effectIdSource: WLED_BASIC_EFFECT_ID_SOURCE,
    project: {
      name: projectName || 'Untitled Project',
      duration,
      ledCount: totalPixels(strips),
      stripCount: strips.length,
    },
    install: {
      applyViaJsonApi: 'POST /json/state with each preset state, then POST /json/state with {"psave":presetId,"n":"Preset name","ib":true,"sb":true} if applying interactively.',
      restorePresetsJson: 'Back up the current WLED presets first, then upload the generated presetsJson object as /presets.json from the WLED /edit page.',
      playlist: `Load preset ${resolvedPlaylistPresetId} to cycle the Basic WLED bank.`,
      physicalControls: controlContract.encoder?.enabled
        ? `Encoder rotation is handled by WLED firmware. Assign encoder press/button action to preset ${controlContract.encoder.press.helperPresetId} to step through Lightweaver looks.`
        : 'No physical encoder contract is enabled for this package.',
      cautions: [
        'Effect IDs are exported with names so an installer can re-resolve them if a different WLED build changes the effect order.',
        'Custom-effect ports require a Lightweaver WLED firmware build before those looks can run from flash.',
        'Encoder rotation requires a WLED rotary encoder usermod or Lightweaver WLED firmware; stock button settings only cover press actions.',
      ],
    },
    presetStart,
    playlistPresetId: resolvedPlaylistPresetId,
    presetDurationSeconds,
    transitionMs,
    presets,
    presetsJson,
    controlContract,
    customEffectPorts,
    unsupportedPatterns,
    compatibilityAudit,
    requestedCompatibilityAudit,
    gateSummary,
    warnings,
  };
}

export function makeWledBasicPresetsJson({
  presets = [],
  playlistName = 'Lightweaver Basic Cycle',
  playlistPresetId = null,
  presetDurationSeconds = WLED_BASIC_DEFAULT_PLAYLIST_SECONDS,
  transitionMs = WLED_BASIC_DEFAULT_TRANSITION_MS,
  repeat = 0,
  extraEntries = {},
} = {}) {
  const output = {};
  presets.forEach((preset) => {
    output[String(preset.presetId)] = {
      n: preset.name,
      ql: preset.quickLabel,
      ...preset.state,
    };
  });

  if (presets.length > 0) {
    const id = playlistPresetId || Math.max(...presets.map(preset => preset.presetId)) + 1;
    output[String(id)] = {
      n: playlistName,
      playlist: {
        ps: presets.map(preset => preset.presetId),
        dur: presets.map(() => secondsToTenths(presetDurationSeconds)),
        transition: presets.map(() => millisecondsToTenths(transitionMs)),
        repeat,
        end: presets[0].presetId,
      },
    };
  }

  Object.entries(extraEntries || {}).forEach(([id, entry]) => {
    output[String(id)] = entry;
  });

  return output;
}

export function makeWledBasicSegments(strips = [], { maxSegments = 16 } = {}) {
  const validStrips = strips.filter(strip => pixelCountForStrip(strip) > 0);
  if (validStrips.length === 0) {
    return [{ id: 0, n: 'All LEDs' }];
  }
  if (validStrips.length > maxSegments) {
    return [{ id: 0, start: 0, stop: totalPixels(validStrips), n: 'All LEDs' }];
  }

  let cursor = 0;
  return validStrips.map((strip, index) => {
    const count = pixelCountForStrip(strip);
    const segment = {
      id: index,
      start: cursor,
      stop: cursor + count,
      n: strip.name || titleFromId(strip.id || `segment-${index + 1}`),
    };
    cursor += count;
    return segment;
  });
}

function makeWledBasicPreset({
  pattern,
  stock,
  presetId,
  segments,
  palette,
  brightness,
  transitionMs,
}) {
  const colors = normalizeWledColors(palette);
  const stateSegments = segments.map(segment => ({
    ...segment,
    fx: stock.effectId,
    sx: stock.sx,
    ix: stock.ix,
    pal: stock.paletteId,
    col: colors,
    sel: true,
  }));
  return {
    presetId,
    patternId: pattern.id,
    name: `LW ${pattern.name || titleFromId(pattern.id)}`,
    quickLabel: makeQuickLabel(presetId),
    compatibility: 'stock-wled-preset',
    approximation: stock.effectName !== pattern.name,
    effectName: stock.effectName,
    effectId: stock.effectId,
    paletteName: stock.paletteName,
    paletteId: stock.paletteId,
    segments: stateSegments,
    state: {
      on: true,
      bri: clampByte(brightness),
      transition: millisecondsToTenths(transitionMs),
      mainseg: 0,
      seg: stateSegments,
    },
  };
}

function makeCustomEffectPort(pattern) {
  const name = pattern.name || titleFromId(pattern.id);
  return {
    patternId: pattern.id,
    name,
    expectedEffectName: `Lightweaver ${name}`,
    targets: inferPatternTargets(pattern),
    reason: 'This look is WLED Basic compatible only after being ported into a Lightweaver custom WLED effect.',
  };
}

function isWledBasicCompatible(pattern) {
  if (!pattern) return false;
  if (WLED_STOCK_LOOKS[pattern.id]) return true;
  const gate = getPatternCompatibilityGate(pattern);
  if (gate.gate === PATTERN_COMPATIBILITY_GATES.WLED_CUSTOM_PORT) return true;
  const targets = inferPatternTargets(pattern);
  return targets.includes(PATTERN_TARGETS.WLED_PRESET) || targets.includes(PATTERN_TARGETS.WLED_CUSTOM_EFFECT);
}

function stockPresetCount(patternIds = []) {
  return patternIds.filter(id => WLED_STOCK_LOOKS[id]).length;
}

function normalizeWledColors(palette = []) {
  const colors = Array.isArray(palette)
    ? palette.map(color => normalizeHexColor(color)).filter(Boolean)
    : [];
  while (colors.length < 3) {
    colors.push(['FFB15C', '080200', 'FFD7A0'][colors.length]);
  }
  return colors.slice(0, 3);
}

function normalizeHexColor(color) {
  const raw = String(color || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return raw.split('').map(ch => ch + ch).join('').toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
  return '';
}

function patternById(patterns, id) {
  const normalized = String(id || '').trim();
  return patterns.find(pattern => pattern.id === normalized);
}

function uniqueIds(ids = []) {
  const out = [];
  ids.forEach((id) => {
    const normalized = String(id || '').trim();
    if (normalized && !out.includes(normalized)) out.push(normalized);
  });
  return out;
}

function totalPixels(strips = []) {
  return strips.reduce((sum, strip) => sum + pixelCountForStrip(strip), 0);
}

function pixelCountForStrip(strip = {}) {
  return Math.max(0, Math.floor(Number(strip.pixels?.length || strip.pixelCount || strip.leds || 0)));
}

function makeQuickLabel(presetId) {
  return String(presetId).slice(-2);
}

function secondsToTenths(seconds) {
  return Math.max(1, Math.round(Number(seconds || 0) * 10));
}

function millisecondsToTenths(ms) {
  return Math.max(0, Math.round(Number(ms || 0) / 100));
}

function clampByte(value) {
  return Math.max(1, Math.min(255, Math.round(Number(value) || 128)));
}

function titleFromId(id) {
  return String(id || 'untitled')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}
