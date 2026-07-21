export const PATTERN_LAB_WORKER_REQUEST_TYPES = Object.freeze([
  'initialize',
  'render',
  'cancel',
  'dispose',
]);

export const PATTERN_LAB_WORKER_REPLY_TYPES = Object.freeze([
  'ready',
  'frame',
  'warning',
  'error',
  'stats',
]);

export const PATTERN_LAB_WORKER_BUDGETS = Object.freeze({
  maxLayers: 3,
  previewSamples: 384,
  finalSamples: 1024,
  previewFps: 24,
  maxFrameBytes: 1024 * 3,
  maxSourcePixels: 16384,
  maxGeometryBytes: 512 * 1024,
  maxGeometryMetadataBytes: 64 * 1024,
  maxAllocationBytes: 4 * 1024 * 1024,
  renderWarningMs: 40,
  exportWarningMs: 250,
});

const RENDER_MODES = Object.freeze(['preview', 'final', 'export']);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function copyBoundedJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new RangeError('Pattern Lab worker geometry metadata must be serializable');
  }
}

function geometryMetadataBytes(geometry) {
  const metadata = {
    version: geometry.version,
    sourcePixelCount: geometry.sourcePixelCount,
    visiblePixelCount: geometry.visiblePixelCount,
    normalizationBounds: geometry.normalizationBounds,
    strips: geometry.strips,
    bpm: geometry.bpm,
    gammaEnabled: geometry.gammaEnabled,
    gammaValue: geometry.gammaValue,
    symSettings: geometry.symSettings,
    audioBands: geometry.audioBands,
  };
  return new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
}

export function validatePatternLabWorkerGeometry(geometry) {
  if (!geometry || geometry.version !== 1) {
    throw new RangeError('Pattern Lab worker geometry version must be 1');
  }
  const sourcePixelCount = Number(geometry.sourcePixelCount);
  const visiblePixelCount = Number(geometry.visiblePixelCount);
  if (!Number.isSafeInteger(sourcePixelCount) || sourcePixelCount < 1
    || sourcePixelCount > PATTERN_LAB_WORKER_BUDGETS.maxSourcePixels) {
    throw new RangeError(`Pattern Lab worker geometry supports at most ${PATTERN_LAB_WORKER_BUDGETS.maxSourcePixels} source pixels`);
  }
  if (!Number.isSafeInteger(visiblePixelCount) || visiblePixelCount < 1 || visiblePixelCount > sourcePixelCount) {
    throw new RangeError('Pattern Lab worker geometry visible pixel count is invalid');
  }
  if (!(geometry.coordinates instanceof Float64Array)
    || geometry.coordinates.length !== visiblePixelCount * 2) {
    throw new RangeError('Pattern Lab worker geometry coordinates must be a bounded Float64Array');
  }
  if (!(geometry.progress instanceof Float64Array)
    || geometry.progress.length !== visiblePixelCount) {
    throw new RangeError('Pattern Lab worker geometry progress must be a bounded Float64Array');
  }
  for (const coordinate of geometry.coordinates) {
    if (!Number.isFinite(coordinate)) {
      throw new RangeError('Pattern Lab worker geometry coordinates must be finite');
    }
  }
  for (const value of geometry.progress) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError('Pattern Lab worker geometry progress must stay between zero and one');
    }
  }
  const bounds = geometry.normalizationBounds;
  if (!bounds || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)
    || !Number.isFinite(bounds.range) || bounds.range <= 0) {
    throw new RangeError('Pattern Lab worker geometry normalization bounds are invalid');
  }
  if (!Array.isArray(geometry.strips) || geometry.strips.length < 1) {
    throw new RangeError('Pattern Lab worker geometry requires visible strip metadata');
  }
  let offset = 0;
  for (const strip of geometry.strips) {
    if (!strip || typeof strip.id !== 'string' || strip.id.length < 1
      || strip.start !== offset || !Number.isSafeInteger(strip.count) || strip.count < 1
      || !Number.isFinite(strip.speed) || !Number.isFinite(strip.brightness)
      || !Number.isFinite(strip.hueShift)) {
      throw new RangeError('Pattern Lab worker geometry strip metadata is invalid');
    }
    offset += strip.count;
  }
  if (offset !== visiblePixelCount) {
    throw new RangeError('Pattern Lab worker geometry strip counts do not match visible pixels');
  }
  const typedBytes = geometry.coordinates.byteLength + geometry.progress.byteLength;
  const metadataBytes = geometryMetadataBytes(geometry);
  if (metadataBytes > PATTERN_LAB_WORKER_BUDGETS.maxGeometryMetadataBytes) {
    throw new RangeError(`Pattern Lab worker geometry metadata exceeds ${PATTERN_LAB_WORKER_BUDGETS.maxGeometryMetadataBytes} bytes`);
  }
  if (typedBytes + metadataBytes > PATTERN_LAB_WORKER_BUDGETS.maxGeometryBytes) {
    throw new RangeError(`Pattern Lab worker geometry exceeds ${PATTERN_LAB_WORKER_BUDGETS.maxGeometryBytes} bytes`);
  }
  if (geometry.geometryBytes != null && geometry.geometryBytes !== typedBytes + metadataBytes) {
    throw new RangeError('Pattern Lab worker geometry byte accounting is invalid');
  }
  return geometry;
}

export function compactPatternLabWorkerGeometry(input = {}) {
  const strips = Array.isArray(input.strips) ? input.strips : [];
  const hidden = input.hidden && typeof input.hidden === 'object' ? input.hidden : {};
  let sourcePixelCount = 0;
  let visiblePixelCount = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const visibleStrips = [];

  for (const strip of strips) {
    if (!strip) continue;
    const pixels = Array.isArray(strip.pixels) ? strip.pixels : [];
    sourcePixelCount += pixels.length;
    if (sourcePixelCount > PATTERN_LAB_WORKER_BUDGETS.maxSourcePixels) {
      throw new RangeError(`Pattern Lab worker geometry supports at most ${PATTERN_LAB_WORKER_BUDGETS.maxSourcePixels} source pixels`);
    }
    for (const pixel of pixels) {
      const x = finiteNumber(pixel?.x);
      const y = finiteNumber(pixel?.y);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    if (hidden[strip.id] || pixels.length === 0) continue;
    visibleStrips.push({ strip, pixels, start: visiblePixelCount });
    visiblePixelCount += pixels.length;
  }

  if (sourcePixelCount < 1 || visiblePixelCount < 1) {
    throw new RangeError('Pattern Lab worker geometry requires at least one visible source pixel');
  }
  const coordinates = new Float64Array(visiblePixelCount * 2);
  const progress = new Float64Array(visiblePixelCount);
  const compactStrips = [];
  let cursor = 0;
  for (const { strip, pixels, start } of visibleStrips) {
    compactStrips.push({
      id: String(strip.id || `strip-${compactStrips.length + 1}`),
      start,
      count: pixels.length,
      speed: finiteNumber(strip.speed, 1),
      brightness: finiteNumber(strip.brightness, 1),
      hueShift: finiteNumber(strip.hueShift, 0),
    });
    pixels.forEach((pixel, pixelIndex) => {
      coordinates[cursor * 2] = finiteNumber(pixel?.x);
      coordinates[cursor * 2 + 1] = finiteNumber(pixel?.y);
      progress[cursor] = pixels.length > 1 ? pixelIndex / (pixels.length - 1) : 0.5;
      cursor += 1;
    });
  }
  const geometry = {
    version: 1,
    sourcePixelCount,
    visiblePixelCount,
    normalizationBounds: {
      minX: Number.isFinite(minX) ? minX : 0,
      minY: Number.isFinite(minY) ? minY : 0,
      range: Number.isFinite(minX)
        ? Math.max(maxX - minX, maxY - minY, 0.001)
        : 1,
    },
    strips: compactStrips,
    coordinates,
    progress,
    bpm: finiteNumber(input.bpm, 120),
    gammaEnabled: Boolean(input.gammaEnabled),
    gammaValue: finiteNumber(input.gammaValue, 2.2),
    symSettings: copyBoundedJson(input.symSettings, null),
    audioBands: copyBoundedJson(input.audioBands, null),
  };
  geometry.geometryBytes = geometry.coordinates.byteLength
    + geometry.progress.byteLength
    + geometryMetadataBytes(geometry);
  return validatePatternLabWorkerGeometry(geometry);
}

export function clonePatternLabWorkerGeometryForTransfer(cachedGeometry) {
  validatePatternLabWorkerGeometry(cachedGeometry);
  const geometry = {
    ...cachedGeometry,
    strips: cachedGeometry.strips.map(strip => ({ ...strip })),
    normalizationBounds: { ...cachedGeometry.normalizationBounds },
    coordinates: new Float64Array(cachedGeometry.coordinates),
    progress: new Float64Array(cachedGeometry.progress),
  };
  return {
    geometry,
    transfer: [geometry.coordinates.buffer, geometry.progress.buffer],
  };
}

function positiveRequestId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function requestType(type) {
  if (!PATTERN_LAB_WORKER_REQUEST_TYPES.includes(type)) {
    throw new RangeError(`Unsupported Pattern Lab worker request: ${String(type)}`);
  }
  return type;
}

export function createPatternLabWorkerRequestSequencer(start = 0) {
  if (!Number.isSafeInteger(start) || start < 0 || start >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Pattern Lab worker request sequence requires a safe non-negative start');
  }
  let current = start;
  return Object.freeze({
    next(type, payload = {}) {
      requestType(type);
      if (current >= Number.MAX_SAFE_INTEGER) throw new RangeError('Pattern Lab worker request sequence exhausted');
      current += 1;
      return { type, requestId: current, payload: payload && typeof payload === 'object' ? payload : {} };
    },
    current() {
      return current;
    },
  });
}

export function createPatternLabWorkerReply(type, requestId, payload = {}) {
  if (!PATTERN_LAB_WORKER_REPLY_TYPES.includes(type)) {
    throw new RangeError(`Unsupported Pattern Lab worker reply: ${String(type)}`);
  }
  if (!positiveRequestId(requestId)) throw new RangeError('Pattern Lab worker reply requires a positive request ID');
  return { type, requestId, payload: payload && typeof payload === 'object' ? payload : {} };
}

export function shouldAcceptPatternLabWorkerReply(reply, latestRequestId) {
  return Boolean(
    reply
    && PATTERN_LAB_WORKER_REPLY_TYPES.includes(reply.type)
    && positiveRequestId(reply.requestId)
    && reply.requestId === latestRequestId,
  );
}

export function clampPatternLabWorkerSampleCount(value, mode = 'preview') {
  if (!RENDER_MODES.includes(mode)) {
    throw new RangeError(`Unsupported Pattern Lab worker render mode: ${String(mode)}`);
  }
  const number = Number(value);
  const requested = Number.isFinite(number) ? Math.max(1, Math.round(number)) : 1;
  const maximum = mode === 'preview'
    ? PATTERN_LAB_WORKER_BUDGETS.previewSamples
    : PATTERN_LAB_WORKER_BUDGETS.finalSamples;
  return Math.min(requested, maximum);
}

export function quantizePatternLabWorkerTime(value, mode = 'preview') {
  if (!RENDER_MODES.includes(mode)) {
    throw new RangeError(`Unsupported Pattern Lab worker render mode: ${String(mode)}`);
  }
  const time = Number(value);
  const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0;
  if (mode !== 'preview') return safeTime;
  return Math.floor(safeTime * PATTERN_LAB_WORKER_BUDGETS.previewFps)
    / PATTERN_LAB_WORKER_BUDGETS.previewFps;
}

export function validatePatternLabWorkerRenderRequest(input = {}) {
  const mode = input.mode || 'preview';
  const requestedSamples = Number(input.sampleCount);
  const sampleCount = clampPatternLabWorkerSampleCount(requestedSamples, mode);
  if (!Number.isFinite(requestedSamples) || requestedSamples < 1 || Math.round(requestedSamples) !== sampleCount) {
    throw new RangeError(`Pattern Lab worker ${mode} render exceeds its sample budget`);
  }
  const layerCount = Number(input.layerCount ?? 0);
  if (!Number.isInteger(layerCount) || layerCount < 0) {
    throw new RangeError('Pattern Lab worker layer count must be a non-negative integer');
  }
  if (layerCount > PATTERN_LAB_WORKER_BUDGETS.maxLayers) {
    throw new RangeError(`Pattern Lab worker supports at most ${PATTERN_LAB_WORKER_BUDGETS.maxLayers} layers`);
  }
  const geometryBytes = Number(input.geometryBytes ?? 0);
  if (!Number.isSafeInteger(geometryBytes) || geometryBytes < 0) {
    throw new RangeError('Pattern Lab worker geometry allocation must be a non-negative safe integer');
  }
  const allocationBytes = geometryBytes + sampleCount * (3 + Uint32Array.BYTES_PER_ELEMENT);
  if (allocationBytes > PATTERN_LAB_WORKER_BUDGETS.maxAllocationBytes) {
    throw new RangeError(`Pattern Lab worker allocation exceeds ${PATTERN_LAB_WORKER_BUDGETS.maxAllocationBytes} bytes`);
  }
  return { mode, sampleCount, layerCount, allocationBytes };
}

export function validatePatternLabWorkerFrameReply(reply, pending) {
  if (!pending || !positiveRequestId(pending.id) || !RENDER_MODES.includes(pending.mode)
    || !Number.isSafeInteger(pending.visiblePixelCount) || pending.visiblePixelCount < 1
    || !Number.isSafeInteger(pending.expectedSampleCount) || pending.expectedSampleCount < 1
    || pending.expectedSampleCount !== clampPatternLabWorkerSampleCount(
      pending.visiblePixelCount,
      pending.mode,
    )
    || !Number.isFinite(pending.time)
    || !positiveRequestId(pending.generation)) {
    throw new RangeError('Malformed Pattern Lab worker pending frame contract');
  }
  if (!shouldAcceptPatternLabWorkerReply(reply, pending.id) || reply.type !== 'frame') {
    throw new RangeError('Malformed Pattern Lab worker frame identity');
  }
  const payload = reply.payload;
  if (!payload || payload.mode !== pending.mode) {
    throw new RangeError('Malformed Pattern Lab worker frame mode');
  }
  if (payload.time !== pending.time || payload.generation !== pending.generation) {
    throw new RangeError('Malformed Pattern Lab worker frame generation');
  }
  if (!(payload.colors instanceof ArrayBuffer) || !(payload.indices instanceof ArrayBuffer)) {
    throw new RangeError('Malformed Pattern Lab worker frame buffers');
  }
  if (payload.colors.byteLength > PATTERN_LAB_WORKER_BUDGETS.maxFrameBytes
    || payload.indices.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0) {
    throw new RangeError('Malformed Pattern Lab worker frame byte lengths');
  }
  const colors = new Uint8ClampedArray(payload.colors);
  const indices = new Uint32Array(payload.indices);
  if (indices.length !== pending.expectedSampleCount || colors.length !== indices.length * 3
    || payload.sampleCount !== pending.expectedSampleCount
    || payload.totalSamples !== pending.visiblePixelCount) {
    throw new RangeError('Malformed Pattern Lab worker frame sample counts');
  }
  let previous = -1;
  for (const index of indices) {
    if (index <= previous || index >= pending.visiblePixelCount) {
      throw new RangeError('Malformed Pattern Lab worker frame indices');
    }
    previous = index;
  }
  return { ...payload, colors, indices };
}
