export const LWSEQ_HEADER_BYTES = 64;

export const DEFAULT_STANDALONE_OUTPUTS = [
  { id: 'out1', name: 'Output 1', pin: 16, pixels: 0 },
  { id: 'out2', name: 'Output 2', pin: 17, pixels: 0 },
  { id: 'out3', name: 'Output 3', pin: 18, pixels: 0 },
  { id: 'out4', name: 'Output 4', pin: 21, pixels: 0 },
];

export const DEFAULT_STANDALONE_CONTROLS = {
  encoder: { a: 4, b: 5, press: 0, alternatePress: 6 },
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
};

export const STANDALONE_RUNTIME_MODES = ['sequence', 'procedural', 'preset'];

export const DEFAULT_STANDALONE_RUNTIME_MODE = 'sequence';

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
} = {}) {
  const mode = normalizeRuntimeMode(runtimeMode);
  const normalizedOutputs = normalizeStandaloneOutputs(outputs);
  const normalizedLooks = looks.length
    ? looks.map((look, index) => normalizeLook(look, index))
    : [defaultLookForMode(mode)];

  return {
    version: 1,
    runtimeMode: mode,
    piece: {
      id: sanitizeId(projectName),
      name: projectName || 'Untitled Project',
    },
    led: {
      ...DEFAULT_STANDALONE_LED,
      ...led,
      brightnessLimit: clamp01(led.brightnessLimit ?? DEFAULT_STANDALONE_LED.brightnessLimit),
    },
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
  const profile = buildStandaloneProfile({
    projectName,
    runtimeMode: mode,
    outputs,
    controls,
    led,
    looks,
  });
  if (mode === 'sequence') {
    profile.runtimeMode = 'sd-sequence';
  }
  const files = { '/lightweaver.json': profile };
  if (mode === 'sequence') {
    const sequence = toLwseqBytes(frames, { fps, outputs });
    files[filePath] = {
      encoding: 'base64',
      bytes: sequence.byteLength,
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
