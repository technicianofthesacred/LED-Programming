# LED Selection Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the selected LED section unmistakable at every zoom level and expose its draggable state with grab/grabbing cursors.

**Architecture:** `CanvasManager` will own a non-interactive selection overlay inside each strip group and a `setZoom()` API that inversely scales the overlay as the canvas zoom changes. The existing zoom controller will report every applied zoom to that API. A Playwright-backed Node test will exercise the actual SVG DOM, selection lifecycle, scaling, and cursor states.

**Tech Stack:** JavaScript ES modules, browser SVG DOM, Vite, Node test runner, Playwright Chromium.

---

### Task 1: Specify the selection overlay and cursor lifecycle

**Files:**
- Create: `led-art-mapper/app/test/canvas-selection.test.js`

- [ ] **Step 1: Write the failing browser test**

Create a Vite/Playwright test harness following `test/project-geometry.test.js`. In the browser, import `CanvasManager`, replace the document body with a fixed-size canvas containing the mapper's required SVG groups, add one strip, render 12 LEDs, and select it. Assert the selected group is visible, its badge reads section `1` and `12 LEDs`, the hit target uses `grab`, and the overlay ignores pointer events.

```js
const selected = await page.evaluate(async () => {
  const { CanvasManager } = await import('/src/canvas.js');
  document.body.innerHTML = `<div style="width:400px;height:240px">
    <svg id="test-canvas" viewBox="0 0 400 240" width="400" height="240">
      <g id="imported-svg"></g><g id="layer-hits"></g>
      <g id="selection-overlay"></g><g id="strips-layer"></g>
      <g id="connections-layer"></g>
    </svg></div>`;
  const manager = new CanvasManager(document.querySelector('#test-canvas'), {
    onStripCreated() {}, onStripSelected() {}, onStripDeleted() {},
  });
  manager.addStrip({ id: 'section-a', name: 'Section A', pathData: 'M20 120 L380 120', color: '#ff6b6b' });
  manager.setStripDots('section-a', Array.from({ length: 12 }, (_, i) => ({ x: 20 + i * 30, y: 120 })));
  manager.selectStrip('section-a');
  const entry = manager._strips.get('section-a');
  return {
    display: entry.selectionG.style.display,
    index: entry.selectionIndex.textContent,
    count: entry.selectionCount.textContent,
    cursor: entry.hitPath.style.cursor,
    pointerEvents: entry.selectionG.getAttribute('pointer-events'),
  };
});
assert.deepEqual(selected, {
  display: '', index: '1', count: '12 LEDs', cursor: 'grab', pointerEvents: 'none',
});
```

- [ ] **Step 2: Add zoom, drag, and deselection assertions**

In the same browser session, call `setZoom(0.25)` and `setZoom(4)` and assert that halo widths and badge inverse scales compensate for each zoom. Dispatch a left-button `mousedown` on the selected hit path followed by a moved `mousemove` and assert `document.body.style.cursor === 'grabbing'`; dispatch `mouseup` and assert it clears. Finally call `deselectAll()` and assert the overlay hides and the cursor returns to `pointer`.

```js
manager.setZoom(0.25);
const far = {
  halo: entry.selectionHalo.getAttribute('stroke-width'),
  transform: entry.selectionBadge.getAttribute('transform'),
};
manager.setZoom(4);
const near = {
  halo: entry.selectionHalo.getAttribute('stroke-width'),
  transform: entry.selectionBadge.getAttribute('transform'),
};
```

Expected values: far halo `32`, far transform contains `scale(4)`; near halo `2`, near transform contains `scale(0.25)`.

- [ ] **Step 3: Run the focused test and verify it fails**

Run: `cd led-art-mapper/app && node --test test/canvas-selection.test.js`

Expected: FAIL because strip entries do not yet expose a selection overlay or `setZoom()`.

- [ ] **Step 4: Commit the failing test**

```bash
git add led-art-mapper/app/test/canvas-selection.test.js
git commit -m "test: cover zoom-safe LED selection"
```

### Task 2: Render a zoom-independent selected-section treatment

**Files:**
- Modify: `led-art-mapper/app/src/canvas.js`

- [ ] **Step 1: Add zoom state and a public zoom update API**

Initialize `this._zoom = 1` in the constructor. Add `setZoom(zoom)` that accepts positive finite values, stores the normalized zoom, and refreshes the selected strip.

```js
setZoom(zoom) {
  const nextZoom = Number(zoom);
  this._zoom = Number.isFinite(nextZoom) && nextZoom > 0 ? nextZoom : 1;
  if (this.selectedId) this._updateStripSelectionVisual(this.selectedId);
}
```

- [ ] **Step 2: Create each strip's non-interactive selection overlay**

In `addStrip()`, create a hidden `<g pointer-events="none">` above the colored path. Add a cyan halo path, a white core path, and a compact badge group containing a rounded background, numbered circle, index text, and LED-count text. Store these elements on the strip entry as `selectionG`, `selectionHalo`, `selectionCore`, `selectionBadge`, `selectionIndex`, and `selectionCount`.

```js
const ns = 'http://www.w3.org/2000/svg';
const selectionG = document.createElementNS(ns, 'g');
selectionG.dataset.stripSelection = strip.id;
selectionG.setAttribute('pointer-events', 'none');
selectionG.style.display = 'none';
const selectionHalo = this._makePath(strip.pathData, '#4cc9f0', 8);
selectionHalo.setAttribute('stroke-opacity', '0.38');
const selectionCore = this._makePath(strip.pathData, '#ffffff', 2);

const selectionBadge = document.createElementNS(ns, 'g');
const badgeBackground = document.createElementNS(ns, 'rect');
badgeBackground.setAttribute('x', '-48');
badgeBackground.setAttribute('y', '-12');
badgeBackground.setAttribute('width', '96');
badgeBackground.setAttribute('height', '24');
badgeBackground.setAttribute('rx', '12');
badgeBackground.setAttribute('fill', '#d9f7ff');
const badgeCircle = document.createElementNS(ns, 'circle');
badgeCircle.setAttribute('cx', '-34');
badgeCircle.setAttribute('r', '9');
badgeCircle.setAttribute('fill', '#0891b2');
const selectionIndex = document.createElementNS(ns, 'text');
selectionIndex.setAttribute('x', '-34');
selectionIndex.setAttribute('text-anchor', 'middle');
selectionIndex.setAttribute('dominant-baseline', 'central');
selectionIndex.setAttribute('fill', '#fff');
selectionIndex.setAttribute('font-size', '10');
selectionIndex.setAttribute('font-weight', '700');
const selectionCount = document.createElementNS(ns, 'text');
selectionCount.setAttribute('x', '-20');
selectionCount.setAttribute('dominant-baseline', 'central');
selectionCount.setAttribute('fill', '#071418');
selectionCount.setAttribute('font-size', '10');
selectionCount.setAttribute('font-weight', '700');
selectionBadge.append(badgeBackground, badgeCircle, selectionIndex, selectionCount);
selectionG.append(selectionHalo, selectionCore, selectionBadge);
g.appendChild(selectionG);
```

- [ ] **Step 3: Implement one refresh method for visibility, scale, badge position, and cursor**

Add `_updateStripSelectionVisual(id)`. It must show the overlay only when `id === selectedId`, set halo/core widths to `8 / zoom` and `2 / zoom`, place the badge at the path midpoint with `translate(midpoint) scale(1 / zoom) translate(0 -24)`, update the section number from map order, update the LED count from cached pixels, and set the hit cursor to `grab` for the selected section or `pointer` for another section in Select mode.

```js
const inverseZoom = 1 / this._zoom;
entry.selectionHalo.setAttribute('stroke-width', String(8 * inverseZoom));
entry.selectionCore.setAttribute('stroke-width', String(2 * inverseZoom));
entry.selectionBadge.setAttribute(
  'transform',
  `translate(${mid.x} ${mid.y}) scale(${inverseZoom}) translate(0 -24)`,
);
```

For Draw and Delete tools, clear the inline hit-target cursor so the existing canvas cursor remains authoritative.

- [ ] **Step 4: Correct selection lifecycle ordering and refresh both affected strips**

In `selectStrip()`, capture the previous ID, assign `selectedId` before redrawing cached dots, then refresh both the previous and current entry. In `deselectAll()`, clear `selectedId` before redrawing the previous dots, hide its selection overlay, and restore its pointer cursor. In `setStripDots()`, refresh the selected visual after count or geometry changes. In `setTool()`, refresh every strip cursor without changing Draw/Delete behavior.

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `cd led-art-mapper/app && node --test test/canvas-selection.test.js`

Expected: PASS, including overlay content, inverse zoom, drag cursor, and deselection assertions.

- [ ] **Step 6: Commit the canvas behavior**

```bash
git add led-art-mapper/app/src/canvas.js
git commit -m "feat: clarify selected LED sections"
```

### Task 3: Connect canvas zoom and verify the finished behavior

**Files:**
- Modify: `led-art-mapper/app/src/main.js`

- [ ] **Step 1: Report every applied zoom to `CanvasManager`**

Update `_applyCanvasTransform()` immediately after applying the SVG transform:

```js
svgEl.style.transform = `translate(${state.canvasPanX}px, ${state.canvasPanY}px) scale(${state.canvasZoom})`;
canvasManager.setZoom(state.canvasZoom);
```

This covers wheel zoom, zoom buttons, reset, fit-all, and pan redraws through their shared transform function.

- [ ] **Step 2: Run focused and full mapper verification**

Run: `cd led-art-mapper/app && node --test test/canvas-selection.test.js`

Expected: PASS.

Run: `cd led-art-mapper/app && npm test && npm run build`

Expected: all Node/Playwright tests pass and Vite produces `dist/` without errors.

- [ ] **Step 3: Inspect the real canvas states**

Open the mapper with `npm run dev`, load or draw at least two overlapping sections, and inspect Select mode at 10%, 100%, and 800%. Confirm the selected halo and badge remain stable, blank-canvas deselection clears them, unselected hover uses `pointer`, selected hover uses `grab`, active movement uses `grabbing`, and Draw/Delete/pan/connector cursors still behave normally.

- [ ] **Step 4: Commit the zoom integration**

```bash
git add led-art-mapper/app/src/main.js
git commit -m "feat: keep LED selection visible while zooming"
```
