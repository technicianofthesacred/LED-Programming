# Chop Link Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build canvas-first `Chop` and `Link` overlay modes in Layout so users cut LED paths on the artwork, link resulting segments in physical order, and tune cuts with `+`, `-`, and Delete.

**Architecture:** Keep `patchBoard` as the saved/exported model. Add pure patch-board helpers for cut extraction, cut nudging/deletion, and route ordering, then wire those helpers into `LayoutScreen.jsx` for canvas interaction. Keep `PatchBoardScreen.jsx` as a compact Details/Wire Order confirmation panel instead of the primary chopping surface.

**Tech Stack:** React, Vite, SVG canvas interactions, existing Lightweaver project context, Node `node:test`, Playwright.

---

## File Structure

- `lightweaver/src/lib/patchBoard.js`: add pure helpers:
  - `cutsForStrip(board, stripId)`
  - `nudgeStripCut(board, strip, cutLed, delta)`
  - `deleteStripCut(board, strip, cutLed)`
  - `applyPatchRouteOrder(board, patchIds)`
- `lightweaver/src/lib/patchBoard.test.js`: add unit tests for helper behavior before implementation.
- `lightweaver/src/components/LayoutScreen.jsx`: add `Chop` and `Link` toolbar modes, canvas hit targets, cut markers, linked route badges, and jump connectors.
- `lightweaver/src/components/PatchBoardScreen.jsx`: simplify the mini preview panel into Details/Wire Order support, and add selected cut tuning hooks passed from Layout.
- `lightweaver/src/main.css`: add overlay styling for tool buttons, cut markers, active segments, route badges, jumps, and compact details rows.
- `lightweaver/tests/patch-board.spec.ts`: add Playwright coverage for canvas chopping and linking.

## Scope Notes

This plan implements a practical first version:

- Chops commit immediately on click while mode is active. `Chop` off exits the mode and leaves the saved segmentation in place.
- `+` and `-` tune the selected cut by one LED index.
- `Link` mode records the clicked physical route directly into `chains[0].rowIds`.
- Existing off-block insertion remains available in the Details panel.

Commit-on-exit draft buffers and drag handles are deferred until the first overlay workflow is stable.

### Task 1: Pure Cut And Route Helpers

**Files:**
- Modify: `lightweaver/src/lib/patchBoard.js`
- Modify: `lightweaver/src/lib/patchBoard.test.js`

- [x] **Step 1: Write failing helper tests**

Add these imports to `lightweaver/src/lib/patchBoard.test.js`:

```js
import {
  applyPatchRouteOrder,
  cutsForStrip,
  deleteStripCut,
  nudgeStripCut,
} from './patchBoard.js';
```

Extend the existing import block rather than creating a second import.

Add these tests near the existing `sliceStripIntoPatches` tests:

```js
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

test('nudgeStripCut does not cross neighboring cuts or endpoints', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [1, 2]);

  nudgeStripCut(board, strip, 1, -1);
  nudgeStripCut(board, strip, 2, -1);

  assert.deepEqual(cutsForStrip(board, 'outer'), [1, 2]);
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

test('applyPatchRouteOrder makes clicked segments the exported physical route', () => {
  const strip = makeStrip('outer', 8);
  const board = createDefaultPatchBoard([strip]);
  sliceStripIntoPatches(board, strip, [2, 5]);

  applyPatchRouteOrder(board, ['patch-outer-6-7', 'patch-outer-0-2']);

  assert.deepEqual(board.chains[0].rowIds, ['patch-outer-6-7', 'patch-outer-0-2']);
  const expanded = expandPatchBoard(board, [strip]);
  assert.deepEqual(expanded.pixels.map(pixel => pixel.sourceLed), [6, 7, 0, 1, 2]);
});
```

- [x] **Step 2: Run helper tests to verify RED**

Run:

```bash
npm run test:unit
```

Expected: FAIL because `cutsForStrip`, `nudgeStripCut`, `deleteStripCut`, and `applyPatchRouteOrder` are not exported.

- [x] **Step 3: Implement helper functions**

Add these exports after `sliceStripIntoPatches` in `lightweaver/src/lib/patchBoard.js`:

```js
function patchSpan(patch) {
  if (patch?.source?.type !== 'strip') return null;
  const start = ledIndexOrNull(patch.source.startLed);
  const end = ledIndexOrNull(patch.source.endLed);
  if (start === null || end === null) return null;
  return { min: Math.min(start, end), max: Math.max(start, end) };
}

export function cutsForStrip(board, stripId) {
  const normalized = normalizePatchBoard(board);
  const patches = normalized.patches
    .filter(patch => patch.source?.type === 'strip' && patch.source.stripId === stripId)
    .sort((a, b) => (patchSpan(a)?.min ?? 0) - (patchSpan(b)?.min ?? 0));

  return patches.slice(0, -1)
    .map(patch => patchSpan(patch)?.max)
    .filter(value => Number.isFinite(value));
}

export function nudgeStripCut(board, strip, cutLed, delta) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch ranges.');
  }
  const cuts = cutsForStrip(board, strip.id);
  const index = cuts.indexOf(ledIndexOrNull(cutLed));
  if (index < 0) return board;

  const maxLed = maxLedForStrip(strip);
  const previousLimit = index === 0 ? 1 : cuts[index - 1] + 1;
  const nextLimit = index === cuts.length - 1 ? maxLed - 1 : cuts[index + 1] - 1;
  const nextCut = cuts[index] + Math.sign(Number(delta) || 0);
  if (nextCut < previousLimit || nextCut > nextLimit) return board;

  const nextCuts = [...cuts];
  nextCuts[index] = nextCut;
  return sliceStripIntoPatches(board, strip, nextCuts);
}

export function deleteStripCut(board, strip, cutLed) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch ranges.');
  }
  const cut = ledIndexOrNull(cutLed);
  const nextCuts = cutsForStrip(board, strip.id).filter(value => value !== cut);
  return sliceStripIntoPatches(board, strip, nextCuts);
}

export function applyPatchRouteOrder(board, patchIds = []) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch order.');
  }
  const patchIdSet = new Set(board.patches.map(patch => patch.id));
  const uniqueIds = [];
  for (const patchId of patchIds) {
    if (!patchIdSet.has(patchId) || uniqueIds.includes(patchId)) continue;
    uniqueIds.push(patchId);
  }
  mutableMainChain(board).rowIds = uniqueIds;
  return board;
}
```

- [x] **Step 4: Run helper tests to verify GREEN**

Run:

```bash
npm run test:unit
```

Expected: PASS, including the new helper tests.

### Task 2: Canvas Overlay Mode State And Rendering

Task 1 completion note: the final helper implementation includes additional regression coverage beyond the initial task text for preserving explicit route membership while nudging/deleting cuts, interleaved off-row preservation, largest-overlap remapping, missing-cut no-op, and zero-delta no-op behavior.

**Files:**
- Modify: `lightweaver/src/components/LayoutScreen.jsx`
- Modify: `lightweaver/src/main.css`

- [x] **Step 1: Write failing Playwright test for canvas Chop UI**

Add this test to `lightweaver/tests/patch-board.spec.ts` after the existing test:

```ts
test('canvas chop mode creates a cut marker on the artwork path', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-canvas-chop-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();
  await expect(page.locator('.lw-strip-row')).toHaveCount(1);

  await page.getByRole('button', { name: 'Chop' }).click();
  await expect(page.locator('.lw-route-mode-chip')).toContainText('Chop');

  const stripPath = page.locator('path[data-strip-path]').first();
  const target = await stripPath.evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() * 0.45);
    const ctm = path.getScreenCTM();
    if (!ctm) return null;
    return {
      x: point.x * ctm.a + point.y * ctm.c + ctm.e,
      y: point.x * ctm.b + point.y * ctm.d + ctm.f,
    };
  });
  expect(target).not.toBeNull();
  await page.mouse.click(target!.x, target!.y);

  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(1);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(2);
});
```

- [x] **Step 2: Run Playwright test to verify RED**

Run:

```bash
npx playwright test tests/patch-board.spec.ts --project=chromium
```

Expected: FAIL because the `Chop` toolbar button and canvas cut marker do not exist.

- [x] **Step 3: Add imports and mode state**

In `lightweaver/src/components/LayoutScreen.jsx`, extend the `patchBoard.js` import:

```js
import {
  applyPatchRouteOrder,
  cutsForStrip,
  deleteStripCut,
  mainChain,
  normalizePatchBoard,
  nudgeStripCut,
  sliceStripIntoPatches,
} from '../lib/patchBoard.js';
```

Add state near other canvas tool state:

```js
const [wireOverlayMode, setWireOverlayMode] = useState('idle'); // idle | chop | link
const [selectedWireCut, setSelectedWireCut] = useState(null); // { stripId, led }
const [selectedWirePatchId, setSelectedWirePatchId] = useState(null);
const [linkRouteIds, setLinkRouteIds] = useState([]);
```

- [x] **Step 4: Add patch-board mutation helpers in Layout**

Inside `LayoutScreen`, add:

```js
const updatePatchBoard = useCallback((mutate) => {
  project.setPatchBoard(prev => {
    const next = normalizePatchBoard(prev, strips);
    mutate(next);
    return normalizePatchBoard(next, strips);
  });
}, [project.setPatchBoard, strips]);

const nearestLedIndex = useCallback((strip, clientX, clientY) => {
  const svg = svgRef.current;
  if (!svg || !strip?.pixels?.length) return null;
  const point = svgPt(svg, clientX, clientY);
  let bestIndex = 0;
  let bestDistance = Infinity;
  strip.pixels.forEach((pixel, index) => {
    const dx = pixel.x - point.x;
    const dy = pixel.y - point.y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}, []);

const chopStripAtEvent = useCallback((event, strip) => {
  if (wireOverlayMode !== 'chop' || !strip) return;
  event.stopPropagation();
  const cutLed = nearestLedIndex(strip, event.clientX, event.clientY);
  if (cutLed === null) return;
  const board = normalizePatchBoard(project.patchBoard, strips);
  const cuts = [...new Set([...cutsForStrip(board, strip.id), cutLed])];
  updatePatchBoard(next => sliceStripIntoPatches(next, strip, cuts));
  setSelectedWireCut({ stripId: strip.id, led: cutLed });
  setSelStripId(strip.id);
}, [nearestLedIndex, project.patchBoard, strips, updatePatchBoard, wireOverlayMode]);
```

- [x] **Step 5: Add toolbar buttons**

In the Layout toolbar after `Draw`, add:

```jsx
<button
  className={`btn ${wireOverlayMode === 'chop' ? 'btn-primary' : 'btn-ghost'}`}
  title="Chop a selected LED path into physical runs"
  onClick={() => {
    setWireOverlayMode(mode => mode === 'chop' ? 'idle' : 'chop');
    setSelectedWireCut(null);
  }}
>
  Chop
</button>
<button
  className={`btn ${wireOverlayMode === 'link' ? 'btn-primary' : 'btn-ghost'}`}
  title="Click chopped segments in physical wire order"
  onClick={() => {
    setWireOverlayMode(mode => mode === 'link' ? 'idle' : 'link');
    setLinkRouteIds([]);
  }}
>
  Link
</button>
{wireOverlayMode !== 'idle' && (
  <span className="lw-route-mode-chip">{wireOverlayMode === 'chop' ? 'Chop' : 'Link'} mode</span>
)}
```

- [x] **Step 6: Route strip clicks through Chop mode**

In the `path[data-strip-path]` `onClick`, call chop first:

```jsx
onClick={e => {
  e.stopPropagation();
  if (stripDragSuppressClickRef.current) return;
  if (wireOverlayMode === 'chop') {
    chopStripAtEvent(e, s);
    return;
  }
  if (e.shiftKey || e.metaKey || e.ctrlKey) toggleStripSelection(s.id);
  else selectStrip(s.id);
}}
```

- [x] **Step 7: Render cut markers**

Add a memo:

```js
const wireCutMarkers = useMemo(() => {
  const board = normalizePatchBoard(project.patchBoard, strips);
  return strips.flatMap(strip => cutsForStrip(board, strip.id).map(led => ({
    id: `${strip.id}-${led}`,
    stripId: strip.id,
    led,
    color: strip.color || 'var(--accent)',
    point: strip.pixels?.[led],
  }))).filter(marker => marker.point);
}, [project.patchBoard, strips]);
```

Render it after strip paths and before LED dots:

```jsx
{!isEditingGesture && wireCutMarkers.map(marker => {
  const selected = selectedWireCut?.stripId === marker.stripId && selectedWireCut?.led === marker.led;
  return (
    <g key={marker.id} className="lw-wire-cut-marker" style={{ pointerEvents: 'none' }}>
      <circle
        cx={marker.point.x}
        cy={marker.point.y}
        r={vbScale * (selected ? 7 : 5)}
        className={selected ? 'selected' : ''}
        style={{ '--wire-color': marker.color }}
      />
    </g>
  );
})}
```

- [x] **Step 8: Add CSS**

Add to `lightweaver/src/main.css`:

```css
.lw-route-mode-chip {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 2px 8px;
  color: var(--accent);
  background: color-mix(in oklab, var(--accent) 10%, var(--surface));
  border: 1px solid color-mix(in oklab, var(--accent) 42%, var(--border));
  border-radius: var(--r-sm);
  font-family: var(--mono-font);
  font-size: var(--fs-xs);
}

.lw-wire-cut-marker circle {
  fill: var(--surface);
  stroke: var(--wire-color, var(--accent));
  stroke-width: 2;
  filter: drop-shadow(0 0 4px var(--wire-color, var(--accent)));
}

.lw-wire-cut-marker circle.selected {
  fill: var(--accent);
  stroke: var(--surface);
}
```

- [x] **Step 9: Run Playwright test to verify GREEN**

Run:

```bash
npx playwright test tests/patch-board.spec.ts --project=chromium
```

Expected: PASS for the new chop test and existing patch-board flow.

Task 2 completion note: canvas Chop mode now creates saved cuts directly from artwork-path clicks, renders cut markers and patch segments on the canvas, preserves existing route rows while adding cuts, preserves reversed routed ranges when a split is introduced, and keeps one-LED patch ranges visible in the overlay.

### Task 3: Link Mode Route Recording

**Files:**
- Modify: `lightweaver/src/components/LayoutScreen.jsx`
- Modify: `lightweaver/src/main.css`
- Modify: `lightweaver/tests/patch-board.spec.ts`

- [x] **Step 1: Write failing Playwright test for Link mode**

Add this test to `lightweaver/tests/patch-board.spec.ts`:

```ts
test('canvas link mode records clicked chopped segments as physical route order', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-canvas-link-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();

  await page.getByRole('button', { name: 'Chop' }).click();
  const stripPath = page.locator('path[data-strip-path]').first();
  const clickAt = async (ratio: number) => {
    const target = await stripPath.evaluate((path: SVGPathElement, ratioArg) => {
      const point = path.getPointAtLength(path.getTotalLength() * ratioArg);
      const ctm = path.getScreenCTM();
      if (!ctm) return null;
      return {
        x: point.x * ctm.a + point.y * ctm.c + ctm.e,
        y: point.x * ctm.b + point.y * ctm.d + ctm.f,
      };
    }, ratio);
    expect(target).not.toBeNull();
    await page.mouse.click(target!.x, target!.y);
  };
  await clickAt(0.33);
  await clickAt(0.66);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(3);
  await page.getByRole('button', { name: 'Chop' }).click();

  await page.getByRole('button', { name: 'Link' }).click();
  const segments = page.locator('.lw-wire-canvas-segment-hit');
  await expect(segments).toHaveCount(3);
  await segments.nth(2).click();
  await segments.nth(0).click();
  await expect(page.locator('.lw-route-badge')).toHaveCount(2);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project JSON').click();
  const saved = await saveDownload;
  const projectPath = path.join(tmp, await saved.suggestedFilename());
  await saved.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  const rowIds = projectData.layout.patchBoard.chains[0].rowIds;
  expect(rowIds).toHaveLength(2);
  expect(rowIds[0]).toMatch(/patch-line-layer/);
});
```

- [x] **Step 2: Run Playwright to verify RED**

Run:

```bash
npx playwright test tests/patch-board.spec.ts --project=chromium
```

Expected: FAIL because segment hit targets and route badges are not implemented.

- [x] **Step 3: Include unlinked segment overlays**

Change `wirePathCanvasSegments` so it is built from all strip patches, not only linked row IDs. Use `chain.rowIds` only to determine `order` and `linked`.

Implementation shape:

```js
const rowOrder = new Map(mainChain(board).rowIds.map((patchId, order) => [patchId, order]));
const segmentPatches = board.patches
  .filter(patch => patch.source?.type === 'strip')
  .map(patch => ({ patch, order: rowOrder.get(patch.id), linked: rowOrder.has(patch.id) }));
```

Each segment object should contain:

```js
{
  id: patch.id,
  patchId: patch.id,
  stripId,
  color,
  order,
  linked,
  points,
  mid,
  startPoint: points[0],
  endPoint: points[points.length - 1],
}
```

- [x] **Step 4: Add segment hit target click behavior**

Add a function in `LayoutScreen`:

```js
const toggleRoutePatch = useCallback((patchId) => {
  if (wireOverlayMode !== 'link') return;
  setLinkRouteIds(prev => {
    const nextRoute = prev.includes(patchId)
      ? prev.filter(id => id !== patchId)
      : [...prev, patchId];
    updatePatchBoard(next => applyPatchRouteOrder(next, nextRoute));
    setSelectedWirePatchId(patchId);
    return nextRoute;
  });
}, [updatePatchBoard, wireOverlayMode]);
```

When Link mode is turned on, seed `linkRouteIds` from the current row IDs:

```js
const currentRows = mainChain(normalizePatchBoard(project.patchBoard, strips)).rowIds;
setLinkRouteIds(currentRows);
```

- [x] **Step 5: Render hit targets and badges**

In the segment overlay render, add a hit polyline before the visible polyline:

```jsx
{wireOverlayMode === 'link' && (
  <polyline
    points={segment.points.map(point => `${point.x},${point.y}`).join(' ')}
    className="lw-wire-canvas-segment-hit"
    onClick={event => {
      event.stopPropagation();
      toggleRoutePatch(segment.patchId);
    }}
  />
)}
```

Add route badge:

```jsx
{segment.linked && Number.isFinite(segment.order) && (
  <g className="lw-route-badge">
    <circle cx={segment.mid.x} cy={segment.mid.y} r={vbScale * 9}/>
    <text x={segment.mid.x} y={segment.mid.y + vbScale * 3.5} fontSize={vbScale * 8}>
      {segment.order + 1}
    </text>
  </g>
)}
```

- [x] **Step 6: Render dashed jump connectors**

Create memo:

```js
const wireRouteJumps = useMemo(() => {
  const linked = wirePathCanvasSegments
    .filter(segment => segment.linked && Number.isFinite(segment.order))
    .sort((a, b) => a.order - b.order);
  return linked.slice(0, -1).map((segment, index) => ({
    id: `${segment.patchId}-${linked[index + 1].patchId}`,
    from: segment.endPoint,
    to: linked[index + 1].startPoint,
  }));
}, [wirePathCanvasSegments]);
```

Render before LED dots:

```jsx
{wireRouteJumps.map(jump => (
  <line
    key={jump.id}
    className="lw-wire-route-jump"
    x1={jump.from.x}
    y1={jump.from.y}
    x2={jump.to.x}
    y2={jump.to.y}
  />
))}
```

- [x] **Step 7: Add CSS**

```css
.lw-wire-canvas-segment-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 18;
  stroke-linecap: round;
  stroke-linejoin: round;
  cursor: pointer;
  pointer-events: visibleStroke;
}

.lw-route-badge circle {
  fill: var(--accent);
  stroke: var(--surface);
  stroke-width: 1.5;
}

.lw-route-badge text {
  fill: var(--surface);
  font-family: var(--mono-font);
  font-weight: 800;
  text-anchor: middle;
  pointer-events: none;
}

.lw-wire-route-jump {
  stroke: var(--accent-2);
  stroke-width: 1.5;
  stroke-dasharray: 5 5;
  opacity: 0.7;
  pointer-events: none;
}
```

- [x] **Step 8: Run Playwright to verify GREEN**

Run:

```bash
npx playwright test tests/patch-board.spec.ts --project=chromium
```

Expected: PASS.

Task 3 completion note: Link mode now exposes clickable canvas segment hit targets, starts a fresh route from clicked segment order, saves the selected physical route into `chains[0].rowIds`, and renders linked order badges plus dashed route jumps.

### Task 4: Details Tuning For Selected Cuts

**Files:**
- Modify: `lightweaver/src/components/LayoutScreen.jsx`
- Modify: `lightweaver/src/components/PatchBoardScreen.jsx`
- Modify: `lightweaver/src/main.css`

- [x] **Step 1: Write failing Playwright assertions**

In `canvas chop mode creates a cut marker on the artwork path`, after asserting the cut marker exists, add:

```ts
await expect(page.getByText('Selected cut')).toBeVisible();
await page.getByRole('button', { name: 'Move cut later' }).click();
await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(1);
await page.getByRole('button', { name: 'Delete cut' }).click();
await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(0);
await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(0);
```

- [x] **Step 2: Run Playwright to verify RED**

Run:

```bash
npx playwright test tests/patch-board.spec.ts --project=chromium
```

Expected: FAIL because selected cut Details controls do not exist.

- [x] **Step 3: Pass selected cut props into PatchBoardScreen**

Change the embedded render in `LayoutScreen.jsx`:

```jsx
<PatchBoardScreen
  embedded
  wireOverlayMode={wireOverlayMode}
  selectedWireCut={selectedWireCut}
  onNudgeSelectedCut={(delta) => {
    if (!selectedWireCut) return;
    const strip = strips.find(item => item.id === selectedWireCut.stripId);
    if (!strip) return;
    updatePatchBoard(next => nudgeStripCut(next, strip, selectedWireCut.led, delta));
    const nextLed = selectedWireCut.led + Math.sign(delta);
    setSelectedWireCut({ ...selectedWireCut, led: nextLed });
  }}
  onDeleteSelectedCut={() => {
    if (!selectedWireCut) return;
    const strip = strips.find(item => item.id === selectedWireCut.stripId);
    if (!strip) return;
    updatePatchBoard(next => deleteStripCut(next, strip, selectedWireCut.led));
    setSelectedWireCut(null);
  }}
/>
```

- [x] **Step 4: Render selected cut details**

Update `PatchBoardScreen` signature:

```js
export function PatchBoardScreen({
  embedded = false,
  wireOverlayMode = 'idle',
  selectedWireCut = null,
  onNudgeSelectedCut,
  onDeleteSelectedCut,
}) {
```

Render this section before the existing Source Paths section:

```jsx
{selectedWireCut && (
  <section className="lw-wire-selected-detail">
    <div className="lw-wire-section-title">
      <span>Selected cut</span>
      <strong>LED {selectedWireCut.led}</strong>
    </div>
    <div className="lw-wire-tool-row">
      <button className="btn btn-ghost" aria-label="Move cut earlier" onClick={() => onNudgeSelectedCut?.(-1)}>
        -
      </button>
      <button className="btn btn-ghost" aria-label="Move cut later" onClick={() => onNudgeSelectedCut?.(1)}>
        +
      </button>
      <button className="btn btn-ghost lw-btn-danger" aria-label="Delete cut" onClick={() => onDeleteSelectedCut?.()}>
        Delete
      </button>
    </div>
  </section>
)}
```

- [x] **Step 5: Add CSS**

```css
.lw-wire-selected-detail {
  min-width: 0;
  padding: var(--s-3);
  background: color-mix(in oklab, var(--accent) 8%, var(--bg));
  border: 1px solid color-mix(in oklab, var(--accent) 38%, var(--border));
  border-radius: var(--r-md);
}
```

- [x] **Step 6: Run Playwright to verify GREEN**

Run:

```bash
npx playwright test tests/patch-board.spec.ts --project=chromium
```

Expected: PASS.

Task 4 completion note: Details now shows the selected canvas cut with Move earlier, Move later, and Delete controls, keeps selection synced after nudges/deletes/clear-cuts, and hides idle full-strip overlays after deleting the only cut while preserving full-strip linking in Link mode.

### Task 5: Polish, Browser Verification, Commit, Push

**Files:**
- Modify as needed only if verification reveals issues.

- [x] **Step 1: Run unit tests**

Run:

```bash
npm run test:unit
```

Expected: all tests pass.

- [x] **Step 2: Run core audit**

Run:

```bash
npm run test:core
```

Expected: `project-frame-audit passed`.

- [x] **Step 3: Run production build**

Run:

```bash
npm run build
```

Expected: Vite build exits 0.

- [x] **Step 4: Run browser regression suite**

Run:

```bash
npx playwright test tests/patch-board.spec.ts tests/screen-smoke.spec.ts tests/workflow.spec.ts --project=chromium
```

Expected: all tests pass.

- [x] **Step 5: Verify localhost preview**

Open or refresh:

```text
http://localhost:9999/#screen=patch
```

Expected:

- `Chop` and `Link` buttons are visible in Layout.
- Clicking `Chop` shows the active mode chip.
- Clicking a visible LED strip creates a cut marker on the artwork.
- Right-side Details shows `Selected cut` with `-`, `+`, and Delete.
- Clicking `Link` makes chopped segments clickable and numbered.

- [x] **Step 6: Commit implementation**

Run:

```bash
git add lightweaver/src/lib/patchBoard.js lightweaver/src/lib/patchBoard.test.js lightweaver/src/components/LayoutScreen.jsx lightweaver/src/components/PatchBoardScreen.jsx lightweaver/src/main.css lightweaver/tests/patch-board.spec.ts docs/superpowers/plans/2026-05-25-chop-link-overlay.md
git commit -m "feat: add canvas chop and link overlay"
```

- [ ] **Step 7: Push branch**

Run:

```bash
git push origin codex/patch-board-foundation
```

Task 5 verification note: `npm run test:unit`, `npm run test:core`, `npm run build`, and the combined Playwright regression suite passed. The in-app browser preview at `http://localhost:9999/#screen=patch` shows Lightweaver v2 with `Chop` and `Link`; both toolbar modes activate their mode chip.
