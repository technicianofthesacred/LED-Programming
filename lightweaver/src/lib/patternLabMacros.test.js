import test from 'node:test';
import assert from 'node:assert/strict';

import {
  patternLabMacrosFromTechnicalValues,
  resolvePatternLabMacros,
} from './patternLabMacros.js';

const CASES = [
  ['color',
    { paletteTravel: 0, warmth: -1, saturation: 0.55 },
    { paletteTravel: 0.5, warmth: 0, saturation: 0.775 },
    { paletteTravel: 1, warmth: 1, saturation: 1 }],
  ['movement',
    { speedMultiplier: 0.25, driftToPulse: 0, modulationDepth: 0.05 },
    { speedMultiplier: 1.125, driftToPulse: 0.5, modulationDepth: 0.4 },
    { speedMultiplier: 2, driftToPulse: 1, modulationDepth: 0.75 }],
  ['shape',
    { spatialScale: 0.5, radialBias: -1, symmetryStrength: 0.15 },
    { spatialScale: 1.5, radialBias: 0, symmetryStrength: 0.575 },
    { spatialScale: 2.5, radialBias: 1, symmetryStrength: 1 }],
  ['texture',
    { detailScale: 0.5, crispness: 0, density: 0.15 },
    { detailScale: 2.25, crispness: 0.5, density: 0.575 },
    { detailScale: 4, crispness: 1, density: 1 }],
  ['energy',
    { brightness: 0.15, dynamicRange: 0.1, rareEventStrength: 0 },
    { brightness: 0.575, dynamicRange: 0.55, rareEventStrength: 0.4 },
    { brightness: 1, dynamicRange: 1, rareEventStrength: 0.8 }],
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
    macros: { color: 0.2, movement: 0.3, shape: 0.4, texture: 0.6, energy: 0.7 },
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

test('technical values reverse exactly to endpoint and midpoint macros', () => {
  for (const [macro, atZero, atMidpoint, atOne] of CASES) {
    for (const [amount, technical] of [[0, atZero], [0.5, atMidpoint], [1, atOne]]) {
      const reversed = patternLabMacrosFromTechnicalValues({ [macro]: technical });
      assert.equal(reversed[macro], amount, `${macro} should reverse to ${amount}`);
    }
  }
});

test('a resolve-reverse-resolve round trip is stable and non-destructive', () => {
  const macros = { color: 0.13, movement: 0.27, shape: 0.49, texture: 0.68, energy: 0.91 };
  const before = structuredClone(macros);
  const technical = resolvePatternLabMacros(macros);
  const reversed = patternLabMacrosFromTechnicalValues(technical);
  const resolvedAgain = resolvePatternLabMacros(reversed);

  assert.deepEqual(macros, before);
  assert.deepEqual(reversed, macros);
  assert.deepEqual(resolvedAgain, technical);
});

test('missing macros use midpoint defaults and out-of-range inputs clamp', () => {
  assert.deepEqual(patternLabMacrosFromTechnicalValues(resolvePatternLabMacros({})), {
    color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5, energy: 0.5,
  });
  const resolved = resolvePatternLabMacros({ color: -1, movement: 2 });
  assert.equal(resolved.color.paletteTravel, 0);
  assert.equal(resolved.movement.speedMultiplier, 2);
});
