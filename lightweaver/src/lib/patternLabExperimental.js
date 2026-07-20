export const PATTERN_LAB_EXPERIMENTAL_VERSION = 1;

export const PATTERN_LAB_EXPERIMENTAL_FEATURE_IDS = Object.freeze([
  'advancedGraph',
  'shaderBake',
  'cardArtnetRecord',
]);

export const PATTERN_LAB_EXPERIMENTAL_FLAGS = Object.freeze({
  advancedGraph: false,
  shaderBake: false,
  cardArtnetRecord: false,
});

export const PATTERN_LAB_EXPERIMENTAL_LOWERING_TARGETS = Object.freeze([
  'bounded-recipe',
  'lwseq',
]);

const MAX_RECIPE_LAYERS = 3;
const MAX_RECIPE_BYTES = 256 * 1024;
const MAX_LWSEQ_PIXELS = 1024;
const MAX_LWSEQ_FPS = 24;
const MAX_LWSEQ_FRAMES = 24 * 60 * 15;
const LWSEQ_HEADER_BYTES = 64;

export const PATTERN_LAB_CARD_RECORD_HARDWARE_GATES = deepFreeze([
  {
    id: 'sd-sustained-write',
    label: 'Sustained microSD write throughput',
    required: true,
    status: 'unverified-on-hardware',
  },
  {
    id: 'dropped-frame-accounting',
    label: 'Dropped-frame detection and accounting',
    required: true,
    status: 'unverified-on-hardware',
  },
  {
    id: 'power-loss',
    label: 'Power-loss interruption safety',
    required: true,
    status: 'unverified-on-hardware',
  },
  {
    id: 'filesystem-recovery',
    label: 'Filesystem recovery after interrupted capture',
    required: true,
    status: 'unverified-on-hardware',
  },
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${name} contains unknown or raw field: ${key}`);
  }
}

function wholeNumber(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function validatePatternLabExperimentalFlags(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Pattern Lab experimental flags must be an object');
  }
  for (const [key, value] of Object.entries(input)) {
    if (!PATTERN_LAB_EXPERIMENTAL_FEATURE_IDS.includes(key)) {
      throw new TypeError(`Unknown Pattern Lab experimental flag: ${key}`);
    }
    if (typeof value !== 'boolean') {
      throw new TypeError(`Pattern Lab experimental flag ${key} must be boolean`);
    }
  }
  return deepFreeze({ ...PATTERN_LAB_EXPERIMENTAL_FLAGS, ...input });
}

export function createPatternLabExperimentalDescriptor(flags = {}) {
  const validatedFlags = validatePatternLabExperimentalFlags(flags);
  const bakeFeature = (id, sourceKind) => ({
    id,
    enabled: validatedFlags[id],
    status: validatedFlags[id] ? 'experimental' : 'disabled',
    runtimePath: null,
    sourceKind,
    delivery: 'bake-only',
    cardNative: false,
    allowedLowerings: [...PATTERN_LAB_EXPERIMENTAL_LOWERING_TARGETS],
  });
  const features = {
    advancedGraph: bakeFeature('advancedGraph', 'bounded-graph'),
    shaderBake: bakeFeature('shaderBake', 'shader'),
    cardArtnetRecord: {
      id: 'cardArtnetRecord',
      enabled: validatedFlags.cardArtnetRecord,
      status: validatedFlags.cardArtnetRecord ? 'hardware-validation-required' : 'disabled',
      runtimePath: null,
      preferredCapture: 'studio-known-frames',
      cardCaptureAvailable: false,
      hardwareApprovalRequired: true,
      hardwareGates: PATTERN_LAB_CARD_RECORD_HARDWARE_GATES,
    },
  };
  return deepFreeze({
    version: PATTERN_LAB_EXPERIMENTAL_VERSION,
    flags: validatedFlags,
    runtime: {
      imports: [],
      paths: [],
      workers: [],
      network: [],
      storage: [],
    },
    features,
  });
}

function sameDescriptorValue(actual, expected) {
  if (actual === expected) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return actualKeys.every(key => sameDescriptorValue(actual[key], expected[key]));
}

export function validatePatternLabExperimentalDescriptor(input) {
  plainObject(input, 'Pattern Lab experimental descriptor');
  if (input.version !== PATTERN_LAB_EXPERIMENTAL_VERSION) {
    throw new RangeError(`Unsupported Pattern Lab experimental descriptor version: ${String(input.version)}`);
  }
  const flags = validatePatternLabExperimentalFlags(input.flags);
  if (input.features?.advancedGraph?.cardNative === true
    || input.features?.shaderBake?.cardNative === true) {
    throw new TypeError('Experimental graph and shader sources must never be card-native');
  }
  const canonical = createPatternLabExperimentalDescriptor(flags);
  if (!sameDescriptorValue(input, canonical)) {
    throw new TypeError('Pattern Lab experimental descriptor does not match its safe canonical contract');
  }
  return canonical;
}

function validateRecipeArtifact(input) {
  const artifact = plainObject(input, 'Bounded Recipe artifact');
  exactKeys(artifact, ['kind', 'version', 'layerCount', 'byteLength'], 'Bounded Recipe artifact');
  if (artifact.kind !== 'pattern-lab-recipe') throw new TypeError('Bounded Recipe artifact kind is invalid');
  if (artifact.version !== 1) throw new RangeError('Bounded Recipe artifact version must be 1');
  wholeNumber(artifact.layerCount, 'Bounded Recipe layer count', 0, MAX_RECIPE_LAYERS);
  wholeNumber(artifact.byteLength, 'Bounded Recipe byteLength', 1, MAX_RECIPE_BYTES);
  return { ...artifact };
}

function validateLwseqArtifact(input) {
  const artifact = plainObject(input, 'LWSEQ artifact');
  exactKeys(
    artifact,
    ['kind', 'version', 'pixelCount', 'fps', 'frameCount', 'byteLength'],
    'LWSEQ artifact',
  );
  if (artifact.kind !== 'lwseq') throw new TypeError('LWSEQ artifact kind is invalid');
  if (artifact.version !== 1) throw new RangeError('LWSEQ artifact version must be 1');
  wholeNumber(artifact.pixelCount, 'LWSEQ pixel count', 1, MAX_LWSEQ_PIXELS);
  wholeNumber(artifact.fps, 'LWSEQ FPS', 1, MAX_LWSEQ_FPS);
  wholeNumber(artifact.frameCount, 'LWSEQ frame count', 1, MAX_LWSEQ_FRAMES);
  const expectedBytes = LWSEQ_HEADER_BYTES + artifact.pixelCount * 3 * artifact.frameCount;
  if (artifact.byteLength !== expectedBytes) {
    throw new RangeError(`LWSEQ byteLength must match its pixel and frame counts (${expectedBytes})`);
  }
  return { ...artifact };
}

export function createPatternLabExperimentalLowering(input) {
  const source = plainObject(input, 'Pattern Lab experimental lowering');
  exactKeys(source, ['featureId', 'target', 'artifact'], 'Pattern Lab experimental lowering');
  if (!['advancedGraph', 'shaderBake'].includes(source.featureId)) {
    throw new TypeError('Experimental lowering feature must be advancedGraph or shaderBake');
  }
  if (!PATTERN_LAB_EXPERIMENTAL_LOWERING_TARGETS.includes(source.target)) {
    throw new TypeError('Experimental sources must lower to bounded-recipe or lwseq, never card-native');
  }
  const artifact = source.target === 'bounded-recipe'
    ? validateRecipeArtifact(source.artifact)
    : validateLwseqArtifact(source.artifact);
  return deepFreeze({
    version: PATTERN_LAB_EXPERIMENTAL_VERSION,
    featureId: source.featureId,
    sourceKind: source.featureId === 'advancedGraph' ? 'bounded-graph' : 'shader',
    delivery: 'bake-only',
    cardNative: false,
    target: source.target,
    artifact,
  });
}

export function createPatternLabStudioRecordingDescriptor(input) {
  const source = plainObject(input, 'Pattern Lab Studio recording');
  exactKeys(source, ['pixelCount', 'fps', 'frameCount'], 'Pattern Lab Studio recording');
  const pixelCount = wholeNumber(source.pixelCount, 'Studio recording pixel count', 1, MAX_LWSEQ_PIXELS);
  const fps = wholeNumber(source.fps, 'Studio recording FPS', 1, MAX_LWSEQ_FPS);
  const frameCount = wholeNumber(source.frameCount, 'Studio recording frame count', 1, MAX_LWSEQ_FRAMES);
  return deepFreeze({
    version: PATTERN_LAB_EXPERIMENTAL_VERSION,
    kind: 'studio-known-frame-recording',
    captureLocation: 'studio',
    frameSource: 'known-render-frames',
    delivery: 'lwseq',
    cardNative: false,
    cardCapture: false,
    pixelCount,
    fps,
    frameCount,
    durationSeconds: frameCount / fps,
    expectedByteLength: LWSEQ_HEADER_BYTES + pixelCount * 3 * frameCount,
  });
}

export function validatePatternLabStudioRecordingDescriptor(input) {
  plainObject(input, 'Pattern Lab Studio recording descriptor');
  if (input.cardCapture !== false || input.captureLocation !== 'studio') {
    throw new TypeError('Studio known-frame descriptors cannot claim card capture');
  }
  const canonical = createPatternLabStudioRecordingDescriptor({
    pixelCount: input.pixelCount,
    fps: input.fps,
    frameCount: input.frameCount,
  });
  if (!sameDescriptorValue(input, canonical)) {
    throw new TypeError('Pattern Lab Studio recording descriptor does not match its safe canonical contract');
  }
  return canonical;
}
