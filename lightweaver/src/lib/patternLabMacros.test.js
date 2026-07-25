import test from 'node:test';
import assert from 'node:assert/strict';

import {
  patternLabMacrosFromTechnicalValues,
  projectPatternLabMacrosFromTechnicalValues,
  resolvePatternLabMacros,
} from './patternLabMacros.js';

const CASES = [
  ['color',
    { paletteTravel: 0, warmth: -1, saturation: 0.55 },
    { paletteTravel: 0.5, warmth: 0, saturation: 0.775 },
    { paletteTravel: 1, warmth: 1, saturation: 1 }],
  ['movement',
    { driftToPulse: 0, modulationDepth: 0.05 },
    { driftToPulse: 0.5, modulationDepth: 0.4 },
    { driftToPulse: 1, modulationDepth: 0.75 }],
  ['shape',
    { spatialScale: 0.5, radialBias: -1, symmetryStrength: 0.15 },
    { spatialScale: 1.5, radialBias: 0, symmetryStrength: 0.575 },
    { spatialScale: 2.5, radialBias: 1, symmetryStrength: 1 }],
  ['texture',
    { detailScale: 0.5, crispness: 0, density: 0.15 },
    { detailScale: 2.25, crispness: 0.5, density: 0.575 },
    { detailScale: 4, crispness: 1, density: 1 }],
];

for (const [macro, atZero, atMidpoint, atOne] of CASES) {
  for (const [label, input, expected] of [['endpoint 0', 0, atZero], ['midpoint', 0.5, atMidpoint], ['endpoint 1', 1, atOne]]) {
    test(`${macro} ${label} resolves to its exact technical values`, () => {
      const resolved = resolvePatternLabMacros({ [macro]: input });
      assert.deepEqual(resolved[macro], expected);
    });
  }
}

test('resolution returns fresh values and never mutates the source recipe or macro object', () => {
  const source = {
    id: 'immutable',
    macros: { color: 0.2, movement: 0.3, shape: 0.4, texture: 0.6 },
  };
  const before = structuredClone(source);
  const first = resolvePatternLabMacros(source);
  const second = resolvePatternLabMacros(source);

  assert.deepEqual(source, before);
  assert.notEqual(first, second);
  assert.notEqual(first.color, second.color);
  first.color.warmth = 99;
  assert.deepEqual(source, before);
  assert.notEqual(second.color.warmth, 99);
});

test('primary-field projection recovers endpoint and midpoint resolver outputs', () => {
  for (const [macro, atZero, atMidpoint, atOne] of CASES) {
    for (const [amount, technical] of [[0, atZero], [0.5, atMidpoint], [1, atOne]]) {
      const projected = projectPatternLabMacrosFromTechnicalValues({ [macro]: technical });
      assert.equal(projected[macro], amount, `${macro} should project to ${amount}`);
    }
  }
});

test('resolver output projects back within documented twelve-decimal precision', () => {
  const macros = { color: 0.13, movement: 0.27, shape: 0.49, texture: 0.68 };
  const before = structuredClone(macros);
  const technical = resolvePatternLabMacros(macros);
  const projected = projectPatternLabMacrosFromTechnicalValues(technical);
  const resolvedAgain = resolvePatternLabMacros(projected);

  assert.deepEqual(macros, before);
  assert.deepEqual(projected, macros);
  assert.deepEqual(resolvedAgain, technical);
});

test('projection uses only the documented primary field for contradictory technical groups', () => {
  const technical = {
    color: { paletteTravel: 0.25, warmth: 1, saturation: 0.55 },
    movement: { driftToPulse: 0.75, modulationDepth: 0.05 },
  };
  const before = structuredClone(technical);
  const projected = projectPatternLabMacrosFromTechnicalValues(technical);
  assert.equal(projected.color, 0.25);
  assert.equal(projected.movement, 0.75);
  assert.deepEqual(technical, before);
});

test('arbitrary macro floats project within precision without promising an exact inverse', () => {
  const amount = 0.123456789012345;
  const projected = projectPatternLabMacrosFromTechnicalValues(resolvePatternLabMacros({ color: amount }));
  assert.ok(Math.abs(projected.color - amount) <= 1e-12);
  assert.notEqual(projected.color, amount);
});

test('legacy technical-to-macro name remains a projection-compatible alias', () => {
  const technical = resolvePatternLabMacros({ color: 0.2, movement: 0.7 });
  assert.deepEqual(patternLabMacrosFromTechnicalValues(technical), projectPatternLabMacrosFromTechnicalValues(technical));
});

test('missing macros use midpoint defaults and out-of-range inputs clamp', () => {
  assert.deepEqual(projectPatternLabMacrosFromTechnicalValues(resolvePatternLabMacros({})), {
    color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5,
  });
  const resolved = resolvePatternLabMacros({ color: -1, movement: 2 });
  assert.equal(resolved.color.paletteTravel, 0);
  assert.deepEqual(resolved.movement, { driftToPulse: 1, modulationDepth: .75 });
});

test('movement owns motion character only and Energy has no technical group', () => {
  const resolved = resolvePatternLabMacros({
    color: .4,
    movement: .6,
    shape: .5,
    texture: .5,
    energy: 1,
  });
  assert.deepEqual(Object.keys(resolved), ['color', 'movement', 'shape', 'texture']);
  assert.equal(Object.hasOwn(resolved.movement, 'speedMultiplier'), false);
  assert.equal(Object.hasOwn(resolved, 'energy'), false);
});
