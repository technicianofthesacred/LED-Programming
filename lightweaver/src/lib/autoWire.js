import { CARD_HARDWARE_CAPABILITIES } from './cardRuntimeContract.js';
import { normalizeWiring, validateWiring } from './wiringModel.js';

const OPERATION_CAP = 250000;
const EPSILON = 1e-9;
const clone = value => JSON.parse(JSON.stringify(value));
const error = (code, message, extra = {}) => ({ code, message, ...extra });
const rounded = value => Math.round(value * 1e9) / 1e9;
const compareText = (a, b) => String(a).localeCompare(String(b));

function pixelCount(run) {
  return run.type === 'strip' ? Math.max(0, run.source.to - run.source.from + 1) : Math.max(0, Number(run.count) || 0);
}

function stripPoint(strip, index) {
  const point = strip?.pixels?.[index] || {};
  return {
    x: Number(point.x || 0) + Number(strip?.offsetX || strip?.x || 0),
    y: Number(point.y || 0) + Number(strip?.offsetY || strip?.y || 0),
  };
}

function routeOrder(run, direction, seam) {
  let order = Array.from({ length: pixelCount(run) }, (_, index) => run.source.from + index);
  if (direction === 'source-reverse') order.reverse();
  if (seam != null) {
    const seamIndex = order.indexOf(seam);
    if (seamIndex >= 0) order = [...order.slice(seamIndex), ...order.slice(0, seamIndex)];
  }
  return order;
}

function isClosedStrip(strip) {
  return strip?.closed === true || strip?.isClosed === true || strip?.loop === true || strip?.closedPath === true;
}

function runOptions(run, strip) {
  const directions = run.directionPolicy === 'fixed'
    ? [run.physicalDirection]
    : ['source-forward', 'source-reverse'];
  const movableSeam = (isClosedStrip(strip) || run.seamLed != null) && run.directionPolicy === 'flexible' && !run.verified;
  const seams = movableSeam
    ? Array.from({ length: pixelCount(run) }, (_, index) => run.source.from + index)
    : [run.seamLed];
  const options = [];
  for (const direction of directions) {
    for (const seam of seams) {
      const order = routeOrder(run, direction, seam);
      options.push({
        runId: run.id,
        direction,
        seam,
        start: stripPoint(strip, order[0]),
        end: stripPoint(strip, order[order.length - 1]),
      });
    }
  }
  return options.sort((a, b) => compareText(`${a.direction}:${a.seam ?? ''}`, `${b.direction}:${b.seam ?? ''}`));
}

function distance(a, b, scale) {
  return rounded(Math.hypot(a.x - b.x, a.y - b.y) * scale);
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function properIntersection(first, second) {
  if (samePoint(first.a, second.a) || samePoint(first.a, second.b) || samePoint(first.b, second.a) || samePoint(first.b, second.b)) return false;
  const abC = orientation(first.a, first.b, second.a);
  const abD = orientation(first.a, first.b, second.b);
  const cdA = orientation(second.a, second.b, first.a);
  const cdB = orientation(second.a, second.b, first.b);
  return ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON));
}

function stableSignature(lanes, choices, outputs) {
  return lanes.map((lane, index) => `${outputs[index].id}:${lane.map(runId => {
    const choice = choices.get(runId);
    return `${runId}:${choice.direction}:${choice.seam ?? '-'}`;
  }).join(',')}`).join('|');
}

function compareScore(a, b) {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (typeof a[index] === 'string' || typeof b[index] === 'string') return compareText(a[index], b[index]);
    if (Math.abs(a[index] - b[index]) > EPSILON) return a[index] - b[index];
  }
  return a.length - b.length;
}

function retainCandidate(candidates, candidate, limit = 64) {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compareScore(candidates[middle].score, candidate.score) <= 0) low = middle + 1;
    else high = middle;
  }
  if (low < limit) candidates.splice(low, 0, candidate);
  if (candidates.length > limit) candidates.length = limit;
}

function bundlePixels(id, context) {
  return context.bundleById?.get(id)?.totalPixels ?? pixelCount(context.runById.get(id));
}

function outputLimitsSatisfied(lanes, context) {
  const maxPixels = Number(context.capabilities.maxPixelsPerOutput ?? context.capabilities.maxPixels);
  const maxRuns = Number(context.capabilities.maxRunsPerOutput ?? context.capabilities.maxRangesPerOutput ?? Infinity);
  return lanes.every(lane => {
    const pixels = lane.reduce((sum, id) => sum + bundlePixels(id, context), 0);
    return lane.length > 0 && pixels <= maxPixels && lane.length <= maxRuns;
  });
}

function evaluate(lanes, choices, context) {
  if (!outputLimitsSatisfied(lanes, context)) return null;
  const jumpers = [];
  const totals = [];
  for (let outputIndex = 0; outputIndex < lanes.length; outputIndex += 1) {
    const lane = lanes[outputIndex];
    totals.push(lane.reduce((sum, id) => sum + bundlePixels(id, context), 0));
    let cursor = context.anchor;
    for (let index = 0; index < lane.length; index += 1) {
      const choice = choices.get(lane[index]);
      const length = distance(cursor, choice.start, context.scale);
      jumpers.push({ outputId: context.outputs[outputIndex].id, toRunId: lane[index], fromRunId: index ? lane[index - 1] : null, a: cursor, b: choice.start, length });
      cursor = choice.end;
    }
  }
  const lengths = jumpers.map(jumper => jumper.length);
  const total = rounded(lengths.reduce((sum, length) => sum + length, 0));
  const worst = rounded(Math.max(0, ...lengths));
  const largest = Math.max(0, ...totals);
  const range = largest - Math.min(...totals);
  let reversals = 0;
  let seams = 0;
  for (const run of context.runs) {
    const choice = choices.get(run.id);
    if (choice.direction !== run.physicalDirection) reversals += 1;
    if (choice.seam !== run.seamLed) seams += 1;
  }
  let crossings = 0;
  for (let a = 0; a < jumpers.length; a += 1) {
    for (let b = a + 1; b < jumpers.length; b += 1) if (properIntersection(jumpers[a], jumpers[b])) crossings += 1;
  }
  const lexical = stableSignature(lanes, choices, context.outputs);
  const score = [0, lanes.length, total, worst, largest, range, reversals, seams, crossings, lexical];
  return { lanes: lanes.map(lane => [...lane]), choices: new Map(choices), jumpers, totals, total, worst, largest, range, reversals, seams, crossings, lexical, score };
}

function permutations(values, visit, budget) {
  const used = new Array(values.length).fill(false);
  const current = [];
  function walk() {
    if (budget.stopped) return;
    if (current.length === values.length) {
      visit(current);
      return;
    }
    for (let index = 0; index < values.length && !budget.stopped; index += 1) {
      if (used[index]) continue;
      used[index] = true;
      current.push(values[index]);
      walk();
      current.pop();
      used[index] = false;
    }
  }
  walk();
}

function splitPermutation(permutation, outputCount) {
  if (outputCount === 1) return [[permutation.map(String)]];
  const splits = [];
  for (let cut = 1; cut < permutation.length; cut += 1) splits.push([permutation.slice(0, cut), permutation.slice(cut)]);
  return splits;
}

function exactSearch(context, budget) {
  const candidates = [];
  const ids = context.runs.map(run => run.id).sort(compareText);
  permutations(ids, permutation => {
    for (const lanes of splitPermutation(permutation, context.outputs.length)) {
      if (budget.stopped || !outputLimitsSatisfied(lanes, context)) continue;
      const orderedIds = lanes.flat();
      const choices = new Map();
      function select(index) {
        if (budget.stopped) return;
        if (index === orderedIds.length) {
          budget.operations += 1;
          const candidate = evaluate(lanes, choices, context);
          if (candidate) retainCandidate(candidates, candidate);
          if (budget.operations >= OPERATION_CAP) budget.stopped = true;
          return;
        }
        for (const option of context.optionsById.get(orderedIds[index])) {
          choices.set(orderedIds[index], option);
          select(index + 1);
          if (budget.stopped) return;
        }
      }
      select(0);
    }
  }, budget);
  return candidates;
}

function centerOfOptions(options) {
  const option = options[0];
  return { x: (option.start.x + option.end.x) / 2, y: (option.start.y + option.end.y) / 2 };
}

function spatialClusters(context) {
  const count = context.outputs.length;
  const ids = context.runs.map(run => run.id).sort(compareText);
  if (count === 1) return [ids];
  const centers = new Map(ids.map(id => [id, centerOfOptions(context.optionsById.get(id))]));
  const seeds = [ids[0]];
  while (seeds.length < count) {
    let best = null;
    for (const id of ids) {
      if (seeds.includes(id)) continue;
      const nearest = Math.min(...seeds.map(seed => distance(centers.get(id), centers.get(seed), 1)));
      const key = [nearest, id];
      if (!best || key[0] > best.key[0] + EPSILON || (Math.abs(key[0] - best.key[0]) <= EPSILON && compareText(id, best.id) < 0)) best = { id, key };
    }
    seeds.push(best.id);
  }
  const clusters = Array.from({ length: count }, (_, index) => [seeds[index]]);
  const pixelTotals = seeds.map(id => bundlePixels(id, context));
  const maxPixels = Number(context.capabilities.maxPixelsPerOutput ?? context.capabilities.maxPixels);
  const maxRuns = Number(context.capabilities.maxRunsPerOutput ?? context.capabilities.maxRangesPerOutput ?? Infinity);
  const remaining = ids.filter(id => !seeds.includes(id)).sort((a, b) => bundlePixels(b, context) - bundlePixels(a, context) || compareText(a, b));
  for (const id of remaining) {
    const pixels = bundlePixels(id, context);
    const ranked = seeds.map((seed, index) => ({ index, distance: distance(centers.get(id), centers.get(seed), 1) }))
      .sort((a, b) => a.distance - b.distance || a.index - b.index);
    const target = ranked.find(item => pixelTotals[item.index] + pixels <= maxPixels && clusters[item.index].length < maxRuns) || ranked[0];
    clusters[target.index].push(id);
    pixelTotals[target.index] += pixels;
  }
  return clusters;
}

function greedyRoute(ids, context, budget) {
  const remaining = new Set(ids);
  const lane = [];
  const choices = new Map();
  let cursor = context.anchor;
  while (remaining.size && !budget.stopped) {
    let best = null;
    for (const id of [...remaining].sort(compareText)) {
      for (const option of context.optionsById.get(id)) {
        budget.operations += 1;
        const key = [distance(cursor, option.start, context.scale), id, option.direction, option.seam ?? -1];
        if (!best || compareScore(key, best.key) < 0) best = { id, option, key };
        if (budget.operations >= OPERATION_CAP) { budget.stopped = true; break; }
      }
      if (budget.stopped) break;
    }
    if (!best) break;
    lane.push(best.id);
    choices.set(best.id, best.option);
    remaining.delete(best.id);
    cursor = best.option.end;
  }
  for (const id of [...remaining].sort(compareText)) {
    const option = context.optionsById.get(id)[0];
    lane.push(id); choices.set(id, option);
  }
  return { lane, choices };
}

function chooseRouteOptions(lane, context, budget) {
  let states = [{ end: context.anchor, cost: 0, choices: new Map(), lexical: '' }];
  for (const id of lane) {
    const next = [];
    for (const state of states) {
      for (const option of context.optionsById.get(id)) {
        budget.operations += 1;
        next.push({
          end: option.end,
          cost: rounded(state.cost + distance(state.end, option.start, context.scale)),
          choices: new Map([...state.choices, [id, option]]),
          lexical: `${state.lexical}|${id}:${option.direction}:${option.seam ?? '-'}`,
        });
        if (budget.operations >= OPERATION_CAP) { budget.stopped = true; break; }
      }
      if (budget.stopped) break;
    }
    next.sort((a, b) => compareScore([a.cost, a.lexical], [b.cost, b.lexical]));
    states = next.slice(0, Math.max(1, context.optionsById.get(id).length));
    if (budget.stopped) break;
  }
  return states[0]?.choices || new Map(lane.map(id => [id, context.optionsById.get(id)[0]]));
}

function heuristicSearch(context, budget) {
  let lanes = spatialClusters(context);
  const initialChoices = new Map();
  lanes = lanes.map(cluster => {
    const route = greedyRoute(cluster, context, budget);
    for (const [id, option] of route.choices) initialChoices.set(id, option);
    return route.lane;
  });
  let choices = initialChoices;
  let best = evaluate(lanes, choices, context);
  if (!best) return [];
  let improved = true;
  while (improved && !budget.stopped) {
    improved = false;
    outer: for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
      for (let from = 0; from < lanes[laneIndex].length - 1; from += 1) {
        for (let to = from + 1; to < lanes[laneIndex].length; to += 1) {
          const nextLanes = lanes.map(lane => [...lane]);
          nextLanes[laneIndex].splice(from, to - from + 1, ...nextLanes[laneIndex].slice(from, to + 1).reverse());
          const nextChoices = new Map(choices);
          const laneChoices = chooseRouteOptions(nextLanes[laneIndex], context, budget);
          for (const [id, option] of laneChoices) nextChoices.set(id, option);
          if (budget.stopped) break outer;
          const candidate = evaluate(nextLanes, nextChoices, context);
          if (candidate && compareScore(candidate.score, best.score) < 0) {
            lanes = nextLanes; choices = nextChoices; best = candidate; improved = true;
            break outer;
          }
        }
      }
    }
  }
  return [best];
}

function materialize(candidate, context, search) {
  const wiring = clone(context.model);
  wiring.controllerAnchor = clone(context.anchor);
  wiring.outputs = context.outputs.map((output, index) => ({
    id: output.id,
    ...(output.name ? { name: output.name } : {}),
    pin: output.pin,
    runIds: candidate.lanes[index].flatMap(id => [...context.bundleById.get(id).members]),
  }));
  const choiceById = candidate.choices;
  wiring.runs = wiring.runs.map(run => run.type !== 'strip' ? run : {
    ...run,
    physicalDirection: choiceById.get(run.id).direction,
    seamLed: choiceById.get(run.id).seam,
  });
  const directionChanges = context.runs.flatMap(run => {
    const to = choiceById.get(run.id).direction;
    return to === run.physicalDirection ? [] : [{ runId: run.id, from: run.physicalDirection, to }];
  });
  const seamChanges = context.runs.flatMap(run => {
    const to = choiceById.get(run.id).seam;
    return to === run.seamLed ? [] : [{ runId: run.id, from: run.seamLed, to }];
  });
  return {
    wiring,
    jumpers: candidate.jumpers.map(({ a, b, ...jumper }) => jumper),
    outputTotals: candidate.totals,
    totalJumperLength: candidate.total,
    worstJumperLength: candidate.worst,
    unit: context.unit,
    directionChanges,
    seamChanges,
    crossings: candidate.crossings,
    search,
  };
}

function buildBundles(model) {
  const allRunsById = new Map(model.runs.map(run => [run.id, run]));
  const bundles = [];
  const errors = [];
  for (const output of model.outputs) {
    let current = null;
    const leading = [];
    for (const runId of output.runIds) {
      const run = allRunsById.get(runId);
      if (!run) continue;
      if (run.type === 'cable') {
        errors.push(error('run-type-unsupported', `Persisted cable run ${run.id} cannot be routed as addressable pixels.`, { runId: run.id }));
        continue;
      }
      if (run.type === 'inactive') {
        if (current) current.members.push(run.id);
        else leading.push(run.id);
        continue;
      }
      current = { id: run.id, run, members: [...leading, run.id] };
      leading.length = 0;
      bundles.push(current);
    }
    if (leading.length) errors.push(error('inactive-unanchored', `Inactive runs ${leading.join(', ')} have no neighboring pixel run.`, { runIds: [...leading], outputId: output.id }));
  }
  for (const bundle of bundles) bundle.totalPixels = bundle.members.reduce((sum, id) => sum + pixelCount(allRunsById.get(id)), 0);
  bundles.sort((a, b) => compareText(a.id, b.id));
  return { bundles, errors };
}

function artworkDiagonal(strips) {
  const points = strips.flatMap(strip => (strip.pixels || []).map((_, index) => stripPoint(strip, index)));
  if (!points.length) return 0;
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

function physicalScaleInfo(value) {
  const pxPerMm = typeof value === 'number' ? value : Number(value?.pxPerMm);
  const mmPerUnit = Number(value?.mmPerUnit);
  if (Number.isFinite(pxPerMm) && pxPerMm > 0) return { scale: 1 / pxPerMm, unit: 'mm', valid: true };
  if (Number.isFinite(mmPerUnit) && mmPerUnit > 0) return { scale: mmPerUnit, unit: 'mm', valid: true };
  return { scale: 1, unit: 'artwork', valid: false };
}

function requestedOutputCounts(outputCount, availableCount, capabilities, totalPixels) {
  const max = Math.min(availableCount, Number(capabilities.maxOutputs) || availableCount);
  if (outputCount !== 'auto') return [Number(outputCount)];
  const perOutput = Number(capabilities.maxPixelsPerOutput ?? capabilities.maxPixels);
  const minimum = Math.max(1, Math.ceil(totalPixels / perOutput));
  return Array.from({ length: Math.max(0, max - minimum + 1) }, (_, index) => minimum + index);
}

export function proposeAutoWiring({
  wiring,
  strips = [],
  controllerAnchor,
  availableOutputs = [],
  outputCount = 'auto',
  physicalScale,
  capabilities = CARD_HARDWARE_CAPABILITIES,
} = {}) {
  const originalWiring = clone(wiring || {});
  const model = normalizeWiring(originalWiring);
  const validation = validateWiring(originalWiring, strips, capabilities);
  const errors = [...validation.errors];
  const assumptions = [];
  const anchor = { x: Number(controllerAnchor?.x), y: Number(controllerAnchor?.y) };
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) errors.push(error('controller-anchor-missing', 'Place the controller anchor before routing.'));
  const scaleInfo = physicalScaleInfo(physicalScale);
  if (!scaleInfo.valid) assumptions.push({ code: 'physical-scale-missing', message: 'Cable lengths are relative artwork distances, not physical estimates.' });
  const outputs = [...availableOutputs].map((output, index) => ({
    id: String(output?.id || `out${index + 1}`),
    ...(output?.name ? { name: String(output.name) } : {}),
    pin: Number(output?.pin),
  })).sort((a, b) => compareText(a.id, b.id));
  const outputIds = new Set(), pins = new Set();
  for (const output of outputs) {
    if (outputIds.has(output.id)) errors.push(error('output-id-duplicate', `Duplicate available output ID ${output.id}.`, { outputId: output.id }));
    if (pins.has(output.pin)) errors.push(error('output-pin-duplicate', `Duplicate available output pin ${output.pin}.`, { pin: output.pin }));
    if (!capabilities.supportedOutputPins?.includes(output.pin)) errors.push(error('output-pin-unsupported', `Unsupported available output pin ${output.pin}.`, { pin: output.pin }));
    outputIds.add(output.id); pins.add(output.pin);
  }
  const bundleResult = buildBundles(model);
  errors.push(...bundleResult.errors);
  const runs = bundleResult.bundles.map(bundle => bundle.run);
  const bundleById = new Map(bundleResult.bundles.map(bundle => [bundle.id, bundle]));
  const geometryByStrip = new Map(strips.map(strip => [String(strip.id), strip]));
  for (const run of runs) {
    const strip = geometryByStrip.get(run.source.stripId);
    const required = isClosedStrip(strip) || run.seamLed != null
      ? Array.from({ length: pixelCount(run) }, (_, index) => run.source.from + index)
      : [run.source.from, run.source.to];
    if (required.some(index => !Number.isFinite(Number(strip?.pixels?.[index]?.x)) || !Number.isFinite(Number(strip?.pixels?.[index]?.y)))) {
      errors.push(error('geometry-invalid', `Run ${run.id} needs finite sampled pixel coordinates.`, { runId: run.id }));
    }
  }
  const totalPixels = bundleResult.bundles.reduce((sum, bundle) => sum + bundle.totalPixels, 0);
  if (totalPixels > capabilities.maxPixels) errors.push(error('pixel-limit', `Wiring uses ${totalPixels} pixels; hardware supports ${capabilities.maxPixels}.`));
  if (errors.length) return { ok: false, proposal: null, alternatives: [], assumptions, errors, score: null };

  const counts = requestedOutputCounts(outputCount, outputs.length, capabilities, totalPixels);
  const requested = outputCount === 'auto' ? null : Number(outputCount);
  if (!counts.length || counts.some(count => !Number.isInteger(count) || count < 1 || count > outputs.length || count > capabilities.maxOutputs)) {
    return { ok: false, proposal: null, alternatives: [], assumptions, errors: [error('output-unavailable', `Requested ${requested ?? 'automatic'} output count cannot be provided.`)], score: null };
  }
  const stripById = geometryByStrip;
  const runById = new Map(runs.map(item => [item.id, item]));
  const optionsById = new Map(runs.map(item => [item.id, runOptions(item, stripById.get(item.source.stripId))]));
  let candidates = [];
  let usedCount = null;
  let mode = null;
  let budget = null;
  for (const count of counts) {
    if (count > runs.length) continue;
    const selectedOutputs = outputs.slice(0, count);
    const context = { model, runs, runById, bundleById, optionsById, outputs: selectedOutputs, anchor, scale: scaleInfo.scale, unit: scaleInfo.unit, capabilities };
    budget = { operations: 0, stopped: false };
    mode = runs.length <= 9 && count <= 2 ? 'exact' : 'heuristic';
    candidates = mode === 'exact' ? exactSearch(context, budget) : heuristicSearch(context, budget);
    if (candidates.length) { usedCount = count; break; }
    if (outputCount !== 'auto') break;
  }
  if (!candidates.length) {
    return { ok: false, proposal: null, alternatives: [], assumptions, errors: [error('route-impossible', 'No route satisfies the fixed directions and hardware limits.')], score: null };
  }
  candidates.sort((a, b) => compareScore(a.score, b.score));
  const unique = [];
  const signatures = new Set();
  for (const candidate of candidates) if (!signatures.has(candidate.lexical)) { signatures.add(candidate.lexical); unique.push(candidate); }
  const best = unique[0];
  const selectedOutputs = outputs.slice(0, usedCount);
  const context = { model, runs, runById, bundleById, optionsById, outputs: selectedOutputs, anchor, scale: scaleInfo.scale, unit: scaleInfo.unit, capabilities };
  const search = { mode, operations: budget.operations, cap: OPERATION_CAP, capped: budget.stopped };
  if (budget.stopped) search.warning = 'Search stopped at the deterministic 250,000-operation cap; further improvements may exist.';
  const proposal = materialize(best, context, search);
  const threshold = scaleInfo.valid
    ? Math.max(10, best.total * 0.02)
    : artworkDiagonal(strips) * 0.002;
  const equivalent = candidate => candidate.lanes.length === best.lanes.length
    && candidate.largest === best.largest
    && candidate.reversals === best.reversals
    && candidate.seams === best.seams
    && candidate.total - best.total <= threshold + EPSILON;
  const alternatives = unique.slice(1).filter(equivalent).slice(0, 8).map(candidate => materialize(candidate, context, search));
  return { ok: true, proposal, alternatives, assumptions, errors: [], score: best.score };
}

export { OPERATION_CAP };
