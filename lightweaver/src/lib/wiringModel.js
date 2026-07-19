import { CARD_HARDWARE_CAPABILITIES } from './cardRuntimeContract.js';

export const WIRING_VERSION = 1;
const clone = value => JSON.parse(JSON.stringify(value));
const integer = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;

const stripCount = strip => Math.max(0, integer(strip?.pixelCount ?? strip?.pixels?.length ?? strip?.leds, 0));

export function makeDefaultWiring(strips = [], options = {}) {
  const runs = strips.map(strip => ({
    id: `run-${strip.id}`,
    type: 'strip',
    source: { stripId: strip.id, from: 0, to: Math.max(0, stripCount(strip) - 1) },
    directionPolicy: 'flexible',
    physicalDirection: 'source-forward',
    seamLed: null,
    verified: false,
  }));
  return {
    version: WIRING_VERSION,
    locked: false,
    verified: false,
    controllerAnchor: options.controllerAnchor ?? null,
    outputs: [{ id: 'out1', name: 'Output 1', pin: options.pin ?? 16, runIds: runs.map(run => run.id) }],
    runs,
  };
}

export function reconcileWiringToStrips(wiring, strips = []) {
  const model = normalizeWiring(wiring);
  const stripById = new Map(strips.map(strip => [String(strip.id), strip]));
  const runsByStrip = new Map();
  for (const run of model.runs) {
    if (run.type !== 'strip') continue;
    const stripId = String(run.source?.stripId || '');
    const runs = runsByStrip.get(stripId) || [];
    runs.push(run);
    runsByStrip.set(stripId, runs);
  }

  let changed = false;
  for (const [stripId, runs] of runsByStrip) {
    // Split runs carry intentional Advanced-wiring boundaries. A single Draw
    // run represents the complete strip and must follow its live LED count.
    if (runs.length !== 1) continue;
    const strip = stripById.get(stripId);
    if (!strip) continue;
    const lastLed = Math.max(0, stripCount(strip) - 1);
    const run = runs[0];
    if (run.source.from !== 0 || run.source.to !== lastLed) {
      run.source.from = 0;
      run.source.to = lastLed;
      changed = true;
    }
    if (run.seamLed != null) {
      const seamLed = Math.max(0, Math.min(lastLed, run.seamLed));
      if (seamLed !== run.seamLed) {
        run.seamLed = seamLed;
        changed = true;
      }
    }
  }
  if (changed) {
    model.locked = false;
    model.verified = false;
    model.runs.forEach(run => { run.verified = false; });
  }
  return model;
}

export function migrateWiring(wiring, strips = [], legacyPatchBoard = null, options = {}) {
  if (wiring && typeof wiring === 'object') return reconcileWiringToStrips(wiring, strips);
  if (!legacyPatchBoard?.patches?.length) return makeDefaultWiring(strips, options);
  const patchesById = new Map(legacyPatchBoard.patches.map(patch => [patch.id, patch]));
  const savedRows = legacyPatchBoard.chains?.[0]?.rowIds;
  const rowIds = Array.isArray(savedRows) && savedRows.length ? savedRows : legacyPatchBoard.patches.map(patch => patch.id);
  const runs = [];
  for (const id of rowIds) {
    const patch = patchesById.get(id);
    if (!patch) continue;
    if (patch.source?.type === 'off') {
      runs.push({ id, type: 'inactive', count: integer(patch.source.ledCount), verified: legacyPatchBoard.physicalLocked === true });
      continue;
    }
    if (patch.source?.type !== 'strip') continue;
    const a = integer(patch.source.startLed);
    const b = integer(patch.source.endLed);
    runs.push({
      id,
      type: 'strip',
      source: { stripId: patch.source.stripId, from: Math.min(a, b), to: Math.max(a, b) },
      directionPolicy: 'flexible',
      physicalDirection: a > b ? 'source-reverse' : 'source-forward',
      seamLed: null,
      verified: legacyPatchBoard.physicalLocked === true,
    });
  }
  const configuredOutputs = (options.outputs || []).filter(output => Number(output?.pixels) > 0).slice(0, 4);
  const migrationWarnings = [];
  const outputs = configuredOutputs.length
    ? configuredOutputs.map((output, index) => ({
        id: String(output.id || `out${index + 1}`),
        name: String(output.name || `Output ${index + 1}`),
        pin: integer(output.pin, [16, 17, 18, 21][index] ?? 16),
        runIds: [],
      }))
    : [{ id: 'out1', name: 'Output 1', pin: options.pin ?? 16, runIds: [] }];
  const boundaries = [];
  let boundary = 0;
  for (const output of configuredOutputs.slice(0, -1)) {
    boundary += integer(output.pixels);
    boundaries.push(boundary);
  }
  let outputIndex = 0;
  let cursor = 0;
  const addressCount = run => run.type === 'inactive'
    ? Math.max(0, integer(run.count))
    : run.type === 'strip'
      ? Math.max(0, run.source.to - run.source.from + 1)
      : 0;
  for (const run of runs) {
    const count = addressCount(run);
    const nextBoundary = boundaries[outputIndex];
    if (nextBoundary != null && cursor < nextBoundary && cursor + count > nextBoundary) {
      migrationWarnings.push(error('output-boundary-inside-run', `Configured output boundary ${nextBoundary} falls inside run ${run.id}; review required.`, {
        runId: run.id,
        boundary: nextBoundary,
      }));
    }
    outputs[Math.min(outputIndex, outputs.length - 1)].runIds.push(run.id);
    cursor += count;
    while (boundaries[outputIndex] != null && cursor >= boundaries[outputIndex] && outputIndex < outputs.length - 1) outputIndex += 1;
  }
  for (const configuredBoundary of boundaries) {
    if (configuredBoundary > cursor) migrationWarnings.push(error('output-boundary-beyond-wiring', `Configured output boundary ${configuredBoundary} exceeds migrated wiring total ${cursor}; review required.`, {
      boundary: configuredBoundary,
      totalPixels: cursor,
    }));
  }
  const configuredTotal = configuredOutputs.reduce((sum, output) => sum + integer(output.pixels), 0);
  if (configuredTotal > cursor) migrationWarnings.push(error('output-total-beyond-wiring', `Configured output total ${configuredTotal} exceeds migrated wiring total ${cursor}; review required.`, {
    configuredTotal,
    totalPixels: cursor,
  }));
  const migrationNeedsReview = migrationWarnings.length > 0;
  if (migrationNeedsReview) for (const run of runs) run.verified = false;
  return normalizeWiring({
    version: WIRING_VERSION,
    locked: legacyPatchBoard.physicalLocked === true && !migrationNeedsReview,
    verified: legacyPatchBoard.physicalLocked === true && !migrationNeedsReview,
    controllerAnchor: options.controllerAnchor ?? null,
    outputs,
    runs,
    migrationWarnings,
  });
}

export function normalizeWiring(input = {}) {
  return {
    version: WIRING_VERSION,
    locked: input.locked === true,
    verified: input.verified === true,
    controllerAnchor: input.controllerAnchor ?? null,
    migrationWarnings: Array.isArray(input.migrationWarnings) ? clone(input.migrationWarnings) : [],
    outputs: (Array.isArray(input.outputs) ? input.outputs : []).map((output, index) => ({
      id: String(output?.id || `out${index + 1}`),
      ...(output?.name ? { name: String(output.name) } : {}),
      pin: integer(output?.pin, [16, 17, 18, 21][index] ?? 16),
      runIds: Array.isArray(output?.runIds) ? output.runIds.map(String) : [],
    })),
    runs: (Array.isArray(input.runs) ? input.runs : []).map((run, index) => {
      const type = ['strip', 'inactive', 'cable'].includes(run?.type) ? run.type : 'strip';
      const normalized = { id: String(run?.id || `run-${index + 1}`), type, verified: run?.verified === true };
      if (type === 'strip') {
        normalized.source = {
          stripId: String(run.source?.stripId || ''),
          from: integer(run.source?.from),
          to: integer(run.source?.to),
        };
        normalized.directionPolicy = run.directionPolicy || 'flexible';
        normalized.physicalDirection = run.physicalDirection || 'source-forward';
        normalized.seamLed = run.seamLed == null ? null : integer(run.seamLed);
      } else if (type === 'inactive') {
        normalized.count = integer(run.count);
      }
      if (Array.isArray(run?.nextRunIds)) normalized.nextRunIds = run.nextRunIds.map(String);
      return normalized;
    }),
  };
}

const error = (code, message, extra = {}) => ({ code, message, ...extra });

export function validateWiring(wiring, strips = [], capabilities = CARD_HARDWARE_CAPABILITIES, options = {}) {
  const rawRuns = Array.isArray(wiring?.runs) ? wiring.runs : [];
  const model = normalizeWiring(wiring);
  const errors = [];
  const warnings = [...model.migrationWarnings];
  const validateSources = options.validateSources !== false;
  if (model.outputs.length < 1 || model.outputs.length > capabilities.maxOutputs) errors.push(error('output-count', `Wiring requires one to ${capabilities.maxOutputs} outputs.`));
  const outputIds = new Set();
  const pins = new Set();
  const runRefs = new Map();
  const runsById = new Map(model.runs.map(run => [run.id, run]));
  for (const output of model.outputs) {
    if (outputIds.has(output.id)) errors.push(error('output-id-duplicate', `Duplicate output ID ${output.id}.`, { outputId: output.id }));
    if (pins.has(output.pin)) errors.push(error('output-pin-duplicate', `Duplicate output pin ${output.pin}.`, { pin: output.pin }));
    if (!capabilities.supportedOutputPins.includes(output.pin)) errors.push(error('output-pin-unsupported', `Unsupported output pin ${output.pin}.`, { pin: output.pin }));
    outputIds.add(output.id); pins.add(output.pin);
    for (const runId of output.runIds) {
      if (!runsById.has(runId)) errors.push(error('run-missing', `Output ${output.id} references missing run ${runId}.`, { runId }));
      runRefs.set(runId, (runRefs.get(runId) || 0) + 1);
    }
  }
  const stripById = new Map(strips.map(strip => [strip.id, strip]));
  const runIds = new Set();
  for (const run of model.runs) {
    if (runIds.has(run.id)) errors.push(error('run-id-duplicate', `Duplicate run ID ${run.id}.`, { runId: run.id }));
    runIds.add(run.id);
    const refs = runRefs.get(run.id) || 0;
    if (refs === 0) errors.push(error('run-unassigned', `Run ${run.id} is not assigned to an output.`, { runId: run.id }));
    if (refs > 1) errors.push(error('run-duplicate', `Run ${run.id} appears more than once.`, { runId: run.id }));
    if ((run.nextRunIds || []).length > 1) errors.push(error('run-branch', `Run ${run.id} branches.`, { runId: run.id }));
    if ((run.nextRunIds || []).includes(run.id)) errors.push(error('run-cycle', `Run ${run.id} cycles to itself.`, { runId: run.id }));
    if (run.type === 'inactive' && run.count <= 0) errors.push(error('inactive-count-invalid', `Inactive run ${run.id} needs a positive count.`, { runId: run.id }));
    const rawRun = rawRuns.find(item => String(item?.id || '') === run.id);
    if (rawRun?.verified != null && typeof rawRun.verified !== 'boolean') errors.push(error('run-verified-invalid', `Run ${run.id} verified state must be boolean.`, { runId: run.id }));
    if (run.type !== 'strip') continue;
    if (run.source.from > run.source.to) errors.push(error('source-range-descending', `Run ${run.id} source range must be ascending.`, { runId: run.id }));
    if (!['flexible', 'fixed'].includes(run.directionPolicy)) errors.push(error('direction-policy-invalid', `Run ${run.id} has an invalid direction policy.`, { runId: run.id }));
    if (!['source-forward', 'source-reverse'].includes(run.physicalDirection)) errors.push(error('physical-direction-invalid', `Run ${run.id} has an invalid physical direction.`, { runId: run.id }));
    const strip = stripById.get(run.source.stripId);
    if (!strip && validateSources) errors.push(error('source-strip-missing', `Run ${run.id} references missing strip ${run.source.stripId}.`, { runId: run.id }));
    else if (strip && (run.source.from < 0 || run.source.to >= stripCount(strip))) errors.push(error('source-range-out-of-bounds', `Run ${run.id} is outside its strip.`, { runId: run.id }));
    if (run.seamLed != null && (run.seamLed < run.source.from || run.seamLed > run.source.to)) errors.push(error('seam-out-of-range', `Run ${run.id} seam is outside its source range.`, { runId: run.id }));
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = runId => {
    if (visiting.has(runId)) {
      errors.push(error('run-cycle', `Run graph contains a cycle at ${runId}.`, { runId }));
      return;
    }
    if (visited.has(runId)) return;
    visiting.add(runId);
    for (const nextId of runsById.get(runId)?.nextRunIds || []) if (runsById.has(nextId)) visit(nextId);
    visiting.delete(runId);
    visited.add(runId);
  };
  for (const run of model.runs) visit(run.id);
  return { ok: errors.length === 0, errors, warnings, wiring: model };
}

export function updateWiring(wiring, mutate, options = {}) {
  const current = normalizeWiring(wiring);
  const draft = clone(current);
  try { mutate(draft); } catch (cause) { return { ok: false, wiring: current, errors: [error('mutation-failed', cause.message || String(cause))] }; }
  let next = normalizeWiring(draft);
  if (current.locked && next.locked && wiringFingerprint(current) !== wiringFingerprint(next)) {
    return { ok: false, wiring: current, errors: [error('wiring-locked', 'Unlock verified wiring before changing physical configuration.')] };
  }
  const validation = validateWiring(next, options.strips || [], options.capabilities || CARD_HARDWARE_CAPABILITIES, {
    validateSources: options.validateSources,
  });
  if (!validation.ok) return { ok: false, wiring: current, errors: validation.errors };
  if (wiringFingerprint(current) !== wiringFingerprint(next) && invalidatesVerifiedWiring(options.changeKind || 'route')) {
    const invalidation = invalidateWiringVerification(next, { kind: options.changeKind || 'route', runIds: options.runIds });
    if (!invalidation.ok) return { ok: false, wiring: current, errors: invalidation.errors };
    next = invalidation.wiring;
  }
  return { ok: true, wiring: next, errors: [], warnings: validation.warnings };
}

export function invalidatesVerifiedWiring(change) {
  const kind = typeof change === 'string' ? change : change?.kind;
  return new Set(['geometry', 'led-count', 'direction', 'route', 'output', 'seam', 'controller-anchor', 'gpio']).has(kind);
}

export const PHYSICAL_COMPAT_FIELD_KINDS = Object.freeze({
  strips: 'geometry',
  density: 'led-count',
  pxPerMm: 'geometry',
  editCounts: 'led-count',
  stripCountOverrides: 'led-count',
  stripDensities: 'led-count',
});

export function physicalChangeKindForCompatField(field) {
  return PHYSICAL_COMPAT_FIELD_KINDS[field] || null;
}

const physicalControllerPins = controller => ({
  encoderA: controller?.controls?.encoder?.a,
  encoderB: controller?.controls?.encoder?.b,
  encoderPress: controller?.controls?.encoder?.press,
  encoderAlternatePress: controller?.controls?.encoder?.alternatePress,
  previous: controller?.controls?.previous,
  next: controller?.controls?.next,
  blackout: controller?.controls?.blackout,
  brightness: controller?.controls?.brightness,
  statusLed: controller?.controls?.statusLed,
});

const physicalStandaloneOutputs = controller => (controller?.outputs || []).map(output => ({
  id: String(output?.id || ''),
  pin: integer(output?.pin),
  pixels: Math.max(0, integer(output?.pixels ?? output?.pixelCount)),
}));

const physicalWiringOutputs = outputs => outputs.map(output => ({
  id: output.id,
  pin: output.pin,
  runIds: output.runIds,
}));

export function standaloneControllerPhysicalChangeKind(previous, next) {
  if (JSON.stringify(physicalStandaloneOutputs(previous)) !== JSON.stringify(physicalStandaloneOutputs(next))) return 'output';
  if (JSON.stringify(physicalControllerPins(previous)) !== JSON.stringify(physicalControllerPins(next))) return 'gpio';
  return null;
}

export function invalidateWiringVerification(wiring, { kind, runIds } = {}) {
  if (!invalidatesVerifiedWiring(kind)) return { ok: true, wiring, errors: [] };
  const current = normalizeWiring(wiring);
  if (current.locked) return { ok: false, wiring: current, errors: [error('wiring-locked', 'Unlock verified wiring before changing physical configuration.')] };
  const affected = Array.isArray(runIds) && runIds.length ? new Set(runIds) : null;
  return {
    ok: true,
    wiring: {
      ...current,
      verified: false,
      runs: current.runs.map(run => affected && !affected.has(run.id) ? run : { ...run, verified: false }),
    },
    errors: [],
  };
}

export function wiringFingerprint(wiring) {
  const model = normalizeWiring(wiring);
  const runs = model.runs.map(({ verified, ...run }) => run);
  return JSON.stringify({ controllerAnchor: model.controllerAnchor, outputs: physicalWiringOutputs(model.outputs), runs });
}
