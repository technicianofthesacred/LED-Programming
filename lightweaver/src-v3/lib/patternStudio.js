import {
  PATTERN_COMPATIBILITY_GATES,
  detectPatternFeatures,
  getPatternCompatibilityGate,
} from './patternCompatibility.js';

export const PATTERN_STUDIO_INSTALLABILITY = Object.freeze({
  READY: 'ready',
  PORT_REQUIRED: 'port-required',
  RUNTIME_ONLY: 'runtime-only',
  ADVANCED_ONLY: 'advanced-only',
});

export function makePatternStudioSummary(pattern = {}, {
  params = {},
  palette = [],
  targetRuntime = 'wled-basic',
} = {}) {
  const compatibility = getPatternCompatibilityGate(pattern);
  const controls = summarizeControls(pattern, params, palette);
  const installability = classifyInstallability(compatibility, targetRuntime);
  const qualityScore = scorePatternStudioReadiness(compatibility, controls);
  const portability = summarizePortability(compatibility);

  return {
    patternId: pattern.id || '',
    name: pattern.name || titleFromId(pattern.id),
    targetRuntime,
    compatibility,
    controls,
    installability,
    qualityScore,
    qualityGrade: gradeScore(qualityScore),
    portability,
    nextActions: makeNextActions(installability, compatibility, controls),
  };
}

export function summarizeControls(pattern = {}, params = {}, palette = []) {
  const code = String(pattern.code || '');
  const declaredParams = parsePatternParams(code);
  const paramNames = new Set([
    ...declaredParams.map(param => param.name),
    ...Object.keys(params || {}),
  ]);
  const features = detectPatternFeatures(pattern);
  const usesPalette = /\bsamplePalette\s*\(|\bpalette\b/.test(code);
  const paletteColors = Array.isArray(palette) ? palette.filter(Boolean).length : 0;

  return {
    paramCount: paramNames.size,
    declaredParams,
    tunedParamCount: Object.keys(params || {}).length,
    usesPalette,
    paletteColors,
    features,
    authoringSurface: pickAuthoringSurface(features),
  };
}

export function scorePatternStudioReadiness(compatibility, controls) {
  let score = 100;
  if (compatibility.gate === PATTERN_COMPATIBILITY_GATES.WLED_CUSTOM_PORT) score -= 14;
  if (compatibility.gate === PATTERN_COMPATIBILITY_GATES.BEAT_SOURCE) score -= 28;
  if (compatibility.gate === PATTERN_COMPATIBILITY_GATES.AUDIO_SOURCE) score -= 38;
  if (compatibility.gate === PATTERN_COMPATIBILITY_GATES.COMPUTER_RENDER) score -= 34;
  if (controls.features.heavyRender) score -= 12;
  if (controls.features.randomDriven) score -= 4;
  if (controls.paramCount === 0) score -= 8;
  if (controls.usesPalette && controls.paletteColors < 3) score -= 6;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function classifyInstallability(compatibility, targetRuntime) {
  if (targetRuntime !== 'wled-basic') {
    return compatibility.gate === PATTERN_COMPATIBILITY_GATES.AUDIO_SOURCE
      ? PATTERN_STUDIO_INSTALLABILITY.RUNTIME_ONLY
      : PATTERN_STUDIO_INSTALLABILITY.READY;
  }
  if (compatibility.gate === PATTERN_COMPATIBILITY_GATES.WLED_STOCK) {
    return PATTERN_STUDIO_INSTALLABILITY.READY;
  }
  if (compatibility.gate === PATTERN_COMPATIBILITY_GATES.WLED_CUSTOM_PORT) {
    return PATTERN_STUDIO_INSTALLABILITY.PORT_REQUIRED;
  }
  if (
    compatibility.gate === PATTERN_COMPATIBILITY_GATES.AUDIO_SOURCE ||
    compatibility.gate === PATTERN_COMPATIBILITY_GATES.BEAT_SOURCE
  ) {
    return PATTERN_STUDIO_INSTALLABILITY.RUNTIME_ONLY;
  }
  return PATTERN_STUDIO_INSTALLABILITY.ADVANCED_ONLY;
}

function summarizePortability(compatibility) {
  const channels = compatibility.allowedRuntimes || [];
  return {
    wledBasic: channels.includes('wled-basic'),
    wledCustom: channels.includes('wled-custom'),
    artnet: channels.includes('artnet'),
    piLive: channels.includes('pi-live'),
    computerLive: channels.includes('computer-live'),
    standaloneSequence: channels.includes('standalone-sequence'),
  };
}

function makeNextActions(installability, compatibility, controls) {
  if (installability === PATTERN_STUDIO_INSTALLABILITY.READY) {
    const actions = [{
      id: 'save-wled-preset',
      label: 'Save as WLED preset',
      detail: 'This look can be included in the Basic WLED package now.',
    }];
    if (controls.usesPalette) {
      actions.push({
        id: 'lock-palette',
        label: 'Lock palette',
        detail: 'Keep three export colors with the look so WLED and preview match.',
      });
    }
    return actions;
  }
  if (installability === PATTERN_STUDIO_INSTALLABILITY.PORT_REQUIRED) {
    return [{
      id: 'port-custom-effect',
      label: 'Port to WLED effect',
      detail: 'Add this look to the Lightweaver custom WLED effect backlog.',
    }, {
      id: 'sequence-fallback',
      label: 'Allow sequence fallback',
      detail: 'Use Art-Net or standalone sequence when exact browser behavior matters.',
    }];
  }
  if (installability === PATTERN_STUDIO_INSTALLABILITY.RUNTIME_ONLY) {
    return [{
      id: 'gate-advanced',
      label: 'Gate to Advanced runtime',
      detail: compatibility.reason,
    }, {
      id: 'make-static-variant',
      label: 'Create non-live variant',
      detail: 'Design a stored approximation that does not need audio or beat input.',
    }];
  }
  return [{
    id: 'gate-renderer',
    label: 'Keep on renderer path',
    detail: 'Use computer/Pi live frames, Art-Net, or pre-rendered sequence export.',
  }];
}

function parsePatternParams(code) {
  const params = [];
  const re = /\/\/ @param\s+(\w+)\s+\w+\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;
  let match;
  while ((match = re.exec(String(code || ''))) !== null) {
    params.push({
      name: match[1],
      value: Number(match[2]),
      min: Number(match[3]),
      max: Number(match[4]),
    });
  }
  return params;
}

function pickAuthoringSurface(features) {
  if (features.audioDriven) return 'audio-reactive';
  if (features.beatDriven) return 'timeline-beat';
  if (features.heavyRender) return 'renderer';
  if (features.xyDriven || features.polarDriven) return 'spatial';
  return 'ambient';
}

function gradeScore(score) {
  if (score >= 86) return 'A';
  if (score >= 72) return 'B';
  if (score >= 58) return 'C';
  return 'D';
}

function titleFromId(id) {
  return String(id || 'Untitled')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}
