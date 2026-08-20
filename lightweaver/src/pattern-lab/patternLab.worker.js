import {
  buildGammaLut,
  compilePattern,
  normalizePalette,
  renderPixelFrame,
} from '../lib/frameEngine.js';
import {
  PATTERN_LAB_WORKER_BUDGETS,
  clampPatternLabWorkerSampleCount,
  createPatternLabWorkerReply,
  validatePatternLabWorkerGeometry,
  validatePatternLabWorkerRenderRequest,
} from '../lib/patternLabWorkerProtocol.js';
import {
  PATTERN_LAB_GENERATOR_IDS,
  getPatternLabGenerator,
  measurePatternLabGeneratorStateBytes,
  resolvePatternLabGeneratorInputs,
} from '../lib/patternLabGenerators.js';
import {
  blendPatternLabColors,
  finalizePatternLabColors,
} from '../lib/patternLabCompositor.js';
import { applyPatternLabMotionToStrips } from '../lib/patternLabMotion.js';
import { applyPatternLabTransform, samplePatternLabMask } from '../lib/patternLabTransforms.js';

let initialized = false;
let staticGeometry = null;
let staticGeneration = 0;
const cancelledRequests = new Set();
// The worker now lives for the whole session, so a cancel for a request that has
// already been handled must never be retained — otherwise this set grows forever.
// Every 'render' message retires its id in a finally block, including one rejected
// before rendering starts, and a cancel naming an already-retired id is ignored.
// Ids only ever increase, so the set holds at most the not-yet-rendered requests.
let lastHandledRequestId = 0;
let generatorRuntime = null;

function reply(type, requestId, payload = {}, transfer = []) {
  globalThis.postMessage(createPatternLabWorkerReply(type, requestId, payload), transfer);
}

function sampledIndices(total, sampleCount) {
  if (total <= sampleCount) return Uint32Array.from({ length: total }, (_, index) => index);
  if (sampleCount === 1) return Uint32Array.of(Math.floor(total / 2));
  return Uint32Array.from({ length: sampleCount }, (_, index) => (
    Math.round(index * (total - 1) / (sampleCount - 1))
  ));
}

function sampledStrips(geometry, indices) {
  const strips = [];
  let stripIndex = 0;
  for (const sourceIndex of indices) {
    while (stripIndex < geometry.strips.length - 1
      && sourceIndex >= geometry.strips[stripIndex].start + geometry.strips[stripIndex].count) {
      stripIndex += 1;
    }
    const sourceStrip = geometry.strips[stripIndex];
    let sampled = strips.at(-1);
    if (!sampled || sampled.id !== sourceStrip.id) {
      sampled = {
        id: sourceStrip.id,
        speed: sourceStrip.speed,
        brightness: sourceStrip.brightness,
        hueShift: sourceStrip.hueShift,
        patternId: null,
        pts: [],
      };
      strips.push(sampled);
    }
    sampled.pts.push({
      x: geometry.coordinates[sourceIndex * 2],
      y: geometry.coordinates[sourceIndex * 2 + 1],
      p: geometry.progress[sourceIndex],
      sourceProgress: geometry.progress[sourceIndex],
      reflectionProgress: geometry.reflectionProgress[sourceIndex],
      kaleidoscopeProgress: geometry.kaleidoscopeProgress[sourceIndex],
      reflectionDistance: geometry.reflectionDistance[sourceIndex],
      reflectionSegment: geometry.reflectionSegment[sourceIndex],
      reflectionPoint: geometry.reflectionPoint[sourceIndex] < 0 ? null : geometry.reflectionPoint[sourceIndex],
      isReflectionPoint: geometry.reflectionFlags[sourceIndex] === 1,
      hasKaleidoscope: Boolean(sourceStrip.hasKaleidoscope),
      i: sourceIndex,
    });
  }
  return strips;
}

function compileAuthoritativePattern(patternId, indices, visiblePixelCount) {
  const compiled = compilePattern(patternId);
  if (!compiled) return null;
  return (index, x, y, t, time, _sampleCount, ...rest) => {
    const sampledIndex = Math.max(0, Math.min(indices.length - 1, Math.round(index)));
    return compiled(indices[sampledIndex], x, y, t, time, visiblePixelCount, ...rest);
  };
}

function layerTransforms(layer) {
  if (Array.isArray(layer?.transforms)) return layer.transforms;
  return layer?.transform ? [layer.transform] : [];
}

function layerTargetMatches(layer, stripId) {
  const target = layer?.target;
  if (!target || target.kind === 'whole-piece' || target.kind === 'all') return true;
  if (target.kind === 'section') return String(target.id || '') === String(stripId || '');
  throw new RangeError(`Unsupported Pattern Lab layer target: ${String(target.kind)}`);
}

function layerGeometry(strips, layer, bounds) {
  const transforms = layerTransforms(layer);
  const coordinates = [];
  const transformed = strips.map(strip => ({
    ...strip,
    pts: strip.pts.map(point => {
      const normalized = {
        ...point,
        x: (point.x - bounds.minX) / bounds.range,
        y: (point.y - bounds.minY) / bounds.range,
      };
      coordinates.push({
        ...normalized,
        stripId: strip.id,
        stripProgress: point.stripProgress ?? point.p,
        targetMatched: layerTargetMatches(layer, strip.id),
      });
      const changed = applyPatternLabTransform(normalized, transforms);
      return {
        ...point,
        x: bounds.minX + changed.x * bounds.range,
        y: bounds.minY + changed.y * bounds.range,
      };
    }),
  }));
  return { strips: transformed, coordinates };
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
}

function disposeGeneratorRuntime() {
  if (!generatorRuntime) return;
  generatorRuntime.generator.dispose(generatorRuntime.state);
  generatorRuntime = null;
}

function statefulPattern(recipe, indices, controls) {
  const generatorId = recipe?.base?.kind;
  if (!PATTERN_LAB_GENERATOR_IDS.includes(generatorId)) {
    disposeGeneratorRuntime();
    return null;
  }
  const generator = getPatternLabGenerator(generatorId);
  const inputs = resolvePatternLabGeneratorInputs(generatorId, recipe, controls);
  const seed = Number(recipe?.seed) >>> 0;
  const signature = `${generatorId}:${seed}:${indices.length}:${JSON.stringify(inputs)}`;
  const targetTime = Math.max(0, Number(recipe?.time) || 0);
  if (!generatorRuntime || generatorRuntime.signature !== signature
    || targetTime < generatorRuntime.time) {
    disposeGeneratorRuntime();
    generatorRuntime = {
      generator,
      signature,
      state: generator.initialize({ sampleCount: indices.length, seed }),
      time: 0,
    };
  }
  generator.update(targetTime - generatorRuntime.time, generatorRuntime.state, inputs);
  generatorRuntime.time = targetTime;
  return generatorRuntime;
}

async function renderRequest(requestId, payload) {
  const startedAt = performance.now();
  if (!Number.isSafeInteger(payload.generation) || payload.generation !== staticGeneration) {
    throw new RangeError('Pattern Lab worker render generation does not match initialized geometry');
  }
  const geometry = validatePatternLabWorkerGeometry(staticGeometry);
  const requestedSamples = clampPatternLabWorkerSampleCount(geometry.visiblePixelCount, payload.mode);
  const validated = validatePatternLabWorkerRenderRequest({
    mode: payload.mode,
    sampleCount: requestedSamples,
    layerCount: payload.layerCount,
    geometryBytes: geometry.geometryBytes,
    time: payload.time,
    recipe: payload.recipe,
    renderOptions: payload.renderOptions,
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

  const indices = sampledIndices(geometry.visiblePixelCount, validated.sampleCount);
  const recipe = payload.recipe || {};
  const options = payload.renderOptions || {};
  const stateful = statefulPattern({ ...recipe, time: payload.time }, indices, options);
  const activeFn = stateful
    ? (index, x, y, _time, _cycle, _count, _palette, _beat, _beatSin, _params, _stripId, stripProgress) => {
      const sampleIndex = Math.max(0, Math.min(indices.length - 1, Math.round(index)));
      return stateful.generator.render(sampleIndex, {
        x,
        y,
        stripProgress,
        index: sampleIndex,
        sourceIndex: indices[sampleIndex],
      }, stateful.state);
    }
    : compileAuthoritativePattern(recipe.base?.patternId, indices, geometry.visiblePixelCount);
  const sampled = sampledStrips(geometry, indices);
  const motionSampled = applyPatternLabMotionToStrips(sampled, {
    elapsedSeconds: Number(payload.time) || 0,
    seed: recipe.seed,
    motionWeights: options.motionWeights,
    bounds: geometry.normalizationBounds,
  });
  const frame = renderPixelFrame({
    t: Number(payload.time) || 0,
    strips: stateful ? sampled : motionSampled,
    patternId: recipe.base?.patternId,
    activeFn,
    params: recipe.base?.params || {},
    paletteNorm: normalizePalette(recipe.palette),
    bpm: geometry.bpm,
    masterSpeed: options.masterSpeed,
    masterBrightness: 1,
    masterSaturation: options.masterSaturation,
    masterHueShift: options.masterHueShift,
    gammaLUT: null,
    symSettings: geometry.symSettings,
    audioBands: geometry.audioBands,
    normBounds: geometry.normalizationBounds,
  });
  let renderedPixels = frame.pixels;
  for (const layer of recipe.layers || []) {
    if (layer?.generator?.kind !== 'lightweaver-pattern') {
      throw new RangeError(`Unsupported Pattern Lab layer generator: ${String(layer?.generator?.kind)}`);
    }
    const layerFn = compileAuthoritativePattern(
      layer.generator.patternId,
      indices,
      geometry.visiblePixelCount,
    );
    if (!layerFn) throw new RangeError(`Unknown Pattern Lab layer pattern: ${String(layer.generator.patternId)}`);
    const preparedLayer = layerGeometry(motionSampled, layer, geometry.normalizationBounds);
    const layerFrame = renderPixelFrame({
      t: Number(payload.time) || 0,
      strips: preparedLayer.strips,
      patternId: layer.generator.patternId,
      activeFn: layerFn,
      params: layer.generator.params || {},
      paletteNorm: normalizePalette(layer.palette || recipe.palette),
      bpm: geometry.bpm,
      masterSpeed: options.masterSpeed,
      masterBrightness: 1,
      masterSaturation: options.masterSaturation,
      masterHueShift: options.masterHueShift,
      gammaLUT: null,
      symSettings: geometry.symSettings,
      audioBands: geometry.audioBands,
      normBounds: geometry.normalizationBounds,
    });
    if (layerFrame.pixels.length !== renderedPixels.length
      || preparedLayer.coordinates.length !== renderedPixels.length) {
      throw new RangeError('Pattern Lab layer output does not match the base geometry');
    }
    renderedPixels = renderedPixels.map((backdrop, index) => {
      const coordinate = preparedLayer.coordinates[index];
      const mask = coordinate.targetMatched
        ? samplePatternLabMask(layer.mask || { kind: 'none' }, coordinate)
        : 0;
      return blendPatternLabColors(
        backdrop,
        layerFrame.pixels[index],
        layer.blendMode || 'normal',
        (layer.opacity ?? 1) * mask,
      );
    });
  }
  renderedPixels = finalizePatternLabColors(renderedPixels, {
    masterBrightness: options.masterBrightness,
    gammaLUT: buildGammaLut(geometry.gammaEnabled, geometry.gammaValue),
  });
  if (cancelledRequests.delete(requestId)) return;

  const colors = new Uint8ClampedArray(renderedPixels.length * 3);
  renderedPixels.forEach((color, index) => {
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  });
  const allocatedBytes = colors.byteLength + indices.byteLength;
  const generatorStateBytes = stateful ? measurePatternLabGeneratorStateBytes(stateful.state) : 0;
  const totalAllocationBytes = validated.allocationBytes + generatorStateBytes;
  if (totalAllocationBytes > PATTERN_LAB_WORKER_BUDGETS.maxAllocationBytes) {
    throw new RangeError(`Pattern Lab worker allocation exceeds ${PATTERN_LAB_WORKER_BUDGETS.maxAllocationBytes} bytes`);
  }
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
    generation: staticGeneration,
    patternLabControlsApplied: true,
    totalSamples: geometry.visiblePixelCount,
    sampleCount: indices.length,
    colors: colors.buffer,
    indices: indices.buffer,
  }, [colors.buffer, indices.buffer]);
  reply('stats', requestId, {
    elapsedMs,
    sampleCount: indices.length,
    allocatedBytes: totalAllocationBytes,
    outputBytes: allocatedBytes,
    ...(stateful ? {
      generatorId: stateful.generator.id,
      generatorStateBytes,
      generatorElapsedSeconds: stateful.state.elapsedSeconds,
    } : {}),
  });
}

async function handleMessage(message) {
  const { type, requestId, payload = {} } = message || {};
  try {
    if (type === 'initialize') {
      if (!Number.isSafeInteger(payload.generation) || payload.generation < 1) {
        throw new RangeError('Pattern Lab worker geometry generation must be a positive safe integer');
      }
      const nextGeometry = validatePatternLabWorkerGeometry(payload.geometry);
      disposeGeneratorRuntime();
      staticGeometry = nextGeometry;
      staticGeneration = payload.generation;
      initialized = true;
      reply('ready', requestId, {
        generation: staticGeneration,
        budgets: PATTERN_LAB_WORKER_BUDGETS,
        sourcePixelCount: staticGeometry.sourcePixelCount,
        visiblePixelCount: staticGeometry.visiblePixelCount,
        geometryBytes: staticGeometry.geometryBytes,
      });
      return;
    }
    if (type === 'cancel') {
      const targetRequestId = Number(payload.targetRequestId);
      if (Number.isSafeInteger(targetRequestId) && targetRequestId > 0
        && targetRequestId > lastHandledRequestId) cancelledRequests.add(targetRequestId);
      reply('stats', requestId, { cancelledRequestId: targetRequestId || null });
      return;
    }
    if (type === 'dispose') {
      disposeGeneratorRuntime();
      cancelledRequests.clear();
      staticGeometry = null;
      staticGeneration = 0;
      initialized = false;
      reply('stats', requestId, { disposed: true });
      globalThis.close();
      return;
    }
    if (type !== 'render') throw new RangeError(`Unsupported Pattern Lab worker request: ${String(type)}`);
    try {
      // Inside the try/finally on purpose: a render rejected before it starts must still
      // retire its id, or a cancel recorded against it would be retained forever.
      if (!initialized) throw new Error('Pattern Lab worker must be initialized before rendering');
      await renderRequest(requestId, payload);
    } finally {
      if (Number.isSafeInteger(requestId)) {
        lastHandledRequestId = Math.max(lastHandledRequestId, requestId);
        cancelledRequests.delete(requestId);
      }
    }
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
