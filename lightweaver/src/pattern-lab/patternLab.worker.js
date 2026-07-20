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

let initialized = false;
let staticGeometry = null;
let staticGeneration = 0;
const cancelledRequests = new Set();
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

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
}

function disposeGeneratorRuntime() {
  if (!generatorRuntime) return;
  generatorRuntime.generator.dispose(generatorRuntime.state);
  generatorRuntime = null;
}

function statefulPattern(recipe, indices) {
  const generatorId = recipe?.base?.kind;
  if (!PATTERN_LAB_GENERATOR_IDS.includes(generatorId)) {
    disposeGeneratorRuntime();
    return null;
  }
  const generator = getPatternLabGenerator(generatorId);
  const inputs = resolvePatternLabGeneratorInputs(generatorId, recipe);
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
  const stateful = statefulPattern({ ...recipe, time: payload.time }, indices);
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
  const frame = renderPixelFrame({
    t: Number(payload.time) || 0,
    strips: sampledStrips(geometry, indices),
    patternId: recipe.base?.patternId,
    activeFn,
    params: recipe.base?.params || {},
    paletteNorm: normalizePalette(recipe.palette),
    bpm: geometry.bpm,
    masterSpeed: options.masterSpeed,
    masterBrightness: options.masterBrightness,
    masterSaturation: options.masterSaturation,
    masterHueShift: options.masterHueShift,
    gammaLUT: buildGammaLut(geometry.gammaEnabled, geometry.gammaValue),
    symSettings: geometry.symSettings,
    audioBands: geometry.audioBands,
    normBounds: geometry.normalizationBounds,
  });
  if (cancelledRequests.delete(requestId)) return;

  const colors = new Uint8ClampedArray(frame.pixels.length * 3);
  frame.pixels.forEach((color, index) => {
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
      if (Number.isSafeInteger(targetRequestId) && targetRequestId > 0) cancelledRequests.add(targetRequestId);
      reply('stats', requestId, { cancelledRequestId: targetRequestId || null });
      return;
    }
    if (type === 'dispose') {
      disposeGeneratorRuntime();
      staticGeometry = null;
      staticGeneration = 0;
      initialized = false;
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
