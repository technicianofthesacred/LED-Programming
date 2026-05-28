# Wire Path UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the number-heavy embedded physical mapping panel with a visual Wire Path workflow for selecting source paths, clicking cut marks, seeing segments, and keeping numbers in Advanced.

**Architecture:** Keep `patchBoard` as the saved/exported data model. Add a pure slicing helper in `lightweaver/src/lib/patchBoard.js`, then rebuild `PatchBoardScreen.jsx` as a visual Wire Path panel that writes to the same model. Layout keeps embedding the component, but the summary and labels change from Physical mapping to Wire Path.

**Tech Stack:** React, Vite, existing Lightweaver project context, Node `node:test`, Playwright.

---

### Task 1: Patch Model Slicing

**Files:**
- Modify: `lightweaver/src/lib/patchBoard.js`
- Modify: `lightweaver/src/lib/patchBoard.test.js`

- [x] **Step 1: Write failing tests**

Add tests for `sliceStripIntoPatches(board, strip, cuts)`:

```js
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
    { type: 'strip', stripId: 'outer', startLed: 0, endLed: 2, autoRange: false },
    { type: 'strip', stripId: 'outer', startLed: 3, endLed: 5, autoRange: false },
    { type: 'strip', stripId: 'outer', startLed: 6, endLed: 7, autoRange: false },
  ]);
});
```

Run: `npm run test:unit`
Expected: fail because `sliceStripIntoPatches` is not exported.

- [x] **Step 2: Implement helper**

Add `sliceStripIntoPatches(board, strip, cutIndexes)` that:
- ignores cuts at or outside the strip endpoints
- sorts and deduplicates cuts
- replaces existing patches for that strip with generated segment patches
- preserves non-selected strip patches and off blocks
- inserts segments at the first existing row for that strip

- [x] **Step 3: Verify model tests**

Run: `npm run test:unit`
Expected: all unit tests pass.

### Task 2: Wire Path Panel UI

**Files:**
- Modify: `lightweaver/src/components/PatchBoardScreen.jsx`
- Modify: `lightweaver/src/components/LayoutScreen.jsx`
- Modify: `lightweaver/src/main.css`

- [x] **Step 1: Write failing Playwright test**

Update `lightweaver/tests/patch-board.spec.ts` to:
- open the embedded Wire Path panel
- confirm `Wire Path` and `Source Paths` are visible
- click the visual path surface to add a cut
- confirm at least two segment chips appear
- save project JSON and confirm multiple strip patches exist

Run: `npx playwright test tests/patch-board.spec.ts --project=chromium`
Expected: fail because the UI does not exist yet.

- [x] **Step 2: Rebuild the embedded panel**

Replace the embedded `PatchBoardScreen` contents with:
- header: `Wire Path`
- compact source path picker from current strips
- visual SVG path surface using sampled strip pixels
- click-to-cut behavior calling `sliceStripIntoPatches`
- segment chips that select patches and expose reverse/move/delete actions
- off LED insertion
- `Advanced` details for numeric ranges

- [x] **Step 3: Rename Layout summary**

Change the Layout accordion summary from `Physical mapping` to `Wire Path`, with metadata like `{n} paths · visual order`.

- [x] **Step 4: Verify browser behavior**

Run:

```bash
npm run test:unit
npx playwright test tests/patch-board.spec.ts --project=chromium
npm run build
```

Expected: all commands pass.
