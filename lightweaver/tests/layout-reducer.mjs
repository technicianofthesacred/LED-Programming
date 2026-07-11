import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLayoutState,
  layoutReducer,
  layoutActions,
  makeLayoutSnapshot,
  applyLayoutSnapshot,
  createLayoutHistory,
  commitLayout,
  undoLayout,
  redoLayout,
  LAYOUT_HISTORY_LIMIT,
} from '../src/state/layoutReducer.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const pixels = (n) => Array.from({ length: n }, (_, i) => ({ x: i, y: 0, index: i }));

const makeStrip = (id, count, extra = {}) => ({
  id,
  name: id,
  pathData: `M0 0 L${count} 0`,
  pixelCount: count,
  pixels: pixels(count),
  sourceLayerId: null,
  sourcePathId: null,
  x: 0,
  y: 0,
  reversed: false,
  ...extra,
});

// A deterministic, DOM-free stand-in for the app's DOM pixel sampler.
const rebuild = (strip) => ({ ...strip, pixels: pixels(strip.pixelCount) });

const stripPayload = (name, count) => ({
  name,
  pathData: `M0 0 L${count} 0`,
  pixelCount: count,
  pixels: pixels(count),
  sourceLayerId: null,
  sourcePathId: null,
});

// ── 1. Snapshot round-trip rebuilds pixels ──────────────────────────────────

test('snapshot drops pixels and applyLayoutSnapshot rebuilds them', () => {
  const state = createLayoutState({ strips: [makeStrip('strip-1', 3), makeStrip('strip-2', 5)] });

  const snap = makeLayoutSnapshot(state);
  // Snapshot carries no pixels and no bulky selection entries.
  assert.ok(snap.strips.every(s => s.pixels === undefined));
  assert.equal(snap.selection.entries, undefined);

  const restored = applyLayoutSnapshot(state, snap, rebuild);
  assert.deepEqual(restored.strips.map(s => s.pixels.length), [3, 5]);
  assert.deepEqual(restored.strips.map(s => s.id), ['strip-1', 'strip-2']);
  assert.equal(restored.strips[0].pixelCount, 3);
});

// ── 2. Undo of a strip edit restores the prior selection ────────────────────

test('undo of a strip add restores the selection that was active before it', () => {
  let state = createLayoutState({ strips: [makeStrip('strip-1', 4)] });
  let history = createLayoutHistory();

  // Select strip-1 (a selection-only action: no undo entry).
  state = layoutReducer(state, layoutActions.selectStrip('strip-1'));
  assert.deepEqual(state.selection.ids, ['strip-1']);

  // Add a strip (undoable). This selects the freshly created strip.
  ({ history, state } = commitLayout(history, state, layoutActions.addStrip(stripPayload('B', 2))));
  assert.equal(state.strips.length, 2);
  assert.equal(state.selection.kind, 'strip');
  assert.deepEqual(state.selection.ids, ['strip-2']);
  assert.equal(history.past.length, 1);

  // Undo restores both the strips AND the pre-add selection.
  ({ history, state } = undoLayout(history, state, rebuild));
  assert.equal(state.strips.length, 1);
  assert.deepEqual(state.selection.ids, ['strip-1']);

  // Redo returns to the added strip + its selection.
  ({ history, state } = redoLayout(history, state, rebuild));
  assert.equal(state.strips.length, 2);
  assert.deepEqual(state.selection.ids, ['strip-2']);
});

// ── 3. Interleaved strip + patch-board edits undo in order ──────────────────

test('interleaved strip and patch-board edits undo in LIFO order', () => {
  let state = createLayoutState({ strips: [makeStrip('strip-1', 4)] });
  let history = createLayoutHistory();
  const boardV0 = state.patchBoard;

  // Edit 1: add a strip.
  ({ history, state } = commitLayout(history, state, layoutActions.addStrip(stripPayload('B', 2))));
  const boardAfterAdd = state.patchBoard;
  assert.equal(state.strips.length, 2);

  // Edit 2: replace the patch board (a marked copy so we can see it revert).
  const markedBoard = { ...state.patchBoard, marker: 'v2' };
  ({ history, state } = commitLayout(history, state, layoutActions.setPatchBoard(markedBoard)));
  assert.equal(state.patchBoard.marker, 'v2');
  assert.equal(history.past.length, 2);

  // First undo reverts ONLY the patch-board edit; the added strip stays.
  ({ history, state } = undoLayout(history, state, rebuild));
  assert.equal(state.patchBoard.marker, undefined);
  assert.equal(state.patchBoard, boardAfterAdd);
  assert.equal(state.strips.length, 2);

  // Second undo reverts the strip add.
  ({ history, state } = undoLayout(history, state, rebuild));
  assert.equal(state.strips.length, 1);
  assert.equal(state.patchBoard, boardV0);
  assert.equal(history.past.length, 0);
});

// ── 4. History is bounded at 50 ─────────────────────────────────────────────

test('history is bounded at LAYOUT_HISTORY_LIMIT (50)', () => {
  assert.equal(LAYOUT_HISTORY_LIMIT, 50);
  let state = createLayoutState({ strips: [makeStrip('strip-1', 2)] });
  let history = createLayoutHistory();

  for (let i = 0; i < 60; i += 1) {
    ({ history, state } = commitLayout(
      history, state, layoutActions.updateStrip('strip-1', { name: `n${i}` }),
    ));
  }
  assert.equal(history.past.length, 50);
  assert.equal(state.strips[0].name, 'n59');

  // Selection-only actions never grow history.
  const before = history.past.length;
  ({ history, state } = commitLayout(history, state, layoutActions.selectStrip('strip-1')));
  assert.equal(history.past.length, before);
});

// ── 5. Selection actions clear each other correctly ─────────────────────────

test('selection actions replace and clear each other', () => {
  let state = createLayoutState({ strips: [makeStrip('strip-1', 2)] });

  state = layoutReducer(state, layoutActions.selectStrip('strip-1'));
  assert.equal(state.selection.kind, 'strip');
  assert.deepEqual(state.selection.ids, ['strip-1']);

  state = layoutReducer(state, layoutActions.selectLayer('layer-1'));
  assert.equal(state.selection.kind, 'layer');
  assert.deepEqual(state.selection.ids, ['layer-1']);

  state = layoutReducer(state, layoutActions.selectPaths([
    { pathId: 'p1', name: 'P1' },
    { pathId: 'p2', name: 'P2' },
  ]));
  assert.equal(state.selection.kind, 'path');
  assert.deepEqual(state.selection.ids, ['p1', 'p2']);
  assert.equal(state.selection.entries.length, 2);

  // Toggling a path off shrinks the selection.
  state = layoutReducer(state, layoutActions.togglePath({ pathId: 'p1', name: 'P1' }));
  assert.deepEqual(state.selection.ids, ['p2']);
  assert.equal(state.selection.name, 'P2'); // single remaining path auto-names

  state = layoutReducer(state, layoutActions.clearSelection());
  assert.equal(state.selection.kind, 'none');
  assert.deepEqual(state.selection.ids, []);

  // Toggling a strip from an empty selection starts a fresh strip selection.
  state = layoutReducer(state, layoutActions.toggleStrip('strip-1'));
  assert.equal(state.selection.kind, 'strip');
  assert.deepEqual(state.selection.ids, ['strip-1']);

  // Renaming the selection buffer leaves the kind/ids intact.
  state = layoutReducer(state, layoutActions.renameSelection('My group'));
  assert.equal(state.selection.kind, 'strip');
  assert.equal(state.selection.name, 'My group');
});
