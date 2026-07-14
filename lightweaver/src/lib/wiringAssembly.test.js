import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveWiringAssembly } from './wiringAssembly.js';

const wiring = {
  version: 1,
  locked: true,
  verified: true,
  controllerAnchor: { x: 12, y: 34 },
  outputs: [{ id: 'out1', name: 'Output A', pin: 16, runIds: ['run-a', 'cable-1', 'run-b', 'reserved-1'] }],
  runs: [
    { id: 'run-a', type: 'strip', source: { stripId: 'a', from: 0, to: 4 }, physicalDirection: 'source-forward', directionPolicy: 'fixed', seamLed: null, verified: true },
    { id: 'cable-1', type: 'cable', verified: true, estimatedLength: 25 },
    { id: 'run-b', type: 'strip', source: { stripId: 'b', from: 2, to: 6 }, physicalDirection: 'source-reverse', directionPolicy: 'fixed', seamLed: 6, verified: true },
    { id: 'reserved-1', type: 'inactive', count: 3, verified: true },
  ],
};

const compiled = {
  ok: true,
  totalPixels: 13,
  outputs: [{ id: 'out1', name: 'Output A', pin: 16, start: 0, count: 13 }],
  runs: [
    { ...wiring.runs[0], outputId: 'out1', start: 0, count: 5, reversed: false },
    { ...wiring.runs[1], outputId: 'out1', start: 5, count: 0 },
    { ...wiring.runs[2], outputId: 'out1', start: 5, count: 5, reversed: true },
    { ...wiring.runs[3], outputId: 'out1', start: 10, count: 3 },
  ],
};

test('assembly derives every physical instruction from a locked compiler result', () => {
  const result = deriveWiringAssembly({ wiring, compiled, strips: [{ id: 'a', name: 'Left ring' }, { id: 'b', name: 'Right ring' }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.controllerAnchor, { x: 12, y: 34 });
  assert.equal(result.totalPixels, 13);
  assert.deepEqual(result.outputs[0], {
    id: 'out1', label: 'Output A', pin: 16, start: 0, count: 13, verified: true,
    runs: [
      { id: 'run-a', type: 'strip', label: 'Left ring', addressRange: [0, 4], sourceRange: [0, 4], count: 5, direction: 'Start LED → end LED', seamLed: null, verified: true, jumper: null },
      { id: 'cable-1', type: 'cable', label: 'Cable jump', addressRange: null, sourceRange: null, count: 0, direction: null, seamLed: null, verified: true, jumper: { toRunId: 'run-b', estimatedLength: null, lengthLabel: 'Relative length unavailable' } },
      { id: 'run-b', type: 'strip', label: 'Right ring', addressRange: [5, 9], sourceRange: [2, 6], count: 5, direction: 'End LED → start LED', seamLed: 6, verified: true, jumper: null },
      { id: 'reserved-1', type: 'inactive', label: 'Reserved · unlit', addressRange: [10, 12], sourceRange: null, count: 3, direction: null, seamLed: null, verified: true, jumper: null },
    ],
  });
});

test('assembly derives implicit and explicit jumpers from canonical endpoint geometry', () => {
  const geometricWiring = {
    ...wiring,
    runs: wiring.runs.map(run => ({ ...run, verified: true })),
  };
  const geometricCompiled = {
    ...compiled,
    runs: compiled.runs.map(run => ({ ...run, verified: true })),
  };
  const strips = [
    { id: 'a', name: 'Left ring', pixels: Array.from({ length: 5 }, (_, x) => ({ x, y: 0 })) },
    { id: 'b', name: 'Right ring', pixels: Array.from({ length: 7 }, (_, x) => ({ x: 10 + x, y: 0 })) },
  ];
  const manual = deriveWiringAssembly({ wiring: geometricWiring, compiled: geometricCompiled, strips, physicalScale: { pxPerMm: 2 } });
  assert.deepEqual(manual.outputs[0].runs[1].jumper, { toRunId: 'run-b', estimatedLength: 6, lengthLabel: '6 mm' });

  const implicitWiring = {
    ...geometricWiring,
    outputs: [{ ...geometricWiring.outputs[0], runIds: ['run-a', 'run-b'] }],
    runs: geometricWiring.runs.filter(run => ['run-a', 'run-b'].includes(run.id)),
  };
  const implicitCompiled = {
    ...geometricCompiled,
    totalPixels: 10,
    outputs: [{ ...geometricCompiled.outputs[0], count: 10 }],
    runs: geometricCompiled.runs.filter(run => ['run-a', 'run-b'].includes(run.id)),
  };
  const automatic = deriveWiringAssembly({ wiring: implicitWiring, compiled: implicitCompiled, strips, physicalScale: null });
  assert.deepEqual(automatic.outputs[0].runs[0].jumper, { toRunId: 'run-b', estimatedLength: 12, lengthLabel: '12 relative units' });
});

test('assembly refuses unlocked or compiler-invalid data instead of inventing instructions', () => {
  assert.equal(deriveWiringAssembly({ wiring: { ...wiring, locked: false }, compiled }).ok, false);
  assert.equal(deriveWiringAssembly({ wiring, compiled: { ...compiled, ok: false } }).ok, false);
  assert.equal(deriveWiringAssembly({ wiring: { ...wiring, verified: false }, compiled }).errors[0].code, 'wiring-unverified');
});
