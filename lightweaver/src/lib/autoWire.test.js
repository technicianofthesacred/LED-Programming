import test from 'node:test';
import assert from 'node:assert/strict';

import { proposeAutoWiring } from './autoWire.js';

const capabilities = {
  maxPixels: 1024,
  maxOutputs: 4,
  supportedOutputPins: [16, 17, 18, 21],
  maxZones: 10,
  maxRangesPerZone: 4,
};

const strip = (id, points, extra = {}) => ({
  id,
  name: id,
  pixelCount: points.length,
  pixels: points.map(([x, y]) => ({ x, y })),
  ...extra,
});

const run = (id, stripId = id, extra = {}) => ({
  id,
  type: 'strip',
  source: { stripId, from: 0, to: 1 },
  directionPolicy: 'flexible',
  physicalDirection: 'source-forward',
  seamLed: null,
  verified: false,
  ...extra,
});

const model = (runs, outputs = [{ id: 'out1', pin: 16, runIds: runs.map(item => item.id) }]) => ({
  version: 1,
  locked: false,
  verified: false,
  controllerAnchor: null,
  outputs,
  runs,
});

const solve = overrides => proposeAutoWiring({
  wiring: overrides.wiring,
  strips: overrides.strips,
  controllerAnchor: overrides.controllerAnchor ?? { x: 0, y: 0 },
  availableOutputs: overrides.availableOutputs ?? [{ id: 'out1', name: 'A', pin: 16 }, { id: 'out2', name: 'B', pin: 17 }],
  outputCount: overrides.outputCount ?? 1,
  physicalScale: Object.hasOwn(overrides, 'physicalScale') ? overrides.physicalScale : { pxPerMm: 1 },
  capabilities: overrides.capabilities ?? capabilities,
});

test('routes a one-output chain from the controller without mutating accepted wiring', () => {
  const strips = [strip('a', [[10, 0], [20, 0]]), strip('b', [[30, 0], [40, 0]])];
  const wiring = model([run('a'), run('b')]);
  const before = JSON.stringify({ wiring, strips });
  const result = solve({ wiring, strips });
  assert.equal(result.ok, true);
  assert.deepEqual(result.proposal.wiring.outputs[0].runIds, ['a', 'b']);
  assert.equal(result.proposal.totalJumperLength, 20);
  assert.equal(result.proposal.unit, 'mm');
  assert.equal(JSON.stringify({ wiring, strips }), before);
  assert.notEqual(result.proposal.wiring, wiring);
});

test('automatic output count uses the fewest outputs that satisfy per-output limits', () => {
  const strips = [strip('a', [[0, 0], [1, 0]]), strip('b', [[2, 0], [3, 0]])];
  const wiring = model([run('a'), run('b')]);
  const result = solve({ wiring, strips, outputCount: 'auto', capabilities: { ...capabilities, maxPixelsPerOutput: 2 } });
  assert.equal(result.ok, true);
  assert.equal(result.proposal.wiring.outputs.length, 2);
  assert.deepEqual(result.proposal.outputTotals, [2, 2]);
});

test('fixed output count separates two spatial clusters and balances output pixels', () => {
  const strips = [
    strip('a', [[-101, 0], [-100, 0]]), strip('b', [[-91, 0], [-90, 0]]),
    strip('c', [[90, 0], [91, 0]]), strip('d', [[100, 0], [101, 0]]),
  ];
  const wiring = model([run('a'), run('b'), run('c'), run('d')]);
  const result = solve({ wiring, strips, outputCount: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.proposal.outputTotals, [4, 4]);
  const lanes = result.proposal.wiring.outputs.map(output => [...output.runIds].sort());
  assert.deepEqual(lanes.sort((a, b) => a[0].localeCompare(b[0])), [['a', 'b'], ['c', 'd']]);
});

test('preserves fixed physical direction while reversing flexible runs when shorter', () => {
  const strips = [strip('fixed', [[10, 0], [20, 0]]), strip('flex', [[40, 0], [30, 0]])];
  const wiring = model([
    run('fixed', 'fixed', { directionPolicy: 'fixed', physicalDirection: 'source-forward' }),
    run('flex', 'flex'),
  ]);
  const result = solve({ wiring, strips });
  assert.equal(result.ok, true);
  const byId = new Map(result.proposal.wiring.runs.map(item => [item.id, item]));
  assert.equal(byId.get('fixed').physicalDirection, 'source-forward');
  assert.equal(byId.get('flex').physicalDirection, 'source-reverse');
  assert.deepEqual(result.proposal.directionChanges, [{ runId: 'flex', from: 'source-forward', to: 'source-reverse' }]);
});

test('moves a flexible closed-ring seam but preserves a verified seam', () => {
  const ring = strip('ring', [[10, 0], [0, 10], [-10, 0], [0, -10]], { closed: true });
  const movable = model([run('ring', 'ring', { source: { stripId: 'ring', from: 0, to: 3 }, seamLed: 2 })]);
  const moved = solve({ wiring: movable, strips: [ring], controllerAnchor: { x: 11, y: 0 } });
  assert.equal(moved.ok, true);
  assert.equal(moved.proposal.wiring.runs[0].seamLed, 0);
  assert.deepEqual(moved.proposal.seamChanges, [{ runId: 'ring', from: 2, to: 0 }]);

  const fixed = model([run('ring', 'ring', { source: { stripId: 'ring', from: 0, to: 3 }, seamLed: 2, verified: true })]);
  const preserved = solve({ wiring: fixed, strips: [ring], controllerAnchor: { x: 11, y: 0 } });
  assert.equal(preserved.ok, true);
  assert.equal(preserved.proposal.wiring.runs[0].seamLed, 2);
});

test('lexicographic scoring prefers total jumper length before worst jumper and balance after it', () => {
  const strips = [
    strip('a', [[1, 0], [2, 0]]), strip('b', [[3, 0], [4, 0]]),
    strip('c', [[100, 0], [101, 0]]),
  ];
  const wiring = model([run('a'), run('b'), run('c')]);
  const result = solve({ wiring, strips, outputCount: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.score[0], 0);
  assert.equal(result.score[1], 2);
  assert.equal(result.score[2], result.proposal.totalJumperLength);
  assert.equal(result.score[3], result.proposal.worstJumperLength);
  assert.equal(result.score[4], Math.max(...result.proposal.outputTotals));
});

test('chooses lower total cable before a route with a shorter worst jumper', () => {
  const strips = [
    strip('a', [[8, 8], [4, -7]]),
    strip('b', [[-1, 1], [6, -5]]),
    strip('c', [[10, 2], [-7, -3]]),
  ];
  const runs = ['a', 'b', 'c'].map(id => run(id, id, { directionPolicy: 'fixed' }));
  const result = solve({ wiring: model(runs), strips });
  assert.deepEqual(result.proposal.wiring.outputs[0].runIds, ['b', 'a', 'c']);
  assert.ok(Math.abs(result.proposal.totalJumperLength - 25.383813827) < 1e-8);
  assert.ok(result.proposal.worstJumperLength > Math.hypot(8, 8), 'the lower-total route accepts a longer worst jumper');
});

test('returns only materially equivalent alternatives', () => {
  const strips = [strip('a', [[10, 10], [20, 10]]), strip('b', [[10, -10], [20, -10]])];
  const result = solve({ wiring: model([run('a'), run('b')]), strips });
  assert.equal(result.ok, true);
  assert.ok(result.alternatives.length >= 1);
  for (const alternative of result.alternatives) {
    assert.equal(alternative.wiring.outputs.length, result.proposal.wiring.outputs.length);
    assert.equal(Math.max(...alternative.outputTotals), Math.max(...result.proposal.outputTotals));
    assert.equal(alternative.directionChanges.length, result.proposal.directionChanges.length);
    assert.equal(alternative.seamChanges.length, result.proposal.seamChanges.length);
    assert.ok(Math.abs(alternative.totalJumperLength - result.proposal.totalJumperLength) <= Math.max(10, result.proposal.totalJumperLength * 0.02));
  }
});

test('hard rejects invalid topology, pins, fixed constraints, pixels, and ranges', () => {
  const strips = [strip('a', [[0, 0], [1, 0]])];
  const cases = [
    [model([{ ...run('a'), nextRunIds: ['a'] }]), 'run-cycle'],
    [model([{ ...run('a'), nextRunIds: ['a', 'missing'] }]), 'run-branch'],
    [model([run('a')], [{ id: 'o1', pin: 16, runIds: [] }]), 'run-unassigned'],
    [model([run('a'), run('a')]), 'run-id-duplicate'],
    [model([run('a')], [{ id: 'o1', pin: 16, runIds: ['a'] }, { id: 'o2', pin: 16, runIds: ['a'] }]), 'output-pin-duplicate'],
    [model([run('a')], [{ id: 'o1', pin: 99, runIds: ['a'] }]), 'output-pin-unsupported'],
    [model([run('a', 'a', { directionPolicy: 'fixed', physicalDirection: 'sideways' })]), 'physical-direction-invalid'],
    [model([run('a', 'a', { source: { stripId: 'a', from: 0, to: 9 } })]), 'source-range-out-of-bounds'],
  ];
  for (const [wiring, code] of cases) {
    const result = solve({ wiring, strips });
    assert.equal(result.ok, false, code);
    assert.ok(result.errors.some(error => error.code === code), code);
  }
  const tooManyPixels = solve({
    wiring: model([run('a')]), strips,
    capabilities: { ...capabilities, maxPixels: 1 },
  });
  assert.ok(tooManyPixels.errors.some(error => error.code === 'pixel-limit'));
  const impossible = solve({
    wiring: model([run('a')]), strips,
    outputCount: 2,
    availableOutputs: [{ id: 'out1', pin: 16 }],
  });
  assert.equal(impossible.ok, false);
  assert.ok(impossible.errors.some(error => error.code === 'output-unavailable'));

  const fixedImpossible = solve({
    wiring: model(['a', 'b', 'c'].map(id => run(id, 'a', { directionPolicy: 'fixed' }))),
    strips,
    outputCount: 2,
    capabilities: { ...capabilities, maxPixelsPerOutput: 2 },
  });
  assert.equal(fixedImpossible.ok, false);
  assert.ok(fixedImpossible.errors.some(error => error.code === 'route-impossible'));
});

test('missing scale uses artwork units, states an assumption, and computes proper crossings only', () => {
  const strips = [strip('a', [[-10, -10], [10, 10]]), strip('b', [[-10, 10], [10, -10]])];
  const result = solve({ wiring: model([run('a'), run('b')]), strips, physicalScale: null });
  assert.equal(result.ok, true);
  assert.equal(result.proposal.unit, 'artwork');
  assert.ok(result.assumptions.some(item => item.code === 'physical-scale-missing'));
  assert.equal(result.proposal.crossings, 0, 'shared strip endpoints and strip bodies are not jumper crossings');
});

test('is byte-for-byte repeatable across object-key ordering and caps deterministic work', () => {
  const strips = Array.from({ length: 10 }, (_, index) => strip(`s${String(index).padStart(2, '0')}`, [[index * 10, 0], [index * 10 + 1, 0]]));
  const runs = strips.map(item => run(item.id));
  const wiringA = model(runs);
  const wiringB = {
    runs: runs.map(item => ({ verified: item.verified, seamLed: item.seamLed, physicalDirection: item.physicalDirection, directionPolicy: item.directionPolicy, source: { to: item.source.to, from: item.source.from, stripId: item.source.stripId }, type: item.type, id: item.id })),
    outputs: wiringA.outputs.map(output => ({ runIds: output.runIds, pin: output.pin, id: output.id })),
    controllerAnchor: null, verified: false, locked: false, version: 1,
  };
  const first = solve({ wiring: wiringA, strips, outputCount: 2 });
  const second = solve({ wiring: wiringB, strips: strips.map(item => ({ pixels: item.pixels.map(pixel => ({ y: pixel.y, x: pixel.x })), pixelCount: item.pixelCount, name: item.name, id: item.id })), outputCount: 2 });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.ok(first.proposal.search.operations <= 250000);
  assert.equal(first.proposal.search.mode, 'heuristic');
});

test('exact search stops at 250,000 deterministic candidates and reports the cap', () => {
  const strips = Array.from({ length: 7 }, (_, index) => strip(`r${index}`, [[index * 3, 0], [index * 3 + 1, 1]]));
  const result = solve({ wiring: model(strips.map(item => run(item.id))), strips, outputCount: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.proposal.search.mode, 'exact');
  assert.equal(result.proposal.search.operations, 250000);
  assert.equal(result.proposal.search.capped, true);
  assert.match(result.proposal.search.warning, /250,000-operation cap/);
});

test('preserves inactive runs as addressable bundles without adding jumpers', () => {
  const strips = [strip('a', [[10, 0], [20, 0]]), strip('b', [[30, 0], [40, 0]])];
  const runs = [run('a'), { id: 'reserved', type: 'inactive', count: 3, verified: false }, run('b')];
  const wiring = model(runs);
  const before = JSON.stringify({ wiring, strips });
  const result = solve({ wiring, strips });
  assert.equal(result.ok, true);
  assert.deepEqual(result.proposal.wiring.outputs[0].runIds, ['a', 'reserved', 'b']);
  assert.deepEqual(result.proposal.outputTotals, [7]);
  assert.equal(result.proposal.jumpers.length, 2);
  assert.ok(result.proposal.jumpers.every(jumper => jumper.toRunId !== 'reserved'));
  assert.equal(result.proposal.totalJumperLength, 20);
  assert.equal(JSON.stringify({ wiring, strips }), before);
  assert.equal(JSON.stringify(solve({ wiring, strips })), JSON.stringify(result));
});

test('leading and consecutive inactive runs move with their following pixel run', () => {
  const strips = [strip('a', [[10, 0], [20, 0]]), strip('b', [[30, 0], [40, 0]])];
  const runs = [
    { id: 'lead-1', type: 'inactive', count: 1, verified: false },
    { id: 'lead-2', type: 'inactive', count: 2, verified: false },
    run('a'), run('b'),
  ];
  const result = solve({ wiring: model(runs), strips });
  assert.equal(result.ok, true);
  const ids = result.proposal.wiring.outputs[0].runIds;
  assert.deepEqual(ids.slice(ids.indexOf('a') - 2, ids.indexOf('a') + 1), ['lead-1', 'lead-2', 'a']);
  assert.deepEqual(result.proposal.outputTotals, [7]);
  assert.equal(result.proposal.jumpers.length, 2);
});

test('inactive bundles stay on their pixel output and count toward limits and balance', () => {
  const strips = [
    strip('a', [[-20, 0], [-19, 0]]), strip('b', [[20, 0], [21, 0]]), strip('c', [[22, 0], [23, 0]]),
  ];
  const runs = [run('a'), { id: 'reserved', type: 'inactive', count: 2, verified: false }, run('b'), run('c')];
  const result = solve({
    wiring: model(runs), strips, outputCount: 'auto',
    capabilities: { ...capabilities, maxPixelsPerOutput: 4 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.proposal.wiring.outputs.length, 2);
  assert.deepEqual(result.proposal.outputTotals, [4, 4]);
  const bundledLane = result.proposal.wiring.outputs.find(output => output.runIds.includes('a'));
  assert.deepEqual(bundledLane.runIds.slice(bundledLane.runIds.indexOf('a'), bundledLane.runIds.indexOf('a') + 2), ['a', 'reserved']);
  assert.equal(result.proposal.wiring.outputs.filter(output => output.runIds.includes('reserved')).length, 1);
});

test('heuristic scoring includes inactive bundle pixels while routing only strip geometry', () => {
  const strips = Array.from({ length: 10 }, (_, index) => strip(`h${index}`, [[index * 4, 0], [index * 4 + 1, 0]]));
  const runs = [run('h0'), { id: 'reserved', type: 'inactive', count: 100, verified: false }, ...strips.slice(1).map(item => run(item.id))];
  const result = solve({ wiring: model(runs), strips, outputCount: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.proposal.search.mode, 'heuristic');
  assert.equal(result.proposal.outputTotals.reduce((sum, count) => sum + count, 0), 120);
  assert.equal(result.proposal.jumpers.length, 10);
});

test('rejects unanchored inactive-only lanes and persisted cable rows without omitting them', () => {
  const inactive = model([{ id: 'reserved', type: 'inactive', count: 2, verified: false }]);
  const noAnchor = solve({ wiring: inactive, strips: [] });
  assert.equal(noAnchor.ok, false);
  assert.ok(noAnchor.errors.some(item => item.code === 'inactive-unanchored'));

  const strips = [strip('a', [[0, 0], [1, 0]])];
  const cable = model([run('a'), { id: 'legacy-cable', type: 'cable', verified: false }]);
  const persisted = solve({ wiring: cable, strips });
  assert.equal(persisted.ok, false);
  assert.ok(persisted.errors.some(item => item.code === 'run-type-unsupported'));
});
