import { buildGammaLut } from './frameEngine.js';
import { pixelsFromWiring, remapFrameToWiring } from './export.js';
import { sampleEvolution } from './patternLabEvolution.js';
import { resolvePatternLabMacros } from './patternLabMacros.js';
import { renderPatternLabRecipeFrame } from './patternLabPatternAdapter.js';
import { assertPatternLabJsonSafe, normalizePatternLabRecipe } from './patternLabRecipe.js';
import {
  PATTERN_LAB_WORKER_BUDGETS,
  clonePatternLabWorkerGeometryForTransfer,
  compactPatternLabWorkerGeometry,
  createPatternLabWorkerRequestSequencer,
  validatePatternLabWorkerFrameReply,
} from './patternLabWorkerProtocol.js';
import { getPatternById, isBuiltInPattern } from './patternRegistry.js';
import {
  DEFAULT_STANDALONE_OUTPUTS,
  LWSEQ_HEADER_BYTES,
  estimateLwseqBytes,
  toLwseqBytes,
} from './standaloneController.js';

const MAX_BAKE_FPS = 24;
const MAX_BAKE_DURATION_SECONDS = 15 * 60;
const EXPORT_FRAME_ESTIMATE_MS = PATTERN_LAB_WORKER_BUDGETS.exportWarningMs;
const WORKER_REQUEST_TIMEOUT_MS = 10_000;
const YIELD_EVERY_FRAMES = 8;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NONDETERMINISTIC_CAPABILITIES = new Set([
  'clock',
  'date',
  'live-audio',
  'local-time',
  'network',
  'random',
  'wall-clock',
]);
const RESOLVABLE_CAPABILITIES = new Set(['beat', 'offline-analysis', 'time']);
const EXECUTABLE_KEYS = /^(?:code|glsl|javascript|script|shaderSource|sourceCode|graphSource)$/i;
const FORBIDDEN_PATTERN_SOURCE = [
  [/(?:\bDate\b|\bperformance\b)/, 'wall clock'],
  [/\bMath\s*\.\s*random\b/, 'Math.random'],
  [/(?:\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b|\bnavigator\b|\bwindow\b|\bdocument\b|\bglobalThis\b)/, 'network or page globals'],
];

export const MAX_PATTERN_LAB_LWSEQ_BYTES = LWSEQ_HEADER_BYTES
  + PATTERN_LAB_WORKER_BUDGETS.finalSamples * 3 * MAX_BAKE_FPS * MAX_BAKE_DURATION_SECONDS;

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('Pattern Lab bake was canceled', 'AbortError');
  const error = new Error('Pattern Lab bake was canceled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason?.name === 'AbortError') throw signal.reason;
  throw abortError();
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return number;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function mix(from, to, amount) {
  return from + (to - from) * amount;
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortCanonical(value[key])]));
  }
  return value;
}

function assertPlainDataTree(value, label, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must not contain non-finite numbers`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${label} must contain only plain data`);
  const prototype = Object.getPrototypeOf(value);
  const validPrototype = Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
  if (!validPrototype) throw new TypeError(`${label} must contain only plain object and array data`);
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cyclic values`);
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol keys`);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property?.get || property?.set) throw new TypeError(`${label} must not contain accessor properties`);
    if (property && Object.hasOwn(property, 'value')) {
      assertPlainDataTree(property.value, label, ancestors);
    }
  }
  ancestors.delete(value);
}

function clonePlainData(value) {
  if (Array.isArray(value)) return value.map(clonePlainData);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map(key => [key, clonePlainData(value[key])]));
  }
  return value;
}

export function canonicalPatternLabBakeJson(value) {
  assertPlainDataTree(value, 'Canonical Pattern Lab bake value');
  assertPatternLabJsonSafe(value);
  return JSON.stringify(sortCanonical(value));
}

function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalPatternLabBakeJson(value));
}

async function sha256(bytes, signal) {
  throwIfAborted(signal);
  const cryptoImpl = globalThis.crypto;
  if (!cryptoImpl?.subtle?.digest) throw new Error('Secure SHA-256 hashing is unavailable');
  const result = await cryptoImpl.subtle.digest('SHA-256', bytes);
  throwIfAborted(signal);
  const digest = new Uint8Array(result);
  if (digest.byteLength !== 32) throw new TypeError('SHA-256 digest must contain exactly 32 bytes');
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function rejectExecutableRecipeFields(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string' && EXECUTABLE_KEYS.test(key)) {
      throw new TypeError(`Pattern Lab bake rejects executable source field ${path}.${key}`);
    }
    rejectExecutableRecipeFields(value[key], `${path}.${String(key)}`);
  }
}

function recipePatternIds(recipe) {
  const ids = [];
  if (recipe.base?.kind === 'lightweaver-pattern') ids.push(recipe.base.patternId);
  for (const layer of recipe.layers || []) {
    if (layer?.generator?.kind === 'lightweaver-pattern') ids.push(layer.generator.patternId);
  }
  return ids;
}

function validateDeterministicRecipe(recipe) {
  rejectExecutableRecipeFields(recipe);
  for (const requirement of recipe.requirements || []) {
    if (requirement?.required === false) continue;
    const capability = String(requirement?.capability || '').trim().toLowerCase();
    if (NONDETERMINISTIC_CAPABILITIES.has(capability)) {
      const suffix = capability === 'live-audio' ? 'is unresolved for offline baking' : 'is not deterministic';
      throw new TypeError(`Pattern Lab requirement ${capability} ${suffix}`);
    }
    if (capability && !RESOLVABLE_CAPABILITIES.has(capability)) {
      throw new TypeError(`Pattern Lab requirement ${capability} is unresolved for deterministic baking`);
    }
  }
  for (const patternId of recipePatternIds(recipe)) {
    if (!isBuiltInPattern(patternId)) {
      throw new RangeError(`Pattern Lab bake requires a built-in pattern: ${String(patternId)}`);
    }
    const source = getPatternById(patternId)?.code || '';
    for (const [expression, label] of FORBIDDEN_PATTERN_SOURCE) {
      if (expression.test(source)) throw new TypeError(`Pattern ${patternId} uses forbidden ${label} input`);
    }
  }
}

function outputLayout(wiring, physicalPixels) {
  return wiring.outputs.map((output, index) => ({
    id: String(output.id),
    name: String(output.name || output.id),
    pin: Number.isFinite(Number(output.pin))
      ? Number(output.pin)
      : DEFAULT_STANDALONE_OUTPUTS[index]?.pin,
    pixels: physicalPixels.filter(pixel => String(pixel.outputId) === String(output.id)).length,
  })).filter(output => output.pixels > 0);
}

function safeCoordinate(value, label) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return Object.is(number, -0) ? 0 : number;
}

function sourceStrips(strips, hidden = {}) {
  if (!Array.isArray(strips) || !strips.length) throw new TypeError('Pattern Lab bake requires source strips');
  return strips.map((strip, stripIndex) => {
    const pixels = Array.isArray(strip?.pixels) ? strip.pixels : [];
    if (!strip?.id || !pixels.length) throw new TypeError(`Pattern Lab source strip ${stripIndex + 1} is incomplete`);
    return {
      id: String(strip.id),
      speed: safeCoordinate(strip.speed ?? 1, `Strip ${strip.id} speed`),
      brightness: hidden?.[strip.id] ? 0 : safeCoordinate(strip.brightness ?? 1, `Strip ${strip.id} brightness`),
      hueShift: safeCoordinate(strip.hueShift ?? 0, `Strip ${strip.id} hue shift`),
      pixels: pixels.map((pixel, pixelIndex) => ({
        x: safeCoordinate(pixel?.x, `Strip ${strip.id} pixel ${pixelIndex} x`),
        y: safeCoordinate(pixel?.y, `Strip ${strip.id} pixel ${pixelIndex} y`),
        z: safeCoordinate(pixel?.z, `Strip ${strip.id} pixel ${pixelIndex} z`),
        p: Number.isFinite(Number(pixel?.p))
          ? clamp(Number(pixel.p), 0, 1)
          : (pixels.length > 1 ? pixelIndex / (pixels.length - 1) : 0.5),
      })),
    };
  });
}

function validateOfflineAudio(audioLanes, recipe, durationSeconds, lastBakeTime) {
  const requirements = (recipe.requirements || []).filter(requirement => (
    requirement?.required !== false && requirement?.capability === 'offline-analysis'
  ));
  const sourceUsesAudio = recipePatternIds(recipe).some(patternId => (
    /\b(?:bass|mid|hi)\b/.test(getPatternById(patternId)?.code || '')
  ));
  if (!audioLanes) {
    if (requirements.length || sourceUsesAudio) {
      throw new TypeError('Resolved offline audio lanes are required; audio input is unresolved');
    }
    return null;
  }
  assertPatternLabJsonSafe(audioLanes);
  if (audioLanes.version !== 1
    || audioLanes.audioFingerprint?.algorithm !== 'SHA-256'
    || !SHA256_PATTERN.test(String(audioLanes.audioFingerprint?.sha256 || ''))) {
    throw new TypeError('Offline audio lanes require a valid SHA-256 fingerprint');
  }
  for (const requirement of requirements) {
    if (requirement.analysisVersion !== 1
      || requirement.audioSha256 !== audioLanes.audioFingerprint.sha256) {
      throw new TypeError('Offline audio lanes do not resolve the recipe fingerprint');
    }
  }
  const settings = audioLanes.settings;
  if (!settings || finite(settings.durationSeconds, -1) < durationSeconds) {
    throw new RangeError('Offline audio lanes do not cover the full bake duration');
  }
  const names = ['bass', 'mid', 'high', 'level', 'centroid', 'flux', 'onset'];
  const frameCount = positiveInteger(settings.frameCount, 'Offline audio frame count');
  for (const name of names) {
    const lane = audioLanes.lanes?.[name];
    if (!Array.isArray(lane) || lane.length !== frameCount
      || lane.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new RangeError(`Offline audio lane ${name} is invalid or incomplete`);
    }
  }
  const sampleRate = positiveInteger(settings.sampleRate, 'Offline audio sample rate');
  const hopSize = positiveInteger(settings.hopSize, 'Offline audio hop size');
  const frameTimeOffsetSeconds = finite(settings.frameTimeOffsetSeconds);
  const availableThrough = frameTimeOffsetSeconds + (frameCount - 1) * hopSize / sampleRate;
  if (availableThrough + Number.EPSILON < lastBakeTime) {
    throw new RangeError('Offline audio lanes do not cover the full bake duration');
  }
  return audioLanes;
}

function physicalHashProjection({ strips, wiring, physicalPixels, outputs, groups, hidden, render }) {
  return {
    version: 1,
    strips,
    outputs,
    physicalOrder: physicalPixels.map(pixel => ({
      index: pixel.index,
      outputId: String(pixel.outputId || ''),
      runId: String(pixel.runId || ''),
      stripId: pixel.stripId == null ? null : String(pixel.stripId),
      sourceLed: pixel.sourceLed == null ? null : pixel.sourceLed,
      inactive: pixel.inactive === true,
    })),
    wiring: {
      version: wiring.version,
      controllerAnchor: wiring.controllerAnchor == null ? null : clonePlainData(wiring.controllerAnchor),
    },
    groups: Array.isArray(groups) ? groups : [],
    hidden: hidden && typeof hidden === 'object' ? hidden : {},
    render,
  };
}

function prepareBake(input = {}) {
  if (!input.wiring || typeof input.wiring !== 'object') {
    throw new TypeError('Known physical wiring is required for Pattern Lab bake');
  }
  assertPlainDataTree(input.recipe, 'Pattern Lab bake recipe');
  assertPlainDataTree(input.strips, 'Pattern Lab bake strips');
  assertPlainDataTree(input.wiring, 'Pattern Lab bake wiring');
  if (input.groups !== undefined) assertPlainDataTree(input.groups, 'Pattern Lab bake groups');
  if (input.hidden !== undefined) assertPlainDataTree(input.hidden, 'Pattern Lab bake hidden map');
  if (input.render !== undefined) assertPlainDataTree(input.render, 'Pattern Lab bake render settings');
  if (input.audioLanes !== undefined) assertPlainDataTree(input.audioLanes, 'Pattern Lab bake audio lanes');
  if (!Array.isArray(input.wiring.outputs) || !Array.isArray(input.wiring.runs)) {
    throw new TypeError('Known physical wiring is required for Pattern Lab bake');
  }
  assertPatternLabJsonSafe(input.recipe);
  const recipe = normalizePatternLabRecipe(input.recipe);
  validateDeterministicRecipe(recipe);
  const strips = sourceStrips(input.strips, input.hidden);
  const sourcePixelCount = strips.reduce((sum, strip) => sum + strip.pixels.length, 0);
  if (sourcePixelCount > PATTERN_LAB_WORKER_BUDGETS.finalSamples) {
    throw new RangeError(`Pattern Lab bake supports at most ${PATTERN_LAB_WORKER_BUDGETS.finalSamples} source pixels`);
  }
  const physicalPixels = pixelsFromWiring(
    input.wiring,
    input.strips,
    input.groups || [],
    undefined,
    { requireSendReady: true },
  );
  if (!physicalPixels.length) throw new TypeError('Physical wiring contains no pixels to bake');
  const outputs = outputLayout(input.wiring, physicalPixels);
  if (!outputs.length) throw new TypeError('Physical wiring contains no active outputs');
  const pixelCount = physicalPixels.length;
  const fps = positiveInteger(input.fps ?? MAX_BAKE_FPS, 'Pattern Lab bake FPS', MAX_BAKE_FPS);
  const durationSeconds = finite(recipe.evolution?.durationSeconds, 0);
  if (durationSeconds <= 0 || durationSeconds > MAX_BAKE_DURATION_SECONDS) {
    throw new RangeError(`Pattern Lab bake duration must be from 1 to ${MAX_BAKE_DURATION_SECONDS} seconds`);
  }
  const frameCount = Math.round(durationSeconds * fps);
  positiveInteger(frameCount, 'Pattern Lab bake frame count', MAX_BAKE_FPS * MAX_BAKE_DURATION_SECONDS);
  const requestedMax = positiveInteger(
    input.maxBytes ?? MAX_PATTERN_LAB_LWSEQ_BYTES,
    'Pattern Lab bake storage cap',
  );
  if (requestedMax > MAX_PATTERN_LAB_LWSEQ_BYTES) {
    throw new RangeError(`Pattern Lab bake storage cap exceeds the absolute maximum of ${MAX_PATTERN_LAB_LWSEQ_BYTES} bytes`);
  }
  const storage = estimateLwseqBytes({ pixels: pixelCount, fps, frames: frameCount });
  if (!Number.isSafeInteger(storage.totalBytes) || storage.totalBytes > requestedMax) {
    throw new RangeError(`Pattern Lab LWSEQ estimate ${storage.totalBytes} exceeds storage cap ${requestedMax} before rendering`);
  }
  const audioLanes = validateOfflineAudio(
    input.audioLanes === undefined ? null : clonePlainData(input.audioLanes),
    recipe,
    durationSeconds,
    (frameCount - 1) / fps,
  );
  const render = {
    bpm: safeCoordinate(input.render?.bpm ?? input.bpm ?? 120, 'Pattern Lab bake BPM'),
    gammaEnabled: input.render?.gammaEnabled === true,
    gammaValue: safeCoordinate(input.render?.gammaValue ?? 2.2, 'Pattern Lab bake gamma'),
    symSettings: input.render?.symSettings == null ? null : clonePlainData(input.render.symSettings),
  };
  assertPatternLabJsonSafe(render);
  const layoutProjection = physicalHashProjection({
    strips,
    wiring: input.wiring,
    physicalPixels,
    outputs,
    groups: input.groups === undefined ? [] : clonePlainData(input.groups),
    hidden: input.hidden === undefined ? {} : clonePlainData(input.hidden),
    render,
  });
  assertPatternLabJsonSafe(layoutProjection);
  return {
    recipe,
    strips,
    physicalPixels,
    compiledWiring: { pixels: physicalPixels },
    outputs,
    pixelCount,
    sourcePixelCount,
    fps,
    durationSeconds,
    frameCount,
    maxBytes: requestedMax,
    storage,
    audioLanes,
    render,
    layoutProjection,
  };
}

function estimatePreparedBake(prepared) {
  return Object.freeze({
    ...prepared.storage,
    pixelCount: prepared.pixelCount,
    frameCount: prepared.frameCount,
    fps: prepared.fps,
    durationSeconds: prepared.durationSeconds,
    estimatedRenderMilliseconds: prepared.frameCount * EXPORT_FRAME_ESTIMATE_MS,
    maxBytes: prepared.maxBytes,
  });
}

export function estimatePatternLabBake(input = {}) {
  return estimatePreparedBake(prepareBake(input));
}

function renderOptionsAt(recipe, time) {
  const macros = resolvePatternLabMacros(recipe);
  const evolution = recipe.evolution.enabled ? sampleEvolution(recipe, time) : null;
  const amount = evolution?.change ?? 0;
  const destinations = evolution?.destinations;
  return {
    masterSpeed: clamp(mix(
      macros.movement.speedMultiplier,
      0.4 + (destinations?.movement ?? 0.5) * 2.1,
      amount,
    ), 0.1, 3),
    masterBrightness: clamp(mix(
      macros.energy.brightness,
      Math.min(macros.energy.brightness, destinations?.brightness ?? macros.energy.brightness),
      amount,
    ), 0.08, 1),
    masterSaturation: clamp(mix(
      macros.color.saturation,
      0.55 + (destinations?.color ?? 0.5) * 0.45,
      amount,
    ), 0.25, 1),
    masterHueShift: macros.color.warmth * 18
      + ((destinations?.color ?? 0.5) - 0.5) * 72 * amount,
  };
}

function sampleLane(lane, position) {
  const clamped = clamp(position, 0, lane.length - 1);
  const lower = Math.floor(clamped);
  const upper = Math.min(lane.length - 1, lower + 1);
  return mix(lane[lower], lane[upper], clamped - lower);
}

function audioBandsAt(audioLanes, time) {
  if (!audioLanes) return null;
  const settings = audioLanes.settings;
  const position = (time - finite(settings.frameTimeOffsetSeconds))
    * settings.sampleRate / settings.hopSize;
  return {
    bass: sampleLane(audioLanes.lanes.bass, position),
    mid: sampleLane(audioLanes.lanes.mid, position),
    hi: sampleLane(audioLanes.lanes.high, position),
  };
}

function renderStrips(strips) {
  return strips.map(strip => ({
    id: strip.id,
    speed: strip.speed,
    brightness: strip.brightness,
    hueShift: strip.hueShift,
    patternId: null,
    pts: strip.pixels.map(pixel => ({ x: pixel.x, y: pixel.y, p: pixel.p })),
  }));
}

function renderDirectFrame(prepared, time) {
  if (prepared.recipe.base?.kind !== 'lightweaver-pattern') {
    throw new Error('This stateful Pattern Lab recipe requires Web Worker rendering');
  }
  const options = renderOptionsAt(prepared.recipe, time);
  return renderPatternLabRecipeFrame(prepared.recipe, {
    t: time,
    strips: renderStrips(prepared.strips),
    bpm: prepared.render.bpm,
    gammaLUT: buildGammaLut(prepared.render.gammaEnabled, prepared.render.gammaValue),
    symSettings: prepared.render.symSettings,
    audioBands: audioBandsAt(prepared.audioLanes, time),
    ...options,
  }).pixels;
}

function canUseWorker(prepared) {
  return typeof globalThis.Worker === 'function' && !prepared.audioLanes;
}

function createWorkerRenderer(prepared, signal) {
  const worker = new globalThis.Worker(new URL('../pattern-lab/patternLab.worker.js', import.meta.url), { type: 'module' });
  const sequence = createPatternLabWorkerRequestSequencer();
  const generation = 1;
  const pending = new Map();
  let stopped = false;

  const stop = error => {
    if (stopped) return;
    stopped = true;
    worker.terminate();
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error || new Error('Pattern Lab bake worker stopped'));
    }
    pending.clear();
  };
  const abort = () => stop(signal?.reason?.name === 'AbortError' ? signal.reason : abortError());
  signal?.addEventListener('abort', abort, { once: true });
  worker.onerror = event => stop(new Error(event.message || 'Pattern Lab bake worker failed'));
  worker.onmessage = event => {
    const reply = event.data;
    const request = pending.get(reply?.requestId);
    if (!request) return;
    if (reply.type === 'warning' || reply.type === 'stats') return;
    clearTimeout(request.timeout);
    pending.delete(reply.requestId);
    if (reply.type === 'error') {
      const error = new Error(reply.payload?.message || 'Pattern Lab bake worker rejected a frame');
      error.name = reply.payload?.name || 'Error';
      request.reject(error);
    } else request.resolve(reply);
  };

  const send = (type, payload, transfer = []) => {
    throwIfAborted(signal);
    if (stopped) return Promise.reject(new Error('Pattern Lab bake worker is unavailable'));
    const request = sequence.next(type, payload);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(request.requestId);
        const error = new Error(`Pattern Lab bake worker exceeded ${WORKER_REQUEST_TIMEOUT_MS} ms`);
        stop(error);
        reject(error);
      }, WORKER_REQUEST_TIMEOUT_MS);
      pending.set(request.requestId, { resolve, reject, timeout });
      worker.postMessage(request, transfer);
    });
  };

  return {
    async initialize() {
      const compact = compactPatternLabWorkerGeometry({
        strips: prepared.strips,
        hidden: {},
        bpm: prepared.render.bpm,
        gammaEnabled: prepared.render.gammaEnabled,
        gammaValue: prepared.render.gammaValue,
        symSettings: prepared.render.symSettings,
        audioBands: null,
      });
      const snapshot = clonePatternLabWorkerGeometryForTransfer(compact);
      const reply = await send('initialize', { geometry: snapshot.geometry, generation }, snapshot.transfer);
      if (reply.type !== 'ready' || reply.payload?.generation !== generation) {
        throw new Error('Pattern Lab bake worker did not confirm its geometry generation');
      }
    },
    async render(time) {
      const requestId = sequence.current() + 1;
      const expectedSampleCount = prepared.sourcePixelCount;
      const reply = await send('render', {
        recipe: prepared.recipe,
        time,
        mode: 'export',
        generation,
        layerCount: prepared.recipe.layers.length,
        renderOptions: renderOptionsAt(prepared.recipe, time),
      });
      const frame = validatePatternLabWorkerFrameReply(reply, {
        id: requestId,
        mode: 'export',
        expectedSampleCount,
        visiblePixelCount: prepared.sourcePixelCount,
        time,
        generation,
      });
      return Array.from({ length: prepared.sourcePixelCount }, (_, index) => ({
        r: frame.colors[index * 3],
        g: frame.colors[index * 3 + 1],
        b: frame.colors[index * 3 + 2],
      }));
    },
    close() {
      signal?.removeEventListener('abort', abort);
      stop();
    },
  };
}

function createLwseqBuffer(prepared) {
  const blackFrame = Array.from({ length: prepared.pixelCount }, () => ({ r: 0, g: 0, b: 0 }));
  const template = toLwseqBytes([blackFrame], { fps: prepared.fps, outputs: prepared.outputs });
  const bytes = new Uint8Array(prepared.storage.totalBytes);
  bytes.set(template.subarray(0, LWSEQ_HEADER_BYTES));
  new DataView(bytes.buffer).setUint32(16, prepared.frameCount, true);
  return bytes;
}

function writePhysicalFrame(bytes, frameIndex, physicalFrame, pixelCount) {
  let cursor = LWSEQ_HEADER_BYTES + frameIndex * pixelCount * 3;
  for (const pixel of physicalFrame) {
    bytes[cursor++] = clamp(Math.round(finite(pixel?.r)), 0, 255);
    bytes[cursor++] = clamp(Math.round(finite(pixel?.g)), 0, 255);
    bytes[cursor++] = clamp(Math.round(finite(pixel?.b)), 0, 255);
  }
}

function yieldToHost() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export async function bakePatternLabRecipe(input = {}) {
  throwIfAborted(input.signal);
  const prepared = prepareBake(input);
  throwIfAborted(input.signal);
  const bytes = createLwseqBuffer(prepared);
  const workerRenderer = canUseWorker(prepared) ? createWorkerRenderer(prepared, input.signal) : null;
  try {
    if (workerRenderer) await workerRenderer.initialize();
    for (let frameIndex = 0; frameIndex < prepared.frameCount; frameIndex += 1) {
      throwIfAborted(input.signal);
      const time = frameIndex / prepared.fps;
      const sourceFrame = workerRenderer
        ? await workerRenderer.render(time)
        : renderDirectFrame(prepared, time);
      if (!Array.isArray(sourceFrame) || sourceFrame.length !== prepared.sourcePixelCount) {
        throw new RangeError('Canonical Pattern Lab renderer returned an incomplete source frame');
      }
      const physicalFrame = remapFrameToWiring(sourceFrame, prepared.compiledWiring, prepared.strips);
      if (physicalFrame.length !== prepared.pixelCount) {
        throw new RangeError('Physical frame order changed during Pattern Lab bake');
      }
      writePhysicalFrame(bytes, frameIndex, physicalFrame, prepared.pixelCount);
      if ((frameIndex + 1) % YIELD_EVERY_FRAMES === 0) await yieldToHost();
    }
  } finally {
    workerRenderer?.close();
  }
  throwIfAborted(input.signal);
  const [recipeSha256, layoutPhysicalOrderSha256, audioLanesSha256, lwseqSha256] = await Promise.all([
    sha256(canonicalBytes(prepared.recipe), input.signal),
    sha256(canonicalBytes(prepared.layoutProjection), input.signal),
    prepared.audioLanes ? sha256(canonicalBytes(prepared.audioLanes), input.signal) : null,
    sha256(bytes, input.signal),
  ]);
  const sidecar = Object.freeze({
    format: 'lightweaver-lwseq-sidecar',
    version: 1,
    hashAlgorithm: 'SHA-256',
    recipeSha256,
    layoutPhysicalOrderSha256,
    audioLanesSha256,
    fps: prepared.fps,
    frameCount: prepared.frameCount,
    pixelCount: prepared.pixelCount,
    seed: prepared.recipe.seed,
    lwseqSha256,
  });
  const sidecarJson = canonicalPatternLabBakeJson(sidecar);
  return Object.freeze({
    bytes,
    sidecar,
    sidecarJson,
    recipe: prepared.recipe,
    outputs: prepared.outputs,
    estimate: estimatePreparedBake(prepared),
  });
}
