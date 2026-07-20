import { buildGammaLut, normalizePalette, renderPixelFrame } from '../lib/frameEngine.js';
import {
  PATTERN_LAB_WORKER_BUDGETS,
  createPatternLabWorkerReply,
  validatePatternLabWorkerRenderRequest,
} from '../lib/patternLabWorkerProtocol.js';

let initialized = false;
const cancelledRequests = new Set();

function reply(type, requestId, payload = {}, transfer = []) {
  globalThis.postMessage(createPatternLabWorkerReply(type, requestId, payload), transfer);
}

function visiblePixels(geometry = {}) {
  const hidden = geometry.hidden || {};
  const entries = [];
  for (const strip of geometry.strips || []) {
    if (!strip || hidden[strip.id] || strip.hidden) continue;
    const pixels = Array.isArray(strip.pixels) ? strip.pixels : [];
    pixels.forEach((pixel, pixelIndex) => entries.push({
      strip,
      pixel,
      progress: pixels.length > 1 ? pixelIndex / (pixels.length - 1) : 0.5,
      index: entries.length,
    }));
  }
  return entries;
}

function sampledEntries(entries, sampleCount) {
  if (entries.length <= sampleCount) return entries;
  if (sampleCount === 1) return [entries[Math.floor(entries.length / 2)]];
  return Array.from({ length: sampleCount }, (_, index) => (
    entries[Math.round(index * (entries.length - 1) / (sampleCount - 1))]
  ));
}

function sampledStrips(entries) {
  const strips = [];
  const byId = new Map();
  for (const entry of entries) {
    let sampled = byId.get(entry.strip.id);
    if (!sampled) {
      sampled = {
        id: entry.strip.id,
        speed: entry.strip.speed,
        brightness: entry.strip.brightness,
        hueShift: entry.strip.hueShift,
        patternId: null,
        pts: [],
      };
      byId.set(entry.strip.id, sampled);
      strips.push(sampled);
    }
    sampled.pts.push({
      x: Number(entry.pixel?.x) || 0,
      y: Number(entry.pixel?.y) || 0,
      p: entry.progress,
      i: entry.index,
    });
  }
  return strips;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
}

async function renderRequest(requestId, payload) {
  const startedAt = performance.now();
  const allEntries = visiblePixels(payload.geometry);
  const requestedSamples = Math.min(
    Math.max(1, allEntries.length),
    Number(payload.sampleCount) || Math.max(1, allEntries.length),
  );
  const allocationBytes = payload.allocationBytes ?? requestedSamples * 5;
  const validated = validatePatternLabWorkerRenderRequest({
    mode: payload.mode,
    sampleCount: requestedSamples,
    layerCount: payload.layerCount,
    allocationBytes,
  });

  if (payload.testGenerator?.kind === 'loop') {
    // Deliberately test the main-thread watchdog. This worker is terminated by its owner.
    // eslint-disable-next-line no-constant-condition
    while (true) {}
  }
  if (payload.testGenerator?.kind === 'delay') {
    await wait(payload.testGenerator.milliseconds);
    if (cancelledRequests.delete(requestId)) return;
  }
  if (cancelledRequests.delete(requestId)) return;

  const samples = sampledEntries(allEntries, validated.sampleCount);
  const recipe = payload.recipe || {};
  const options = payload.renderOptions || {};
  const frame = renderPixelFrame({
    t: Number(payload.time) || 0,
    strips: sampledStrips(samples),
    patternId: recipe.base?.patternId,
    params: recipe.base?.params || {},
    paletteNorm: normalizePalette(recipe.palette),
    bpm: Number(payload.geometry?.bpm) || 120,
    masterSpeed: options.masterSpeed,
    masterBrightness: options.masterBrightness,
    masterSaturation: options.masterSaturation,
    masterHueShift: options.masterHueShift,
    gammaLUT: buildGammaLut(Boolean(payload.geometry?.gammaEnabled), payload.geometry?.gammaValue),
    symSettings: payload.geometry?.symSettings,
    audioBands: payload.geometry?.audioBands,
  });
  if (cancelledRequests.delete(requestId)) return;

  const colors = new Uint8ClampedArray(frame.pixels.length * 3);
  frame.pixels.forEach((color, index) => {
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  });
  const indices = new Uint16Array(samples.map(sample => sample.index));
  const allocatedBytes = colors.byteLength + indices.byteLength;
  const elapsedMs = performance.now() - startedAt;
  const warningMs = validated.mode === 'export'
    ? PATTERN_LAB_WORKER_BUDGETS.exportWarningMs
    : PATTERN_LAB_WORKER_BUDGETS.renderWarningMs;
  if (elapsedMs > warningMs) reply('warning', requestId, {
    code: 'render-wall-time',
    message: `Pattern Lab worker render took ${elapsedMs.toFixed(1)} ms`,
    elapsedMs,
    limitMs: warningMs,
  });
  reply('frame', requestId, {
    mode: validated.mode,
    time: Number(payload.time) || 0,
    totalSamples: allEntries.length,
    sampleCount: samples.length,
    colors: colors.buffer,
    indices: indices.buffer,
  }, [colors.buffer, indices.buffer]);
  reply('stats', requestId, {
    elapsedMs,
    sampleCount: samples.length,
    allocatedBytes,
  });
}

async function handleMessage(message) {
  const { type, requestId, payload = {} } = message || {};
  try {
    if (type === 'initialize') {
      initialized = true;
      reply('ready', requestId, { budgets: PATTERN_LAB_WORKER_BUDGETS });
      return;
    }
    if (type === 'cancel') {
      const targetRequestId = Number(payload.targetRequestId);
      if (Number.isSafeInteger(targetRequestId) && targetRequestId > 0) cancelledRequests.add(targetRequestId);
      reply('stats', requestId, { cancelledRequestId: targetRequestId || null });
      return;
    }
    if (type === 'dispose') {
      reply('stats', requestId, { disposed: true });
      globalThis.close();
      return;
    }
    if (type !== 'render') throw new RangeError(`Unsupported Pattern Lab worker request: ${String(type)}`);
    if (!initialized) throw new Error('Pattern Lab worker must be initialized before rendering');
    await renderRequest(requestId, payload);
  } catch (error) {
    reply('error', requestId, {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

globalThis.onmessage = event => {
  void handleMessage(event.data);
};
