import test from 'node:test';
import assert from 'node:assert/strict';

import { COLOUR_PROBE_BLOCKS, buildColourProbeFrame, colourOrderFromSeenOrder } from './colourReorder.js';
import { COLOR_ORDERS } from './usbLedColorOrder.js';

test('probe blocks describe the three blocks in send order', () => {
  assert.deepEqual(COLOUR_PROBE_BLOCKS, [
    { id: 'red', hex: 'FF0000' },
    { id: 'green', hex: '00FF00' },
    { id: 'blue', hex: '0000FF' },
  ]);
});

test('real-hardware case: driven GRB, seen green / red / blue — true order is RGB', () => {
  assert.equal(colourOrderFromSeenOrder(['green', 'red', 'blue'], 'GRB'), 'RGB');
});

test('seeing exactly what was sent means nothing is transposed — answer is the declared order itself', () => {
  for (const order of COLOR_ORDERS) {
    assert.equal(colourOrderFromSeenOrder(['red', 'green', 'blue'], order), order);
  }
});

test('every seen permutation under declared GRB resolves to the unique true order', () => {
  const expectations = {
    'red,green,blue': 'GRB',
    'red,blue,green': 'BRG',
    'green,red,blue': 'RGB',
    'green,blue,red': 'BGR',
    'blue,red,green': 'RBG',
    'blue,green,red': 'GBR',
  };
  for (const [seen, expected] of Object.entries(expectations)) {
    assert.equal(colourOrderFromSeenOrder(seen.split(','), 'GRB'), expected, seen);
  }
});

test('every seen permutation under declared RGB resolves to the unique true order', () => {
  const expectations = {
    'red,green,blue': 'RGB',
    'red,blue,green': 'RBG',
    'green,red,blue': 'GRB',
    'green,blue,red': 'GBR',
    'blue,red,green': 'BRG',
    'blue,green,red': 'BGR',
  };
  for (const [seen, expected] of Object.entries(expectations)) {
    assert.equal(colourOrderFromSeenOrder(seen.split(','), 'RGB'), expected, seen);
  }
});

test('invalid seen input returns empty string', () => {
  const invalid = [
    ['red', 'red', 'blue'],
    ['red', 'green'],
    ['red', 'green', 'blue', 'red'],
    ['red', 'green', 'yellow'],
    [],
    'red,green,blue',
    null,
    undefined,
    {},
  ];
  for (const seen of invalid) {
    assert.equal(colourOrderFromSeenOrder(seen, 'GRB'), '');
  }
});

test('a declared order that is not real returns empty string', () => {
  for (const declared of ['XYZ', 'GRBR', '', null, 42, 0, false]) {
    assert.equal(colourOrderFromSeenOrder(['red', 'green', 'blue'], declared), '');
  }
});

test('buildColourProbeFrame produces exact-length frames with remainder to earlier blocks', () => {
  const cases = [
    { pixels: 41, blocks: [14, 14, 13] },
    { pixels: 9, blocks: [3, 3, 3] },
    { pixels: 10, blocks: [4, 3, 3] },
    { pixels: 1, blocks: [1, 0, 0] },
  ];
  const hexes = COLOUR_PROBE_BLOCKS.map(block => block.hex);
  for (const { pixels, blocks } of cases) {
    const frame = buildColourProbeFrame(pixels);
    assert.equal(frame.length, pixels);
    let offset = 0;
    blocks.forEach((size, index) => {
      assert.ok(frame.slice(offset, offset + size).every(hex => hex === hexes[index]), `${pixels} lights, block ${index}`);
      offset += size;
    });
    assert.ok(frame.every(hex => /^[0-9A-F]{6}$/.test(hex)), `${pixels} lights, hex uppercase`);
  }
});

test('buildColourProbeFrame returns an empty frame for zero or less', () => {
  for (const pixels of [0, -3, NaN, '0', Infinity]) {
    assert.deepEqual(buildColourProbeFrame(pixels), []);
  }
});
