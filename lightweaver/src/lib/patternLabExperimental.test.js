import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  PATTERN_LAB_CARD_RECORD_HARDWARE_GATES,
  PATTERN_LAB_EXPERIMENTAL_FEATURE_IDS,
  PATTERN_LAB_EXPERIMENTAL_FLAGS,
  PATTERN_LAB_EXPERIMENTAL_LOWERING_TARGETS,
  createPatternLabExperimentalDescriptor,
  createPatternLabExperimentalLowering,
  createPatternLabStudioRecordingDescriptor,
  validatePatternLabExperimentalDescriptor,
  validatePatternLabExperimentalFlags,
  validatePatternLabStudioRecordingDescriptor,
} from './patternLabExperimental.js';
import { normalizePatternLabRecipe } from './patternLabRecipe.js';

function assertDeepFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  Object.values(value).forEach(assertDeepFrozen);
}

function canonicalRecipe(overrides = {}) {
  return {
    version: 1,
    id: 'experimental-recipe',
    name: 'Experimental Recipe',
    base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
    palette: ['#000000', '#ffffff'],
    macros: { color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5, energy: 0.5 },
    evolution: { enabled: true, character: 'slow-bloom', durationSeconds: 600, change: 0.35 },
    seed: 7,
    layers: [],
    targets: [{ kind: 'whole-piece', id: 'all' }],
    requirements: [],
    provenance: [],
    ...overrides,
  };
}

function generatedLwseq({ pixelCount = 3, fps = 24, frameCount = 240 } = {}) {
  const bytes = new Uint8Array(64 + pixelCount * 3 * frameCount);
  bytes.set([76, 87, 83, 69, 81, 49], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1, true);
  view.setUint16(10, 1, true);
  view.setUint32(12, pixelCount, true);
  view.setUint32(16, frameCount, true);
  view.setUint16(20, fps, true);
  view.setUint16(22, 3, true);
  return bytes;
}

function trustedArtifact(artifact) {
  return {
    produceArtifact: async () => artifact,
  };
}

test('all production experimental flags are immutable and disabled by default', () => {
  assert.deepEqual(PATTERN_LAB_EXPERIMENTAL_FEATURE_IDS, [
    'advancedGraph',
    'shaderBake',
    'cardArtnetRecord',
  ]);
  assert.deepEqual(PATTERN_LAB_EXPERIMENTAL_FLAGS, {
    advancedGraph: false,
    shaderBake: false,
    cardArtnetRecord: false,
  });
  assertDeepFrozen(PATTERN_LAB_EXPERIMENTAL_FEATURE_IDS);
  assertDeepFrozen(PATTERN_LAB_EXPERIMENTAL_FLAGS);
});

test('disabled flags expose no runtime imports, paths, workers, network, or storage', () => {
  const descriptor = createPatternLabExperimentalDescriptor();

  assert.deepEqual(descriptor.flags, PATTERN_LAB_EXPERIMENTAL_FLAGS);
  assert.deepEqual(descriptor.runtime, {
    imports: [],
    paths: [],
    workers: [],
    network: [],
    storage: [],
  });
  for (const feature of Object.values(descriptor.features)) {
    assert.equal(feature.enabled, false);
    assert.equal(feature.runtimePath, null);
  }
  assertDeepFrozen(descriptor);
});

test('flag validation fails closed on unknown or non-boolean values', () => {
  assert.deepEqual(validatePatternLabExperimentalFlags({ advancedGraph: true }), {
    advancedGraph: true,
    shaderBake: false,
    cardArtnetRecord: false,
  });
  assert.throws(
    () => validatePatternLabExperimentalFlags({ shaderBake: 'true' }),
    /shaderBake.*boolean/i,
  );
  assert.throws(
    () => validatePatternLabExperimentalFlags({ futureExperiment: true }),
    /unknown.*futureExperiment/i,
  );

  const symbolic = { advancedGraph: false };
  symbolic[Symbol('hidden')] = true;
  assert.throws(() => validatePatternLabExperimentalFlags(symbolic), /symbol/i);
  assert.throws(() => validatePatternLabExperimentalFlags(new Date()), /plain object/i);
  assert.throws(
    () => validatePatternLabExperimentalFlags({ advancedGraph: () => false }),
    /function|boolean/i,
  );

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'advancedGraph', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });
  assert.throws(() => validatePatternLabExperimentalFlags(accessor), /accessor/i);
  assert.equal(getterCalls, 0);
});

test('graph and shader gates are bake-only and never card-native', () => {
  const descriptor = createPatternLabExperimentalDescriptor({
    advancedGraph: true,
    shaderBake: true,
  });
  assert.deepEqual(PATTERN_LAB_EXPERIMENTAL_LOWERING_TARGETS, ['bounded-recipe', 'lwseq']);
  for (const id of ['advancedGraph', 'shaderBake']) {
    assert.equal(descriptor.features[id].enabled, true);
    assert.equal(descriptor.features[id].delivery, 'bake-only');
    assert.equal(descriptor.features[id].cardNative, false);
    assert.deepEqual(descriptor.features[id].allowedLowerings, PATTERN_LAB_EXPERIMENTAL_LOWERING_TARGETS);
  }

  const validated = validatePatternLabExperimentalDescriptor(structuredClone(descriptor));
  assert.deepEqual(validated, descriptor);
  assertDeepFrozen(validated);

  const unsafe = structuredClone(descriptor);
  unsafe.features.advancedGraph.cardNative = true;
  assert.throws(() => validatePatternLabExperimentalDescriptor(unsafe), /card-native/i);

  const symbolic = structuredClone(descriptor);
  symbolic.features[Symbol('hidden')] = { enabled: true };
  assert.throws(() => validatePatternLabExperimentalDescriptor(symbolic), /symbol/i);

  const cyclic = structuredClone(descriptor);
  cyclic.runtime.loop = cyclic;
  assert.throws(() => validatePatternLabExperimentalDescriptor(cyclic), /cyclic/i);

  let getterCalls = 0;
  const accessor = structuredClone(descriptor);
  Object.defineProperty(accessor.features, 'advancedGraph', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return descriptor.features.advancedGraph;
    },
  });
  assert.throws(() => validatePatternLabExperimentalDescriptor(accessor), /accessor/i);
  assert.equal(getterCalls, 0);
});

test('enabled graph and shader gates bind output to canonical Recipe payloads or real LWSEQ bytes', async () => {
  const graphDescriptor = createPatternLabExperimentalDescriptor({ advancedGraph: true });
  const recipe = canonicalRecipe();
  const recipeLowering = await createPatternLabExperimentalLowering(
    graphDescriptor,
    { featureId: 'advancedGraph', target: 'bounded-recipe' },
    trustedArtifact(recipe),
  );
  assert.equal(recipeLowering.artifact.kind, 'pattern-lab-recipe');
  assert.equal(recipeLowering.artifact.byteLength, new TextEncoder().encode(JSON.stringify(recipe)).byteLength);
  assert.deepEqual(recipeLowering.artifact.payload, recipe);

  const shaderDescriptor = createPatternLabExperimentalDescriptor({ shaderBake: true });
  const bytes = generatedLwseq();
  const shaderLowering = await createPatternLabExperimentalLowering(
    shaderDescriptor,
    { featureId: 'shaderBake', target: 'lwseq' },
    trustedArtifact(bytes),
  );
  assert.deepEqual(shaderLowering.artifact, {
    kind: 'lwseq',
    version: 1,
    outputCount: 1,
    pixelCount: 3,
    fps: 24,
    frameCount: 240,
    byteLength: bytes.byteLength,
    fingerprint: {
      algorithm: 'SHA-256',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  });
  assertDeepFrozen(recipeLowering);
  assertDeepFrozen(shaderLowering);
  assert.ok(!/(glsl|javascript|sourceCode|executable)/i.test(JSON.stringify([
    recipeLowering,
    shaderLowering,
  ])));
});

test('disabled or mismatched feature descriptors block lowering before the trusted producer runs', async () => {
  let producerCalls = 0;
  const producer = {
    produceArtifact: async () => {
      producerCalls += 1;
      return canonicalRecipe();
    },
  };
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      createPatternLabExperimentalDescriptor(),
      { featureId: 'advancedGraph', target: 'bounded-recipe' },
      producer,
    ),
    /advancedGraph.*disabled/i,
  );
  assert.equal(producerCalls, 0);

  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      createPatternLabExperimentalDescriptor({ shaderBake: true }),
      { featureId: 'advancedGraph', target: 'bounded-recipe' },
      producer,
    ),
    /advancedGraph.*disabled/i,
  );
  assert.equal(producerCalls, 0);

  const forged = structuredClone(createPatternLabExperimentalDescriptor());
  forged.flags.advancedGraph = true;
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      forged,
      { featureId: 'advancedGraph', target: 'bounded-recipe' },
      producer,
    ),
    /canonical contract|descriptor/i,
  );
  assert.equal(producerCalls, 0);
});

test('lowering rejects native targets, forged metadata, hostile structures, and invalid artifacts', async () => {
  const descriptor = createPatternLabExperimentalDescriptor({ advancedGraph: true, shaderBake: true });
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'advancedGraph', target: 'card-native' },
      trustedArtifact(canonicalRecipe()),
    ),
    /bounded-recipe.*lwseq|card-native/i,
  );
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'advancedGraph', target: 'bounded-recipe', sourceCode: 'return pixel;' },
      trustedArtifact(canonicalRecipe()),
    ),
    /raw|sourceCode|unknown/i,
  );

  const symbolicRequest = { featureId: 'advancedGraph', target: 'bounded-recipe' };
  symbolicRequest[Symbol('hidden')] = true;
  await assert.rejects(
    () => createPatternLabExperimentalLowering(descriptor, symbolicRequest, trustedArtifact(canonicalRecipe())),
    /symbol/i,
  );

  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'shaderBake', target: 'lwseq' },
      trustedArtifact({ kind: 'lwseq', pixelCount: 3, frameCount: 240 }),
    ),
    /Uint8Array|bytes/i,
  );

  const badHeader = generatedLwseq();
  badHeader[0] = 0;
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'shaderBake', target: 'lwseq' },
      trustedArtifact(badHeader),
    ),
    /LWSEQ1|header/i,
  );

  const truncated = generatedLwseq().subarray(0, 100);
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'shaderBake', target: 'lwseq' },
      trustedArtifact(truncated),
    ),
    /length|byte/i,
  );

  const invalidRecipe = canonicalRecipe({ layers: [{}, {}, {}, {}] });
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'advancedGraph', target: 'bounded-recipe' },
      trustedArtifact(invalidRecipe),
    ),
    /3 layers|layer.*3/i,
  );

  const symbolicRecipe = canonicalRecipe();
  symbolicRecipe.base.params[Symbol('hidden')] = 1;
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'advancedGraph', target: 'bounded-recipe' },
      trustedArtifact(symbolicRecipe),
    ),
    /symbol/i,
  );

  let getterCalls = 0;
  const accessorRecipe = canonicalRecipe();
  Object.defineProperty(accessorRecipe.base.params, 'hidden', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'advancedGraph', target: 'bounded-recipe' },
      trustedArtifact(accessorRecipe),
    ),
    /accessor/i,
  );
  assert.equal(getterCalls, 0);

  const cyclicRecipe = canonicalRecipe();
  cyclicRecipe.base.params.loop = cyclicRecipe;
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'advancedGraph', target: 'bounded-recipe' },
      trustedArtifact(cyclicRecipe),
    ),
    /cyclic/i,
  );

  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'advancedGraph', target: 'bounded-recipe' },
      trustedArtifact(canonicalRecipe({
        base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: new Date() },
      })),
    ),
    /prototype/i,
  );
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'advancedGraph', target: 'bounded-recipe' },
      trustedArtifact(canonicalRecipe({
        base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: { run: () => true } },
      })),
    ),
    /function/i,
  );
});

test('LWSEQ duration is capped at 900 seconds even at low frame rates', async () => {
  const descriptor = createPatternLabExperimentalDescriptor({ shaderBake: true });
  await assert.doesNotReject(() => createPatternLabExperimentalLowering(
    descriptor,
    { featureId: 'shaderBake', target: 'lwseq' },
    trustedArtifact(generatedLwseq({ pixelCount: 1, fps: 1, frameCount: 900 })),
  ));
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      descriptor,
      { featureId: 'shaderBake', target: 'lwseq' },
      trustedArtifact(generatedLwseq({ pixelCount: 1, fps: 1, frameCount: 901 })),
    ),
    /duration|900 seconds|frame count/i,
  );
});

test('LWSEQ fingerprints always use platform crypto and reject a caller-supplied digest', async () => {
  let fakeDigestCalls = 0;
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      createPatternLabExperimentalDescriptor({ shaderBake: true }),
      { featureId: 'shaderBake', target: 'lwseq' },
      {
        produceArtifact: async () => generatedLwseq({ pixelCount: 1, fps: 1, frameCount: 1 }),
        cryptoImpl: {
          subtle: {
            digest: async () => {
              fakeDigestCalls += 1;
              return new Uint8Array(32);
            },
          },
        },
      },
    ),
    /cryptoImpl|unknown/i,
  );
  assert.equal(fakeDigestCalls, 0);
});

test('LWSEQ absolute size is rejected before cloning producer bytes', async () => {
  const maximumBytes = 64 + 1024 * 3 * 24 * 60 * 15;
  const oversized = new Uint8Array(maximumBytes + 1);
  await assert.rejects(
    () => createPatternLabExperimentalLowering(
      createPatternLabExperimentalDescriptor({ shaderBake: true }),
      { featureId: 'shaderBake', target: 'lwseq' },
      trustedArtifact(oversized),
    ),
    /absolute.*size|maximum.*byte|exceeds.*byte/i,
  );
});

test('experimental lowering reuses the forward-compatible canonical Recipe contract', async () => {
  const source = canonicalRecipe({
    futureTop: { enabled: true },
    base: {
      kind: 'lightweaver-pattern',
      patternId: 'aurora',
      params: { density: 0.5 },
      futureBase: 'kept',
    },
    layers: [{ id: 'one', futureLayer: true }],
    targets: [{ kind: 'section', id: 'outer', futureTarget: true }],
    requirements: [{ capability: 'noise-v2', futureRequirement: 2 }],
    provenance: [{ source: 'fastled', futureProvenance: 'commit' }],
  });
  const canonical = normalizePatternLabRecipe(source);
  const lowering = await createPatternLabExperimentalLowering(
    createPatternLabExperimentalDescriptor({ advancedGraph: true }),
    { featureId: 'advancedGraph', target: 'bounded-recipe' },
    trustedArtifact(source),
  );
  assert.deepEqual(lowering.artifact.payload, canonical);
  assert.equal(lowering.artifact.payload.futureTop.enabled, true);
  assert.equal(lowering.artifact.payload.base.futureBase, 'kept');
  assert.equal(lowering.artifact.payload.layers[0].futureLayer, true);
});

test('card-side Art-Net recording stays unavailable behind four explicit hardware gates', () => {
  assert.deepEqual(PATTERN_LAB_CARD_RECORD_HARDWARE_GATES.map(gate => gate.id), [
    'sd-sustained-write',
    'dropped-frame-accounting',
    'power-loss',
    'filesystem-recovery',
  ]);
  for (const gate of PATTERN_LAB_CARD_RECORD_HARDWARE_GATES) {
    assert.equal(gate.required, true);
    assert.equal(gate.status, 'unverified-on-hardware');
  }
  assertDeepFrozen(PATTERN_LAB_CARD_RECORD_HARDWARE_GATES);

  const requested = createPatternLabExperimentalDescriptor({ cardArtnetRecord: true });
  const recording = requested.features.cardArtnetRecord;
  assert.equal(recording.enabled, true);
  assert.equal(recording.status, 'hardware-validation-required');
  assert.equal(recording.preferredCapture, 'studio-known-frames');
  assert.equal(recording.studioRecordingAuthorized, true);
  assert.equal(recording.cardCaptureAvailable, false);
  assert.equal(recording.hardwareApprovalRequired, true);
  assert.deepEqual(recording.hardwareGates, PATTERN_LAB_CARD_RECORD_HARDWARE_GATES);
});

test('Studio recording describes known bounded frames for LWSEQ without storing frame data', () => {
  const authorization = createPatternLabExperimentalDescriptor({ cardArtnetRecord: true });
  const descriptor = createPatternLabStudioRecordingDescriptor(authorization, {
    pixelCount: 300,
    fps: 24,
    frameCount: 14_400,
  });
  assert.deepEqual(descriptor, {
    version: 1,
    kind: 'studio-known-frame-recording',
    captureLocation: 'studio',
    frameSource: 'known-render-frames',
    delivery: 'lwseq',
    cardNative: false,
    cardCapture: false,
    pixelCount: 300,
    fps: 24,
    frameCount: 14_400,
    durationSeconds: 600,
    expectedByteLength: 64 + 300 * 3 * 14_400,
  });
  assertDeepFrozen(descriptor);
  assert.ok(!/(frameData|pixelsData|base64)/i.test(JSON.stringify(descriptor)));

  const validated = validatePatternLabStudioRecordingDescriptor(authorization, structuredClone(descriptor));
  assert.deepEqual(validated, descriptor);
  assertDeepFrozen(validated);
});

test('Studio recording validation rejects raw frames, invalid bounds, and card capture claims', () => {
  const disabled = createPatternLabExperimentalDescriptor();
  const authorization = createPatternLabExperimentalDescriptor({ cardArtnetRecord: true });
  assert.throws(
    () => createPatternLabStudioRecordingDescriptor(disabled, { pixelCount: 1, fps: 1, frameCount: 1 }),
    /Studio recording.*disabled|not authorized/i,
  );
  assert.throws(
    () => createPatternLabStudioRecordingDescriptor(authorization, {
      pixelCount: 1,
      fps: 24,
      frameCount: 1,
      frames: [[{ r: 1, g: 2, b: 3 }]],
    }),
    /frames|unknown|raw/i,
  );
  assert.throws(
    () => createPatternLabStudioRecordingDescriptor(authorization, { pixelCount: 1025, fps: 24, frameCount: 1 }),
    /pixel.*1024/i,
  );
  assert.throws(
    () => createPatternLabStudioRecordingDescriptor(authorization, { pixelCount: 1, fps: 25, frameCount: 1 }),
    /FPS.*24/i,
  );
  assert.throws(
    () => createPatternLabStudioRecordingDescriptor(authorization, { pixelCount: 1, fps: 1, frameCount: 901 }),
    /duration|900 seconds|frame count/i,
  );

  const unsafe = structuredClone(createPatternLabStudioRecordingDescriptor(authorization, {
    pixelCount: 1,
    fps: 24,
    frameCount: 1,
  }));
  unsafe.cardCapture = true;
  assert.throws(() => validatePatternLabStudioRecordingDescriptor(authorization, unsafe), /card capture/i);
});

test('mount-ready experimental UI stays collapsed and contains no feature runtime side effects', async () => {
  const source = await readFile(
    new URL('../pattern-lab/PatternLabExperimental.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /<details[^>]*data-testid="pattern-lab-experimental"/);
  assert.doesNotMatch(source, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(source, /Off by default/);
  assert.match(source, /Card-side recording is unavailable/i);
  assert.doesNotMatch(
    source,
    /import\s*\(|\bfetch\s*\(|\bnew\s+Worker\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/,
  );
});
