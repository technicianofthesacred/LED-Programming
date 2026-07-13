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

export function migrateWiring(wiring, strips = [], legacyPatchBoard = null, options = {}) {
  if (wiring && typeof wiring === 'object') return normalizeWiring(wiring);
  if (!legacyPatchBoard?.patches?.length) return makeDefaultWiring(strips, options);
  const patchesById = new Map(legacyPatchBoard.patches.map(patch => [patch.id, patch]));
  const savedRows = legacyPatchBoard.chains?.[0]?.rowIds;
  const rowIds = Array.isArray(savedRows) && savedRows.length ? savedRows : legacyPatchBoard.patches.map(patch => patch.id);
  const runs = [];
  for (const id of rowIds) {
    const patch = patchesById.get(id);
    if (!patch) continue;
    if (patch.source?.type === 'off') {
      runs.push({ id, type: 'inactive', count: integer(patch.source.ledCount) });
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
    });
  }
  return normalizeWiring({
    version: WIRING_VERSION,
    locked: legacyPatchBoard.physicalLocked === true,
    verified: legacyPatchBoard.physicalLocked === true,
    controllerAnchor: options.controllerAnchor ?? null,
    outputs: [{ id: 'out1', name: 'Output 1', pin: options.pin ?? 16, runIds: runs.map(run => run.id) }],
    runs,
  });
}

export function normalizeWiring(input = {}) {
  return {
    version: WIRING_VERSION,
    locked: input.locked === true,
    verified: input.verified === true,
    controllerAnchor: input.controllerAnchor ?? null,
    outputs: (Array.isArray(input.outputs) ? input.outputs : []).map((output, index) => ({
      id: String(output?.id || `out${index + 1}`),
      ...(output?.name ? { name: String(output.name) } : {}),
      pin: integer(output?.pin, [16, 17, 18, 21][index] ?? 16),
      runIds: Array.isArray(output?.runIds) ? output.runIds.map(String) : [],
    })),
    runs: (Array.isArray(input.runs) ? input.runs : []).map((run, index) => {
      const type = ['strip', 'inactive', 'cable'].includes(run?.type) ? run.type : 'strip';
      const normalized = { id: String(run?.id || `run-${index + 1}`), type };
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

export function validateWiring(wiring, strips = [], capabilities = CARD_HARDWARE_CAPABILITIES) {
  const model = normalizeWiring(wiring);
  const errors = [];
  const warnings = [];
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
    if (run.type !== 'strip') continue;
    if (run.source.from > run.source.to) errors.push(error('source-range-descending', `Run ${run.id} source range must be ascending.`, { runId: run.id }));
    if (!['flexible', 'fixed'].includes(run.directionPolicy)) errors.push(error('direction-policy-invalid', `Run ${run.id} has an invalid direction policy.`, { runId: run.id }));
    if (!['source-forward', 'source-reverse'].includes(run.physicalDirection)) errors.push(error('physical-direction-invalid', `Run ${run.id} has an invalid physical direction.`, { runId: run.id }));
    const strip = stripById.get(run.source.stripId);
    if (!strip) errors.push(error('source-strip-missing', `Run ${run.id} references missing strip ${run.source.stripId}.`, { runId: run.id }));
    else if (run.source.from < 0 || run.source.to >= stripCount(strip)) errors.push(error('source-range-out-of-bounds', `Run ${run.id} is outside its strip.`, { runId: run.id }));
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
  const next = normalizeWiring(draft);
  if (current.locked && wiringFingerprint(current) !== wiringFingerprint(next)) {
    return { ok: false, wiring: current, errors: [error('wiring-locked', 'Unlock verified wiring before changing physical configuration.')] };
  }
  const validation = validateWiring(next, options.strips || [], options.capabilities || CARD_HARDWARE_CAPABILITIES);
  if (options.validate === true && !validation.ok) return { ok: false, wiring: current, errors: validation.errors };
  return { ok: true, wiring: next, errors: [], warnings: validation.warnings };
}

export function invalidatesVerifiedWiring(change) {
  const kind = typeof change === 'string' ? change : change?.kind;
  return new Set(['geometry', 'led-count', 'direction', 'route', 'output', 'seam', 'controller-anchor', 'gpio']).has(kind);
}

export function wiringFingerprint(wiring) {
  const model = normalizeWiring(wiring);
  return JSON.stringify({ controllerAnchor: model.controllerAnchor, outputs: model.outputs, runs: model.runs });
}
