# Patch Board Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working Patch Board slice: a saved physical chain made from reorderable patches, partial LED ranges, reverse ranges, off blocks, and export integration.

**Architecture:** Put Patch Board behavior in a pure model module first, then connect it to the existing vanilla Vite app. The first UI should be functional and testable with buttons and inputs rather than polished drag-and-drop. Canvas handles, verification mode, power budgeting, patch presets, and performance mode become follow-up plans once this foundation is green.

**Tech Stack:** Vanilla JavaScript modules, Vite, Node `node:test`, Playwright e2e tests, existing SVG path sampling and export modules.

---

## Critical Scope Split

Do not implement the full spec in one branch. The approved design covers several subsystems:

1. Patch Board physical model and export.
2. Patch Board UI for split, reorder, reverse, and off blocks.
3. Canvas handles and stacked LED badges.
4. Group playback inheritance.
5. Hardware Verification Mode.
6. Preflight, power budget, patch presets, and Performance Mode.

This plan implements items 1 and 2, plus the persistence needed to keep the feature usable. The later items need separate plans because each can be tested and shipped independently.

## File Structure

- Create: `led-art-mapper/app/src/patchBoard.js`
  - Pure data model for Patch Board creation, expansion, validation, and row updates.
  - No DOM access.
  - No SVG APIs.

- Create: `led-art-mapper/app/src/patchBoard.test.js`
  - Node unit tests for model behavior.
  - Uses fake strips with precomputed pixels, so tests do not need a browser.

- Modify: `led-art-mapper/app/package.json`
  - Add `test:unit` script with Node's built-in test runner.

- Modify: `led-art-mapper/app/src/main.js`
  - Add `state.patchBoard`.
  - Initialize default Patch Board from strips.
  - Persist Patch Board in project save/load and local autosave.
  - Expand Patch Board for export.
  - Render a minimal Patch Board panel and actions.

- Modify: `led-art-mapper/app/index.html`
  - Add a Patch Board tab button and side-panel content section.

- Modify: `led-art-mapper/app/styles.css`
  - Add compact product-style Patch Board row styling.

- Create: `e2e/patch-board.spec.ts`
  - End-to-end coverage for visible Patch Board controls, splitting, reversing, moving, off blocks, and export order.

---

## Program Roadmap After This Plan

Write these as separate plans after this foundation passes:

1. **Patch Board Canvas Handles:** draggable start/end handles, snapped LED indexes, stacked badges.
2. **Groups And Playback Inheritance:** group controls, patch overrides, resolved playback in render loop.
3. **Verification Mode:** physical address chase, WLED/live push integration, quick correction actions.
4. **Preflight And Power Budget:** validation panel, power estimates, export warnings.
5. **Performance Mode And Presets:** operator live view and fast patch-generation actions.

---

### Task 1: Add Unit Test Runner And Failing Patch Board Expansion Tests

**Files:**
- Modify: `led-art-mapper/app/package.json`
- Create: `led-art-mapper/app/src/patchBoard.test.js`

- [ ] **Step 1: Add the unit test script**

Modify `led-art-mapper/app/package.json` scripts to include `test:unit`:

```json
{
  "scripts": {
    "dev": "pkill -f 'vite' 2>/dev/null; sleep 0.3 && vite --port 9999",
    "build": "vite build",
    "preview": "vite preview",
    "test:unit": "node --test src/*.test.js"
  }
}
```

- [ ] **Step 2: Write the failing model tests**

Create `led-art-mapper/app/src/patchBoard.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDefaultPatchBoard,
  expandPatchBoard,
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
```

- [ ] **Step 3: Run the unit tests to verify they fail**

Run:

```bash
cd led-art-mapper/app
npm run test:unit
```

Expected: FAIL with an error equivalent to:

```text
Cannot find module './patchBoard.js'
```

- [ ] **Step 4: Commit the failing tests**

```bash
git add led-art-mapper/app/package.json led-art-mapper/app/src/patchBoard.test.js
git commit -m "test: add patch board model coverage"
```

---

### Task 2: Implement Pure Patch Board Model

**Files:**
- Create: `led-art-mapper/app/src/patchBoard.js`
- Test: `led-art-mapper/app/src/patchBoard.test.js`

- [ ] **Step 1: Create the pure model implementation**

Create `led-art-mapper/app/src/patchBoard.js`:

```js
const DEFAULT_CHAIN_ID = 'main';

export const DEFAULT_PLAYBACK = Object.freeze({
  patternId: null,
  speed: 1,
  brightness: 1,
  hueShift: 0,
  enabled: true,
});

const patchIdForStrip = strip => `patch-${strip.id}`;

const clone = value => JSON.parse(JSON.stringify(value));

const byId = items => new Map((items || []).map(item => [item.id, item]));

const numberOr = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function createDefaultPatchBoard(strips = []) {
  const patches = strips.map(strip => ({
    id: patchIdForStrip(strip),
    name: strip.name || strip.id,
    groupId: null,
    source: {
      type: 'strip',
      stripId: strip.id,
      startLed: 0,
      endLed: Math.max(0, (strip.pixelCount ?? strip.pixels?.length ?? 1) - 1),
    },
    output: { mode: strip.visible === false ? 'off' : 'normal' },
    playback: {
      patternId: null,
      speed: strip.speed ?? null,
      brightness: strip.brightness ?? null,
      hueShift: strip.hueShift ?? null,
      enabled: strip.visible === false ? false : null,
    },
  }));

  return {
    physicalLocked: false,
    chains: [{
      id: DEFAULT_CHAIN_ID,
      name: 'Main physical strip',
      rowIds: patches.map(patch => patch.id),
    }],
    groups: [],
    patches,
  };
}

export function normalizePatchBoard(board, strips = []) {
  if (!board || !Array.isArray(board.patches) || !Array.isArray(board.chains)) {
    return createDefaultPatchBoard(strips);
  }

  const copy = clone(board);
  copy.physicalLocked = copy.physicalLocked === true;
  copy.groups = Array.isArray(copy.groups) ? copy.groups : [];
  copy.patches = Array.isArray(copy.patches) ? copy.patches : [];
  copy.chains = copy.chains.length
    ? copy.chains.map(chain => ({
        id: chain.id || DEFAULT_CHAIN_ID,
        name: chain.name || 'Main physical strip',
        rowIds: Array.isArray(chain.rowIds) ? chain.rowIds : [],
      }))
    : [{ id: DEFAULT_CHAIN_ID, name: 'Main physical strip', rowIds: copy.patches.map(p => p.id) }];

  return copy;
}

export function mainChain(board) {
  return normalizePatchBoard(board).chains[0];
}

export function resolvePatchPlayback(patch, board, globalPlayback = DEFAULT_PLAYBACK) {
  const groupsById = byId(board.groups);
  const group = patch.groupId ? groupsById.get(patch.groupId) : null;
  const groupPlayback = group?.playback || {};
  const patchPlayback = patch.playback || {};

  return {
    patternId: patchPlayback.patternId ?? groupPlayback.patternId ?? globalPlayback.patternId ?? DEFAULT_PLAYBACK.patternId,
    speed: patchPlayback.speed ?? groupPlayback.speed ?? globalPlayback.speed ?? DEFAULT_PLAYBACK.speed,
    brightness: patchPlayback.brightness ?? groupPlayback.brightness ?? globalPlayback.brightness ?? DEFAULT_PLAYBACK.brightness,
    hueShift: patchPlayback.hueShift ?? groupPlayback.hueShift ?? globalPlayback.hueShift ?? DEFAULT_PLAYBACK.hueShift,
    enabled: patchPlayback.enabled ?? groupPlayback.enabled ?? globalPlayback.enabled ?? DEFAULT_PLAYBACK.enabled,
  };
}

function sourceLedRange(startLed, endLed) {
  const start = Math.trunc(startLed);
  const end = Math.trunc(endLed);
  const step = start <= end ? 1 : -1;
  const values = [];
  for (let led = start; step > 0 ? led <= end : led >= end; led += step) {
    values.push(led);
  }
  return values;
}

function expandStripPatch(patch, strip, startIndex, resolvedPlayback) {
  const pixels = [];
  const range = sourceLedRange(patch.source.startLed, patch.source.endLed);
  for (const sourceLed of range) {
    const sourcePixel = strip.pixels?.[sourceLed];
    if (!sourcePixel) continue;
    const inactive = patch.output?.mode === 'off' || resolvedPlayback.enabled === false;
    pixels.push({
      ...sourcePixel,
      x: sourcePixel.x + (strip.offsetX || 0),
      y: sourcePixel.y + (strip.offsetY || 0),
      index: startIndex + pixels.length,
      patchId: patch.id,
      patchName: patch.name,
      stripId: strip.id,
      sourceLed,
      inactive,
      playback: resolvedPlayback,
    });
  }
  return pixels;
}

function expandOffPatch(patch, startIndex) {
  const count = Math.max(0, Math.trunc(numberOr(patch.source?.ledCount, 0)));
  return Array.from({ length: count }, (_, offset) => ({
    x: 0,
    y: 0,
    index: startIndex + offset,
    patchId: patch.id,
    patchName: patch.name,
    stripId: null,
    sourceLed: null,
    inactive: true,
    playback: { ...DEFAULT_PLAYBACK, enabled: false },
  }));
}

export function expandPatchBoard(board, strips = [], globalPlayback = DEFAULT_PLAYBACK) {
  const normalized = normalizePatchBoard(board, strips);
  const patchesById = byId(normalized.patches);
  const stripsById = byId(strips);
  const chain = mainChain(normalized);
  const pixels = [];
  const rows = [];
  const warnings = validatePatchBoard(normalized, strips);

  for (const rowId of chain.rowIds) {
    const patch = patchesById.get(rowId);
    if (!patch) continue;

    let rowPixels = [];
    if (patch.source?.type === 'off') {
      rowPixels = expandOffPatch(patch, pixels.length);
    } else if (patch.source?.type === 'strip') {
      const strip = stripsById.get(patch.source.stripId);
      if (strip) {
        const playback = resolvePatchPlayback(patch, normalized, globalPlayback);
        rowPixels = expandStripPatch(patch, strip, pixels.length, playback);
      }
    }

    rows.push({ patchId: patch.id, startIndex: pixels.length, count: rowPixels.length });
    pixels.push(...rowPixels);
  }

  pixels.forEach((pixel, index) => {
    pixel.index = index;
  });

  return { pixels, rows, warnings };
}

export function updatePatchRange(board, patchId, startLed, endLed) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch ranges.');
  }
  const patch = board.patches.find(p => p.id === patchId);
  if (!patch || patch.source?.type !== 'strip') return board;
  patch.source.startLed = Math.trunc(startLed);
  patch.source.endLed = Math.trunc(endLed);
  return board;
}

export function movePatch(board, patchId, direction) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch order.');
  }
  const chain = mainChain(board);
  const index = chain.rowIds.indexOf(patchId);
  if (index < 0) return board;
  const next = direction === 'up' ? index - 1 : index + 1;
  if (next < 0 || next >= chain.rowIds.length) return board;
  const [id] = chain.rowIds.splice(index, 1);
  chain.rowIds.splice(next, 0, id);
  return board;
}

export function addOffPatch(board, ledCount = 1) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch order.');
  }
  const id = `off-${Date.now().toString(36)}`;
  const patch = {
    id,
    name: `Off ${Math.max(1, Math.trunc(ledCount))} LEDs`,
    groupId: null,
    source: { type: 'off', ledCount: Math.max(1, Math.trunc(ledCount)) },
    output: { mode: 'off' },
    playback: {},
  };
  board.patches.push(patch);
  mainChain(board).rowIds.push(id);
  return patch;
}

export function validatePatchBoard(board, strips = []) {
  const normalized = normalizePatchBoard(board, strips);
  const stripsById = byId(strips);
  const warnings = [];
  const seenSourceLeds = new Set();

  if (!normalized.physicalLocked) {
    warnings.push({
      code: 'physical-map-unlocked',
      message: 'Physical map is unlocked, so setup edits can still change exported LED addresses.',
    });
  }

  for (const patch of normalized.patches) {
    if (patch.source?.type === 'off') {
      warnings.push({
        code: 'off-block',
        patchId: patch.id,
        message: `${patch.name} reserves ${patch.source.ledCount} LED addresses and outputs black in Lightweaver live output.`,
      });
      continue;
    }

    if (patch.source?.type !== 'strip') continue;
    const strip = stripsById.get(patch.source.stripId);
    if (!strip) {
      warnings.push({
        code: 'missing-source',
        patchId: patch.id,
        message: `${patch.name} references a missing source strip.`,
      });
      continue;
    }

    const maxLed = (strip.pixels?.length ?? strip.pixelCount ?? 0) - 1;
    if (patch.source.startLed < 0 || patch.source.endLed < 0 || patch.source.startLed > maxLed || patch.source.endLed > maxLed) {
      warnings.push({
        code: 'endpoint-out-of-range',
        patchId: patch.id,
        message: `${patch.name} uses LEDs ${patch.source.startLed}-${patch.source.endLed}, but ${strip.name || strip.id} has LEDs 0-${maxLed}.`,
      });
      continue;
    }

    for (const led of sourceLedRange(patch.source.startLed, patch.source.endLed)) {
      const key = `${patch.source.stripId}:${led}`;
      if (seenSourceLeds.has(key)) {
        warnings.push({
          code: 'overlap',
          patchId: patch.id,
          message: `${patch.name} reuses ${patch.source.stripId} LED ${led}, so that coordinate will be stacked in export.`,
        });
        break;
      }
      seenSourceLeds.add(key);
    }
  }

  return warnings;
}
```

- [ ] **Step 2: Run the unit tests and verify they pass**

Run:

```bash
cd led-art-mapper/app
npm run test:unit
```

Expected: PASS for all tests in `patchBoard.test.js`.

- [ ] **Step 3: Commit the pure model**

```bash
git add led-art-mapper/app/src/patchBoard.js
git commit -m "feat: add patch board model"
```

---

### Task 3: Persist Patch Board In Project Save, Load, And Autosave

**Files:**
- Modify: `led-art-mapper/app/src/main.js`
- Test: `led-art-mapper/app/src/patchBoard.test.js`

- [ ] **Step 1: Write failing persistence tests for normalization**

Add this test to `led-art-mapper/app/src/patchBoard.test.js`:

```js
import { normalizePatchBoard } from './patchBoard.js';

test('normalizePatchBoard migrates missing boards to default patches', () => {
  const strips = [makeStrip('layer-1', 2)];
  const board = normalizePatchBoard(null, strips);

  assert.deepEqual(board.chains[0].rowIds, ['patch-layer-1']);
  assert.equal(board.patches[0].source.stripId, 'layer-1');
});
```

- [ ] **Step 2: Run the new test and verify it passes**

Run:

```bash
cd led-art-mapper/app
npm run test:unit
```

Expected: PASS.

- [ ] **Step 3: Import Patch Board helpers in `main.js`**

Modify the imports near the top of `led-art-mapper/app/src/main.js`:

```js
import {
  addOffPatch,
  createDefaultPatchBoard,
  expandPatchBoard,
  movePatch,
  normalizePatchBoard,
  updatePatchRange,
  validatePatchBoard,
} from './patchBoard.js';
```

- [ ] **Step 4: Add Patch Board state**

Add this property to the `state` object:

```js
patchBoard: null,
```

- [ ] **Step 5: Add state helpers**

Add these helpers near the existing strip sampling helpers:

```js
function _ensurePatchBoard() {
  state.patchBoard = normalizePatchBoard(state.patchBoard, state.strips);
  return state.patchBoard;
}

function _resetPatchBoardFromStrips() {
  state.patchBoard = createDefaultPatchBoard(state.strips);
  return state.patchBoard;
}

function _expandedPatchPixels() {
  const board = _ensurePatchBoard();
  return expandPatchBoard(board, state.strips, {
    patternId: state.activePatternId,
    speed: state.masterSpeed,
    brightness: state.masterBrightness,
    hueShift: 0,
    enabled: true,
  });
}
```

- [ ] **Step 6: Save Patch Board in project downloads**

In `saveProject()`, add this field to the saved `data` object:

```js
patchBoard: _ensurePatchBoard(),
```

- [ ] **Step 7: Restore Patch Board during project load**

In `loadProject(file)`, after strips are restored and before `_rebuildNorm()`, add:

```js
state.patchBoard = normalizePatchBoard(data.patchBoard, state.strips);
```

- [ ] **Step 8: Save Patch Board in local autosave**

In `_lsSave()`, add:

```js
patchBoard: _ensurePatchBoard(),
```

- [ ] **Step 9: Restore Patch Board from local autosave**

In `_lsRestore()`, after strips are restored and before `_rebuildNorm()`, add:

```js
state.patchBoard = normalizePatchBoard(data.patchBoard, state.strips);
```

- [ ] **Step 10: Initialize a default board after import and quick strip creation**

Where new strips are added from imports or quick-strip helpers, call:

```js
_resetPatchBoardFromStrips();
renderPatchBoard();
```

Use this rule: when the user creates a new physical map from imported artwork, reset the default Patch Board. When loading an existing project, preserve `data.patchBoard`.

- [ ] **Step 11: Run unit tests and build**

Run:

```bash
cd led-art-mapper/app
npm run test:unit
npm run build
```

Expected: both commands pass.

- [ ] **Step 12: Commit persistence work**

```bash
git add led-art-mapper/app/src/main.js led-art-mapper/app/src/patchBoard.test.js
git commit -m "feat: persist patch board state"
```

---

### Task 4: Use Patch Board Expansion For Export

**Files:**
- Modify: `led-art-mapper/app/src/main.js`
- Test: `e2e/patch-board.spec.ts`

- [ ] **Step 1: Write failing e2e export-order test**

Create `e2e/patch-board.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

const SIMPLE_SVG = 'e2e/fixtures/simple-layers.svg';

test('patch board reorder changes WLED export order', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.locator('input#file-input').setInputFiles(SIMPLE_SVG);

  await expect(page.locator('#artwork-layers-list .alr-row.alr-layer')).toHaveCount(3, {
    timeout: 5000,
  });

  await page.getByRole('button', { name: 'Patch Board' }).click();
  const rows = page.locator('.patch-row');
  await expect(rows).toHaveCount(3);

  const firstBefore = await rows.nth(0).getAttribute('data-patch-id');
  await rows.nth(1).getByRole('button', { name: 'Move up' }).click();
  const firstAfter = await rows.nth(0).getAttribute('data-patch-id');
  expect(firstAfter).not.toBe(firstBefore);

  await page.getByRole('button', { name: 'Export' }).click();
  const previewText = await page.locator('#export-preview').innerText();
  const exported = JSON.parse(previewText);

  expect(exported.n).toBeGreaterThan(0);
  expect(Array.isArray(exported.map[0])).toBe(true);
});
```

- [ ] **Step 2: Run the new e2e test and verify it fails**

Run:

```bash
npm test -- e2e/patch-board.spec.ts --project=chromium
```

Expected: FAIL because the Patch Board tab and `.patch-row` UI do not exist yet.

- [ ] **Step 3: Add an export helper in `main.js`**

Add:

```js
function _exportPixels() {
  const expanded = _expandedPatchPixels();
  const hasPatchBoardPixels = expanded.pixels.length > 0;
  return hasPatchBoardPixels ? expanded.pixels : _allWorldPixels();
}
```

- [ ] **Step 4: Update export preview and export buttons**

Replace export pixel sources in `refreshExportPreview()` and export button handlers:

```js
const pixels = _exportPixels();
```

Use that for:

```js
toWLEDLedmap(pixels, _exportOpts())
toFastLED(pixels, _exportOpts())
toCSV(pixels)
```

- [ ] **Step 5: Keep inactive pixels in export but explain limitation**

In `refreshExportPreview()`, after setting preview content, render any warnings from `_expandedPatchPixels().warnings` into a `#patch-board-warnings` element added in Task 5. If the element does not exist yet, skip rendering:

```js
function renderPatchBoardWarnings() {
  const el = document.getElementById('patch-board-warnings');
  if (!el) return;
  const warnings = validatePatchBoard(_ensurePatchBoard(), state.strips);
  el.innerHTML = warnings.length
    ? warnings.map(w => `<div class="pb-warning">${w.message}</div>`).join('')
    : '<div class="pb-ok">Patch Board ready</div>';
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
cd led-art-mapper/app
npm run test:unit
npm run build
cd ../..
npm test -- e2e/patch-board.spec.ts --project=chromium
```

Expected: unit and build pass. E2E still fails until Task 5 adds UI.

- [ ] **Step 7: Commit export integration**

```bash
git add led-art-mapper/app/src/main.js e2e/patch-board.spec.ts
git commit -m "feat: export patch board order"
```

---

### Task 5: Add Minimal Patch Board UI

**Files:**
- Modify: `led-art-mapper/app/index.html`
- Modify: `led-art-mapper/app/styles.css`
- Modify: `led-art-mapper/app/src/main.js`
- Test: `e2e/patch-board.spec.ts`

- [ ] **Step 1: Add the Patch Board tab markup**

In `led-art-mapper/app/index.html`, add a mode button next to the existing layout/pattern/export buttons:

```html
<button class="mode-btn" data-mode="patch">Patch Board</button>
```

Add a side-panel tab section:

```html
<div id="tab-patch" class="tab-content">
  <section class="panel-section" id="patch-board-section">
    <div class="section-header">
      <h3>Patch Board</h3>
      <button id="patch-lock-btn" class="btn-small" type="button">Lock physical map</button>
    </div>
    <div class="patch-actions">
      <button id="patch-reset-btn" type="button">Reset from layers</button>
      <button id="patch-add-off-btn" type="button">Add off block</button>
    </div>
    <div id="patch-board-warnings" class="patch-board-warnings"></div>
    <ol id="patch-board-list" class="patch-board-list"></ol>
  </section>
</div>
```

- [ ] **Step 2: Add compact Patch Board styles**

In `led-art-mapper/app/styles.css`, add:

```css
.patch-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin: 8px 0;
}

.patch-board-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.patch-row {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-2);
  padding: 7px;
  display: grid;
  gap: 6px;
}

.patch-row-top,
.patch-row-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.patch-row-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.patch-range-input {
  width: 48px;
}

.patch-board-warnings {
  display: grid;
  gap: 4px;
  margin: 6px 0;
}

.pb-warning {
  color: var(--warn);
  font-size: 11px;
}

.pb-ok {
  color: var(--dim);
  font-size: 11px;
}
```

- [ ] **Step 3: Add `renderPatchBoard()` in `main.js`**

Add:

```js
function renderPatchBoard() {
  const list = document.getElementById('patch-board-list');
  if (!list) return;

  const board = _ensurePatchBoard();
  const chain = board.chains[0];
  const patchById = new Map(board.patches.map(patch => [patch.id, patch]));
  list.innerHTML = '';

  chain.rowIds.forEach((patchId, rowIndex) => {
    const patch = patchById.get(patchId);
    if (!patch) return;

    const li = document.createElement('li');
    li.className = 'patch-row';
    li.dataset.patchId = patch.id;

    const isOff = patch.source?.type === 'off';
    const rangeHtml = isOff
      ? `<span>${patch.source.ledCount} LEDs off</span>`
      : `
        <label>Start <input class="patch-range-input patch-start" type="number" value="${patch.source.startLed}" /></label>
        <label>End <input class="patch-range-input patch-end" type="number" value="${patch.source.endLed}" /></label>
      `;

    li.innerHTML = `
      <div class="patch-row-top">
        <button type="button" class="patch-move-up" aria-label="Move up"${rowIndex === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="patch-move-down" aria-label="Move down"${rowIndex === chain.rowIds.length - 1 ? ' disabled' : ''}>↓</button>
        <strong class="patch-row-title">${patch.name}</strong>
        <button type="button" class="patch-reverse" aria-label="Reverse patch"${isOff ? ' disabled' : ''}>⇄</button>
      </div>
      <div class="patch-row-controls">
        ${rangeHtml}
        <label>Speed <input class="patch-speed" type="number" min="0" max="8" step="0.05" value="${patch.playback?.speed ?? ''}" placeholder="inherit" /></label>
      </div>
    `;

    li.querySelector('.patch-move-up')?.addEventListener('click', () => {
      _pushHistory();
      movePatch(board, patch.id, 'up');
      renderPatchBoard();
      refreshExportPreview();
      _markDirty();
    });

    li.querySelector('.patch-move-down')?.addEventListener('click', () => {
      _pushHistory();
      movePatch(board, patch.id, 'down');
      renderPatchBoard();
      refreshExportPreview();
      _markDirty();
    });

    li.querySelector('.patch-reverse')?.addEventListener('click', () => {
      if (patch.source?.type !== 'strip') return;
      _pushHistory();
      updatePatchRange(board, patch.id, patch.source.endLed, patch.source.startLed);
      renderPatchBoard();
      refreshExportPreview();
      _markDirty();
    });

    li.querySelector('.patch-start')?.addEventListener('change', e => {
      _pushHistory();
      updatePatchRange(board, patch.id, parseInt(e.target.value, 10), patch.source.endLed);
      renderPatchBoard();
      refreshExportPreview();
      _markDirty();
    });

    li.querySelector('.patch-end')?.addEventListener('change', e => {
      _pushHistory();
      updatePatchRange(board, patch.id, patch.source.startLed, parseInt(e.target.value, 10));
      renderPatchBoard();
      refreshExportPreview();
      _markDirty();
    });

    li.querySelector('.patch-speed')?.addEventListener('change', e => {
      _pushHistory();
      const value = parseFloat(e.target.value);
      patch.playback = patch.playback || {};
      patch.playback.speed = Number.isFinite(value) ? value : null;
      renderPatchBoard();
      _markDirty();
    });

    list.appendChild(li);
  });

  const lockBtn = document.getElementById('patch-lock-btn');
  if (lockBtn) {
    lockBtn.textContent = board.physicalLocked ? 'Unlock physical map' : 'Lock physical map';
  }
  renderPatchBoardWarnings();
}
```

- [ ] **Step 4: Wire Patch Board buttons**

Add near the existing event wiring:

```js
document.getElementById('patch-reset-btn')?.addEventListener('click', async () => {
  if (!await showConfirm('Reset Patch Board from current layers? This replaces custom patch order.')) return;
  _pushHistory();
  _resetPatchBoardFromStrips();
  renderPatchBoard();
  refreshExportPreview();
  _markDirty();
});

document.getElementById('patch-add-off-btn')?.addEventListener('click', async () => {
  const raw = await showPrompt('How many LEDs should this off block reserve?', '1');
  const count = parseInt(raw, 10);
  if (!Number.isFinite(count) || count < 1) return;
  _pushHistory();
  addOffPatch(_ensurePatchBoard(), count);
  renderPatchBoard();
  refreshExportPreview();
  _markDirty();
});

document.getElementById('patch-lock-btn')?.addEventListener('click', () => {
  _pushHistory();
  const board = _ensurePatchBoard();
  board.physicalLocked = !board.physicalLocked;
  renderPatchBoard();
  _markDirty();
});
```

- [ ] **Step 5: Include the tab in mode switching**

Update the mode maps:

```js
const tabToMode = { strips: 'layout', patch: 'patch', pattern: 'pattern', export: 'export', flash: 'flash' };
const modeToTab = { layout: 'strips', patch: 'patch', pattern: 'pattern', export: 'export', flash: 'flash' };
```

When switching into `patch` mode, call:

```js
renderPatchBoard();
```

- [ ] **Step 6: Render Patch Board after strip list refreshes**

After calls that rebuild strip lists following import/load/delete, add:

```js
renderPatchBoard();
```

If this causes too many renders, keep it only in import, load, restore, and Patch Board event handlers.

- [ ] **Step 7: Run all checks**

Run:

```bash
cd led-art-mapper/app
npm run test:unit
npm run build
cd ../..
npm test -- e2e/patch-board.spec.ts --project=chromium
```

Expected: all pass.

- [ ] **Step 8: Commit minimal UI**

```bash
git add led-art-mapper/app/index.html led-art-mapper/app/styles.css led-art-mapper/app/src/main.js e2e/patch-board.spec.ts
git commit -m "feat: add patch board foundation UI"
```

---

### Task 6: Add Split And Off-Block E2E Coverage

**Files:**
- Modify: `e2e/patch-board.spec.ts`
- Modify: `led-art-mapper/app/src/main.js`

- [ ] **Step 1: Add a failing split-range e2e test**

Append to `e2e/patch-board.spec.ts`:

```ts
test('patch board range edits and reverse controls update row state', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.locator('input#file-input').setInputFiles(SIMPLE_SVG);

  await page.getByRole('button', { name: 'Patch Board' }).click();
  const firstRow = page.locator('.patch-row').first();
  await firstRow.locator('.patch-start').fill('2');
  await firstRow.locator('.patch-start').blur();
  await firstRow.locator('.patch-end').fill('10');
  await firstRow.locator('.patch-end').blur();

  await expect(firstRow.locator('.patch-start')).toHaveValue('2');
  await expect(firstRow.locator('.patch-end')).toHaveValue('10');

  await firstRow.getByRole('button', { name: 'Reverse patch' }).click();
  await expect(firstRow.locator('.patch-start')).toHaveValue('10');
  await expect(firstRow.locator('.patch-end')).toHaveValue('2');
});
```

- [ ] **Step 2: Add a failing off-block e2e test**

Append:

```ts
test('patch board off block reserves physical addresses in export', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.locator('input#file-input').setInputFiles(SIMPLE_SVG);

  await page.getByRole('button', { name: 'Patch Board' }).click();
  const before = await page.locator('.patch-row').count();

  page.on('dialog', dialog => dialog.accept('3'));
  await page.getByRole('button', { name: 'Add off block' }).click();
  await expect(page.locator('.patch-row')).toHaveCount(before + 1);

  await page.getByRole('button', { name: 'Export' }).click();
  const exported = JSON.parse(await page.locator('#export-preview').innerText());
  expect(exported.n).toBeGreaterThan(3);
});
```

If the custom prompt helper is not a browser `dialog`, replace the dialog handler with selectors for `#prompt-input` and `#prompt-ok`.

- [ ] **Step 3: Run e2e and verify failures**

Run:

```bash
npm test -- e2e/patch-board.spec.ts --project=chromium
```

Expected: FAIL only where the current UI event behavior does not yet update values or off block prompt handling.

- [ ] **Step 4: Fix range inputs to re-render after blur/change**

If the range e2e sees stale DOM, update the event handlers in `renderPatchBoard()` to set input values before re-render:

```js
const start = parseInt(e.target.value, 10);
if (Number.isFinite(start)) {
  updatePatchRange(board, patch.id, start, patch.source.endLed);
}
```

Use the same guard for end values.

- [ ] **Step 5: Fix off block prompt test path**

If `showPrompt()` renders the custom overlay, update the e2e test to:

```ts
await page.getByRole('button', { name: 'Add off block' }).click();
await page.locator('#prompt-input').fill('3');
await page.locator('#prompt-ok').click();
```

- [ ] **Step 6: Run checks**

Run:

```bash
cd led-art-mapper/app
npm run test:unit
npm run build
cd ../..
npm test -- e2e/patch-board.spec.ts --project=chromium
```

Expected: all pass.

- [ ] **Step 7: Commit coverage fixes**

```bash
git add e2e/patch-board.spec.ts led-art-mapper/app/src/main.js
git commit -m "test: cover patch board editing flow"
```

---

## Completion Criteria

The foundation is complete when:

- `npm run test:unit` passes in `led-art-mapper/app`.
- `npm run build` passes in `led-art-mapper/app`.
- `npm test -- e2e/patch-board.spec.ts --project=chromium` passes at repo root.
- A user can import layers, open Patch Board, reorder rows, reverse a patch, set a range, add an off block, export WLED JSON, save a project, and reload it with the Patch Board intact.
- Existing import and section-drag tests still pass or any failures are understood and fixed.

Final verification command:

```bash
cd led-art-mapper/app
npm run test:unit
npm run build
cd ../..
npm test -- --project=chromium
```
