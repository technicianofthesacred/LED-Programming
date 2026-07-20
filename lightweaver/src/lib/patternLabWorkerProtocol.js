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
  maxAllocationBytes: 4 * 1024 * 1024,
  renderWarningMs: 40,
  exportWarningMs: 250,
});

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
  if (!['preview', 'final', 'export'].includes(mode)) {
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
  if (!['preview', 'final', 'export'].includes(mode)) {
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
  const allocationBytes = Number(input.allocationBytes ?? sampleCount * 3);
  if (!Number.isSafeInteger(allocationBytes) || allocationBytes < 0) {
    throw new RangeError('Pattern Lab worker allocation must be a non-negative safe integer');
  }
  if (allocationBytes > PATTERN_LAB_WORKER_BUDGETS.maxAllocationBytes) {
    throw new RangeError(`Pattern Lab worker allocation exceeds ${PATTERN_LAB_WORKER_BUDGETS.maxAllocationBytes} bytes`);
  }
  return { mode, sampleCount, layerCount, allocationBytes };
}
