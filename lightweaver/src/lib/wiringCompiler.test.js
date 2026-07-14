import test from 'node:test';
import assert from 'node:assert/strict';

import { CARD_HARDWARE_CAPABILITIES } from './cardRuntimeContract.js';
import { compileWiring } from './wiringCompiler.js';
import { validateWiring } from './wiringModel.js';

const strips = [
  { id: 'a', name: 'A', pixelCount: 4, reversed: true, pixels: Array.from({ length: 4 }, (_, i) => ({ x: i, y: 0 })) },
  { id: 'b', name: 'B', pixelCount: 2, pixels: Array.from({ length: 2 }, (_, i) => ({ x: 10 + i, y: 0 })) },
];
const capabilities = CARD_HARDWARE_CAPABILITIES;

const wiring = overrides => ({
  version: 1,
  locked: false,
  verified: false,
  outputs: [{ id: 'o1', name: 'One', pin: 16, runIds: ['a', 'gap', 'jump', 'b'] }],
  runs: [
    { id: 'a', type: 'strip', source: { stripId: 'a', from: 0, to: 3 }, directionPolicy: 'flexible', physicalDirection: 'source-reverse', seamLed: null },
    { id: 'gap', type: 'inactive', count: 3 },
    { id: 'jump', type: 'cable' },
    { id: 'b', type: 'strip', source: { stripId: 'b', from: 0, to: 1 }, directionPolicy: 'fixed', physicalDirection: 'source-forward', seamLed: null },
  ],
  ...overrides,
});

test('compiler applies physical direction, ignores creative reversal, counts inactive, and omits cable jumps', () => {
  const result = compileWiring({ wiring: wiring(), strips, capabilities });
  assert.equal(result.ok, true);
  assert.equal(result.totalPixels, 9);
  assert.deepEqual(result.pixels.map(pixel => pixel.sourceLed), [3, 2, 1, 0, null, null, null, 0, 1]);
  assert.deepEqual(result.outputs, [{ id: 'o1', name: 'One', pin: 16, start: 0, count: 9, pixels: 9 }]);
  assert.deepEqual(result.zones.map(zone => zone.ranges[0]), [{ start: 0, count: 4 }, { start: 7, count: 2 }]);
});

test('compiler supports four outputs and split ranges with unique global offsets', () => {
  const result = compileWiring({
    strips,
    capabilities,
    wiring: wiring({
      outputs: [
        { id: 'o1', pin: 16, runIds: ['a1'] },
        { id: 'o2', pin: 17, runIds: ['a2'] },
        { id: 'o3', pin: 18, runIds: ['b1'] },
        { id: 'o4', pin: 21, runIds: ['b2'] },
      ],
      runs: [
        { id: 'a1', type: 'strip', source: { stripId: 'a', from: 0, to: 1 } },
        { id: 'a2', type: 'strip', source: { stripId: 'a', from: 2, to: 3 } },
        { id: 'b1', type: 'strip', source: { stripId: 'b', from: 0, to: 0 } },
        { id: 'b2', type: 'strip', source: { stripId: 'b', from: 1, to: 1 } },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.outputs.map(output => output.start), [0, 2, 4, 5]);
  assert.equal(result.totalPixels, 6);
});

test('logical split, resize, and reverse edits preserve physical output identities and GPIOs', () => {
  const physicalOutputs = [{ id: 'physical-a', name: 'Data wire A', pin: 18, runIds: ['a'] }];
  const variants = [
    wiring({ outputs: physicalOutputs, runs: [wiring().runs[0]] }),
    wiring({
      outputs: [{ ...physicalOutputs[0], runIds: ['a-head', 'a-tail'] }],
      runs: [
        { id: 'a-head', type: 'strip', source: { stripId: 'a', from: 0, to: 1 }, physicalDirection: 'source-forward' },
        { id: 'a-tail', type: 'strip', source: { stripId: 'a', from: 2, to: 3 }, physicalDirection: 'source-forward' },
      ],
    }),
    wiring({
      outputs: physicalOutputs,
      runs: [{ ...wiring().runs[0], source: { stripId: 'a', from: 0, to: 2 } }],
    }),
    wiring({
      outputs: physicalOutputs,
      runs: [{ ...wiring().runs[0], physicalDirection: 'source-forward' }],
    }),
  ];

  for (const variant of variants) {
    const result = compileWiring({ wiring: variant, strips, capabilities });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.outputs.map(({ id, pin }) => ({ id, pin })),
      [{ id: 'physical-a', pin: 18 }],
    );
    assert.equal(result.physicalOutputCount, 1);
  }
});

test('logical zones compile independently inside one physical output', () => {
  const result = compileWiring({
    wiring: wiring({
      outputs: [{ id: 'one-wire', pin: 16, runIds: ['a', 'b'] }],
      runs: wiring().runs.filter(run => run.id === 'a' || run.id === 'b'),
    }),
    strips,
    capabilities,
  });

  assert.equal(result.outputs.length, 1);
  assert.equal(result.zones.length, 2);
  assert.deepEqual(result.zones.map(zone => zone.id), ['a', 'b']);
});

test('seam rotation changes physical source order without changing inclusive coverage', () => {
  const model = wiring({ outputs: [{ id: 'o', pin: 16, runIds: ['a'] }], runs: [{ id: 'a', type: 'strip', source: { stripId: 'a', from: 0, to: 3 }, physicalDirection: 'source-forward', seamLed: 2 }] });
  const result = compileWiring({ wiring: model, strips, capabilities });
  assert.deepEqual(result.pixels.map(pixel => pixel.sourceLed), [2, 3, 0, 1]);
});

test('reverse direction walks backward from the selected seam', () => {
  const model = wiring({ outputs: [{ id: 'o', pin: 16, runIds: ['a'] }], runs: [{ id: 'a', type: 'strip', source: { stripId: 'a', from: 0, to: 3 }, physicalDirection: 'source-reverse', seamLed: 2 }] });
  const result = compileWiring({ wiring: model, strips, capabilities });
  assert.deepEqual(result.pixels.map(pixel => pixel.sourceLed), [2, 1, 0, 3]);
});

test('compiler rejects missing/duplicate runs and firmware limits instead of truncating', () => {
  const missing = compileWiring({ wiring: wiring({ outputs: [{ id: 'o', pin: 16, runIds: ['a', 'a', 'missing'] }] }), strips, capabilities });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(error => error.code === 'run-duplicate'));
  assert.ok(missing.errors.some(error => error.code === 'run-missing'));

  const oversized = compileWiring({ wiring: wiring({ runs: [{ id: 'gap', type: 'inactive', count: capabilities.maxPixels + 1 }], outputs: [{ id: 'o', pin: 16, runIds: ['gap'] }] }), strips, capabilities });
  assert.equal(oversized.ok, false);
  assert.ok(oversized.errors.some(error => error.code === 'pixel-limit'));
});

test('compiler warns about ambiguous adjacent strip boundaries', () => {
  const model = wiring({ outputs: [{ id: 'o', pin: 16, runIds: ['a', 'b'] }], runs: wiring().runs.filter(run => run.id === 'a' || run.id === 'b') });
  const result = compileWiring({ wiring: model, strips, capabilities });
  assert.ok(result.warnings.some(warning => warning.code === 'boundary-unverified'));
});

test('compiler honors precise per-run verification after downstream invalidation', () => {
  const model = wiring({
    locked: true,
    verified: true,
    outputs: [{ id: 'o', pin: 16, runIds: ['a', 'b'] }],
    runs: wiring().runs.filter(run => run.id === 'a' || run.id === 'b').map(run => ({ ...run, verified: run.id === 'a' })),
  });
  const result = compileWiring({ wiring: model, strips, capabilities });
  assert.ok(result.warnings.some(warning => warning.code === 'boundary-unverified' && warning.runId === 'b'));
  assert.equal(result.sendReady, false);
});

test('compiler groups discontinuous strip runs into one multi-range zone', () => {
  const model = wiring({ outputs: [{ id: 'o', pin: 16, runIds: ['a', 'gap', 'b'] }], runs: wiring().runs.filter(run => run.id !== 'jump') });
  const result = compileWiring({
    wiring: model,
    strips,
    groups: [{ groupId: 'rings', name: 'Rings', members: [{ stripId: 'a' }, { stripId: 'b' }] }],
    capabilities,
  });
  assert.deepEqual(result.zones, [{ id: 'rings', label: 'Rings', ranges: [{ start: 0, count: 4 }, { start: 7, count: 2 }] }]);
});

test('compiler returns structured missing-strip errors without throwing for empty geometry', () => {
  const missingModel = { outputs: [{ id: 'o', pin: 16, runIds: ['missing'] }], runs: [{ id: 'missing', type: 'strip', source: { stripId: 'gone', from: 0, to: 1 } }] };
  const result = compileWiring({
    wiring: missingModel,
    strips: [],
    capabilities,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'source-strip-missing'));
  assert.equal(validateWiring(missingModel, [], capabilities, { validateSources: false }).ok, true);
});

test('compiler propagates migration warnings into preflight output', () => {
  const model = wiring({ migrationWarnings: [{ code: 'output-boundary-inside-run', runId: 'a', message: 'Review boundary.' }] });
  const result = compileWiring({ wiring: model, strips, capabilities });
  assert.ok(result.warnings.some(warning => warning.code === 'output-boundary-inside-run'));
  assert.equal(result.sendReady, false);
});
