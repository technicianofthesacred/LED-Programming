import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatchRouteOrder,
  chainPixelOffsets,
  createDefaultPatchBoard,
  cutsForStrip,
  deleteStripCut,
  expandPatchBoard,
  addOffPatch,
  migrateChainToStripOrder,
  movePatch,
  moveStripRowsInChain,
  nudgeStripCut,
  normalizePatchBoard,
  orderedStripIdsFromChain,
  resolvePatchPlayback,
  sliceStripIntoPatches,
  sliceStripIntoPatchesPreservingRoute,
  updatePatchRange,
  validatePatchBoard,
} from './patchBoard.js';

const makeStrip = (id, count, xOffset = 0) => ({
  id,
  name: id,
  pixelCount: count,
  pixels: Array.from({ length: count }, (_, i) => ({
    x: xOffset + i,
    y: xOffset * 10,
    index: i,
  })),
});

test('default board mirrors current strip order', () => {
  const strips = [makeStrip('layer-10', 3), makeStrip('layer-3', 2, 10)];
  const board = createDefaultPatchBoard(strips);
  const expanded = expandPatchBoard(board, strips);

  assert.deepEqual(board.chains[0].rowIds, ['patch-layer-10', 'patch-layer-3']);
  assert.equal(expanded.pixels.length, 5);
  assert.deepEqual(expanded.pixels.map(px => px.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(expanded.pixels.map(px => px.stripId), [
    'layer-10',
    'layer-10',
    'layer-10',
    'layer-3',
    'layer-3',
  ]);
});

test('normalization creates a default board for missing saved patch board data', () => {
  const strips = [makeStrip('layer-1', 3)];

  const board = normalizePatchBoard(null, strips);

  assert.deepEqual(board.chains[0].rowIds, ['patch-layer-1']);
  assert.equal(board.patches[0].source.stripId, 'layer-1');
});

test('normalization preserves custom rows while appending newly added strips', () => {
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['off', 'patch-layer-1'] }],
    groups: [],
    patches: [
      {
        id: 'off',
        name: 'Hidden LEDs',
        groupId: null,
        source: { type: 'off', ledCount: 2 },
        output: { mode: 'off' },
        playback: {},
      },
      {
        id: 'patch-layer-1',
        name: 'Layer 1',
        groupId: null,
        source: { type: 'strip', stripId: 'layer-1', startLed: 1, endLed: 0 },
        output: { mode: 'normal' },
        playback: { speed: 0.5 },
      },
    ],
  };

  const normalized = normalizePatchBoard(board, [
    makeStrip('layer-1', 2),
    makeStrip('layer-2', 3),
  ]);

  assert.deepEqual(normalized.chains[0].rowIds, ['off', 'patch-layer-1', 'patch-layer-2']);
  assert.deepEqual(
    normalized.patches.find(patch => patch.id === 'patch-layer-1').source,
    { type: 'strip', stripId: 'layer-1', startLed: 1, endLed: 0 },
  );
  assert.equal(normalized.patches.find(patch => patch.id === 'off').source.ledCount, 2);
  assert.equal(normalized.patches.find(patch => patch.id === 'patch-layer-2').source.endLed, 2);
});

test('normalization tracks generated full-strip ranges through strip resize', () => {
  const board = createDefaultPatchBoard([makeStrip('layer-1', 3)]);

  const grown = normalizePatchBoard(board, [makeStrip('layer-1', 5)]);
  assert.equal(grown.patches[0].source.startLed, 0);
  assert.equal(grown.patches[0].source.endLed, 4);

  const shrunk = normalizePatchBoard(grown, [makeStrip('layer-1', 2)]);
  assert.equal(shrunk.patches[0].source.startLed, 0);
  assert.equal(shrunk.patches[0].source.endLed, 1);
});

test('normalization migrates legacy generated patches without autoRange metadata', () => {
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['patch-layer-1', 'patch-layer-2'] }],
    groups: [],
    patches: [
      {
        id: 'patch-layer-1',
        name: 'Layer 1',
        groupId: null,
        source: { type: 'strip', stripId: 'layer-1', startLed: 0, endLed: 2 },
        output: { mode: 'normal' },
        playback: {},
      },
      {
        id: 'patch-layer-2',
        name: 'Layer 2',
        groupId: null,
        source: { type: 'strip', stripId: 'layer-2', startLed: 0, endLed: 1 },
        output: { mode: 'normal' },
        playback: {},
      },
    ],
  };

  const normalized = normalizePatchBoard(board, [makeStrip('layer-1', 5)]);

  assert.deepEqual(normalized.chains[0].rowIds, ['patch-layer-1']);
  assert.equal(normalized.patches[0].source.autoRange, true);
  assert.equal(normalized.patches[0].source.endLed, 4);
});

test('custom range updates opt out of generated full-strip tracking', () => {
  const board = createDefaultPatchBoard([makeStrip('layer-1', 5)]);

  updatePatchRange(board, 'patch-layer-1', 1, 3);
  const normalized = normalizePatchBoard(board, [makeStrip('layer-1', 8)]);

  assert.equal(normalized.patches[0].source.autoRange, false);
  assert.equal(normalized.patches[0].source.startLed, 1);
  assert.equal(normalized.patches[0].source.endLed, 3);
});

test('sliceStripIntoPatches turns visual cut marks into ordered strip patches', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);

  sliceStripIntoPatches(board, strip, [2, 5]);

  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-0-2',
    'patch-outer-3-5',
    'patch-outer-6-7',
  ]);
  assert.deepEqual(board.patches.map(p => p.source), [
    { type: 'strip', stripId: 'outer', startLed: 0, endLed: 2, autoRange: false, stripPixelCount: 8 },
    { type: 'strip', stripId: 'outer', startLed: 3, endLed: 5, autoRange: false, stripPixelCount: 8 },
    { type: 'strip', stripId: 'outer', startLed: 6, endLed: 7, autoRange: false, stripPixelCount: 8 },
  ]);
});

test('sliceStripIntoPatches can create a one-led first segment', () => {
  const strip = makeStrip('outer', 2);
  const board = createDefaultPatchBoard([strip]);

  sliceStripIntoPatches(board, strip, [0]);

  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-0-0',
    'patch-outer-1-1',
  ]);
  const expanded = expandPatchBoard(board, [strip]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [0, 1]);
});

test('sliceStripIntoPatches preserves off blocks and other strip patches', () => {
  const outer = makeStrip('outer', 6);
  const inner = makeStrip('inner', 4);
  const board = createDefaultPatchBoard([outer, inner]);
  const offPatch = addOffPatch(board, 2);

  sliceStripIntoPatches(board, outer, [2, 2, -1, 9]);

  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-0-2',
    'patch-outer-3-5',
    'patch-inner',
    offPatch.id,
  ]);
  assert.equal(board.patches.some(patch => patch.id === 'patch-inner'), true);
  assert.equal(board.patches.some(patch => patch.id === offPatch.id), true);
});

test('normalization reslices segmented strip patches when a strip grows', () => {
  const strip = makeStrip('outer', 10);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [3, 6]);

  const normalized = normalizePatchBoard(board, [makeStrip('outer', 12)]);

  assert.deepEqual(
    normalized.patches
      .filter(patch => patch.source?.type === 'strip')
      .map(patch => patch.source),
    [
      { type: 'strip', stripId: 'outer', startLed: 0, endLed: 3, autoRange: false, stripPixelCount: 12 },
      { type: 'strip', stripId: 'outer', startLed: 4, endLed: 6, autoRange: false, stripPixelCount: 12 },
      { type: 'strip', stripId: 'outer', startLed: 7, endLed: 11, autoRange: false, stripPixelCount: 12 },
    ],
  );
  const expanded = expandPatchBoard(normalized, [makeStrip('outer', 12)]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('normalization reslices segmented strip patches when a strip shrinks', () => {
  const strip = makeStrip('outer', 10);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [3, 6]);

  const normalized = normalizePatchBoard(board, [makeStrip('outer', 6)]);

  assert.deepEqual(normalized.chains[0].rowIds, [
    'patch-outer-0-3',
    'patch-outer-4-5',
  ]);
  const expanded = expandPatchBoard(normalized, [makeStrip('outer', 6)]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [0, 1, 2, 3, 4, 5]);
});

test('normalization preserves segmented patch output and playback while adapting length', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  const tailPatch = board.patches.find(patch => patch.id === 'patch-outer-6-7');
  tailPatch.output = { mode: 'off' };
  tailPatch.playback = { patternId: 'spark', speed: 0.25 };

  const normalized = normalizePatchBoard(board, [makeStrip('outer', 10)]);
  const adaptedTail = normalized.patches.find(patch =>
    patch.source?.type === 'strip' &&
    patch.source.stripId === 'outer' &&
    patch.source.startLed === 6);

  assert.deepEqual(adaptedTail.source, {
    type: 'strip',
    stripId: 'outer',
    startLed: 6,
    endLed: 9,
    autoRange: false,
    stripPixelCount: 10,
  });
  assert.deepEqual(adaptedTail.output, { mode: 'off' });
  assert.deepEqual(adaptedTail.playback, { patternId: 'spark', speed: 0.25 });
});

test('normalization does not restore a deleted trailing segmented patch', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  board.patches = board.patches.filter(patch => patch.id !== 'patch-outer-6-7');
  board.chains[0].rowIds = board.chains[0].rowIds.filter(rowId => rowId !== 'patch-outer-6-7');

  const normalized = normalizePatchBoard(board, [strip]);

  assert.deepEqual(normalized.chains[0].rowIds, [
    'patch-outer-0-2',
    'patch-outer-3-5',
  ]);
  const expanded = expandPatchBoard(normalized, [strip]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [0, 1, 2, 3, 4, 5]);
});

test('sliceStripIntoPatchesPreservingRoute keeps custom route rows while adding a cut', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  const offPatch = addOffPatch(board, 2);
  board.chains[0].rowIds = [
    'patch-outer-6-7',
    offPatch.id,
    'patch-outer-0-2',
  ];

  sliceStripIntoPatchesPreservingRoute(board, strip, [2, 4, 5]);

  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-6-7',
    offPatch.id,
    'patch-outer-0-2',
  ]);
  assert.deepEqual(cutsForStrip(board, 'outer'), [2, 4, 5]);
});

test('sliceStripIntoPatchesPreservingRoute expands a routed segment when a new cut splits it', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  applyPatchRouteOrder(board, [
    'patch-outer-6-7',
    'patch-outer-3-5',
    'patch-outer-0-2',
  ]);

  sliceStripIntoPatchesPreservingRoute(board, strip, [2, 4, 5]);

  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-6-7',
    'patch-outer-3-4',
    'patch-outer-5-5',
    'patch-outer-0-2',
  ]);
  const expanded = expandPatchBoard(board, [strip]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [6, 7, 3, 4, 5, 0, 1, 2]);
});

test('sliceStripIntoPatchesPreservingRoute preserves a reversed routed segment when a new cut splits it', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  updatePatchRange(board, 'patch-outer-3-5', 5, 3);
  applyPatchRouteOrder(board, ['patch-outer-3-5']);

  sliceStripIntoPatchesPreservingRoute(board, strip, [2, 4, 5]);

  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-5-5',
    'patch-outer-3-4',
  ]);
  assert.deepEqual(
    board.patches.find(patch => patch.id === 'patch-outer-3-4').source,
    { type: 'strip', stripId: 'outer', startLed: 4, endLed: 3, autoRange: false, stripPixelCount: 8 },
  );
  const expanded = expandPatchBoard(board, [strip]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [5, 4, 3]);
});

test('sliceStripIntoPatchesPreservingRoute preserves reversed ranges in natural row order', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  updatePatchRange(board, 'patch-outer-3-5', 5, 3);

  sliceStripIntoPatchesPreservingRoute(board, strip, [2, 4, 5]);

  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-0-2',
    'patch-outer-5-5',
    'patch-outer-3-4',
    'patch-outer-6-7',
  ]);
  const expanded = expandPatchBoard(board, [strip]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [0, 1, 2, 5, 4, 3, 6, 7]);
});

test('cutsForStrip returns sorted cut indexes from existing strip segments', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);

  sliceStripIntoPatches(board, strip, [5, 2]);

  assert.deepEqual(cutsForStrip(board, 'outer'), [2, 5]);
});

test('nudgeStripCut moves one cut while preserving adjacent segments', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);

  nudgeStripCut(board, strip, 2, 1);

  assert.deepEqual(cutsForStrip(board, 'outer'), [3, 5]);
  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-0-3',
    'patch-outer-4-5',
    'patch-outer-6-7',
  ]);
});

test('nudgeStripCut can move the first cut to LED zero', () => {
  const strip = makeStrip('outer', 4);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [1]);

  nudgeStripCut(board, strip, 1, -1);

  assert.deepEqual(cutsForStrip(board, 'outer'), [0]);
  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-0-0',
    'patch-outer-1-3',
  ]);
});

test('nudgeStripCut preserves custom route membership', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  applyPatchRouteOrder(board, ['patch-outer-6-7', 'patch-outer-0-2']);

  nudgeStripCut(board, strip, 2, 1);

  assert.deepEqual(board.chains[0].rowIds, ['patch-outer-6-7', 'patch-outer-0-3']);
  const expanded = expandPatchBoard(board, [strip]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [6, 7, 0, 1, 2, 3]);
});

test('nudgeStripCut maps routed segments to the largest overlapping segment', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  applyPatchRouteOrder(board, ['patch-outer-3-5']);

  nudgeStripCut(board, strip, 2, 1);

  assert.deepEqual(board.chains[0].rowIds, ['patch-outer-4-5']);
  const expanded = expandPatchBoard(board, [strip]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [4, 5]);
});

test('nudgeStripCut preserves interleaved non-strip route rows', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  const offPatch = addOffPatch(board, 2);
  board.chains[0].rowIds = [
    'patch-outer-0-2',
    offPatch.id,
    'patch-outer-3-5',
    'patch-outer-6-7',
  ];

  nudgeStripCut(board, strip, 2, 1);

  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-0-3',
    offPatch.id,
    'patch-outer-4-5',
    'patch-outer-6-7',
  ]);
});

test('nudgeStripCut ignores zero delta without rebuilding patch metadata', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  board.patches.find(patch => patch.id === 'patch-outer-3-5').note = 'keep me';
  const before = JSON.stringify(board);

  const result = nudgeStripCut(board, strip, 2, 0);

  assert.equal(result, board);
  assert.equal(JSON.stringify(board), before);
});

test('nudgeStripCut does not cross neighboring cuts', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [1, 2]);

  nudgeStripCut(board, strip, 1, -1);
  nudgeStripCut(board, strip, 2, -1);

  assert.deepEqual(cutsForStrip(board, 'outer'), [0, 1]);
});

test('deleteStripCut merges adjacent visual segments', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);

  deleteStripCut(board, strip, 2);

  assert.deepEqual(cutsForStrip(board, 'outer'), [5]);
  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-0-5',
    'patch-outer-6-7',
  ]);
});

test('deleteStripCut preserves interleaved non-strip route rows', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  const offPatch = addOffPatch(board, 2);
  board.chains[0].rowIds = [
    'patch-outer-0-2',
    offPatch.id,
    'patch-outer-3-5',
    'patch-outer-6-7',
  ];

  deleteStripCut(board, strip, 2);

  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-0-5',
    offPatch.id,
    'patch-outer-6-7',
  ]);
  assert.deepEqual(cutsForStrip(board, 'outer'), [5]);
});

test('deleteStripCut ignores missing cut without rebuilding route order', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  applyPatchRouteOrder(board, ['patch-outer-6-7', 'patch-outer-0-2']);

  const before = JSON.stringify(board);
  const result = deleteStripCut(board, strip, 4);

  assert.equal(result, board);
  assert.equal(JSON.stringify(board), before);
});

test('applyPatchRouteOrder makes clicked segments the exported physical route', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);

  applyPatchRouteOrder(board, ['patch-outer-6-7', 'patch-outer-0-2']);

  assert.deepEqual(board.chains[0].rowIds, ['patch-outer-6-7', 'patch-outer-0-2']);
  const expanded = expandPatchBoard(board, [strip]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [6, 7, 0, 1, 2]);
});

test('applyPatchRouteOrder preserves existing off rows while replacing strip route rows', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);
  const offPatch = addOffPatch(board, 2);
  board.chains[0].rowIds = [
    'patch-outer-0-2',
    offPatch.id,
    'patch-outer-3-5',
    'patch-outer-6-7',
  ];

  applyPatchRouteOrder(board, ['patch-outer-6-7', 'patch-outer-0-2']);

  assert.deepEqual(board.chains[0].rowIds, [
    'patch-outer-6-7',
    offPatch.id,
    'patch-outer-0-2',
  ]);
  const expanded = expandPatchBoard(board, [strip]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [6, 7, null, null, 0, 1, 2]);
});

test('normalization prunes deleted generated strip patches but keeps custom rows', () => {
  const board = createDefaultPatchBoard([makeStrip('layer-1', 2), makeStrip('layer-2', 3)]);
  const offPatch = addOffPatch(board, 2);
  board.patches.push({
    id: 'custom-missing-layer',
    name: 'Custom missing layer',
    groupId: null,
    source: { type: 'strip', stripId: 'layer-1', startLed: 1, endLed: 0, autoRange: false },
    output: { mode: 'normal' },
    playback: {},
  });
  board.chains[0].rowIds = [
    'patch-layer-1',
    'custom-missing-layer',
    'patch-layer-2',
    offPatch.id,
  ];

  const normalized = normalizePatchBoard(board, [makeStrip('layer-2', 3)]);

  assert.deepEqual(normalized.chains[0].rowIds, [
    'custom-missing-layer',
    'patch-layer-2',
    offPatch.id,
  ]);
  assert.equal(normalized.patches.some(patch => patch.id === 'patch-layer-1'), false);
  assert.equal(normalized.patches.some(patch => patch.id === 'custom-missing-layer'), true);
  assert.equal(normalized.patches.some(patch => patch.id === offPatch.id), true);
});

test('forward patch 2 -> 10 emits inclusive ascending source LEDs', () => {
  const strips = [makeStrip('layer-7', 12)];
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['p1'] }],
    groups: [],
    patches: [{
      id: 'p1',
      name: 'Layer 7 2-10',
      groupId: null,
      source: { type: 'strip', stripId: 'layer-7', startLed: 2, endLed: 10 },
      output: { mode: 'normal' },
      playback: {},
    }],
  };

  const expanded = expandPatchBoard(board, strips);

  assert.equal(expanded.pixels.length, 9);
  assert.deepEqual(expanded.pixels.map(px => px.sourceLed), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(expanded.pixels.map(px => px.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('reverse patch 10 -> 2 emits inclusive descending source LEDs', () => {
  const strips = [makeStrip('layer-7', 12)];
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['p1'] }],
    groups: [],
    patches: [{
      id: 'p1',
      name: 'Layer 7 reverse',
      groupId: null,
      source: { type: 'strip', stripId: 'layer-7', startLed: 10, endLed: 2 },
      output: { mode: 'normal' },
      playback: {},
    }],
  };

  const expanded = expandPatchBoard(board, strips);

  assert.equal(expanded.pixels.length, 9);
  assert.deepEqual(expanded.pixels.map(px => px.sourceLed), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.deepEqual(expanded.pixels.map(px => px.x), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
});

test('adjacent patches can be reordered independently', () => {
  const strips = [makeStrip('layer-7', 21)];
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['b', 'a'] }],
    groups: [],
    patches: [
      {
        id: 'a',
        name: 'First source span',
        groupId: null,
        source: { type: 'strip', stripId: 'layer-7', startLed: 2, endLed: 10 },
        output: { mode: 'normal' },
        playback: {},
      },
      {
        id: 'b',
        name: 'Second source span',
        groupId: null,
        source: { type: 'strip', stripId: 'layer-7', startLed: 11, endLed: 20 },
        output: { mode: 'normal' },
        playback: {},
      },
    ],
  };

  const expanded = expandPatchBoard(board, strips);

  assert.deepEqual(expanded.pixels.slice(0, 3).map(px => px.sourceLed), [11, 12, 13]);
  assert.deepEqual(expanded.pixels.slice(-3).map(px => px.sourceLed), [8, 9, 10]);
});

test('movePatch mutates the board main chain row order', () => {
  const board = createDefaultPatchBoard([makeStrip('a', 1), makeStrip('b', 1)]);

  movePatch(board, 'patch-b', 'up');

  assert.deepEqual(board.chains[0].rowIds, ['patch-b', 'patch-a']);
});

test('off patches consume addresses and mark pixels inactive', () => {
  const strips = [makeStrip('layer-1', 2)];
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['a', 'off', 'b'] }],
    groups: [],
    patches: [
      {
        id: 'a',
        name: 'Start',
        groupId: null,
        source: { type: 'strip', stripId: 'layer-1', startLed: 0, endLed: 0 },
        output: { mode: 'normal' },
        playback: {},
      },
      {
        id: 'off',
        name: 'Hidden LEDs',
        groupId: null,
        source: { type: 'off', ledCount: 3 },
        output: { mode: 'off' },
        playback: {},
      },
      {
        id: 'b',
        name: 'End',
        groupId: null,
        source: { type: 'strip', stripId: 'layer-1', startLed: 1, endLed: 1 },
        output: { mode: 'normal' },
        playback: {},
      },
    ],
  };

  const expanded = expandPatchBoard(board, strips);

  assert.deepEqual(expanded.pixels.map(px => px.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(expanded.pixels.map(px => px.inactive === true), [false, true, true, true, false]);
});

test('addOffPatch appends to board main chain and participates in expansion', () => {
  const strips = [makeStrip('layer-1', 2)];
  const board = createDefaultPatchBoard(strips);

  const patch = addOffPatch(board, 3);
  const expanded = expandPatchBoard(board, strips);

  assert.equal(board.chains[0].rowIds.at(-1), patch.id);
  assert.equal(expanded.pixels.length, 5);
  assert.deepEqual(expanded.pixels.slice(-3).map(px => px.inactive === true), [true, true, true]);
});

test('validation reports non-positive off patch lengths', () => {
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['off'] }],
    groups: [],
    patches: [{
      id: 'off',
      name: 'Bad off block',
      groupId: null,
      source: { type: 'off', ledCount: 0 },
      output: { mode: 'off' },
      playback: {},
    }],
  };

  const warnings = validatePatchBoard(board, []);

  assert.ok(warnings.some(w => w.code === 'off-count-invalid'));
});

test('patch playback inherits group playback and overrides explicit patch values', () => {
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['p1'] }],
    groups: [{
      id: 'outer',
      name: 'Outer',
      patchIds: ['p1'],
      playback: { patternId: 'aurora', speed: 0.75, brightness: 0.8, hueShift: 12, enabled: true },
    }],
    patches: [{
      id: 'p1',
      name: 'Patch',
      groupId: 'outer',
      source: { type: 'strip', stripId: 'layer-1', startLed: 0, endLed: 2 },
      output: { mode: 'normal' },
      playback: { patternId: null, speed: 0.5, brightness: null, hueShift: null, enabled: null },
    }],
  };

  const resolved = resolvePatchPlayback(board.patches[0], board, {
    patternId: 'rainbow',
    speed: 1,
    brightness: 1,
    hueShift: 0,
    enabled: true,
  });

  assert.deepEqual(resolved, {
    patternId: 'aurora',
    speed: 0.5,
    brightness: 0.8,
    hueShift: 12,
    enabled: true,
  });
});

test('locked boards reject physical range edits', () => {
  const board = createDefaultPatchBoard([makeStrip('layer-1', 5)]);
  board.physicalLocked = true;

  assert.throws(
    () => updatePatchRange(board, 'patch-layer-1', 1, 3),
    /unlock setup mode/i,
  );
});

test('range updates reject non-finite LED indexes', () => {
  const board = createDefaultPatchBoard([makeStrip('layer-1', 5)]);

  assert.throws(
    () => updatePatchRange(board, 'patch-layer-1', Number.NaN, 3),
    /finite LED indexes/i,
  );
});

test('validation reports malformed ranges without expanding them', () => {
  const strips = [makeStrip('layer-1', 5)];
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['bad'] }],
    groups: [],
    patches: [{
      id: 'bad',
      name: 'Bad range',
      groupId: null,
      source: { type: 'strip', stripId: 'layer-1', startLed: Infinity, endLed: 3 },
      output: { mode: 'normal' },
      playback: {},
    }],
  };

  const warnings = validatePatchBoard(board, strips);
  const expanded = expandPatchBoard(board, strips);

  assert.ok(warnings.some(w => w.code === 'range-invalid'));
  assert.equal(expanded.pixels.length, 0);
});

test('expansion skips missing LEDs when a saved range is longer than the actual strip', () => {
  const strips = [makeStrip('layer-1', 5)];
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['bad'] }],
    groups: [],
    patches: [{
      id: 'bad',
      name: 'Huge bad range',
      groupId: null,
      source: { type: 'strip', stripId: 'layer-1', startLed: 0, endLed: 50000 },
      output: { mode: 'normal' },
      playback: {},
    }],
  };

  const expanded = expandPatchBoard(board, strips);

  assert.ok(expanded.warnings.some(w => w.code === 'endpoint-out-of-range'));
  assert.deepEqual(expanded.pixels.map(px => px.sourceLed), [0, 1, 2, 3, 4]);
});

test('validation reports stacked ranges and out-of-range endpoints', () => {
  const strips = [makeStrip('layer-1', 5)];
  const board = {
    physicalLocked: false,
    chains: [{ id: 'main', name: 'Main physical strip', rowIds: ['a', 'b', 'bad'] }],
    groups: [],
    patches: [
      {
        id: 'a',
        name: 'A',
        groupId: null,
        source: { type: 'strip', stripId: 'layer-1', startLed: 0, endLed: 2 },
        output: { mode: 'normal' },
        playback: {},
      },
      {
        id: 'b',
        name: 'B',
        groupId: null,
        source: { type: 'strip', stripId: 'layer-1', startLed: 1, endLed: 3 },
        output: { mode: 'normal' },
        playback: {},
      },
      {
        id: 'bad',
        name: 'Bad',
        groupId: null,
        source: { type: 'strip', stripId: 'layer-1', startLed: 6, endLed: 7 },
        output: { mode: 'normal' },
        playback: {},
      },
    ],
  };

  const warnings = validatePatchBoard(board, strips);

  assert.ok(warnings.some(w => w.code === 'overlap'));
  assert.ok(warnings.some(w => w.code === 'endpoint-out-of-range'));
});

// ── Chain-order primitives ───────────────────────────────────────────────

test('chainPixelOffsets accumulates split segments then an off block', () => {
  const stripA = makeStrip('A', 3);
  const stripB = makeStrip('B', 2, 10);
  const strips = [stripA, stripB];
  let board = createDefaultPatchBoard(strips);
  board = sliceStripIntoPatches(board, stripA, [0]); // A -> [0..0], [1..2]
  const off = addOffPatch(board, 4);

  const offsets = chainPixelOffsets(board, strips);
  assert.equal(offsets.get('patch-A-0-0'), 0);
  assert.equal(offsets.get('patch-A-1-2'), 1);
  assert.equal(offsets.get('patch-B'), 3);
  assert.equal(offsets.get(off.id), 5);
});

test('chainPixelOffsets counts an off block ahead of a strip against its address', () => {
  const stripA = makeStrip('A', 3);
  const stripB = makeStrip('B', 2, 10);
  const strips = [stripA, stripB];
  const board = createDefaultPatchBoard(strips);
  const off = addOffPatch(board, 5);
  board.chains[0].rowIds = [off.id, 'patch-A', 'patch-B'];

  const offsets = chainPixelOffsets(board, strips);
  assert.equal(offsets.get(off.id), 0);
  assert.equal(offsets.get('patch-A'), 5);
  assert.equal(offsets.get('patch-B'), 8);
});

test('orderedStripIdsFromChain returns chain order with split strips deduped', () => {
  const stripA = makeStrip('A', 3);
  const stripB = makeStrip('B', 2, 10);
  const strips = [stripA, stripB];
  let board = createDefaultPatchBoard(strips);
  board = sliceStripIntoPatches(board, stripA, [0]); // [A1, A2, patch-B]
  const [a1, a2, b] = board.chains[0].rowIds;
  board.chains[0].rowIds = [b, a1, a2]; // B before A's segments

  assert.deepEqual(orderedStripIdsFromChain(board, strips), ['B', 'A']);
});

test('orderedStripIdsFromChain never drops a strip that lacks a chain row', () => {
  const stripA = makeStrip('A', 3);
  const stripB = makeStrip('B', 2, 10);
  const board = createDefaultPatchBoard([stripA]);

  assert.deepEqual(orderedStripIdsFromChain(board, [stripA, stripB]), ['A', 'B']);
});

test('moveStripRowsInChain moves a split strip as a block after the target, off row pinned', () => {
  const stripA = makeStrip('A', 3);
  const stripB = makeStrip('B', 2, 10);
  const stripC = makeStrip('C', 4, 20);
  const strips = [stripA, stripB, stripC];
  let board = createDefaultPatchBoard(strips);
  board = sliceStripIntoPatches(board, stripA, [0]); // A -> A1, A2
  const off = addOffPatch(board, 2);
  board.chains[0].rowIds = ['patch-A-0-0', 'patch-A-1-2', off.id, 'patch-B', 'patch-C'];

  const next = moveStripRowsInChain(board, ['A'], 'C');

  assert.deepEqual(next.chains[0].rowIds, ['patch-B', 'patch-C', off.id, 'patch-A-0-0', 'patch-A-1-2']);
  // input board is not mutated
  assert.deepEqual(board.chains[0].rowIds, ['patch-A-0-0', 'patch-A-1-2', off.id, 'patch-B', 'patch-C']);
});

test('moveStripRowsInChain is a no-op when dragging onto itself', () => {
  const strips = [makeStrip('A', 2), makeStrip('B', 2, 10)];
  const board = createDefaultPatchBoard(strips);
  const next = moveStripRowsInChain(board, ['A'], 'A');
  assert.deepEqual(next.chains[0].rowIds, ['patch-A', 'patch-B']);
});

test('migrateChainToStripOrder preserves saved order, off row, and split direction', () => {
  const stripA = makeStrip('A', 3);
  const stripB = makeStrip('B', 2, 10);
  const stripC = makeStrip('C', 4, 20);
  const strips = [stripA, stripB, stripC];
  let board = createDefaultPatchBoard(strips);
  board = sliceStripIntoPatches(board, stripA, [0]);
  const off = addOffPatch(board, 3);
  board.chains[0].rowIds = ['patch-C', off.id, 'patch-B', 'patch-A-1-2', 'patch-A-0-0'];

  const next = migrateChainToStripOrder(board, strips);

  assert.deepEqual(next.chains[0].rowIds, ['patch-C', off.id, 'patch-B', 'patch-A-1-2', 'patch-A-0-0']);
});

test('migrateChainToStripOrder is idempotent', () => {
  const stripA = makeStrip('A', 3);
  const stripB = makeStrip('B', 2, 10);
  const strips = [stripA, stripB];
  let board = createDefaultPatchBoard(strips);
  board = sliceStripIntoPatches(board, stripA, [0]);
  board.chains[0].rowIds = ['patch-B', 'patch-A-1-2', 'patch-A-0-0'];

  const once = migrateChainToStripOrder(board, strips);
  const twice = migrateChainToStripOrder(once, strips);

  assert.deepEqual(once.chains[0].rowIds, ['patch-B', 'patch-A-1-2', 'patch-A-0-0']);
  assert.deepEqual(twice.chains[0].rowIds, once.chains[0].rowIds);
});

test('migrateChainToStripOrder preserves an existing saved chain even when physicalLocked', () => {
  const strips = [makeStrip('A', 2), makeStrip('B', 2, 10)];
  const board = createDefaultPatchBoard(strips);
  board.physicalLocked = true;
  board.chains[0].rowIds = ['patch-B', 'patch-A'];

  const next = migrateChainToStripOrder(board, strips);

  assert.deepEqual(next.chains[0].rowIds, ['patch-B', 'patch-A']);
  assert.equal(next.physicalLocked, true);
});

test('inactive address rows advance offsets for later physical runs', () => {
  const strips = [makeStrip('A', 3), makeStrip('B', 2, 10)];
  const board = createDefaultPatchBoard(strips);
  const inactive = addOffPatch(board, 4);
  board.chains[0].rowIds = ['patch-A', inactive.id, 'patch-B'];

  const offsets = chainPixelOffsets(board, strips);

  assert.equal(offsets.get('patch-A'), 0);
  assert.equal(offsets.get(inactive.id), 3);
  assert.equal(offsets.get('patch-B'), 7);
  assert.equal(expandPatchBoard(board, strips).pixels.length, 9);
});
