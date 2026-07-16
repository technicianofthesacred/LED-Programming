export const PRODUCTION_DIAGNOSTIC_MAX_CHANNEL = 0x20;
export const PRODUCTION_CANDIDATE_ROLLBACK_MS = 90_000;
export const PRODUCTION_PHYSICAL_OBSERVATIONS = Object.freeze([
  'correct', 'nothing-lit', 'wrong-color', 'wrong-start-end', 'wrong-count',
  'wrong-output', 'flashing-or-frozen',
]);

const ROUTES = Object.freeze({
  'nothing-lit': { action: 'inspect-power-data', title: 'Nothing lit', guidance: 'Check power, ground, and DATA IN before changing software.' },
  'wrong-color': { action: 'test-color-order', title: 'Colors are wrong', guidance: 'Try the next color order as a temporary 90-second candidate.' },
  'wrong-start-end': { action: 'test-direction', title: 'Blue and red are swapped', guidance: 'Try the opposite direction as a temporary 90-second candidate.' },
  'wrong-count': { action: 'adjust-count', title: 'The red end is off', guidance: 'Move the pixel count by one and test again.' },
  'wrong-output': { action: 'test-gpio-output', title: 'A different strip lit', guidance: 'Try the GPIO for the strip that actually lit.' },
  'flashing-or-frozen': { action: 'release-restart-stream', title: 'Lights flashed or froze', guidance: 'Release the test stream, reconnect the card, then test this output again.' },
  correct: { action: 'confirm-output', title: 'Output looks correct', guidance: 'Record this physical observation and continue.' },
});

export function productionDiagnosticCurrentEstimate(frame, maxMilliamps) {
  const limit = Number(maxMilliamps);
  if (!Number.isSafeInteger(limit) || limit < 100 || limit > 20000) throw new Error('A validated aggregate current limit is required.');
  const channelTotal = (frame || []).reduce((sum, pixel) => sum + (String(pixel).match(/../g) || []).reduce((nested, channel) => nested + Number.parseInt(channel, 16), 0), 0);
  const uncappedMilliamps = Math.ceil((channelTotal / 255) * 20);
  return { uncappedMilliamps, cappedMilliamps: Math.min(uncappedMilliamps, limit), maxMilliamps: limit };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function boundedOutputs(outputs) {
  if (!Array.isArray(outputs) || !outputs.length || outputs.length > 4) throw new Error('Physical verification requires one to four outputs.');
  const ids = new Set();
  return outputs.map(output => {
    const pixels = Number(output?.pixels);
    if (!output?.id || ids.has(output.id) || !Number.isSafeInteger(pixels) || pixels < 2 || pixels > 1024) throw new Error('Each diagnostic output must have a unique ID and at least two bounded pixels.');
    ids.add(output.id);
    return { ...output, pixels };
  });
}

function snapshotBoundaries(config, labels = new Map(), testableIds = null) {
  const boundaries = [];
  let globalStart = 0;
  for (const output of config.led.outputs) {
    let outputOffset = 0;
    for (const segment of output.segments || [{ id: `${output.id}-full`, count: output.pixels, direction: output.direction || 'forward' }]) {
      const boundary = {
        id: segment.id, outputId: output.id, outputLabel: output.name || output.id,
        label: labels.get(segment.id) || segment.id, pin: output.pin,
        start: globalStart + outputOffset, outputOffset, count: segment.count,
        direction: segment.direction, colorOrder: config.led.colorOrder,
      };
      if (!testableIds || testableIds.has(segment.id)) boundaries.push(boundary);
      outputOffset += segment.count;
    }
    if (outputOffset !== output.pixels) throw new Error(`Output ${output.id} segments do not match its pixel count.`);
    globalStart += output.pixels;
  }
  return boundaries;
}

export function createProductionKnownGood(job) {
  const config = clone(job?.configuration?.config);
  if (!config?.led?.outputs?.length) throw new Error('Verified job runtime outputs are missing.');
  const strips = new Map((job.project?.restoreSnapshot?.layout?.strips || []).map(strip => [strip.id, strip.name || strip.id]));
  const labels = new Map();
  const testableIds = new Set();
  for (const run of job.project?.restoreSnapshot?.layout?.wiring?.runs || []) {
    if (run.type === 'strip') {
      testableIds.add(run.id);
      labels.set(run.id, strips.get(run.source?.stripId) || run.id);
    }
  }
  const filter = testableIds.size ? testableIds : null;
  return { config, boundaries: snapshotBoundaries(config, labels, filter), testableIds: filter ? [...testableIds] : null, jobId: job.jobId, jobDigest: job.digest, wiringRevision: config.wiringRevision, wiringDigest: config.wiringDigest };
}

export function createProductionKnownGoodFromConfig(job, config) {
  return createProductionKnownGood({ ...job, configuration: { ...job.configuration, config } });
}

function finalWiringError(detail) {
  const error = new Error(`Final wiring read-back did not match the completed physical checks: ${detail}`);
  error.recoveryAction = 'rerun-lights';
  return error;
}

export function assertProductionFinalWiringStatus({ status, job, cardId, firmwareVersion, buildId, physicalResults } = {}) {
  if (status?.state !== 'known-good' || status?.activationId) throw finalWiringError('the card is not in known-good state');
  if (status.cardId !== cardId || status.firmwareVersion !== firmwareVersion || status.buildId !== buildId
    || status.projectRevision !== job?.project?.revision || status.projectFingerprint !== job?.project?.fingerprint
    || status.productionJobId !== job?.jobId || status.productionJobDigest !== job?.digest) {
    throw finalWiringError('card, firmware, project, or job identity changed');
  }
  const expected = createProductionKnownGood(job);
  if (!Number.isSafeInteger(status.maxMilliamps) || status.maxMilliamps < 100
    || status.maxMilliamps !== expected.config.led.maxMilliamps) throw finalWiringError('aggregate current limit changed');
  if (!Array.isArray(physicalResults) || physicalResults.length !== expected.boundaries.length) throw finalWiringError('boundary coverage is incomplete');
  const resultById = new Map();
  for (const result of physicalResults) {
    if (!result?.boundaryId || resultById.has(result.boundaryId) || result.result !== 'correct') throw finalWiringError('boundary coverage is duplicated or invalid');
    resultById.set(result.boundaryId, result);
  }
  const expectedIds = new Set(expected.boundaries.map(boundary => boundary.id));
  if (resultById.size !== expectedIds.size || [...resultById.keys()].some(id => !expectedIds.has(id))) throw finalWiringError('boundary coverage does not match this job');
  const first = physicalResults[0];
  if (!Number.isSafeInteger(first?.wiringRevision) || first.wiringRevision < 1 || !/^[a-f0-9]{64}$/.test(first?.wiringDigest || '')) throw finalWiringError('saved wiring identity is missing');
  if (status.wiringRevision !== first.wiringRevision || status.wiringDigest !== first.wiringDigest) throw finalWiringError('wiring revision or digest changed');
  if (!first.colorOrder || status.colorOrder !== first.colorOrder) throw finalWiringError('LED color order changed');
  if (physicalResults.some(result => result.wiringRevision !== first.wiringRevision || result.wiringDigest !== first.wiringDigest || result.colorOrder !== first.colorOrder)) {
    throw finalWiringError('physical results do not share one confirmed wiring identity');
  }
  if (!Array.isArray(status.outputs) || new Set(status.outputs.map(output => output?.id)).size !== status.outputs.length) throw finalWiringError('output read-back is invalid');
  const segmentLocations = new Map();
  for (const output of status.outputs) for (const segment of output?.segments || []) {
    if (!segment?.id || segmentLocations.has(segment.id)) throw finalWiringError('segment read-back is duplicated or invalid');
    segmentLocations.set(segment.id, { output, segment });
  }
  for (const boundary of expected.boundaries) {
    const result = resultById.get(boundary.id);
    const location = segmentLocations.get(boundary.id);
    if (!location || location.output.id !== boundary.outputId || Number(location.output.pin) !== result.pin
      || Number(location.segment.count) !== result.count || (location.segment.direction || 'forward') !== result.direction) {
      throw finalWiringError(`boundary ${boundary.id} changed`);
    }
  }
  return true;
}

export function buildProductionDiagnosticFrame({ outputs: source, outputId, direction } = {}) {
  const outputs = boundedOutputs(source);
  const active = outputs.find(output => output.id === outputId);
  if (!active) throw new Error('The selected output does not belong to this production job.');
  const total = outputs.reduce((sum, output) => sum + output.pixels, 0);
  if (total > 1024) throw new Error('The diagnostic pixel count is outside card capacity.');
  const start = outputs.slice(0, outputs.indexOf(active)).reduce((sum, output) => sum + output.pixels, 0);
  const frame = Array(total).fill('000000');
  frame.fill('020202', start, start + active.pixels);
  const reverse = (direction || active.direction) === 'reverse';
  frame[start] = reverse ? '200000' : '000020';
  frame[start + active.pixels - 1] = reverse ? '000020' : '200000';
  return frame;
}

export function buildProductionBoundaryFrame({ snapshot, boundaryId } = {}) {
  const boundary = snapshot?.boundaries?.find(item => item.id === boundaryId);
  if (!boundary || boundary.count < 2) throw new Error('The selected physical boundary is not testable.');
  const total = snapshot.config.led.outputs.reduce((sum, output) => sum + output.pixels, 0);
  const frame = Array(total).fill('000000');
  frame.fill('020202', boundary.start, boundary.start + boundary.count);
  // Logical markers are stable. Firmware maps this segment to its physical
  // direction exactly once.
  frame[boundary.start] = '000020';
  frame[boundary.start + boundary.count - 1] = '200000';
  return frame;
}

export function classifyProductionPhysicalObservation(observation, evidence = {}) {
  if (!PRODUCTION_PHYSICAL_OBSERVATIONS.includes(observation)) throw new Error('Choose one physical result.');
  if (evidence.cardIdentityMatches === false) return { action: 'restore-project', title: 'Card setup changed', guidance: 'Stop the light test and restore the verified project to this exact card.' };
  if (evidence.firmwareTrusted === false) return { action: 'signed-firmware-recovery', title: 'Firmware cannot be trusted', guidance: 'Stop and use signed firmware recovery before testing lights.' };
  return ROUTES[observation];
}

export function createProductionPhysicalState(source) {
  const ids = source?.boundaries ? source.boundaries.map(boundary => boundary.id) : boundedOutputs(source).map(output => output.id);
  return { boundaryIds: ids, activeBoundaryId: ids[0], delivery: 'idle', deliveryBoundaryId: null, deliveryGeneration: 0, results: {}, candidate: null, canComplete: false };
}

function complete(state, results = state.results) {
  return state.boundaryIds.every(id => results[id]?.observation === 'correct' && results[id]?.workerConfirmed === true);
}

export function productionPhysicalReducer(state, action) {
  if (!state) return state;
  if (action.type === 'reset') {
    const next = createProductionPhysicalState(action.source);
    const results = action.results && typeof action.results === 'object' && !Array.isArray(action.results) ? action.results : {};
    return { ...next, results, canComplete: complete(next, results) };
  }
  if (action.type === 'select' && !state.candidate && state.boundaryIds.includes(action.boundaryId || action.outputId)) return { ...state, activeBoundaryId: action.boundaryId || action.outputId, delivery: 'idle', deliveryBoundaryId: null };
  if (action.type === 'delivery-started' && (action.boundaryId || action.outputId) === state.activeBoundaryId && Number.isSafeInteger(action.generation) && action.generation > 0) {
    return { ...state, delivery: 'starting', deliveryBoundaryId: state.activeBoundaryId, deliveryGeneration: action.generation };
  }
  const exactDelivery = (action.boundaryId || action.outputId) === state.activeBoundaryId
    && state.deliveryBoundaryId === state.activeBoundaryId && action.generation === state.deliveryGeneration;
  if (action.type === 'delivered' && exactDelivery) return { ...state, delivery: 'acknowledged' };
  if (action.type === 'delivery-failed' && exactDelivery) return { ...state, delivery: 'failed' };
  if (action.type === 'observe' && (action.boundaryId || action.outputId) === state.activeBoundaryId) {
    if (state.delivery !== 'acknowledged' || state.deliveryBoundaryId !== state.activeBoundaryId) return state;
    if (!PRODUCTION_PHYSICAL_OBSERVATIONS.includes(action.observation)) return state;
    const results = { ...state.results, [state.activeBoundaryId]: { observation: action.observation, workerConfirmed: true, observedAt: action.observedAt || new Date().toISOString(), ...(action.activationId ? { activationId: action.activationId } : {}) } };
    return { ...state, results, canComplete: complete(state, results) };
  }
  if (action.type === 'candidate') return { ...state, candidate: action.candidate };
  if (action.type === 'candidate-confirmed') {
    const invalidated = new Set(Array.isArray(action.boundaryIds) ? action.boundaryIds : []);
    const results = Object.fromEntries(Object.entries(state.results).filter(([id]) => !invalidated.has(id)));
    return { ...state, candidate: null, results, canComplete: complete(state, results) };
  }
  if (action.type === 'candidate-clear') return { ...state, candidate: null };
  return state;
}

export function productionCorrectionAffectedBoundaryIds(snapshot, boundaryId, correction = {}) {
  const active = snapshot?.boundaries?.find(boundary => boundary.id === boundaryId);
  if (!active) throw new Error('The corrected boundary does not belong to the confirmed setup.');
  if (correction.kind === 'color-order') return snapshot.boundaries.map(boundary => boundary.id);
  if (correction.kind === 'gpio') return snapshot.boundaries.filter(boundary => boundary.outputId === active.outputId).map(boundary => boundary.id);
  if (correction.kind === 'pixel-count') return snapshot.boundaries.filter(boundary => boundary.outputId === active.outputId && boundary.start >= active.start).map(boundary => boundary.id);
  if (correction.kind === 'direction') return [active.id];
  throw new Error('The confirmed correction type is unsupported.');
}

export function buildProductionPhysicalResults(snapshot, results) {
  if (!snapshot?.boundaries?.length || !results || typeof results !== 'object' || Array.isArray(results)) throw new Error('Every boundary requires confirmed physical evidence.');
  return snapshot.boundaries.map(boundary => {
    const result = results[boundary.id];
    if (result?.observation !== 'correct' || result?.workerConfirmed !== true) throw new Error('Every boundary requires confirmed physical evidence.');
    return {
      boundaryId: boundary.id,
      result: 'correct',
      ...(result.activationId ? { activationId: result.activationId } : {}),
      count: boundary.count,
      pin: boundary.pin,
      direction: boundary.direction,
      colorOrder: snapshot.config.led.colorOrder,
      ...(snapshot.wiringRevision ? { wiringRevision: snapshot.wiringRevision } : {}),
      ...(snapshot.wiringDigest ? { wiringDigest: snapshot.wiringDigest } : {}),
    };
  });
}

function findOutput(job, outputId) {
  const expected = boundedOutputs(job?.expectedOutputs);
  const index = expected.findIndex(output => output.id === outputId);
  if (index < 0) throw new Error('The selected output does not belong to this production job.');
  const configOutputs = job?.configuration?.config?.led?.outputs;
  if (!Array.isArray(configOutputs) || configOutputs[index]?.id !== outputId) throw new Error('The verified job output order does not match its runtime config.');
  return { expected, index };
}

export function buildProductionBoundaryCandidate(snapshot, boundaryId, correction = {}) {
  const boundary = snapshot?.boundaries?.find(item => item.id === boundaryId);
  if (!boundary) throw new Error('The selected boundary does not belong to the confirmed setup.');
  const config = clone(snapshot.config);
  const index = config.led.outputs.findIndex(output => output.id === boundary.outputId);
  const segmentIndex = config.led.outputs[index].segments.findIndex(segment => segment.id === boundaryId);
  if (index < 0 || segmentIndex < 0) throw new Error('The confirmed boundary mapping is inconsistent.');
  const output = config.led.outputs[index];
  if (correction.kind === 'pixel-count') {
    const delta = Number(correction.delta);
    if (!Number.isSafeInteger(delta) || Math.abs(delta) !== 1) throw new Error('Pixel count changes are bounded to plus or minus one.');
    const segmentPixels = output.segments[segmentIndex].count + delta;
    if (segmentPixels < 2 || segmentPixels > 1024) throw new Error('Pixel count change is outside the bounded diagnostic range.');
    const oldEnd = boundary.start + boundary.count;
    output.segments[segmentIndex].count = segmentPixels;
    output.pixels += delta;
    config.led.pixels = config.led.outputs.reduce((sum, output) => sum + Number(output.pixels), 0);
    if (config.led.pixels > 1024) throw new Error('Pixel count change is outside card capacity.');
    let boundaryAdjusted = false;
    for (const zone of config.zones || []) for (const range of zone.ranges || []) {
      const rangeStart = Number(range.start);
      const rangeEnd = rangeStart + Number(range.count);
      if (rangeStart >= oldEnd) range.start = rangeStart + delta;
      else if (rangeEnd >= oldEnd) {
        range.count = Number(range.count) + delta;
        boundaryAdjusted = true;
      }
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.count)
        || range.start < 0 || range.count < 1 || range.start + range.count > config.led.pixels) {
        throw new Error('Pixel count boundary produced an invalid zone interval.');
      }
    }
    if ((config.zones || []).length && !boundaryAdjusted) throw new Error('Pixel count boundary cannot be adjusted safely in this job.');
  } else if (correction.kind === 'gpio') {
    const pin = Number(correction.pin);
    if (!Number.isSafeInteger(pin) || pin < 0 || pin > 48) throw new Error('Choose a valid ESP32 GPIO.');
    if (Number(config.led.outputs[index].pin) === pin) throw new Error('That GPIO is already assigned to this output.');
    if (config.led.outputs.some((output, outputIndex) => outputIndex !== index && Number(output.pin) === pin)) throw new Error('That GPIO is already assigned to another output.');
    const controls = config.controls || {};
    const controlPins = [controls.previous, controls.next, controls.blackout, controls.brightness, controls.statusLed, controls.encoder?.a, controls.encoder?.b, controls.encoder?.press, controls.encoder?.alternatePress].map(Number).filter(value => value >= 0);
    if (controlPins.includes(pin)) throw new Error('That GPIO is already assigned to a control.');
    config.led.outputs[index].pin = pin;
  } else if (correction.kind === 'color-order') {
    if (!['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'].includes(correction.colorOrder)) throw new Error('Choose a supported color order.');
    config.led.colorOrder = correction.colorOrder;
  } else if (correction.kind === 'direction') {
    if (!['forward', 'reverse'].includes(correction.direction)) throw new Error('Choose forward or reverse.');
    output.segments[segmentIndex].direction = correction.direction;
    const directions = new Set(output.segments.map(segment => segment.direction));
    output.direction = directions.size === 1 ? [...directions][0] : 'mixed';
  } else throw new Error('Choose a bounded wiring correction.');
  const next = {
    ...snapshot,
    config,
    boundaries: snapshotBoundaries(
      config,
      new Map(snapshot.boundaries.map(item => [item.id, item.label])),
      snapshot.testableIds ? new Set(snapshot.testableIds) : null,
    ),
    wiringRevision: config.wiringRevision,
    wiringDigest: config.wiringDigest,
  };
  return { config, snapshot: next, correction: clone(correction), outputId: boundary.outputId, boundaryId, rollbackAfterMs: PRODUCTION_CANDIDATE_ROLLBACK_MS };
}

export function buildProductionWiringCandidate(job, outputId, correction = {}) {
  const snapshot = createProductionKnownGood(job);
  const boundary = snapshot.boundaries.find(item => item.outputId === outputId);
  return buildProductionBoundaryCandidate(snapshot, boundary?.id, correction);
}
