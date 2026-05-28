import test from 'node:test';
import assert from 'node:assert/strict';

import { pixelsFromPatchBoard, remapFrameToPatchBoard, toWLEDLedmap } from './export.js';

const strips = [{
  id: 'outer',
  name: 'Outer',
  pixelCount: 5,
  pixels: Array.from({ length: 5 }, (_, i) => ({ x: i, y: 0, index: i })),
}];

test('pixelsFromPatchBoard follows physical patch order for ledmap export', () => {
  const board = {
    physicalLocked: true,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['b', 'off', 'a'] }],
    groups: [],
    patches: [
      { id: 'a', name: 'Start', source: { type: 'strip', stripId: 'outer', startLed: 0, endLed: 1 }, output: { mode: 'normal' }, playback: {} },
      { id: 'b', name: 'Reverse end', source: { type: 'strip', stripId: 'outer', startLed: 4, endLed: 2 }, output: { mode: 'normal' }, playback: {} },
      { id: 'off', name: 'Off 2 LEDs', source: { type: 'off', ledCount: 2 }, output: { mode: 'off' }, playback: {} },
    ],
  };

  const pixels = pixelsFromPatchBoard(board, strips);

  assert.deepEqual(pixels.map(px => px.sourceLed), [4, 3, 2, null, null, 0, 1]);
  assert.equal(JSON.parse(toWLEDLedmap(pixels, { normalize: false })).n, 7);
});

test('remapFrameToPatchBoard emits frame colors in mapped order and black for off blocks', () => {
  const patchPixels = [
    { stripId: 'outer', sourceLed: 4 },
    { stripId: 'outer', sourceLed: 2 },
    { inactive: true, stripId: null, sourceLed: null },
    { stripId: 'outer', sourceLed: 0 },
  ];
  const frame = [
    { r: 1, g: 0, b: 0 },
    { r: 2, g: 0, b: 0 },
    { r: 3, g: 0, b: 0 },
    { r: 4, g: 0, b: 0 },
    { r: 5, g: 0, b: 0 },
  ];

  assert.deepEqual(remapFrameToPatchBoard(frame, patchPixels, strips), [
    { r: 5, g: 0, b: 0 },
    { r: 3, g: 0, b: 0 },
    { r: 0, g: 0, b: 0 },
    { r: 1, g: 0, b: 0 },
  ]);
});
