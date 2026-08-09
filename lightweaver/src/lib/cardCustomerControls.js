import { normalizeCardVisualLook } from './cardVisualLook.js';
import { CUSTOMER_CONTROL_WIRE_FIELDS } from './cardCustomerControlContract.js';

const MAX_PATTERNS = 48;
const MAX_ZONES = 16;
const MAX_TEXT_LENGTH = 96;
const PATTERN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
let nextControlRevision = (Date.now() >>> 0) || 1;

function boundedText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text && text.length <= MAX_TEXT_LENGTH ? text : fallback;
}

function normalizedPatterns(payload = {}) {
  if (!Array.isArray(payload.patterns) || payload.patterns.length > MAX_PATTERNS) {
    throw new TypeError('Malformed card pattern response.');
  }
  const seen = new Set();
  const patterns = payload.patterns.map(pattern => {
    const id = boundedText(pattern?.id);
    const label = boundedText(pattern?.label, id);
    if (!PATTERN_ID.test(id) || !label || seen.has(id)) throw new TypeError('Malformed card pattern response.');
    seen.add(id);
    const mode = boundedText(pattern?.mode, 'procedural');
    if (!PATTERN_ID.test(mode) || !Array.isArray(pattern?.zones || [])) throw new TypeError('Malformed card pattern response.');
    if (pattern?.controls !== undefined && (!pattern.controls || typeof pattern.controls !== 'object' || Array.isArray(pattern.controls))) {
      throw new TypeError('Malformed card pattern response.');
    }
    const explicit = pattern?.controls || {};
    if (['customColor', 'breathe', 'drift'].some(key => explicit[key] !== undefined && typeof explicit[key] !== 'boolean')) {
      throw new TypeError('Malformed card pattern response.');
    }
    const runtimePatternId = boundedText(pattern?.runtimePatternId);
    if (pattern?.runtimePatternId !== undefined && !PATTERN_ID.test(runtimePatternId)) throw new TypeError('Malformed card pattern response.');
    return {
      id,
      label,
      mode,
      runtimePatternId,
      zones: (pattern.zones || []).map(zone => ({ id: boundedText(zone?.id), label: boundedText(zone?.label), patternId: boundedText(zone?.patternId) })),
      controls: {
        customColor: explicit.customColor === true,
        breathe: explicit.breathe === true,
        drift: explicit.drift === true,
      },
    };
  });
  if (!patterns.length) throw new TypeError('Malformed card pattern response.');
  return patterns;
}

function normalizedZone(payload = {}) {
  if (!Array.isArray(payload.zones) || !payload.zones.length || payload.zones.length > MAX_ZONES) {
    throw new TypeError('Malformed card zone response.');
  }
  for (const candidate of payload.zones) {
    const candidateId = boundedText(candidate?.id);
    if (!PATTERN_ID.test(candidateId)) throw new TypeError('Malformed card zone response.');
  }
  const zone = payload.zones[0];
  const id = boundedText(zone?.id);
  if (!id || !PATTERN_ID.test(id)) throw new TypeError('Malformed card zone response.');
  return {
    id,
    label: boundedText(zone?.label, 'Whole piece'),
    look: {
      patternId: boundedText(zone?.patternId),
      brightness: zone?.brightness,
      speed: zone?.speed,
      hueShift: zone?.hueShift,
      customHue: zone?.customHue ?? zone?.hue,
      customSaturation: zone?.customSaturation ?? zone?.saturation,
      customBreathe: zone?.customBreathe ?? zone?.breathe,
      breatheLowerPct: zone?.breatheLowerPct,
      breatheUpperPct: zone?.breatheUpperPct,
      breatheCycleSeconds: zone?.breatheCycleSeconds,
      customDrift: zone?.customDrift ?? zone?.drift,
      driftHueMin: zone?.driftHueMin ?? zone?.driftMin,
      driftHueMax: zone?.driftHueMax ?? zone?.driftMax,
    },
    blackout: zone?.blackout === true,
  };
}

function normalizedLook(source = {}, patterns = []) {
  const requestedPattern = boundedText(source.patternId);
  const patternId = patterns.some(pattern => pattern.id === requestedPattern)
    ? requestedPattern
    : patterns[0].id;
  const normalized = normalizeCardVisualLook({ ...source, patternId });
  const driftHueMin = Math.max(0, Math.min(255, Math.trunc(Number(source.driftHueMin ?? 0) || 0)));
  const driftHueMax = Math.max(0, Math.min(255, Math.trunc(Number(source.driftHueMax ?? 255) || 0)));
  return { ...normalized, patternId, driftHueMin, driftHueMax };
}

export function normalizeCardCustomerControls(zonesPayload = {}, patternsPayload = {}) {
  const patterns = normalizedPatterns(patternsPayload);
  const zone = normalizedZone(zonesPayload);
  const activePatternId = patterns.some(pattern => pattern.id === boundedText(patternsPayload.currentId))
    ? boundedText(patternsPayload.currentId)
    : (patterns.some(pattern => pattern.id === zone.look.patternId) ? zone.look.patternId : patterns[0].id);
  return {
    zone: { id: zone.id, label: zone.label },
    patterns,
    activePatternId,
    look: normalizedLook({ ...zone.look, patternId: activePatternId }, patterns),
    blackout: zone.blackout,
  };
}

function clone(value) {
  return structuredClone(value);
}

export function createCardCustomerControls(confirmed) {
  const model = clone(confirmed);
  return { confirmed: model, view: clone(model), pending: null, failure: null, retry: null };
}

function allocateControlRevision() {
  nextControlRevision = (nextControlRevision + 1) >>> 0;
  if (nextControlRevision === 0) nextControlRevision = 1;
  return nextControlRevision;
}

export function beginCustomerControl(state, patch = {}, options = {}) {
  const command = { id: options.revision || allocateControlRevision(), patch: clone(patch) };
  const nextView = {
    ...state.view,
    activePatternId: patch.patternId && state.view.patterns.some(pattern => pattern.id === patch.patternId)
      ? patch.patternId
      : state.view.activePatternId,
    look: normalizedLook({ ...state.view.look, ...patch }, state.view.patterns),
    blackout: typeof patch.blackout === 'boolean' ? patch.blackout : state.view.blackout,
  };
  nextView.look.patternId = nextView.activePatternId;
  return { ...state, view: nextView, pending: command, failure: null, retry: null, command };
}

function responseLook(model, response = {}, patch = {}) {
  const patternId = boundedText(patch.patternId, model.activePatternId);
  const responseValues = Object.fromEntries(CUSTOMER_CONTROL_WIRE_FIELDS.flatMap(field => (
    field.control === 'patternId' || field.control === 'blackout' || response[field.acknowledgement] === undefined
      ? []
      : [[field.control, response[field.acknowledgement]]]
  )));
  return {
    ...model,
    activePatternId: model.patterns.some(pattern => pattern.id === patternId) ? patternId : model.activePatternId,
    look: normalizedLook({
      ...model.look,
      patternId,
      ...responseValues,
    }, model.patterns),
    blackout: typeof response.blackout === 'boolean' ? response.blackout : model.blackout,
  };
}

export function applyCustomerControlAcknowledgement(state, commandId, responseOrError) {
  if (!state.pending || state.pending.id !== commandId) return state;
  if (responseOrError instanceof Error || responseOrError?.ok !== true) {
    return {
      ...state,
      view: clone(state.confirmed),
      pending: null,
      retry: clone(state.pending.patch),
      failure: responseOrError instanceof Error ? responseOrError : new Error('The card did not accept that control.'),
    };
  }
  const missing = Object.keys(state.pending.patch).some(key => {
    const field = CUSTOMER_CONTROL_WIRE_FIELDS.find(candidate => candidate.control === key);
    return !field || responseOrError[field.acknowledgement] === undefined;
  });
  if (missing) {
    return {
      ...state,
      view: clone(state.confirmed),
      pending: null,
      retry: clone(state.pending.patch),
      failure: new Error('The card did not confirm every changed control.'),
    };
  }
  const confirmed = responseLook(state.confirmed, responseOrError, state.pending.patch);
  return { ...state, confirmed, view: clone(confirmed), pending: null, failure: null, retry: null };
}
