import {
  assertPatternLabJsonSafe,
  normalizePatternLabRecipe,
} from './patternLabRecipe.js';

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

const MAX_RECIPE_BYTES = 256 * 1024;
const MAX_LWSEQ_PIXELS = 1024;
const MAX_LWSEQ_FPS = 24;
const MAX_LWSEQ_FRAMES = 24 * 60 * 15;
const LWSEQ_HEADER_BYTES = 64;
const MAX_LWSEQ_BYTES = LWSEQ_HEADER_BYTES + MAX_LWSEQ_PIXELS * 3 * MAX_LWSEQ_FRAMES;

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

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property && Object.hasOwn(property, 'value')) deepFreeze(property.value, seen);
  }
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
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${name} must not contain symbol keys`);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property?.get || property?.set) throw new TypeError(`${name} must not contain accessor properties`);
    if (!allowed.includes(key)) throw new TypeError(`${name} contains unknown or raw field: ${key}`);
  }
}

function assertPlainDataTree(value, name, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must not contain non-finite numbers`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${name} must not contain ${typeof value} values`);
  const prototype = Object.getPrototypeOf(value);
  const validPrototype = Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
  if (!validPrototype) throw new TypeError(`${name} must contain only plain object and array prototypes`);
  if (ancestors.has(value)) throw new TypeError(`${name} must not contain cyclic values`);
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${name} must not contain symbol keys`);
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property?.get || property?.set) throw new TypeError(`${name} must not contain accessor properties`);
    if (property && Object.hasOwn(property, 'value')) {
      assertPlainDataTree(property.value, name, ancestors);
    }
  }
  ancestors.delete(value);
}

function wholeNumber(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function validatePatternLabExperimentalFlags(input = {}) {
  plainObject(input, 'Pattern Lab experimental flags');
  exactKeys(input, PATTERN_LAB_EXPERIMENTAL_FEATURE_IDS, 'Pattern Lab experimental flags');
  assertPlainDataTree(input, 'Pattern Lab experimental flags');
  const flags = { ...PATTERN_LAB_EXPERIMENTAL_FLAGS };
  for (const key of PATTERN_LAB_EXPERIMENTAL_FEATURE_IDS) {
    if (Object.hasOwn(input, key) && typeof input[key] !== 'boolean') {
      throw new TypeError(`Pattern Lab experimental flag ${key} must be boolean`);
    }
    if (Object.hasOwn(input, key)) flags[key] = input[key];
  }
  return deepFreeze(flags);
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
      studioRecordingAuthorized: validatedFlags.cardArtnetRecord,
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

function sameDescriptorValue(actual, expected, seen = new WeakMap()) {
  if (actual === expected) return true;
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  let expectedSeen = seen.get(actual);
  if (!expectedSeen) {
    expectedSeen = new WeakSet();
    seen.set(actual, expectedSeen);
  } else if (expectedSeen.has(expected)) return true;
  expectedSeen.add(expected);
  const actualKeys = Reflect.ownKeys(actual);
  const expectedKeys = Reflect.ownKeys(expected);
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some(key => !expectedKeys.includes(key))) return false;
  return actualKeys.every(key => {
    const actualProperty = Object.getOwnPropertyDescriptor(actual, key);
    const expectedProperty = Object.getOwnPropertyDescriptor(expected, key);
    if (!actualProperty || !expectedProperty
      || actualProperty.get || actualProperty.set || expectedProperty.get || expectedProperty.set) return false;
    return sameDescriptorValue(actualProperty.value, expectedProperty.value, seen);
  });
}

export function validatePatternLabExperimentalDescriptor(input) {
  plainObject(input, 'Pattern Lab experimental descriptor');
  assertPlainDataTree(input, 'Pattern Lab experimental descriptor');
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

function requireEnabledFeature(descriptor, featureId) {
  const canonical = validatePatternLabExperimentalDescriptor(descriptor);
  if (canonical.flags[featureId] !== true || canonical.features[featureId]?.enabled !== true) {
    throw new Error(`Pattern Lab experimental feature ${featureId} is disabled`);
  }
  return canonical;
}

function requireStudioRecordingAuthorization(descriptor) {
  const canonical = validatePatternLabExperimentalDescriptor(descriptor);
  const recording = canonical.features.cardArtnetRecord;
  if (canonical.flags.cardArtnetRecord !== true
    || recording?.enabled !== true
    || recording.studioRecordingAuthorized !== true) {
    throw new Error('Pattern Lab Studio recording is disabled and not authorized');
  }
  return canonical;
}

function rejectExecutableFields(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`Canonical Recipe must not contain symbol keys at ${path}`);
    if (/^(?:sourceCode|glsl|javascript|shaderSource|graphSource)$/i.test(key)) {
      throw new TypeError(`Canonical Recipe must not contain executable source field ${path}.${key}`);
    }
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property && Object.hasOwn(property, 'value')) rejectExecutableFields(property.value, `${path}.${key}`);
  }
}

function validateCanonicalRecipe(input) {
  assertPlainDataTree(input, 'Canonical Pattern Lab Recipe');
  rejectExecutableFields(input);
  const payload = normalizePatternLabRecipe(input);
  assertPatternLabJsonSafe(payload);
  assertPlainDataTree(payload, 'Canonical Pattern Lab Recipe');
  rejectExecutableFields(payload);
  const byteLength = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (byteLength > MAX_RECIPE_BYTES) {
    throw new RangeError(`Canonical Pattern Lab Recipe exceeds ${MAX_RECIPE_BYTES} bytes`);
  }
  return deepFreeze({
    kind: 'pattern-lab-recipe',
    version: 1,
    byteLength,
    payload,
  });
}

async function digestSha256(bytes) {
  const cryptoImpl = globalThis.crypto;
  if (!cryptoImpl?.subtle?.digest) throw new Error('Secure SHA-256 fingerprinting is unavailable');
  const result = await cryptoImpl.subtle.digest('SHA-256', bytes);
  const digest = ArrayBuffer.isView(result)
    ? new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
    : new Uint8Array(result);
  if (digest.byteLength !== 32) throw new TypeError('SHA-256 digest must contain exactly 32 bytes');
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function validateProducedLwseq(input) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Trusted LWSEQ producer must return Uint8Array bytes');
  if (input.byteLength > MAX_LWSEQ_BYTES) {
    throw new RangeError(`LWSEQ exceeds the absolute maximum of ${MAX_LWSEQ_BYTES} bytes`);
  }
  const bytes = Uint8Array.from(input);
  if (bytes.byteLength < LWSEQ_HEADER_BYTES) throw new TypeError('LWSEQ bytes are shorter than the header');
  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  if (magic !== 'LWSEQ1') throw new TypeError('LWSEQ header must begin with LWSEQ1');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(8, true);
  const outputCount = view.getUint16(10, true);
  const pixelCount = view.getUint32(12, true);
  const frameCount = view.getUint32(16, true);
  const fps = view.getUint16(20, true);
  const channelCount = view.getUint16(22, true);
  if (version !== 1) throw new RangeError('LWSEQ version must be 1');
  wholeNumber(outputCount, 'LWSEQ output count', 1, 4);
  wholeNumber(pixelCount, 'LWSEQ pixel count', 1, MAX_LWSEQ_PIXELS);
  wholeNumber(fps, 'LWSEQ FPS', 1, MAX_LWSEQ_FPS);
  wholeNumber(frameCount, 'LWSEQ frame count', 1, Math.min(MAX_LWSEQ_FRAMES, fps * 900));
  if (channelCount !== 3) throw new RangeError('LWSEQ channel count must be 3');
  const expectedBytes = LWSEQ_HEADER_BYTES + pixelCount * channelCount * frameCount;
  if (bytes.byteLength !== expectedBytes) {
    throw new RangeError(`LWSEQ byte length ${bytes.byteLength} does not match header frame data ${expectedBytes}`);
  }
  const sha256 = await digestSha256(bytes);
  return deepFreeze({
    kind: 'lwseq',
    version,
    outputCount,
    pixelCount,
    fps,
    frameCount,
    byteLength: bytes.byteLength,
    fingerprint: { algorithm: 'SHA-256', sha256 },
  });
}

export async function createPatternLabExperimentalLowering(descriptor, input, dependencies = {}) {
  const source = plainObject(input, 'Pattern Lab experimental lowering');
  exactKeys(source, ['featureId', 'target'], 'Pattern Lab experimental lowering');
  assertPlainDataTree(source, 'Pattern Lab experimental lowering');
  if (!['advancedGraph', 'shaderBake'].includes(source.featureId)) {
    throw new TypeError('Experimental lowering feature must be advancedGraph or shaderBake');
  }
  if (!PATTERN_LAB_EXPERIMENTAL_LOWERING_TARGETS.includes(source.target)) {
    throw new TypeError('Experimental sources must lower to bounded-recipe or lwseq, never card-native');
  }
  requireEnabledFeature(descriptor, source.featureId);
  plainObject(dependencies, 'Pattern Lab trusted artifact producer');
  exactKeys(dependencies, ['produceArtifact'], 'Pattern Lab trusted artifact producer');
  if (typeof dependencies.produceArtifact !== 'function') {
    throw new TypeError('Pattern Lab lowering requires a trusted produceArtifact function');
  }
  const produced = await dependencies.produceArtifact(deepFreeze({
    featureId: source.featureId,
    target: source.target,
  }));
  const artifact = source.target === 'bounded-recipe'
    ? validateCanonicalRecipe(produced)
    : await validateProducedLwseq(produced);
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

export function createPatternLabStudioRecordingDescriptor(descriptor, input) {
  requireStudioRecordingAuthorization(descriptor);
  const source = plainObject(input, 'Pattern Lab Studio recording');
  exactKeys(source, ['pixelCount', 'fps', 'frameCount'], 'Pattern Lab Studio recording');
  assertPlainDataTree(source, 'Pattern Lab Studio recording');
  const pixelCount = wholeNumber(source.pixelCount, 'Studio recording pixel count', 1, MAX_LWSEQ_PIXELS);
  const fps = wholeNumber(source.fps, 'Studio recording FPS', 1, MAX_LWSEQ_FPS);
  const frameCount = wholeNumber(
    source.frameCount,
    'Studio recording frame count for a maximum 900 seconds',
    1,
    Math.min(MAX_LWSEQ_FRAMES, fps * 900),
  );
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

export function validatePatternLabStudioRecordingDescriptor(descriptor, input) {
  requireStudioRecordingAuthorization(descriptor);
  plainObject(input, 'Pattern Lab Studio recording descriptor');
  assertPlainDataTree(input, 'Pattern Lab Studio recording descriptor');
  if (input.cardCapture !== false || input.captureLocation !== 'studio') {
    throw new TypeError('Studio known-frame descriptors cannot claim card capture');
  }
  const canonical = createPatternLabStudioRecordingDescriptor(descriptor, {
    pixelCount: input.pixelCount,
    fps: input.fps,
    frameCount: input.frameCount,
  });
  if (!sameDescriptorValue(input, canonical)) {
    throw new TypeError('Pattern Lab Studio recording descriptor does not match its safe canonical contract');
  }
  return canonical;
}
