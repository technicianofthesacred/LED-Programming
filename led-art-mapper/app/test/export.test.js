import test from 'node:test';
import assert from 'node:assert/strict';

import { toCoordinateMap, toWLEDIndexMap } from '../src/export.js';

test('coordinate normalization preserves artwork aspect ratio', () => {
  const data = JSON.parse(toCoordinateMap([
    { index: 0, x: 0, y: 0 },
    { index: 1, x: 200, y: 100 },
  ]));

  assert.deepEqual(data.map, [[0, 0], [1, 0.5]]);
});

test('a one LED WLED map uses one cell rather than a 64 by 64 grid', () => {
  const data = JSON.parse(toWLEDIndexMap([{ index: 0, x: 50, y: 50 }]));

  assert.deepEqual(data, { width: 1, height: 1, map: [0] });
});

test('WLED grid stays compact while retaining every LED index', () => {
  const pixels = Array.from({ length: 12 }, (_, index) => ({
    index,
    x: index * 10,
    y: index % 2,
  }));
  const data = JSON.parse(toWLEDIndexMap(pixels));

  assert.ok(data.width * data.height <= pixels.length * 4);
  assert.deepEqual(
    data.map.filter(index => index >= 0).sort((a, b) => a - b),
    pixels.map(pixel => pixel.index),
  );
});
