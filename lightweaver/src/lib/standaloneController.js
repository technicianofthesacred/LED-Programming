import { normalizeCardLedType } from './cardHardwareContract.js';

export const LWSEQ_HEADER_BYTES = 64;

export const DEFAULT_STANDALONE_OUTPUTS = [
  { id: 'out1', name: 'Output 1', pin: 16, pixels: 0 },
  { id: 'out2', name: 'Output 2', pin: 17, pixels: 0 },
  { id: 'out3', name: 'Output 3', pin: 18, pixels: 0 },
  { id: 'out4', name: 'Output 4', pin: 21, pixels: 0 },
];

export const DEFAULT_STANDALONE_CONTROLS = {
  encoder: { a: 4, b: 5, press: 0, alternatePress: 6, brightnessStep: 18 },
  previous: 7,
  next: 8,
  blackout: 9,
  brightness: -1,
  statusLed: 2,
};

export const DEFAULT_STANDALONE_LED = {
  type: 'WS2815',
  colorOrder: 'RGB',
  brightnessLimit: 0.45,
  outputGammaEnabled: false,
  outputGammaValue: 2.2,
  calibration: { red: 1, green: 1, blue: 1 },
};

export const STANDALONE_RUNTIME_MODES = ['sequence', 'procedural', 'preset'];

export const DEFAULT_STANDALONE_RUNTIME_MODE = 'sequence';

export function normalizeStandaloneLed(led = {}) {
  const source = led && typeof led === 'object' ? led : {};
  const calibration = source.calibration && typeof source.calibration === 'object'
    ? source.calibration
    : {};
  return {
    ...DEFAULT_STANDALONE_LED,
    ...source,
    type: normalizeCardLedType(source.type, DEFAULT_STANDALONE_LED.type),
    brightnessLimit: clamp01(source.brightnessLimit ?? DEFAULT_STANDALONE_LED.brightnessLimit),
    outputGammaEnabled: source.outputGammaEnabled === true,
    outputGammaValue: clampOutputNumber(source.outputGammaValue, DEFAULT_STANDALONE_LED.outputGammaValue, 1, 3),
    calibration: {
      red: clampOutputNumber(calibration.red, DEFAULT_STANDALONE_LED.calibration.red, 0, 1),
      green: clampOutputNumber(calibration.green, DEFAULT_STANDALONE_LED.calibration.green, 0, 1),
      blue: clampOutputNumber(calibration.blue, DEFAULT_STANDALONE_LED.calibration.blue, 0, 1),
    },
  };
}

export function normalizeStandaloneOutputs(outputs = DEFAULT_STANDALONE_OUTPUTS) {
  return outputs
    .slice(0, 4)
    .map((output, index) => {
      const id = sanitizeId(output.id || `out${index + 1}`);
      const pixels = Math.max(0, Math.floor(Number(output.pixels || output.pixelCount || 0)));
      const pin = Number.isFinite(Number(output.pin)) ? Number(output.pin) : null;
      return {
        id,
        name: output.name || titleFromId(id) || `Output ${index + 1}`,
        pin,
        pixels,
      };
    })
    .filter(output => output.pin != null && output.pixels > 0);
}

export function buildStandaloneProfile({
  projectName = 'Untitled Project',
  runtimeMode = DEFAULT_STANDALONE_RUNTIME_MODE,
  outputs = DEFAULT_STANDALONE_OUTPUTS,
  controls = DEFAULT_STANDALONE_CONTROLS,
  looks = [],
  led = {},
  cardId = '',
} = {}) {
  const mode = normalizeRuntimeMode(runtimeMode);
  const normalizedOutputs = normalizeStandaloneOutputs(outputs);
  const normalizedLooks = looks.length
    ? looks.map((look, index) => normalizeLook(look, index))
    : [defaultLookForMode(mode)];

  return {
    version: 1,
    cardId: String(cardId || '').trim().toLowerCase(),
    runtimeMode: mode,
    piece: {
      id: sanitizeId(projectName),
      name: projectName || 'Untitled Project',
    },
    led: normalizeStandaloneLed(led),
    outputs: normalizedOutputs,
    controls: normalizeControls(controls),
    looks: normalizedLooks,
    startupLook: normalizedLooks[0]?.id || '',
  };
}

export function estimateLwseqBytes({ pixels = 0, fps = 24, duration = 0, frames = null } = {}) {
  const frameCount = frames == null
    ? Math.max(0, Math.round(Number(duration || 0) * Number(fps || 0)))
    : Math.max(0, Number(frames) || 0);
  const payloadBytes = Math.max(0, Number(pixels) || 0) * 3 * frameCount;
  return {
    headerBytes: LWSEQ_HEADER_BYTES,
    payloadBytes,
    totalBytes: LWSEQ_HEADER_BYTES + payloadBytes,
  };
}

export function toLwseqBytes(frames = [], { fps = 24, outputs = DEFAULT_STANDALONE_OUTPUTS } = {}) {
  const normalizedOutputs = normalizeStandaloneOutputs(outputs);
  const expectedPixels = normalizedOutputs.reduce((sum, output) => sum + output.pixels, 0) || (frames[0]?.length || 0);
  const frameCount = frames.length;
  const payloadBytes = expectedPixels * 3 * frameCount;
  const bytes = new Uint8Array(LWSEQ_HEADER_BYTES + payloadBytes);

  bytes.set([76, 87, 83, 69, 81, 49], 0); // LWSEQ1
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1, true);
  view.setUint16(10, normalizedOutputs.length || 1, true);
  view.setUint32(12, expectedPixels, true);
  view.setUint32(16, frameCount, true);
  view.setUint16(20, Math.round(Number(fps) || 24), true);
  view.setUint16(22, 3, true);

  let cursor = LWSEQ_HEADER_BYTES;
  for (const frame of frames) {
    if (frame.length !== expectedPixels) {
      throw new RangeError(`Frame has ${frame.length} pixels, expected ${expectedPixels}`);
    }
    for (const pixel of frame) {
      bytes[cursor++] = clampByte(pixel.r);
      bytes[cursor++] = clampByte(pixel.g);
      bytes[cursor++] = clampByte(pixel.b);
    }
  }
  return bytes;
}

export function makeStandalonePackage({
  projectName = 'Untitled Project',
  runtimeMode = DEFAULT_STANDALONE_RUNTIME_MODE,
  outputs = DEFAULT_STANDALONE_OUTPUTS,
  controls = DEFAULT_STANDALONE_CONTROLS,
  sequenceFilename = '001-timeline-render.lwseq',
  frames = [],
  fps = 24,
  loop = true,
  led = {},
  proceduralPreset = 'aurora',
  preset = 'warm-white',
  cardId = '',
} = {}) {
  const mode = normalizeRuntimeMode(runtimeMode);
  const cleanFilename = sequenceFilename.replace(/^\/+/, '');
  const filePath = `/sequences/${cleanFilename}`;
  const looks = mode === 'sequence'
    ? [{
        id: cleanFilename.replace(/\.[^.]+$/, ''),
        label: projectName,
        mode: 'sequence',
        file: filePath,
        fps,
        loop,
      }]
    : mode === 'procedural'
      ? [{ id: proceduralPreset, label: titleFromId(proceduralPreset), mode: 'procedural', preset: proceduralPreset, loop }]
      : [{ id: preset, label: titleFromId(preset), mode: 'preset', preset, loop }];
  const sequence = mode === 'sequence' ? toLwseqBytes(frames, { fps, outputs }) : null;
  const sequenceSha256 = sequence ? sha256Hex(sequence) : '';
  if (mode === 'sequence') {
    looks[0].bytes = sequence.byteLength;
    looks[0].sha256 = sequenceSha256;
  }
  const profile = buildStandaloneProfile({
    projectName,
    runtimeMode: mode,
    outputs,
    controls,
    led,
    looks,
    cardId,
  });
  if (mode === 'sequence') {
    profile.runtimeMode = 'sd-sequence';
  }
  const files = { '/lightweaver.json': profile };
  if (mode === 'sequence') {
    files[filePath] = {
      encoding: 'base64',
      bytes: sequence.byteLength,
      sha256: sequenceSha256,
      data: uint8ToBase64(sequence),
    };
  }
  return {
    app: 'Lightweaver',
    format: 'standalone-controller-package',
    version: 1,
    files,
  };
}

export function makeStandaloneSequenceFilename(projectName = 'timeline-render') {
  return `001-${sanitizeId(projectName)}.lwseq`;
}

export function totalStandalonePixels(outputs = []) {
  return normalizeStandaloneOutputs(outputs).reduce((sum, output) => sum + output.pixels, 0);
}

export function deriveStandaloneOutputsFromStrips(strips = [], configuredOutputs = DEFAULT_STANDALONE_OUTPUTS) {
  const configuredWithPixels = normalizeStandaloneOutputs(configuredOutputs);
  if (configuredWithPixels.length > 0) return configuredWithPixels;

  const stripRuns = strips
    .map(strip => ({
      id: sanitizeId(strip.id || strip.name || 'strip'),
      name: strip.name || titleFromId(strip.id || 'strip'),
      pixels: Math.max(0, Math.floor(Number(strip.pixels?.length || strip.pixelCount || 0))),
    }))
    .filter(strip => strip.pixels > 0);

  if (stripRuns.length <= 4) {
    return stripRuns.map((strip, index) => {
      const configured = configuredOutputs[index] || DEFAULT_STANDALONE_OUTPUTS[index] || {};
      return {
        id: strip.id || sanitizeId(configured.id || `out${index + 1}`),
        name: strip.name || configured.name || `Output ${index + 1}`,
        pin: Number.isFinite(Number(configured.pin)) ? Number(configured.pin) : DEFAULT_STANDALONE_OUTPUTS[index]?.pin,
        pixels: strip.pixels,
      };
    }).filter(output => output.pin != null && output.pixels > 0);
  }

  const grouped = [];
  let cursor = 0;
  for (let outputIndex = 0; outputIndex < 4 && cursor < stripRuns.length; outputIndex++) {
    const remainingStrips = stripRuns.length - cursor;
    const remainingOutputs = 4 - outputIndex;
    const chunkSize = Math.ceil(remainingStrips / remainingOutputs);
    const chunk = stripRuns.slice(cursor, cursor + chunkSize);
    cursor += chunkSize;
    const configured = configuredOutputs[outputIndex] || DEFAULT_STANDALONE_OUTPUTS[outputIndex] || {};
    grouped.push({
      id: sanitizeId(configured.id || `out${outputIndex + 1}`),
      name: configured.name || `Output ${outputIndex + 1}`,
      pin: Number.isFinite(Number(configured.pin)) ? Number(configured.pin) : DEFAULT_STANDALONE_OUTPUTS[outputIndex]?.pin,
      pixels: chunk.reduce((sum, strip) => sum + strip.pixels, 0),
    });
  }
  return grouped.filter(output => output.pin != null && output.pixels > 0);
}

function normalizeControls(controls = {}) {
  return {
    encoder: { ...DEFAULT_STANDALONE_CONTROLS.encoder, ...(controls.encoder || {}) },
    previous: controls.previous ?? DEFAULT_STANDALONE_CONTROLS.previous,
    next: controls.next ?? DEFAULT_STANDALONE_CONTROLS.next,
    blackout: controls.blackout ?? DEFAULT_STANDALONE_CONTROLS.blackout,
    brightness: controls.brightness ?? DEFAULT_STANDALONE_CONTROLS.brightness,
    statusLed: controls.statusLed ?? DEFAULT_STANDALONE_CONTROLS.statusLed,
  };
}

function normalizeLook(look = {}, index = 0) {
  const id = sanitizeId(look.id || look.label || `look-${index + 1}`);
  const mode = normalizeRuntimeMode(look.mode || DEFAULT_STANDALONE_RUNTIME_MODE);
  const normalized = {
    id,
    label: look.label || titleFromId(id),
    mode,
    file: look.file || `/sequences/${String(index + 1).padStart(3, '0')}-${id}.lwseq`,
    fps: Math.round(Number(look.fps || 24)),
    loop: look.loop ?? true,
    fadeOutMs: Math.max(0, Math.round(Number(look.fadeOutMs ?? 800))),
    fadeInMs: Math.max(0, Math.round(Number(look.fadeInMs ?? 1200))),
    brightness: clamp01(look.brightness ?? 0.35),
  };
  if (mode === 'sequence') {
    normalized.bytes = Math.max(0, Math.floor(Number(look.bytes || 0)));
    normalized.sha256 = String(look.sha256 || '');
  }
  if (mode !== 'sequence') {
    delete normalized.file;
    normalized.preset = look.preset || id;
  }
  return normalized;
}

function defaultLookForMode(mode) {
  if (mode === 'procedural') {
    return normalizeLook({ id: 'aurora', label: 'Aurora', mode: 'procedural', preset: 'aurora' }, 0);
  }
  if (mode === 'preset') {
    return normalizeLook({ id: 'warm-white', label: 'Warm White', mode: 'preset', preset: 'warm-white' }, 0);
  }
  return normalizeLook({ id: 'timeline-render', label: 'Timeline Render', mode: 'sequence', file: '/sequences/001-timeline-render.lwseq' }, 0);
}

function normalizeRuntimeMode(mode) {
  return STANDALONE_RUNTIME_MODES.includes(mode) ? mode : DEFAULT_STANDALONE_RUNTIME_MODE;
}

function sanitizeId(value) {
  return String(value || 'untitled')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

function titleFromId(id) {
  return String(id || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clampOutputNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function clampByte(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function uint8ToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Small synchronous SHA-256 implementation. Exports must remain synchronous
// for the download flow, while the browser Web Crypto API is promise-only.
function sha256Hex(bytes) {
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, bytes.length * 8, false);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const view = new DataView(padded.buffer);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const work = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, false));
    for (let index = 16; index < 64; index++) { const a = work[index - 15]; const b = work[index - 2]; work[index] = (((a >>> 7 | a << 25) ^ (a >>> 18 | a << 14) ^ a >>> 3) + work[index - 7] + ((b >>> 17 | b << 15) ^ (b >>> 19 | b << 13) ^ b >>> 10) + work[index - 16]) | 0; }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index++) { const s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7); const choice = (e & f) ^ (~e & g); const t1 = (h + s1 + choice + constants[index] + work[index]) | 0; const s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10); const majority = (a & b) ^ (a & c) ^ (b & c); h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+s0+majority)|0; }
    hash[0]=(hash[0]+a)|0; hash[1]=(hash[1]+b)|0; hash[2]=(hash[2]+c)|0; hash[3]=(hash[3]+d)|0; hash[4]=(hash[4]+e)|0; hash[5]=(hash[5]+f)|0; hash[6]=(hash[6]+g)|0; hash[7]=(hash[7]+h)|0;
  }
  return hash.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
}
