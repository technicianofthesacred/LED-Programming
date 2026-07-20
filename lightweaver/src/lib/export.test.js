import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dmxAddressForPixel,
  pixelsFromPatchBoard,
  remapFrameToPatchBoard,
  toDmxCsv,
  toWLEDLedmap,
} from './export.js';

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

test('shared DMX address calculation rolls RGB pixels across Art-Net universes', () => {
  const options = {
    startUniverse: 7,
    startChannel: 504,
    channelsPerUniverse: 510,
    channelsPerPixel: 3,
    maxUniverse: 32767,
  };

  assert.deepEqual(dmxAddressForPixel(0, options), { universe: 7, channel: 504 });
  assert.deepEqual(dmxAddressForPixel(1, options), { universe: 7, channel: 507 });
  assert.deepEqual(dmxAddressForPixel(2, options), { universe: 8, channel: 0 });
  assert.throws(
    () => dmxAddressForPixel(2, { ...options, startUniverse: 32767 }),
    /universe.*range/i,
  );

  assert.equal(
    toDmxCsv([[{ r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }]]),
    'frame,channel,value\n0,1,1\n0,2,2\n0,3,3\n0,4,4\n0,5,5\n0,6,6',
    'the existing flat DMX export remains 1-based',
  );
});
