import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDefaultPatchBoard,
  expandPatchBoard,
  addOffPatch,
  movePatch,
  resolvePatchPlayback,
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
