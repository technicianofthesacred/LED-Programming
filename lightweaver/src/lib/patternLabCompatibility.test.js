import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR,
  PATTERN_LAB_COMPATIBILITY_CLASSIFICATIONS,
  PATTERN_LAB_COMPATIBILITY_VERSION,
  buildPatternLabStateWatcher,
  classifyPatternLabCompatibility,
  createPatternLabDiagnosticsSnapshot,
  createPatternLabSimplificationVariant,
  explainPatternLabDarkness,
  stepPatternLabDiagnosticsFrame,
} from './patternLabCompatibility.js';
import { createPatternLabRecipe } from './patternLabRecipe.js';

function recipe(overrides = {}) {
  return {
    version: 1,
    id: 'diagnostic-recipe',
    name: 'Diagnostic Recipe',
    base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
    palette: ['#000000', '#ffffff'],
    macros: {},
    evolution: { enabled: true, character: 'tidal', durationSeconds: 10, change: 0.3 },
    seed: 7,
    layers: [],
    targets: [{ kind: 'whole-piece', id: 'all' }],
    requirements: [],
    provenance: [],
    ...overrides,
  };
}

const FIT_METRICS = {
  pixelCount: 10,
  fps: 20,
  operationsPerFrame: 1000,
  stateBytes: 512,
  framebufferBytes: 30,
  nativeConfigBytes: 400,
  microSdBytes: 10_000,
};

test('compatibility module exposes a versioned data-driven contract', () => {
  assert.equal(PATTERN_LAB_COMPATIBILITY_VERSION, 1);
  assert.deepEqual(PATTERN_LAB_COMPATIBILITY_CLASSIFICATIONS, [
    'live-on-card',
    'bake-to-card',
    'simplify-for-card',
    'studio-only',
  ]);
  assert.equal(DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR.version, 1);
  assert.equal(DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR.limits.nativeConfigBytes, 3968);
  assert.ok(Object.isFrozen(DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR));
});

test('classifies a supported bounded recipe as live on card', () => {
  const result = classifyPatternLabCompatibility(recipe(), { metrics: FIT_METRICS });
  assert.equal(result.classification, 'live-on-card');
  assert.equal(result.descriptor.version, DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR.version);
  assert.equal(result.reasons.length, 0);
});

test('fails closed when a normalized recipe has no authoritative runtime estimates', () => {
  const source = createPatternLabRecipe({ id: 'missing-runtime-estimates' });
  const result = classifyPatternLabCompatibility(source);

  assert.equal(result.classification, 'studio-only');
  for (const key of ['pixelCount', 'fps', 'operationsPerFrame', 'stateBytes', 'framebufferBytes']) {
    assert.equal(result.budgets[key].known, false, `${key} should be unknown`);
    assert.equal(result.budgets[key].used, null, `${key} must not masquerade as zero`);
    assert.equal(result.budgets[key].ok, false, `${key} must fail closed`);
  }
  assert.equal(result.budgets.lwseqBytes.known, false);
  assert.equal(result.budgets.microSdBytes.required, null);
  assert.ok(result.reasons.some(reason => reason.code === 'pixel-count-unknown'));
  assert.ok(result.reasons.some(reason => reason.code === 'operations-unknown'));
  assert.ok(!result.actions.some(action => action.id === 'bake'));
});

test('partial resource estimates remain studio only instead of permitting a bake', () => {
  const { operationsPerFrame, stateBytes, ...partialMetrics } = FIT_METRICS;
  const result = classifyPatternLabCompatibility(recipe({
    base: { kind: 'particles', params: {} },
  }), { metrics: partialMetrics });

  assert.equal(result.classification, 'studio-only');
  assert.equal(result.budgets.operationsPerFrame.known, false);
  assert.equal(result.budgets.stateBytes.known, false);
  assert.ok(!result.actions.some(action => action.id === 'bake'));
});

test('zero or over-budget FPS cannot be baked to the card', () => {
  for (const [fps, expectedStatus] of [[0, 'too-low'], [60, 'over-limit']]) {
    const result = classifyPatternLabCompatibility(
      recipe({ base: { kind: 'particles', params: {} } }),
      { metrics: { ...FIT_METRICS, fps } },
    );
    assert.equal(result.classification, 'studio-only', `fps ${fps} must fail closed`);
    assert.equal(result.budgets.fps.ok, false);
    assert.equal(result.budgets.fps.status, expectedStatus);
    assert.ok(!result.actions.some(action => action.id === 'bake'));
  }
});

test('budget status distinguishes missing, invalid, too-low, fitting, and over-limit values', () => {
  const cases = [
    [undefined, 'unknown', 'pixel-count-unknown'],
    [-1, 'invalid', 'pixel-count-invalid'],
    [0, 'too-low', 'pixel-count-too-low'],
    [10, 'fits', null],
    [1025, 'over-limit', 'pixel-count-over-budget'],
    [Number.POSITIVE_INFINITY, 'invalid', 'pixel-count-invalid'],
  ];

  for (const [pixelCount, status, reasonCode] of cases) {
    const metrics = { ...FIT_METRICS, pixelCount };
    if (pixelCount === undefined) delete metrics.pixelCount;
    const result = classifyPatternLabCompatibility(recipe(), { metrics });
    assert.equal(result.budgets.pixelCount.status, status, String(pixelCount));
    assert.equal(result.budgets.pixelCount.ok, status === 'fits', String(pixelCount));
    if (reasonCode) assert.ok(result.reasons.some(reason => reason.code === reasonCode));
  }
});

test('unsafe numeric extremes fail closed without reporting an overflowing sequence size', () => {
  const invalidInput = classifyPatternLabCompatibility(recipe(), {
    metrics: { ...FIT_METRICS, pixelCount: Number.MAX_SAFE_INTEGER + 1 },
  });
  const unsafeSequence = classifyPatternLabCompatibility(recipe(), {
    metrics: { ...FIT_METRICS, pixelCount: Number.MAX_SAFE_INTEGER },
  });

  assert.equal(invalidInput.budgets.pixelCount.status, 'invalid');
  assert.equal(unsafeSequence.budgets.pixelCount.status, 'over-limit');
  assert.equal(unsafeSequence.budgets.lwseqBytes.status, 'invalid');
  assert.equal(unsafeSequence.budgets.lwseqBytes.used, null);
  assert.equal(unsafeSequence.budgets.microSdBytes.required, null);
  assert.equal(unsafeSequence.classification, 'studio-only');
});

test('classifies an unsupported native generator as bake to card when lwseq fits', () => {
  const result = classifyPatternLabCompatibility(
    recipe({ base: { kind: 'particles', params: {} } }),
    { metrics: FIT_METRICS },
  );
  assert.equal(result.classification, 'bake-to-card');
  assert.ok(result.reasons.some(reason => reason.code === 'generator-not-native'));
  assert.ok(result.actions.some(action => action.id === 'bake'));
});

test('checks the concrete wrapped pattern instead of treating every Lightweaver pattern as native', () => {
  const result = classifyPatternLabCompatibility(recipe({
    base: { kind: 'lightweaver-pattern', patternId: 'studio-only-pattern', params: {} },
  }), { metrics: FIT_METRICS });

  assert.equal(result.classification, 'bake-to-card');
  assert.ok(result.reasons.some(reason => reason.code === 'pattern-not-native'));
});

test('classifies an explicit safe substitution as simplify for card and creates a new immutable variant', () => {
  const source = recipe({
    requirements: [{
      capability: 'live-camera',
      required: true,
      bakeable: false,
      simplification: {
        action: 'remove-feature',
        label: 'Remove live camera input',
        path: ['requirements', 0],
        remove: true,
      },
    }],
  });
  const before = structuredClone(source);
  const result = classifyPatternLabCompatibility(source, {
    metrics: { ...FIT_METRICS, microSdBytes: 0 },
    simplificationMetrics: { ...FIT_METRICS, microSdBytes: 0 },
  });

  assert.equal(result.classification, 'simplify-for-card');
  assert.equal(result.simplification.changes[0].action, 'remove-feature');
  assert.equal(result.simplification.variant.id, `${source.id}-simplified`);
  assert.deepEqual(result.simplification.variant.requirements, []);
  assert.deepEqual(source, before);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.simplification));
  assert.ok(Object.isFrozen(result.simplification.variant));
  assert.ok(result.actions.some(action => action.id === 'simplify'));
  assert.ok(result.actions.some(action => action.id === 'remove-feature'));
});

test('classifies an unresolved non-bakeable capability with no safe substitution as studio only', () => {
  const result = classifyPatternLabCompatibility(recipe({
    requirements: [{ capability: 'live-audio', required: true, bakeable: false }],
  }), { metrics: FIT_METRICS });

  assert.equal(result.classification, 'studio-only');
  assert.ok(result.reasons.some(reason => reason.code === 'required-capability-unsupported'));
});

test('unknown required capabilities default to non-bakeable', () => {
  const result = classifyPatternLabCompatibility(recipe({
    requirements: [{ capability: 'future-input', required: true }],
  }), { metrics: FIT_METRICS });

  assert.equal(result.classification, 'studio-only');
  assert.ok(!result.actions.some(action => action.id === 'bake'));
});

test('only descriptor-modeled deterministic capabilities may opt into baking', () => {
  const descriptor = structuredClone(DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR);
  descriptor.features.bakeableCapabilities.push('offline-analysis');
  const result = classifyPatternLabCompatibility(recipe({
    requirements: [{ capability: 'offline-analysis', required: true }],
  }), { descriptor, metrics: FIT_METRICS });

  assert.equal(result.classification, 'bake-to-card');
  assert.ok(result.actions.some(action => action.id === 'bake'));
});

test('reports every explicit native and sequence budget including the 3968-byte cap', () => {
  const result = classifyPatternLabCompatibility(recipe(), { metrics: FIT_METRICS });
  assert.deepEqual(Object.keys(result.budgets), [
    'pixelCount',
    'fps',
    'operationsPerFrame',
    'stateBytes',
    'framebufferBytes',
    'nativeConfigBytes',
    'lwseqBytes',
    'microSdBytes',
  ]);
  assert.deepEqual(result.budgets.pixelCount, {
    used: 10, limit: 1024, known: true, status: 'fits', ok: true,
  });
  assert.deepEqual(result.budgets.fps, {
    used: 20, limit: 30, known: true, status: 'fits', ok: true,
  });
  assert.deepEqual(result.budgets.framebufferBytes, {
    used: 30, limit: 196608, known: true, status: 'fits', ok: true,
  });
  assert.deepEqual(result.budgets.nativeConfigBytes, {
    used: 400, limit: 3968, known: true, status: 'fits', ok: true,
  });
  assert.deepEqual(result.budgets.lwseqBytes, {
    used: 6064, limit: 10_000, known: true, status: 'fits', ok: true,
  });
  assert.deepEqual(result.budgets.microSdBytes, {
    required: 6064, available: 10_000, known: true, status: 'fits', ok: true,
  });
  assert.ok(Object.values(result.budgets).every(Object.isFrozen));
});

test('physical pixel overflow blocks both native and baked card output', () => {
  const result = classifyPatternLabCompatibility(recipe(), {
    metrics: { ...FIT_METRICS, pixelCount: 1025, framebufferBytes: 3075 },
  });
  assert.equal(result.classification, 'studio-only');
  assert.equal(result.budgets.pixelCount.ok, false);
  assert.ok(result.reasons.some(reason => reason.code === 'pixel-count-over-budget'));
});

test('firmware descriptor overrides drive decisions and preserve descriptor version', () => {
  const descriptor = structuredClone(DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR);
  descriptor.version = 7;
  descriptor.id = 'future-card-v7';
  descriptor.features.generators.push('particles');

  const result = classifyPatternLabCompatibility(
    recipe({ base: { kind: 'particles', params: {} } }),
    { descriptor, metrics: FIT_METRICS },
  );
  assert.equal(result.classification, 'live-on-card');
  assert.deepEqual(result.descriptor, { id: 'future-card-v7', version: 7 });
});

test('descriptor pattern and layer capabilities drive native decisions', () => {
  const descriptor = structuredClone(DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR);
  descriptor.features.patterns.push('gradient');
  descriptor.limits.layers = 1;
  const native = classifyPatternLabCompatibility(recipe({
    base: { kind: 'lightweaver-pattern', patternId: 'gradient', params: {} },
  }), { descriptor, metrics: FIT_METRICS });
  const layered = classifyPatternLabCompatibility(recipe({
    layers: [
      { id: 'a', generator: { kind: 'lightweaver-pattern', patternId: 'aurora' } },
      { id: 'b', generator: { kind: 'lightweaver-pattern', patternId: 'ocean' } },
    ],
  }), { descriptor, metrics: FIT_METRICS });

  assert.equal(native.classification, 'live-on-card');
  assert.equal(layered.classification, 'bake-to-card');
  assert.ok(layered.reasons.some(reason => reason.code === 'layers-over-budget'));
});

test('malformed or incomplete layer generators fail closed', () => {
  const malformedLayers = [
    {},
    { generator: {} },
    { generator: { kind: 'lightweaver-pattern' } },
    { generator: { kind: 'lightweaver-pattern', patternId: 'not-a-built-in-pattern' } },
  ];

  for (const layer of malformedLayers) {
    const result = classifyPatternLabCompatibility(recipe({ layers: [layer] }), { metrics: FIT_METRICS });
    assert.equal(result.classification, 'studio-only');
    assert.ok(result.reasons.some(reason => reason.code.startsWith('layer-generator-')));
    assert.ok(!result.actions.some(action => action.id === 'bake'));
  }
});

test('known unsupported target restrictions offer an explicit simplified variant', () => {
  const result = classifyPatternLabCompatibility(recipe({
    targets: [{ kind: 'section', id: 'outer' }],
  }), {
    metrics: { ...FIT_METRICS, microSdBytes: 0 },
    simplificationMetrics: { ...FIT_METRICS, microSdBytes: 0 },
  });

  assert.equal(result.classification, 'simplify-for-card');
  assert.equal(result.simplification.variant.targets[0].kind, 'whole-piece');
  assert.ok(result.actions.some(action => action.id === 'simplify'));
});

test('simplification does not reuse source estimates for the generated variant', () => {
  const result = classifyPatternLabCompatibility(recipe({
    targets: [{ kind: 'section', id: 'outer' }],
  }), { metrics: { ...FIT_METRICS, microSdBytes: 0 } });

  assert.equal(result.classification, 'studio-only');
  assert.equal(result.simplification.resolvesCompatibility, false);
  assert.ok(result.simplification.remainingReasons.some(reason => reason.code === 'pixel-count-unknown'));
  assert.ok(!result.actions.some(action => action.id === 'simplify'));
});

test('partial cleanup remains studio only when the generated variant still has a blocker', () => {
  const result = classifyPatternLabCompatibility(recipe({
    requirements: [
      {
        capability: 'live-camera',
        required: true,
        simplification: {
          action: 'remove-feature',
          label: 'Remove live camera input',
          path: ['requirements', 0],
          remove: true,
        },
      },
      { capability: 'unmodeled-input', required: true },
    ],
  }), {
    metrics: { ...FIT_METRICS, microSdBytes: 0 },
    simplificationMetrics: { ...FIT_METRICS, microSdBytes: 0 },
  });

  assert.equal(result.classification, 'studio-only');
  assert.equal(result.simplification.resolvesCompatibility, false);
  assert.equal(result.simplification.resultClassification, 'studio-only');
  assert.ok(result.simplification.remainingReasons.some(reason => reason.feature === 'unmodeled-input'));
  assert.ok(!result.actions.some(action => action.id === 'simplify'));
  assert.ok(result.actions.some(action => action.id === 'remove-feature'));
});

test('simplification variants apply explicit path changes without mutating their source', () => {
  const source = recipe({ layers: [{ id: 'glow', blendMode: 'screen', opacity: 1 }] });
  const before = structuredClone(source);
  const variant = createPatternLabSimplificationVariant(source, [{
    action: 'replace-feature',
    label: 'Use normal blend',
    path: ['layers', 0, 'blendMode'],
    value: 'normal',
  }], { id: 'card-safe-copy' });

  assert.equal(variant.id, 'card-safe-copy');
  assert.equal(variant.layers[0].blendMode, 'normal');
  assert.deepEqual(source, before);
  assert.ok(Object.isFrozen(variant));
});

test('simplification rejects dangerous or non-schema paths without polluting prototypes', () => {
  const source = recipe({
    requirements: [{
      capability: 'unsafe-input',
      required: true,
      simplification: {
        action: 'replace-feature',
        label: 'Unsafe change',
        path: ['__proto__', 'patternLabPolluted'],
        value: true,
      },
    }],
  });

  try {
    assert.throws(() => createPatternLabSimplificationVariant(source, [{
      action: 'replace-feature',
      label: 'Unsafe direct change',
      path: ['constructor', 'prototype', 'patternLabPolluted'],
      value: true,
    }]), /allowed schema path/);
    const result = classifyPatternLabCompatibility(source, {
      metrics: FIT_METRICS,
      simplificationMetrics: FIT_METRICS,
    });
    assert.equal(result.classification, 'studio-only');
    assert.equal(result.simplification, null);
    assert.equal(Object.prototype.patternLabPolluted, undefined);
    assert.equal({}.patternLabPolluted, undefined);
  } finally {
    delete Object.prototype.patternLabPolluted;
  }
});

test('simplification removes multiple array entries without index drift', () => {
  const source = recipe({
    requirements: [
      { capability: 'live-camera', required: true },
      { capability: 'live-audio', required: true },
      { capability: 'time', required: true },
    ],
  });
  const variant = createPatternLabSimplificationVariant(source, [
    { action: 'remove-feature', label: 'Remove camera', path: ['requirements', 0], remove: true },
    { action: 'remove-feature', label: 'Remove audio', path: ['requirements', 1], remove: true },
  ]);

  assert.deepEqual(variant.requirements, [{ capability: 'time', required: true }]);
});

test('array removals stay descending when replacement operations are interleaved', () => {
  const source = recipe({
    requirements: [
      { capability: 'live-camera', required: true },
      { capability: 'live-audio', required: true },
      { capability: 'time', required: true },
    ],
  });
  const variant = createPatternLabSimplificationVariant(source, [
    { action: 'remove-feature', label: 'Remove camera', path: ['requirements', 0], remove: true },
    { action: 'replace-feature', label: 'Use ocean', path: ['base', 'patternId'], value: 'ocean' },
    { action: 'remove-feature', label: 'Remove audio', path: ['requirements', 1], remove: true },
  ]);

  assert.equal(variant.base.patternId, 'ocean');
  assert.deepEqual(variant.requirements, [{ capability: 'time', required: true }]);
});

test('bounded state watcher limits flattened coordinate and state entries', () => {
  const watcher = buildPatternLabStateWatcher({
    zeta: 4,
    motion: { velocity: 0.25, phase: 0.75 },
    energy: 0.5,
  }, { maxEntries: 2 });

  assert.equal(watcher.entries.length, 2);
  assert.equal(watcher.maxEntries, 2);
  assert.equal(watcher.truncated, true);
  assert.ok(Object.isFrozen(watcher.entries));
});

test('state watcher stops traversal at its entry and depth bounds', () => {
  let latePropertyRead = false;
  const wide = { a: 1 };
  Object.defineProperty(wide, 'z', {
    enumerable: true,
    get() {
      latePropertyRead = true;
      return 2;
    },
  });
  let deep = { value: 1 };
  for (let index = 0; index < 100; index += 1) deep = { next: deep };

  const wideWatcher = buildPatternLabStateWatcher(wide, { maxEntries: 1 });
  const deepWatcher = buildPatternLabStateWatcher(deep, { maxEntries: 4, maxDepth: 3 });

  assert.equal(latePropertyRead, false);
  assert.equal(wideWatcher.truncated, true);
  assert.ok(deepWatcher.entries.some(entry => entry.value === '[Max depth]'));
  assert.equal(deepWatcher.truncated, true);
});

test('diagnostic snapshot clamps watchers, coordinates, performance, and memory readouts', () => {
  const snapshot = createPatternLabDiagnosticsSnapshot({
    paused: false,
    frameIndex: -3,
    coordinates: { x: 2, y: -1, stripProgress: 0.4, radius: 3, angle: -2 },
    fps: 999,
    frameTimeMs: -4,
    stateBytes: -10,
    framebufferBytes: 1234.8,
    state: { a: 1, b: 2, c: 3 },
    maxWatcherEntries: 2,
  });

  assert.deepEqual(snapshot.playback, { paused: false, frameIndex: 0 });
  assert.deepEqual(snapshot.coordinates, { x: 1, y: 0, stripProgress: 0.4, radius: 1, angle: 0 });
  assert.deepEqual(snapshot.performance, { fps: 240, frameTimeMs: 0 });
  assert.deepEqual(snapshot.memory, { stateBytes: 0, framebufferBytes: 1235 });
  assert.equal(snapshot.watcher.entries.length, 2);
  assert.ok(Object.isFrozen(snapshot));
});

test('pause and frame-step returns a new frozen diagnostic state', () => {
  const source = createPatternLabDiagnosticsSnapshot({ paused: false, frameIndex: 8 });
  const stepped = stepPatternLabDiagnosticsFrame(source);
  assert.deepEqual(stepped.playback, { paused: true, frameIndex: 9 });
  assert.deepEqual(source.playback, { paused: false, frameIndex: 8 });
  assert.ok(Object.isFrozen(stepped));
});

test('dark-output explanations cover masks, brightness, gamma, power, invalid output, and targets', () => {
  const explanations = explainPatternLabDarkness({
    maskAlpha: 0,
    brightness: 0,
    gammaEnabled: true,
    gammaInput: 0.001,
    powerLimited: true,
    invalidOutput: true,
    targetMatched: false,
  });
  assert.deepEqual(explanations.map(item => item.code), [
    'masked-out',
    'brightness-zero',
    'gamma-crushed-low-values',
    'power-limited',
    'invalid-output',
    'target-not-matched',
  ]);
  assert.ok(explanations.every(item => item.message && item.action));
  assert.ok(Object.isFrozen(explanations));
});

test('dark-output explanations distinguish zero strip brightness and an observed black frame', () => {
  const explanations = explainPatternLabDarkness({
    allStripBrightnessZero: true,
    frameObserved: true,
    sampledPixelCount: 12,
    blackPixelCount: 12,
  });

  assert.deepEqual(explanations.map(item => item.code), [
    'strip-brightness-zero',
    'frame-all-black',
  ]);
  assert.match(explanations[0].message, /Every visible strip has zero brightness/);
  assert.match(explanations[1].message, /Every sampled pixel in the last preview frame is black/);
});
