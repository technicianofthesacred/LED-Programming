export const PATTERN_LAB_GENERATOR_IDS = Object.freeze([
  'particles',
  'ripple',
  'random-walkers',
  'cellular-field',
  'gray-scott-1d',
]);

export const PATTERN_LAB_GENERATOR_BUDGETS = Object.freeze({
  maxSamples: 1024,
  maxStateBytes: 256 * 1024,
  maxDeltaSeconds: 900,
  maxSimulationStepsPerUpdate: 64,
});

const ADVANCED = {
  particles: [
    ['particleCount', 'Particle count', 4, 96, 32, true],
    ['drag', 'Drift drag', 0, 1, 0.18, false],
  ],
  ripple: [
    ['emitterCount', 'Ripple sources', 1, 12, 5, true],
    ['frequency', 'Wave frequency', 1, 18, 7, false],
    ['damping', 'Wave damping', 0.8, 1, 0.94, false],
  ],
  'random-walkers': [
    ['walkerCount', 'Walker count', 2, 64, 18, true],
    ['turnRate', 'Direction changes', 0.1, 8, 1.4, false],
    ['trailWidth', 'Trail width', 0.01, 0.3, 0.075, false],
  ],
  'cellular-field': [
    ['rule', 'Cell rule', 0, 255, 110, true],
    ['stepsPerSecond', 'Cell steps', 0.25, 24, 5, false],
  ],
  'gray-scott-1d': [
    ['feed', 'Feed', 0.01, 0.08, 0.0367, false],
    ['kill', 'Kill', 0.03, 0.08, 0.0649, false],
    ['diffusionU', 'Diffusion U', 0.01, 0.25, 0.16, false],
    ['diffusionV', 'Diffusion V', 0.005, 0.15, 0.08, false],
    ['stepsPerSecond', 'Simulation steps', 0.25, 24, 8, false],
  ],
};

function freezeControls() {
  const result = {};
  const artistic = Object.freeze(['Color', 'Movement', 'Shape', 'Texture', 'Energy']);
  for (const id of PATTERN_LAB_GENERATOR_IDS) {
    result[id] = Object.freeze({
      artistic,
      advanced: Object.freeze(ADVANCED[id].map(([key, label, minimum, maximum, defaultValue]) => (
        Object.freeze({ key, label, minimum, maximum, defaultValue })
      ))),
    });
  }
  return Object.freeze(result);
}

export const PATTERN_LAB_GENERATOR_CONTROLS = freezeControls();

const TAU = Math.PI * 2;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum, fallback = minimum) {
  return Math.min(maximum, Math.max(minimum, finite(value, fallback)));
}

function clamp01(value, fallback = 0.5) {
  return clamp(value, 0, 1, fallback);
}

function fract(value) {
  return value - Math.floor(value);
}

function hash(seed) {
  let value = Number(seed) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 0x100000000;
}

function validateContext(context = {}) {
  const sampleCount = Number(context.sampleCount);
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1
    || sampleCount > PATTERN_LAB_GENERATOR_BUDGETS.maxSamples) {
    throw new RangeError(`Pattern Lab generator sample count must be between 1 and ${PATTERN_LAB_GENERATOR_BUDGETS.maxSamples}`);
  }
  return { sampleCount, seed: Number(context.seed) >>> 0 };
}

function baseState(context, fields) {
  const { sampleCount, seed } = validateContext(context);
  return {
    generatorId: fields.generatorId,
    sampleCount,
    seed,
    elapsedSeconds: 0,
    disposed: false,
    ...fields,
  };
}

function requireLiveState(state, generatorId) {
  if (!state || state.generatorId !== generatorId) {
    throw new TypeError(`Pattern Lab ${generatorId} state is invalid`);
  }
  if (state.disposed) throw new Error(`Pattern Lab ${generatorId} state has been disposed`);
}

function advanceTime(delta, state) {
  const seconds = clamp(delta, 0, PATTERN_LAB_GENERATOR_BUDGETS.maxDeltaSeconds, 0);
  state.elapsedSeconds += seconds;
  return seconds;
}

function circularDistance(a, b) {
  const distance = Math.abs(a - b);
  return Math.min(distance, 1 - distance);
}

function coordinateProgress(pixel, coordinates, sampleCount) {
  const explicit = Number(coordinates?.stripProgress ?? coordinates?.p);
  if (Number.isFinite(explicit)) return clamp01(explicit, 0);
  const index = Number(coordinates?.index ?? pixel);
  return sampleCount > 1 ? clamp(index, 0, sampleCount - 1, 0) / (sampleCount - 1) : 0.5;
}

function colorFromLevel(level, state, offset = 0) {
  const intensity = clamp01(level, 0) * clamp01(state.intensity, 0.5);
  const phase = fract(state.colorShift + offset);
  const red = 0.35 + 0.65 * Math.max(0, Math.sin(TAU * (phase + 0.02)) * 0.5 + 0.5);
  const green = 0.22 + 0.78 * Math.max(0, Math.sin(TAU * (phase + 0.69)) * 0.5 + 0.5);
  const blue = 0.3 + 0.7 * Math.max(0, Math.sin(TAU * (phase + 0.36)) * 0.5 + 0.5);
  return {
    r: Math.round(255 * intensity * red),
    g: Math.round(255 * intensity * green),
    b: Math.round(255 * intensity * blue),
  };
}

function updateArtisticState(state, inputs) {
  const artistic = inputs?.artistic || DEFAULT_INPUTS.artistic;
  state.speed = clamp(artistic.speed, 0.15, 3, 1.575);
  state.intensity = clamp01(artistic.intensity, 0.56);
  state.density = clamp01(artistic.density, 0.55);
  state.scale = clamp(artistic.scale, 0.5, 3, 1.75);
  state.colorShift = clamp01(artistic.colorShift, 0.5);
}

function disposeTypedState(state, generatorId) {
  requireLiveState(state, generatorId);
  for (const value of Object.values(state)) {
    if (ArrayBuffer.isView(value) && typeof value.fill === 'function') value.fill(0);
  }
  state.disposed = true;
}

export function measurePatternLabGeneratorStateBytes(state) {
  if (!state || typeof state !== 'object') throw new TypeError('Pattern Lab generator state is required');
  return Object.values(state).reduce(
    (total, value) => total + (ArrayBuffer.isView(value) ? value.byteLength : 0),
    0,
  );
}

const DEFAULT_INPUTS = Object.freeze({
  artistic: Object.freeze({ speed: 1.575, intensity: 0.56, density: 0.55, scale: 1.75, colorShift: 0.5 }),
  advanced: Object.freeze({}),
});

export function resolvePatternLabGeneratorInputs(generatorId, recipe = {}) {
  if (!PATTERN_LAB_GENERATOR_IDS.includes(generatorId)) {
    throw new RangeError(`Unknown Pattern Lab generator: ${String(generatorId)}`);
  }
  const macros = recipe?.macros || {};
  const artistic = Object.freeze({
    speed: 0.15 + clamp01(macros.movement) * 2.85,
    intensity: 0.12 + clamp01(macros.energy) * 0.88,
    density: 0.1 + clamp01(macros.texture) * 0.9,
    scale: 0.5 + clamp01(macros.shape) * 2.5,
    colorShift: clamp01(macros.color),
  });
  const source = recipe?.base?.params?.advanced || {};
  const advanced = {};
  for (const [key, _label, minimum, maximum, defaultValue, integer] of ADVANCED[generatorId]) {
    const bounded = clamp(source[key], minimum, maximum, defaultValue);
    advanced[key] = integer ? Math.round(bounded) : bounded;
  }
  return Object.freeze({ artistic, advanced: Object.freeze(advanced) });
}

const particles = Object.freeze({
  id: 'particles',
  initialize(context) {
    const validated = validateContext(context);
    const count = Math.min(validated.sampleCount, 96);
    const positions = new Float32Array(count);
    const velocities = new Float32Array(count);
    const luminosity = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      positions[index] = hash(validated.seed + index * 17);
      velocities[index] = (hash(validated.seed + index * 17 + 1) - 0.5) * 0.08;
      luminosity[index] = 0.35 + hash(validated.seed + index * 17 + 2) * 0.65;
    }
    return baseState(validated, {
      generatorId: 'particles', positions, velocities, luminosity,
      speed: DEFAULT_INPUTS.artistic.speed, intensity: DEFAULT_INPUTS.artistic.intensity,
      density: DEFAULT_INPUTS.artistic.density, scale: DEFAULT_INPUTS.artistic.scale,
      colorShift: DEFAULT_INPUTS.artistic.colorShift, particleCount: Math.min(count, 32),
    });
  },
  update(delta, state, inputs = DEFAULT_INPUTS) {
    requireLiveState(state, 'particles');
    const seconds = advanceTime(delta, state);
    updateArtisticState(state, inputs);
    const active = Math.min(state.positions.length, inputs.advanced?.particleCount ?? 32);
    state.particleCount = active;
    const drag = clamp(inputs.advanced?.drag, 0, 1, 0.18);
    for (let index = 0; index < active; index += 1) {
      state.positions[index] = fract(state.positions[index]
        + state.velocities[index] * seconds * state.speed * (1 - drag * 0.7) + 1);
    }
    return state;
  },
  render(pixel, coordinates, state) {
    requireLiveState(state, 'particles');
    const progress = coordinateProgress(pixel, coordinates, state.sampleCount);
    const width = 0.012 + state.density * 0.075 / state.scale;
    let level = 0;
    for (let index = 0; index < state.particleCount; index += 1) {
      const distance = circularDistance(progress, state.positions[index]);
      if (distance < width * 4) {
        level = Math.max(
          level,
          Math.exp(-distance * distance / (2 * width * width)) * state.luminosity[index],
        );
      }
    }
    return colorFromLevel(Math.min(1, level), state, progress * 0.18);
  },
  dispose(state) { disposeTypedState(state, 'particles'); },
});

const ripple = Object.freeze({
  id: 'ripple',
  initialize(context) {
    const validated = validateContext(context);
    const centers = new Float32Array(12);
    const phases = new Float32Array(12);
    const strengths = new Float32Array(12);
    for (let index = 0; index < centers.length; index += 1) {
      centers[index] = hash(validated.seed + index * 23);
      phases[index] = hash(validated.seed + index * 23 + 1) * TAU;
      strengths[index] = 0.45 + hash(validated.seed + index * 23 + 2) * 0.55;
    }
    return baseState(validated, {
      generatorId: 'ripple', centers, phases, strengths,
      speed: DEFAULT_INPUTS.artistic.speed, intensity: DEFAULT_INPUTS.artistic.intensity,
      density: DEFAULT_INPUTS.artistic.density, scale: DEFAULT_INPUTS.artistic.scale,
      colorShift: DEFAULT_INPUTS.artistic.colorShift, frequency: 7, damping: 0.94, emitterCount: 5,
    });
  },
  update(delta, state, inputs = DEFAULT_INPUTS) {
    requireLiveState(state, 'ripple');
    const seconds = advanceTime(delta, state);
    updateArtisticState(state, inputs);
    state.frequency = clamp(inputs.advanced?.frequency, 1, 18, 7);
    state.damping = clamp(inputs.advanced?.damping, 0.8, 1, 0.94);
    state.emitterCount = Math.min(state.centers.length, Math.round(clamp(inputs.advanced?.emitterCount, 1, 12, 5)));
    for (let index = 0; index < state.phases.length; index += 1) {
      state.phases[index] = fract(state.phases[index] / TAU + seconds * state.speed * (0.025 + index * 0.001)) * TAU;
    }
    return state;
  },
  render(pixel, coordinates, state) {
    requireLiveState(state, 'ripple');
    const progress = coordinateProgress(pixel, coordinates, state.sampleCount);
    let level = 0;
    for (let index = 0; index < state.emitterCount; index += 1) {
      const distance = circularDistance(progress, state.centers[index]);
      const wave = Math.sin(distance * state.frequency * TAU - state.phases[index]) * 0.5 + 0.5;
      level = Math.max(level, wave * state.strengths[index] * Math.pow(state.damping, distance * 20));
    }
    return colorFromLevel(level, state, progress * 0.25);
  },
  dispose(state) { disposeTypedState(state, 'ripple'); },
});

const randomWalkers = Object.freeze({
  id: 'random-walkers',
  initialize(context) {
    const validated = validateContext(context);
    const count = Math.min(validated.sampleCount, 64);
    const positions = new Float32Array(count);
    const directions = new Float32Array(count);
    const accents = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      positions[index] = hash(validated.seed + index * 31);
      directions[index] = hash(validated.seed + index * 31 + 1) < 0.5 ? -1 : 1;
      accents[index] = hash(validated.seed + index * 31 + 2);
    }
    return baseState(validated, {
      generatorId: 'random-walkers', positions, directions, accents,
      speed: DEFAULT_INPUTS.artistic.speed, intensity: DEFAULT_INPUTS.artistic.intensity,
      density: DEFAULT_INPUTS.artistic.density, scale: DEFAULT_INPUTS.artistic.scale,
      colorShift: DEFAULT_INPUTS.artistic.colorShift, walkerCount: 18, turnRate: 1.4, trailWidth: 0.075,
    });
  },
  update(delta, state, inputs = DEFAULT_INPUTS) {
    requireLiveState(state, 'random-walkers');
    const seconds = advanceTime(delta, state);
    updateArtisticState(state, inputs);
    state.walkerCount = Math.min(state.positions.length, Math.round(clamp(inputs.advanced?.walkerCount, 2, 64, 18)));
    state.turnRate = clamp(inputs.advanced?.turnRate, 0.1, 8, 1.4);
    state.trailWidth = clamp(inputs.advanced?.trailWidth, 0.01, 0.3, 0.075);
    const turn = Math.floor(state.elapsedSeconds * state.turnRate);
    for (let index = 0; index < state.walkerCount; index += 1) {
      state.directions[index] = hash(state.seed + index * 43 + turn * 101) < 0.5 ? -1 : 1;
      state.positions[index] = fract(state.positions[index]
        + state.directions[index] * seconds * state.speed * (0.004 + state.accents[index] * 0.006) + 1);
    }
    return state;
  },
  render(pixel, coordinates, state) {
    requireLiveState(state, 'random-walkers');
    const progress = coordinateProgress(pixel, coordinates, state.sampleCount);
    let level = 0;
    for (let index = 0; index < state.walkerCount; index += 1) {
      const distance = circularDistance(progress, state.positions[index]);
      level = Math.max(level, Math.max(0, 1 - distance / state.trailWidth) * (0.45 + state.accents[index] * 0.55));
    }
    return colorFromLevel(level, state, progress * 0.4);
  },
  dispose(state) { disposeTypedState(state, 'random-walkers'); },
});

function cellularStep(state) {
  const { cells, nextCells, rule } = state;
  for (let index = 0; index < cells.length; index += 1) {
    const left = cells[(index + cells.length - 1) % cells.length];
    const center = cells[index];
    const right = cells[(index + 1) % cells.length];
    const bit = (left << 2) | (center << 1) | right;
    nextCells[index] = (rule >>> bit) & 1;
  }
  cells.set(nextCells);
}

const cellularField = Object.freeze({
  id: 'cellular-field',
  initialize(context) {
    const validated = validateContext(context);
    const cells = new Uint8Array(validated.sampleCount);
    const nextCells = new Uint8Array(validated.sampleCount);
    for (let index = 0; index < cells.length; index += 1) {
      cells[index] = hash(validated.seed + index * 53) > 0.68 ? 1 : 0;
    }
    cells[validated.seed % cells.length] = 1;
    return baseState(validated, {
      generatorId: 'cellular-field', cells, nextCells, accumulator: 0,
      speed: DEFAULT_INPUTS.artistic.speed, intensity: DEFAULT_INPUTS.artistic.intensity,
      density: DEFAULT_INPUTS.artistic.density, scale: DEFAULT_INPUTS.artistic.scale,
      colorShift: DEFAULT_INPUTS.artistic.colorShift, rule: 110, stepsPerSecond: 5,
    });
  },
  update(delta, state, inputs = DEFAULT_INPUTS) {
    requireLiveState(state, 'cellular-field');
    const seconds = advanceTime(delta, state);
    updateArtisticState(state, inputs);
    state.rule = Math.round(clamp(inputs.advanced?.rule, 0, 255, 110));
    state.stepsPerSecond = clamp(inputs.advanced?.stepsPerSecond, 0.25, 24, 5) * (0.5 + state.speed * 0.5);
    state.accumulator += seconds * state.stepsPerSecond;
    const steps = Math.min(
      PATTERN_LAB_GENERATOR_BUDGETS.maxSimulationStepsPerUpdate,
      Math.floor(state.accumulator),
    );
    state.accumulator -= steps;
    for (let step = 0; step < steps; step += 1) cellularStep(state);
    return state;
  },
  render(pixel, coordinates, state) {
    requireLiveState(state, 'cellular-field');
    const progress = coordinateProgress(pixel, coordinates, state.sampleCount);
    const index = Math.min(state.cells.length - 1, Math.floor(progress * state.cells.length));
    const near = state.cells[index]
      + state.cells[(index + state.cells.length - 1) % state.cells.length] * 0.35
      + state.cells[(index + 1) % state.cells.length] * 0.35;
    return colorFromLevel(Math.min(1, near * (0.45 + state.density * 0.55)), state, progress * 0.3);
  },
  dispose(state) { disposeTypedState(state, 'cellular-field'); },
});

function grayScottStep(state) {
  const { u, v, nextU, nextV, feed, kill, diffusionU, diffusionV } = state;
  for (let index = 0; index < u.length; index += 1) {
    const left = (index + u.length - 1) % u.length;
    const right = (index + 1) % u.length;
    const lapU = u[left] - 2 * u[index] + u[right];
    const lapV = v[left] - 2 * v[index] + v[right];
    const reaction = u[index] * v[index] * v[index];
    nextU[index] = clamp(u[index] + diffusionU * lapU - reaction + feed * (1 - u[index]), 0, 1, 0);
    nextV[index] = clamp(v[index] + diffusionV * lapV + reaction - (feed + kill) * v[index], 0, 1, 0);
  }
  u.set(nextU);
  v.set(nextV);
}

const grayScott = Object.freeze({
  id: 'gray-scott-1d',
  initialize(context) {
    const validated = validateContext(context);
    const u = new Float32Array(validated.sampleCount);
    const v = new Float32Array(validated.sampleCount);
    const nextU = new Float32Array(validated.sampleCount);
    const nextV = new Float32Array(validated.sampleCount);
    u.fill(1);
    const center = validated.seed % validated.sampleCount;
    const width = Math.max(1, Math.floor(validated.sampleCount / 16));
    for (let offset = -width; offset <= width; offset += 1) {
      const index = (center + offset + validated.sampleCount) % validated.sampleCount;
      u[index] = 0.45 + hash(validated.seed + offset + 1000) * 0.1;
      v[index] = 0.2 + hash(validated.seed + offset + 2000) * 0.35;
    }
    return baseState(validated, {
      generatorId: 'gray-scott-1d', u, v, nextU, nextV, accumulator: 0,
      speed: DEFAULT_INPUTS.artistic.speed, intensity: DEFAULT_INPUTS.artistic.intensity,
      density: DEFAULT_INPUTS.artistic.density, scale: DEFAULT_INPUTS.artistic.scale,
      colorShift: DEFAULT_INPUTS.artistic.colorShift,
      feed: 0.0367, kill: 0.0649, diffusionU: 0.16, diffusionV: 0.08, stepsPerSecond: 8,
    });
  },
  update(delta, state, inputs = DEFAULT_INPUTS) {
    requireLiveState(state, 'gray-scott-1d');
    const seconds = advanceTime(delta, state);
    updateArtisticState(state, inputs);
    state.feed = clamp(inputs.advanced?.feed, 0.01, 0.08, 0.0367);
    state.kill = clamp(inputs.advanced?.kill, 0.03, 0.08, 0.0649);
    state.diffusionU = clamp(inputs.advanced?.diffusionU, 0.01, 0.25, 0.16);
    state.diffusionV = clamp(inputs.advanced?.diffusionV, 0.005, 0.15, 0.08);
    state.stepsPerSecond = clamp(inputs.advanced?.stepsPerSecond, 0.25, 24, 8) * (0.5 + state.speed * 0.25);
    state.accumulator += seconds * state.stepsPerSecond;
    const steps = Math.min(
      PATTERN_LAB_GENERATOR_BUDGETS.maxSimulationStepsPerUpdate,
      Math.floor(state.accumulator),
    );
    state.accumulator -= steps;
    for (let step = 0; step < steps; step += 1) grayScottStep(state);
    return state;
  },
  render(pixel, coordinates, state) {
    requireLiveState(state, 'gray-scott-1d');
    const progress = coordinateProgress(pixel, coordinates, state.sampleCount);
    const index = Math.min(state.v.length - 1, Math.floor(progress * state.v.length));
    const level = clamp01((state.v[index] - state.u[index] + 1) * (0.35 + state.density * 0.65), 0);
    return colorFromLevel(level, state, progress * 0.22 + state.v[index] * 0.2);
  },
  dispose(state) { disposeTypedState(state, 'gray-scott-1d'); },
});

const GENERATORS = Object.freeze({
  particles,
  ripple,
  'random-walkers': randomWalkers,
  'cellular-field': cellularField,
  'gray-scott-1d': grayScott,
});

export function getPatternLabGenerator(generatorId) {
  const generator = GENERATORS[generatorId];
  if (!generator) throw new RangeError(`Unknown Pattern Lab generator: ${String(generatorId)}`);
  return generator;
}

const MAX_OPERATIONS_PER_SAMPLE = Object.freeze({
  particles: 96 * 12 + 12,
  ripple: 12 * 12 + 12,
  'random-walkers': 64 * 10 + 12,
  'cellular-field': PATTERN_LAB_GENERATOR_BUDGETS.maxSimulationStepsPerUpdate * 8 + 16,
  'gray-scott-1d': PATTERN_LAB_GENERATOR_BUDGETS.maxSimulationStepsPerUpdate * 40 + 20,
});

export function estimatePatternLabGeneratorBudgets(generatorId, context = {}) {
  const sampleCount = Math.min(
    PATTERN_LAB_GENERATOR_BUDGETS.maxSamples,
    Math.max(1, Math.trunc(Number(context.sampleCount) || 0)),
  );
  const generator = getPatternLabGenerator(generatorId);
  const state = generator.initialize({ sampleCount, seed: Number(context.seed) >>> 0 });
  try {
    return Object.freeze({
      sampleCount,
      stateBytes: measurePatternLabGeneratorStateBytes(state),
      operationsPerFrame: sampleCount * MAX_OPERATIONS_PER_SAMPLE[generatorId],
    });
  } finally {
    generator.dispose(state);
  }
}
