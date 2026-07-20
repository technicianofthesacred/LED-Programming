import test from 'node:test';
import assert from 'node:assert/strict';
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

function assertDeepFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  Object.values(value).forEach(assertDeepFrozen);
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
});

test('bounded recipe and LWSEQ lowering descriptors contain metadata, never executable source', () => {
  const recipeLowering = createPatternLabExperimentalLowering({
    featureId: 'advancedGraph',
    target: 'bounded-recipe',
    artifact: {
      kind: 'pattern-lab-recipe',
      version: 1,
      layerCount: 3,
      byteLength: 64_000,
    },
  });
  assert.deepEqual(recipeLowering, {
    version: 1,
    featureId: 'advancedGraph',
    sourceKind: 'bounded-graph',
    delivery: 'bake-only',
    cardNative: false,
    target: 'bounded-recipe',
    artifact: {
      kind: 'pattern-lab-recipe',
      version: 1,
      layerCount: 3,
      byteLength: 64_000,
    },
  });

  const lwseqBytes = 64 + 300 * 3 * 14_400;
  const shaderLowering = createPatternLabExperimentalLowering({
    featureId: 'shaderBake',
    target: 'lwseq',
    artifact: {
      kind: 'lwseq',
      version: 1,
      pixelCount: 300,
      fps: 24,
      frameCount: 14_400,
      byteLength: lwseqBytes,
    },
  });
  assert.equal(shaderLowering.sourceKind, 'shader');
  assert.equal(shaderLowering.cardNative, false);
  assert.equal(shaderLowering.artifact.byteLength, lwseqBytes);
  assertDeepFrozen(recipeLowering);
  assertDeepFrozen(shaderLowering);
  assert.ok(!/(glsl|javascript|sourceCode|executable)/i.test(JSON.stringify([
    recipeLowering,
    shaderLowering,
  ])));
});

test('lowering validation rejects native targets, raw code, and artifacts outside bounds', () => {
  const recipe = {
    featureId: 'advancedGraph',
    target: 'bounded-recipe',
    artifact: { kind: 'pattern-lab-recipe', version: 1, layerCount: 1, byteLength: 1000 },
  };
  assert.throws(
    () => createPatternLabExperimentalLowering({ ...recipe, target: 'card-native' }),
    /bounded-recipe.*lwseq|card-native/i,
  );
  assert.throws(
    () => createPatternLabExperimentalLowering({ ...recipe, sourceCode: 'return pixel;' }),
    /raw|sourceCode|unknown/i,
  );
  assert.throws(
    () => createPatternLabExperimentalLowering({
      ...recipe,
      artifact: { ...recipe.artifact, glsl: 'void main() {}' },
    }),
    /raw|glsl|unknown/i,
  );
  assert.throws(
    () => createPatternLabExperimentalLowering({
      ...recipe,
      artifact: { ...recipe.artifact, layerCount: 4 },
    }),
    /layer.*3/i,
  );
  assert.throws(
    () => createPatternLabExperimentalLowering({
      featureId: 'shaderBake',
      target: 'lwseq',
      artifact: {
        kind: 'lwseq', version: 1, pixelCount: 1025, fps: 24, frameCount: 1, byteLength: 3139,
      },
    }),
    /pixel.*1024/i,
  );
  assert.throws(
    () => createPatternLabExperimentalLowering({
      featureId: 'shaderBake',
      target: 'lwseq',
      artifact: {
        kind: 'lwseq', version: 1, pixelCount: 1, fps: 24, frameCount: 1, byteLength: 999,
      },
    }),
    /byteLength.*frame/i,
  );
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
  assert.equal(recording.cardCaptureAvailable, false);
  assert.equal(recording.hardwareApprovalRequired, true);
  assert.deepEqual(recording.hardwareGates, PATTERN_LAB_CARD_RECORD_HARDWARE_GATES);
});

test('Studio recording describes known bounded frames for LWSEQ without storing frame data', () => {
  const descriptor = createPatternLabStudioRecordingDescriptor({
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

  const validated = validatePatternLabStudioRecordingDescriptor(structuredClone(descriptor));
  assert.deepEqual(validated, descriptor);
  assertDeepFrozen(validated);
});

test('Studio recording validation rejects raw frames, invalid bounds, and card capture claims', () => {
  assert.throws(
    () => createPatternLabStudioRecordingDescriptor({
      pixelCount: 1,
      fps: 24,
      frameCount: 1,
      frames: [[{ r: 1, g: 2, b: 3 }]],
    }),
    /frames|unknown|raw/i,
  );
  assert.throws(
    () => createPatternLabStudioRecordingDescriptor({ pixelCount: 1025, fps: 24, frameCount: 1 }),
    /pixel.*1024/i,
  );
  assert.throws(
    () => createPatternLabStudioRecordingDescriptor({ pixelCount: 1, fps: 25, frameCount: 1 }),
    /FPS.*24/i,
  );
  assert.throws(
    () => createPatternLabStudioRecordingDescriptor({ pixelCount: 1, fps: 24, frameCount: 21_601 }),
    /frame.*21600/i,
  );

  const unsafe = structuredClone(createPatternLabStudioRecordingDescriptor({
    pixelCount: 1,
    fps: 24,
    frameCount: 1,
  }));
  unsafe.cardCapture = true;
  assert.throws(() => validatePatternLabStudioRecordingDescriptor(unsafe), /card capture/i);
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
