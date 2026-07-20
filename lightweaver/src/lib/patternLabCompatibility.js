import { CARD_HARDWARE_CAPABILITIES } from './cardRuntimeContract.js';
import { CORE_CARD_PATTERN_BANK } from './cardPatternBank.js';
import { CARD_CONFIG_STORAGE_LIMIT_BYTES } from './cardStoragePayload.js';
import { estimateLwseqBytes } from './standaloneController.js';
import { isBuiltInPattern } from './patternRegistry.js';

export const PATTERN_LAB_COMPATIBILITY_VERSION = 1;
export const PATTERN_LAB_COMPATIBILITY_CLASSIFICATIONS = Object.freeze([
  'live-on-card',
  'bake-to-card',
  'simplify-for-card',
  'studio-only',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bounded(value, minimum, maximum, fallback = minimum) {
  return Math.min(maximum, Math.max(minimum, finite(value, fallback)));
}

function wholeBytes(value) {
  return Math.max(0, Math.round(finite(value)));
}

const DEFAULT_MICRO_SD_BYTES = 4 * 1024 * 1024 * 1024;

export const DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR = deepFreeze({
  version: 1,
  id: 'lightweaver-esp32-s3-v1',
  features: {
    generators: ['lightweaver-pattern'],
    patterns: CORE_CARD_PATTERN_BANK.map(pattern => pattern.id),
    blendModes: ['normal'],
    transforms: [],
    masks: [],
    capabilities: ['time', 'beat'],
    bakeableCapabilities: [],
    targets: ['whole-piece'],
  },
  substitutions: {
    generators: {},
    patterns: {},
    blendModes: {},
    transforms: {},
    masks: {},
    capabilities: {},
    targets: { section: 'whole-piece' },
  },
  limits: {
    pixelCount: CARD_HARDWARE_CAPABILITIES.maxPixels,
    layers: 3,
    fps: 30,
    operationsPerFrame: 250_000,
    stateBytes: 262_144,
    framebufferBytes: 196_608,
    nativeConfigBytes: CARD_CONFIG_STORAGE_LIMIT_BYTES,
    microSdBytes: DEFAULT_MICRO_SD_BYTES,
  },
  delivery: {
    nativeRecipe: true,
    lwseq: true,
    microSd: true,
  },
});

function descriptorWithDefaults(input) {
  const source = input && typeof input === 'object' ? input : {};
  const defaults = DEFAULT_PATTERN_LAB_CARD_DESCRIPTOR;
  return {
    ...clone(defaults),
    ...clone(source),
    features: { ...clone(defaults.features), ...clone(source.features || {}) },
    substitutions: { ...clone(defaults.substitutions), ...clone(source.substitutions || {}) },
    limits: { ...clone(defaults.limits), ...clone(source.limits || {}) },
    delivery: { ...clone(defaults.delivery), ...clone(source.delivery || {}) },
  };
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function parseWholeMetric(value) {
  if (value === null || value === undefined || value === '') {
    return { value: null, status: 'unknown' };
  }
  let number;
  try {
    number = Number(value);
  } catch {
    return { value: null, status: 'invalid' };
  }
  const rounded = Math.round(number);
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(rounded)) {
    return { value: null, status: 'invalid' };
  }
  return { value: rounded, status: 'value' };
}

function budget(metric, limit, options = {}) {
  const normalizedLimit = wholeBytes(limit);
  const minimum = wholeBytes(options.minimum);
  if (metric.status === 'unknown' || metric.status === 'invalid') {
    return deepFreeze({
      used: null,
      limit: normalizedLimit,
      known: false,
      status: metric.status,
      ok: false,
    });
  }
  const status = metric.value < minimum
    ? 'too-low'
    : metric.value > normalizedLimit
      ? 'over-limit'
      : 'fits';
  return deepFreeze({
    used: metric.value,
    limit: normalizedLimit,
    known: true,
    status,
    ok: status === 'fits',
  });
}

function derivedMetric(inputs, compute) {
  if (inputs.some(metric => metric.status === 'invalid')) return { value: null, status: 'invalid' };
  if (inputs.some(metric => metric.status === 'unknown')) return { value: null, status: 'unknown' };
  return parseWholeMetric(compute(...inputs.map(metric => metric.value)));
}

function buildBudgets(recipe, descriptor, metrics = {}, options = {}) {
  const estimates = options.allowRecipeEstimates === false ? {} : recipe.estimates || {};
  const runtimeFps = options.allowRecipeEstimates === false ? undefined : recipe.runtime?.fps;
  const pixelCount = parseWholeMetric(metrics.pixelCount ?? estimates.pixelCount);
  const fps = parseWholeMetric(metrics.fps ?? runtimeFps ?? estimates.fps);
  const operationsPerFrame = parseWholeMetric(
    metrics.operationsPerFrame ?? estimates.operationsPerFrame,
  );
  const stateBytes = parseWholeMetric(metrics.stateBytes ?? estimates.stateBytes);
  const estimatedFramebuffer = metrics.framebufferBytes ?? estimates.framebufferBytes;
  const framebufferBytes = estimatedFramebuffer === null || estimatedFramebuffer === undefined
    ? derivedMetric([pixelCount], pixels => pixels * 3)
    : parseWholeMetric(estimatedFramebuffer);
  const nativeConfigBytes = parseWholeMetric(metrics.nativeConfigBytes ?? byteLength(recipe));
  const duration = parseWholeMetric(metrics.durationSeconds ?? recipe.evolution?.durationSeconds);
  const lwseqBytes = derivedMetric(
    [pixelCount, fps, duration],
    (pixels, framesPerSecond, durationSeconds) => estimateLwseqBytes({
      pixels,
      fps: framesPerSecond,
      duration: durationSeconds,
    }).totalBytes,
  );
  const microSdBytes = parseWholeMetric(metrics.microSdBytes ?? descriptor.limits.microSdBytes);
  const microSdStatus = lwseqBytes.status === 'invalid' || microSdBytes.status === 'invalid'
    ? 'invalid'
    : lwseqBytes.status === 'unknown' || microSdBytes.status === 'unknown'
      ? 'unknown'
      : lwseqBytes.value > microSdBytes.value
        ? 'over-limit'
        : 'fits';

  return deepFreeze({
    pixelCount: budget(pixelCount, descriptor.limits.pixelCount, { minimum: 1 }),
    fps: budget(fps, descriptor.limits.fps, { minimum: 1 }),
    operationsPerFrame: budget(operationsPerFrame, descriptor.limits.operationsPerFrame),
    stateBytes: budget(stateBytes, descriptor.limits.stateBytes),
    framebufferBytes: budget(framebufferBytes, descriptor.limits.framebufferBytes),
    nativeConfigBytes: budget(nativeConfigBytes, descriptor.limits.nativeConfigBytes),
    lwseqBytes: budget(lwseqBytes, microSdBytes.value ?? 0),
    microSdBytes: deepFreeze({
      required: lwseqBytes.status === 'value' ? lwseqBytes.value : null,
      available: microSdBytes.status === 'value' ? microSdBytes.value : null,
      known: microSdStatus === 'fits' || microSdStatus === 'over-limit',
      status: microSdStatus,
      ok: microSdStatus === 'fits',
    }),
  });
}

function normalizeTransforms(layer) {
  if (Array.isArray(layer?.transforms)) return layer.transforms;
  if (layer?.transform) return [layer.transform];
  return [];
}

function layerGeneratorIssue(layer, index) {
  if (!layer || typeof layer !== 'object' || !Object.hasOwn(layer, 'generator')) return reason(
    'layer-generator-missing',
    `Layer ${index + 1} has no concrete generator.`,
    { bakeable: false },
  );
  const generator = layer.generator;
  if (!generator || typeof generator !== 'object' || !Object.hasOwn(generator, 'kind')) return reason(
    'layer-generator-incomplete',
    `Layer ${index + 1} has no generator kind.`,
    { bakeable: false },
  );
  const kind = typeof generator.kind === 'string' ? generator.kind.trim() : '';
  if (!kind) return reason(
    'layer-generator-incomplete',
    `Layer ${index + 1} has no generator kind.`,
    { bakeable: false },
  );
  if (kind === 'lightweaver-pattern') {
    const patternId = Object.hasOwn(generator, 'patternId') && typeof generator.patternId === 'string'
      ? generator.patternId.trim()
      : '';
    if (!patternId || !isBuiltInPattern(patternId)) return reason(
      'layer-generator-pattern-invalid',
      `Layer ${index + 1} needs a concrete built-in Lightweaver pattern.`,
      { bakeable: false },
    );
  }
  return null;
}

function collectRecipeFeatures(recipe) {
  const features = [];
  features.push({
    category: 'generators',
    value: recipe.base?.kind || 'lightweaver-pattern',
    path: ['base', 'kind'],
    code: 'generator-not-native',
    label: 'generator',
  });
  if (recipe.base?.kind === 'lightweaver-pattern' && recipe.base.patternId) features.push({
    category: 'patterns',
    value: recipe.base.patternId,
    path: ['base', 'patternId'],
    code: 'pattern-not-native',
    label: 'pattern',
  });
  for (const [index, layer] of (recipe.layers || []).entries()) {
    if (layerGeneratorIssue(layer, index)) continue;
    const generator = layer.generator.kind.trim();
    if (generator) features.push({
      category: 'generators', value: generator, path: ['layers', index, 'generator', 'kind'],
      code: 'generator-not-native', label: 'generator',
    });
    const patternId = layer.generator.patternId;
    if (generator === 'lightweaver-pattern' && patternId) features.push({
      category: 'patterns', value: patternId, path: ['layers', index, 'generator', 'patternId'],
      code: 'pattern-not-native', label: 'pattern',
    });
    if (layer.blendMode) features.push({
      category: 'blendModes', value: layer.blendMode, path: ['layers', index, 'blendMode'],
      code: 'blend-mode-not-native', label: 'blend mode',
    });
    for (const [transformIndex, transform] of normalizeTransforms(layer).entries()) {
      const path = Array.isArray(layer.transforms)
        ? ['layers', index, 'transforms', transformIndex, 'kind']
        : ['layers', index, 'transform', 'kind'];
      if (transform?.kind) features.push({
        category: 'transforms', value: transform.kind, path,
        code: 'transform-not-native', label: 'transform',
      });
    }
    if (layer.mask?.kind) features.push({
      category: 'masks', value: layer.mask.kind, path: ['layers', index, 'mask', 'kind'],
      code: 'mask-not-native', label: 'mask',
    });
  }
  for (const [index, target] of (recipe.targets || []).entries()) {
    features.push({
      category: 'targets', value: target.kind, path: ['targets', index, 'kind'],
      code: 'target-not-native', label: 'target',
    });
  }
  return features;
}

function featureReason(feature, descriptor, changes) {
  const supported = descriptor.features[feature.category] || [];
  if (supported.includes(feature.value)) return null;
  const replacement = descriptor.substitutions[feature.category]?.[feature.value];
  if (replacement !== undefined) {
    changes.push({
      action: 'replace-feature',
      label: `Replace ${feature.label} ${feature.value} with ${replacement}`,
      path: feature.path,
      value: replacement,
    });
  }
  return {
    code: feature.code,
    message: `Card descriptor ${descriptor.id} does not support ${feature.label} “${feature.value}” natively.`,
    feature: feature.value,
    bakeable: feature.category !== 'targets',
  };
}

function requirementReason(requirement, index, descriptor, changes) {
  if (requirement?.required === false) return null;
  const capability = String(requirement?.capability || '').trim();
  if (!capability || descriptor.features.capabilities.includes(capability)) return null;
  if (requirement.simplification && typeof requirement.simplification === 'object') {
    changes.push({ ...clone(requirement.simplification) });
  } else {
    const replacement = descriptor.substitutions.capabilities?.[capability];
    if (replacement !== undefined) changes.push({
      action: replacement === null ? 'remove-feature' : 'replace-feature',
      label: replacement === null ? `Remove ${capability}` : `Replace ${capability} with ${replacement}`,
      path: ['requirements', index],
      ...(replacement === null ? { remove: true } : { value: { ...requirement, capability: replacement } }),
    });
  }
  return {
    code: 'required-capability-unsupported',
    message: `Required capability “${capability}” is not available on ${descriptor.id}.`,
    feature: capability,
    bakeable: (descriptor.features.bakeableCapabilities || []).includes(capability),
  };
}

function applyChange(target, change) {
  if (!isAllowedSimplificationChange(target, change)) {
    throw new TypeError('Simplification change must use an allowed schema path with own properties');
  }
  const path = change.path;
  let parent = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    parent = parent[key];
  }
  const key = path.at(-1);
  if (Object.hasOwn(change, 'remove') && change.remove === true) {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete parent[key];
  } else {
    parent[key] = clone(change.value);
  }
}

const DANGEROUS_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const SIMPLIFICATION_PATHS = [
  ['base', 'kind'],
  ['base', 'patternId'],
  ['layers', '#'],
  ['layers', '#', 'generator', 'kind'],
  ['layers', '#', 'generator', 'patternId'],
  ['layers', '#', 'blendMode'],
  ['layers', '#', 'transforms', '#', 'kind'],
  ['layers', '#', 'transform', 'kind'],
  ['layers', '#', 'mask', 'kind'],
  ['targets', '#'],
  ['targets', '#', 'kind'],
  ['requirements', '#'],
];

function pathMatchesSchema(path, schemaPath) {
  return path.length === schemaPath.length && path.every((segment, index) => (
    schemaPath[index] === '#'
      ? Number.isInteger(segment) && segment >= 0
      : segment === schemaPath[index]
  ));
}

function isAllowedSimplificationChange(target, change) {
  if (!change || typeof change !== 'object' || !Object.hasOwn(change, 'path') || !Array.isArray(change.path)) {
    return false;
  }
  const path = change.path;
  if (!path.length || path.some(segment => (
    typeof segment === 'string' && DANGEROUS_PATH_SEGMENTS.has(segment)
  ))) return false;
  if (!SIMPLIFICATION_PATHS.some(schemaPath => pathMatchesSchema(path, schemaPath))) return false;
  if (!(Object.hasOwn(change, 'remove') && change.remove === true) && !Object.hasOwn(change, 'value')) return false;

  let current = target;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function changesInSafeApplicationOrder(changes) {
  const arrayRemovals = [];
  const otherChanges = [];
  for (const change of changes) {
    const path = Object.hasOwn(change, 'path') && Array.isArray(change.path) ? change.path : [];
    if (Object.hasOwn(change, 'remove') && change.remove === true && Number.isInteger(path.at(-1))) {
      arrayRemovals.push(change);
    } else {
      otherChanges.push(change);
    }
  }
  arrayRemovals.sort((left, right) => {
    const leftParent = JSON.stringify(left.path.slice(0, -1));
    const rightParent = JSON.stringify(right.path.slice(0, -1));
    return leftParent.localeCompare(rightParent) || right.path.at(-1) - left.path.at(-1);
  });
  return [...otherChanges, ...arrayRemovals];
}

export function createPatternLabSimplificationVariant(recipe, changes, options = {}) {
  if (!Array.isArray(changes) || !changes.length) throw new TypeError('Simplification requires at least one explicit change');
  const variant = clone(recipe);
  for (const change of changesInSafeApplicationOrder(changes)) applyChange(variant, change);
  variant.id = String(options.id || `${recipe.id}-simplified`);
  variant.name = String(options.name || `${recipe.name || 'Pattern'} — Card variant`);
  variant.provenance = [
    ...(Array.isArray(variant.provenance) ? variant.provenance : []),
    { source: 'pattern-lab-simplification', sourceRecipeId: recipe.id },
  ];
  return deepFreeze(variant);
}

function reason(code, message, extra = {}) {
  return { code, message, ...extra };
}

function uniqueActions(actions) {
  const seen = new Set();
  return actions.filter(action => {
    if (seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });
}

export function classifyPatternLabCompatibility(recipe, options = {}) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    throw new TypeError('Pattern Lab compatibility requires a recipe');
  }
  const descriptor = descriptorWithDefaults(options.descriptor);
  const evaluation = evaluatePatternLabCompatibility(recipe, descriptor, options.metrics);
  const { budgets, reasons, changes, nativeEligible, bakeEligible } = evaluation;

  const directClassification = nativeEligible
    ? 'live-on-card'
    : bakeEligible
      ? 'bake-to-card'
      : 'studio-only';
  let simplification = null;
  let simplificationResolves = false;
  if (changes.length) {
    const frozenChanges = deepFreeze(clone(changes));
    const variant = createPatternLabSimplificationVariant(
      recipe,
      frozenChanges,
      options.simplificationVariant,
    );
    const variantEvaluation = evaluatePatternLabCompatibility(
      variant,
      descriptor,
      options.simplificationMetrics,
      { allowRecipeEstimates: false },
    );
    const resultClassification = variantEvaluation.nativeEligible
      ? 'live-on-card'
      : variantEvaluation.bakeEligible
        ? 'bake-to-card'
        : 'studio-only';
    simplificationResolves = resultClassification !== 'studio-only';
    simplification = deepFreeze({
      changes: frozenChanges,
      variant,
      resolvesCompatibility: simplificationResolves,
      resultClassification,
      remainingReasons: simplificationResolves ? [] : publicReasons(variantEvaluation.reasons),
    });
  }

  const classification = directClassification !== 'studio-only'
    ? directClassification
    : simplificationResolves
      ? 'simplify-for-card'
      : 'studio-only';

  const actions = [];
  if (bakeEligible && !nativeEligible) actions.push({ id: 'bake', label: 'Bake to card', kind: 'bake' });
  if (simplificationResolves) {
    actions.push({ id: 'simplify', label: 'Create simplified variant', kind: 'simplify' });
  }
  if (changes.some(change => change.action === 'remove-feature')) {
    actions.push({ id: 'remove-feature', label: 'Remove unsupported feature', kind: 'remove-feature' });
  }

  return deepFreeze({
    version: PATTERN_LAB_COMPATIBILITY_VERSION,
    classification,
    descriptor: { id: descriptor.id, version: descriptor.version },
    budgets,
    reasons: publicReasons(reasons),
    actions: uniqueActions(actions),
    simplification,
  });
}

function publicReasons(reasons) {
  return reasons.map(item => ({
    code: item.code,
    message: item.message,
    ...(item.feature ? { feature: item.feature } : {}),
  }));
}

function evaluatePatternLabCompatibility(recipe, descriptor, metrics, options) {
  const budgets = buildBudgets(recipe, descriptor, metrics, options);
  const reasons = [];
  const changes = [];

  for (const [index, layer] of (recipe.layers || []).entries()) {
    const issue = layerGeneratorIssue(layer, index);
    if (issue) reasons.push(issue);
  }
  for (const feature of collectRecipeFeatures(recipe)) {
    const unsupported = featureReason(feature, descriptor, changes);
    if (unsupported) reasons.push(unsupported);
  }
  for (const [index, requirement] of (recipe.requirements || []).entries()) {
    const unsupported = requirementReason(requirement, index, descriptor, changes);
    if (unsupported) reasons.push(unsupported);
  }
  if ((recipe.layers || []).length > descriptor.limits.layers) reasons.push(reason(
    'layers-over-budget',
    `layers uses ${recipe.layers.length}, above the card limit of ${descriptor.limits.layers}.`,
    { bakeable: true },
  ));

  const nativeBudgetRules = {
    pixelCount: {
      overCode: 'pixel-count-over-budget',
      unknownCode: 'pixel-count-unknown',
      invalidCode: 'pixel-count-invalid',
      tooLowCode: 'pixel-count-too-low',
      bakeableWhenOver: false,
    },
    fps: {
      overCode: 'fps-over-budget',
      unknownCode: 'fps-unknown',
      invalidCode: 'fps-invalid',
      tooLowCode: 'fps-too-low',
      bakeableWhenOver: false,
    },
    operationsPerFrame: {
      overCode: 'operations-over-budget',
      unknownCode: 'operations-unknown',
      invalidCode: 'operations-invalid',
      tooLowCode: 'operations-too-low',
      bakeableWhenOver: true,
    },
    stateBytes: {
      overCode: 'state-memory-over-budget',
      unknownCode: 'state-memory-unknown',
      invalidCode: 'state-memory-invalid',
      tooLowCode: 'state-memory-too-low',
      bakeableWhenOver: true,
    },
    framebufferBytes: {
      overCode: 'framebuffer-over-budget',
      unknownCode: 'framebuffer-unknown',
      invalidCode: 'framebuffer-invalid',
      tooLowCode: 'framebuffer-too-low',
      bakeableWhenOver: true,
    },
    nativeConfigBytes: {
      overCode: 'native-config-over-budget',
      unknownCode: 'native-config-unknown',
      invalidCode: 'native-config-invalid',
      tooLowCode: 'native-config-too-low',
      bakeableWhenOver: true,
    },
  };
  for (const [key, rule] of Object.entries(nativeBudgetRules)) {
    if (budgets[key].status === 'unknown') {
      reasons.push(reason(
        rule.unknownCode,
        `${key} has no authoritative runtime estimate; card compatibility cannot be proven.`,
        { bakeable: false },
      ));
    } else if (budgets[key].status === 'invalid') {
      reasons.push(reason(
        rule.invalidCode,
        `${key} is not a finite safe non-negative integer.`,
        { bakeable: false },
      ));
    } else if (budgets[key].status === 'too-low') {
      reasons.push(reason(
        rule.tooLowCode,
        `${key} is below the minimum usable value.`,
        { bakeable: false },
      ));
    } else if (budgets[key].status === 'over-limit') {
      reasons.push(reason(
        rule.overCode,
        `${key} uses ${budgets[key].used}, above the card limit of ${budgets[key].limit}.`,
        { bakeable: rule.bakeableWhenOver },
      ));
    }
  }

  const nativeEligible = descriptor.delivery.nativeRecipe
    && reasons.length === 0
    && Object.keys(nativeBudgetRules).every(key => budgets[key].ok);
  const physicalEligible = budgets.pixelCount.known && budgets.pixelCount.ok;
  const bakeReasonsEligible = reasons.every(item => item.bakeable === true);
  const bakeEligible = descriptor.delivery.lwseq
    && descriptor.delivery.microSd
    && physicalEligible
    && bakeReasonsEligible
    && budgets.fps.ok
    && budgets.lwseqBytes.ok;

  return {
    budgets,
    reasons,
    changes: changes.filter(change => isAllowedSimplificationChange(recipe, change)),
    nativeEligible,
    bakeEligible,
  };
}

function watcherValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return String(value);
}

function flattenState(value, path, entries, ancestors, limits, depth = 0) {
  if (entries.length >= limits.maxEntries) return true;
  if (!value || typeof value !== 'object') {
    entries.push({ path: path || '$', value: watcherValue(value) });
    return false;
  }
  if (ancestors.has(value)) {
    entries.push({ path: path || '$', value: '[Circular]' });
    return false;
  }
  if (depth >= limits.maxDepth) {
    entries.push({ path: path || '$', value: '[Max depth]' });
    return true;
  }
  ancestors.add(value);
  const keys = Object.keys(value).sort();
  if (!keys.length) entries.push({ path: path || '$', value: Array.isArray(value) ? '[]' : '{}' });
  let truncated = false;
  for (const key of keys) {
    if (entries.length >= limits.maxEntries) {
      truncated = true;
      break;
    }
    truncated = flattenState(
      value[key],
      path ? `${path}.${key}` : key,
      entries,
      ancestors,
      limits,
      depth + 1,
    ) || truncated;
  }
  ancestors.delete(value);
  return truncated;
}

export function buildPatternLabStateWatcher(state, options = {}) {
  const maxEntries = Math.round(bounded(options.maxEntries, 1, 32, 12));
  const maxDepth = Math.round(bounded(options.maxDepth, 1, 16, 8));
  const entries = [];
  const truncated = flattenState(state, '', entries, new WeakSet(), { maxEntries, maxDepth });
  return deepFreeze({
    entries,
    maxEntries,
    maxDepth,
    truncated,
  });
}

export function explainPatternLabDarkness(inputs = {}) {
  const explanations = [];
  if (finite(inputs.maskAlpha, 1) <= 0.01) explanations.push({
    code: 'masked-out', message: 'The active mask removes this pixel.', action: 'Inspect or soften the layer mask.',
  });
  if (finite(inputs.brightness, 1) <= 0.01) explanations.push({
    code: 'brightness-zero', message: 'Layer or master brightness is at zero.', action: 'Raise Energy, layer opacity, or master brightness.',
  });
  if (inputs.gammaEnabled && finite(inputs.gammaInput, 1) < 0.01) explanations.push({
    code: 'gamma-crushed-low-values', message: 'Gamma maps this very low input close to black.', action: 'Raise the source level or compare with gamma disabled.',
  });
  if (inputs.powerLimited) explanations.push({
    code: 'power-limited', message: 'The power ceiling is reducing visible output.', action: 'Inspect the current limit and estimated load.',
  });
  if (inputs.invalidOutput || finite(inputs.invalidOutputCount) > 0) explanations.push({
    code: 'invalid-output', message: 'The generator returned an invalid or non-finite color.', action: 'Inspect the failing generator and last valid frame.',
  });
  if (inputs.targetMatched === false || finite(inputs.unsupportedTargetCount) > 0) explanations.push({
    code: 'target-not-matched', message: 'This pixel is outside the active or supported target.', action: 'Inspect section, group, and target selection.',
  });
  return deepFreeze(explanations);
}

export function createPatternLabDiagnosticsSnapshot(input = {}) {
  const coordinates = input.coordinates || {};
  return deepFreeze({
    version: 1,
    playback: {
      paused: Boolean(input.paused),
      frameIndex: Math.max(0, Math.floor(finite(input.frameIndex))),
    },
    coordinates: {
      x: bounded(coordinates.x, 0, 1),
      y: bounded(coordinates.y, 0, 1),
      stripProgress: bounded(coordinates.stripProgress, 0, 1),
      radius: bounded(coordinates.radius, 0, 1),
      angle: bounded(coordinates.angle, 0, 1),
    },
    performance: {
      fps: bounded(input.fps, 0, 240),
      frameTimeMs: bounded(input.frameTimeMs, 0, 1000),
    },
    memory: {
      stateBytes: wholeBytes(input.stateBytes),
      framebufferBytes: wholeBytes(input.framebufferBytes),
    },
    watcher: buildPatternLabStateWatcher(input.state ?? {}, { maxEntries: input.maxWatcherEntries }),
    darkness: explainPatternLabDarkness(input.darkness || input),
  });
}

export function stepPatternLabDiagnosticsFrame(snapshot, amount = 1) {
  const next = clone(snapshot);
  next.playback = {
    paused: true,
    frameIndex: Math.max(0, Math.floor(finite(snapshot?.playback?.frameIndex)))
      + Math.max(1, Math.floor(finite(amount, 1))),
  };
  return deepFreeze(next);
}
