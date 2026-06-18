import { WLED_STOCK_LOOKS } from './wledStockLooks.js';
import { inferPatternTargets } from './runtimeTargets.js';

export const PATTERN_COMPATIBILITY_GATES = Object.freeze({
  WLED_STOCK: 'wled-stock',
  WLED_CUSTOM_PORT: 'wled-custom-port',
  AUDIO_SOURCE: 'audio-source',
  BEAT_SOURCE: 'beat-source',
  COMPUTER_RENDER: 'computer-render',
});

export const RUNTIME_CHANNELS = Object.freeze({
  WLED_BASIC: 'wled-basic',
  WLED_STOCK: 'wled-stock',
  WLED_CUSTOM: 'wled-custom',
  ARTNET: 'artnet',
  PI_LIVE: 'pi-live',
  COMPUTER_LIVE: 'computer-live',
  STANDALONE_SEQUENCE: 'standalone-sequence',
});

const HEAVY_RENDER_PATTERN_IDS = new Set([
  'mandelbrot',
  'tesseract',
  'voronoi',
  'pixel-sort',
  'prism-split',
  'mirror-tunnel',
  'wormhole',
  'black-hole',
  'julia',
  'game-of-life',
]);

const GATE_DETAILS = Object.freeze({
  [PATTERN_COMPATIBILITY_GATES.WLED_STOCK]: Object.freeze({
    label: 'WLED stock',
    chip: 'WLED',
    severity: 'ready',
    reason: 'Runs on the current WLED firmware as a stock effect/preset approximation.',
    allowedRuntimes: Object.freeze([
      RUNTIME_CHANNELS.WLED_BASIC,
      RUNTIME_CHANNELS.WLED_STOCK,
      RUNTIME_CHANNELS.ARTNET,
      RUNTIME_CHANNELS.PI_LIVE,
      RUNTIME_CHANNELS.COMPUTER_LIVE,
      RUNTIME_CHANNELS.STANDALONE_SEQUENCE,
    ]),
  }),
  [PATTERN_COMPATIBILITY_GATES.WLED_CUSTOM_PORT]: Object.freeze({
    label: 'WLED port',
    chip: 'PORT',
    severity: 'port',
    reason: 'Can become WLED Basic after a Lightweaver custom WLED effect port; until then it needs Lightweaver rendering or sequence export.',
    allowedRuntimes: Object.freeze([
      RUNTIME_CHANNELS.WLED_CUSTOM,
      RUNTIME_CHANNELS.ARTNET,
      RUNTIME_CHANNELS.PI_LIVE,
      RUNTIME_CHANNELS.COMPUTER_LIVE,
      RUNTIME_CHANNELS.STANDALONE_SEQUENCE,
    ]),
  }),
  [PATTERN_COMPATIBILITY_GATES.AUDIO_SOURCE]: Object.freeze({
    label: 'Audio source',
    chip: 'AUD',
    severity: 'runtime',
    reason: 'Depends on live audio bands, so it needs a computer or Pi/browser runtime feeding frames or Art-Net.',
    allowedRuntimes: Object.freeze([
      RUNTIME_CHANNELS.ARTNET,
      RUNTIME_CHANNELS.PI_LIVE,
      RUNTIME_CHANNELS.COMPUTER_LIVE,
    ]),
  }),
  [PATTERN_COMPATIBILITY_GATES.BEAT_SOURCE]: Object.freeze({
    label: 'Beat source',
    chip: 'BPM',
    severity: 'runtime',
    reason: 'Depends on Lightweaver beat/timeline timing, so WLED Basic needs an approximation; exact playback needs live rendering, Art-Net, or sequence export.',
    allowedRuntimes: Object.freeze([
      RUNTIME_CHANNELS.ARTNET,
      RUNTIME_CHANNELS.PI_LIVE,
      RUNTIME_CHANNELS.COMPUTER_LIVE,
      RUNTIME_CHANNELS.STANDALONE_SEQUENCE,
    ]),
  }),
  [PATTERN_COMPATIBILITY_GATES.COMPUTER_RENDER]: Object.freeze({
    label: 'Render only',
    chip: 'CPU',
    severity: 'advanced',
    reason: 'Too layout/math-specific for a first WLED Basic port; gate it to Lightweaver rendering, Art-Net, or pre-rendered sequence.',
    allowedRuntimes: Object.freeze([
      RUNTIME_CHANNELS.ARTNET,
      RUNTIME_CHANNELS.PI_LIVE,
      RUNTIME_CHANNELS.COMPUTER_LIVE,
      RUNTIME_CHANNELS.STANDALONE_SEQUENCE,
    ]),
  }),
});

export function getPatternCompatibilityGate(pattern = {}) {
  const id = String(pattern.id || '').trim();
  const code = String(pattern.code || '');
  const features = detectPatternFeatures(pattern);
  const hasStockWled = Boolean(WLED_STOCK_LOOKS[id]);
  let gate;

  if (features.audioDriven) {
    gate = PATTERN_COMPATIBILITY_GATES.AUDIO_SOURCE;
  } else if (features.beatDriven) {
    gate = PATTERN_COMPATIBILITY_GATES.BEAT_SOURCE;
  } else if (hasStockWled) {
    gate = PATTERN_COMPATIBILITY_GATES.WLED_STOCK;
  } else if (features.heavyRender) {
    gate = PATTERN_COMPATIBILITY_GATES.COMPUTER_RENDER;
  } else {
    gate = PATTERN_COMPATIBILITY_GATES.WLED_CUSTOM_PORT;
  }

  const details = GATE_DETAILS[gate];
  return {
    patternId: id,
    name: pattern.name || titleFromId(id),
    gate,
    label: details.label,
    chip: details.chip,
    severity: details.severity,
    reason: details.reason,
    allowedRuntimes: [...details.allowedRuntimes],
    targets: inferPatternTargets(pattern),
    features: {
      ...features,
      stockWledEffect: hasStockWled ? WLED_STOCK_LOOKS[id].effectName : '',
      codeLength: code.length,
    },
  };
}

export function auditPatternCompatibility(patterns = []) {
  return patterns.map(pattern => getPatternCompatibilityGate(pattern));
}

export function summarizePatternCompatibility(audit = []) {
  const gates = {};
  const runtimes = {};
  for (const item of audit) {
    gates[item.gate] = (gates[item.gate] || 0) + 1;
    for (const runtime of item.allowedRuntimes || []) {
      runtimes[runtime] = (runtimes[runtime] || 0) + 1;
    }
  }
  return { total: audit.length, gates, runtimes };
}

export function detectPatternFeatures(pattern = {}) {
  const id = String(pattern.id || '').trim();
  const code = String(pattern.code || '');
  const audioDriven = /\b(bass|mid|hi|treble|audio)\b/i.test(code);
  const beatDriven = /\bbeat\b/.test(code);
  const xyDriven = /\b[xy]\b/.test(code);
  const polarDriven = /\bpolar\s*\(/.test(code);
  const noiseDriven = /\b(noise|fbm)\s*\(/.test(code);
  const randomDriven = /\brandomF\s*\(/.test(code);
  const params = [...code.matchAll(/\/\/ @param\s+(\w+)/g)].map(match => match[1]);
  const heavyRender = HEAVY_RENDER_PATTERN_IDS.has(id) ||
    /\b(iter|mandelbrot|voronoi|cellular|sort|ray|trace)\b/i.test(code) ||
    params.some(param => ['iter', 'iterations', 'cells', 'facets', 'streak'].includes(param));

  return {
    audioDriven,
    beatDriven,
    xyDriven,
    polarDriven,
    noiseDriven,
    randomDriven,
    heavyRender,
    params,
  };
}

function titleFromId(id) {
  return String(id || 'untitled')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}
