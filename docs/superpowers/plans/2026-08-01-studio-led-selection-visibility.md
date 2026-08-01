# Studio LED Selection Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a selected LED strip unmistakable at every Studio Layout zoom and expose accurate select-versus-drag cursors on the live surface.

**Architecture:** Keep selection and drag state unchanged. Add a view-box-scaled, pointer-transparent SVG overlay inside `LayoutCanvas`, upgrade the existing midpoint label into a badge, and derive the strip hit-path cursor from mode, selection, and moving state.

**Tech Stack:** React, SVG, Playwright, Vite, Cloudflare Pages

---

### Task 1: Specify the live canvas behavior with a failing browser test

**Files:**
- Create: `lightweaver/tests/layout-selection-visibility.spec.ts`

- [ ] **Step 1: Add a fresh-layout helper and failing selection test**

Create one line strip through the primitive picker, then assert that the selected strip exposes `data-testid="selected-strip-halo"`, `data-testid="selected-strip-core"`, and `data-testid="selected-strip-badge"`. Assert halo/core pointer events are `none`, the badge contains the strip name and LED count, the selected hit path has cursor `grab`, and a second unselected strip has cursor `pointer`.

- [ ] **Step 2: Assert zoom-stable SVG dimensions**

Capture the halo stroke width and badge font size at 100%, click Zoom out until the minimum supported zoom is reached, and assert the SVG attribute values changed in proportion to the reported zoom while the browser-computed screen-space stroke width and font size remain within one pixel of their original values.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
cd lightweaver
npx playwright test tests/layout-selection-visibility.spec.ts --project=chromium --workers=1
```

Expected: FAIL because the three selection-overlay test IDs do not exist and unselected strips still use `grab`.

- [ ] **Step 4: Commit the failing test**

```bash
git add lightweaver/tests/layout-selection-visibility.spec.ts
git commit -m "test: specify Studio selection visibility"
```

### Task 2: Render the selected-path overlay and accurate cursors

**Files:**
- Modify: `lightweaver/src/components/layout/canvas/LayoutCanvas.jsx`

- [ ] **Step 1: Add the selected overlay inside each strip group**

For the selected, visible strip, render two pointer-transparent paths above the existing rail. Give the outer path `data-testid="selected-strip-halo"`, a cyan stroke, round caps/joins, and `strokeWidth={vbScale * 10}`. Give the inner path `data-testid="selected-strip-core"`, a white stroke, round caps/joins, and `strokeWidth={vbScale * 2.25}`.

- [ ] **Step 2: Replace the plain midpoint text with a badge**

Render a pointer-transparent group with `data-testid="selected-strip-badge"` at the selected strip midpoint. Add a dark translucent rounded rectangle with a cyan border and centered text containing `${s.name} · ${s.pixelCount} LEDs`; derive rectangle, offset, border, and font dimensions from `vbScale`.

- [ ] **Step 3: Derive the hit-path cursor from actual interaction**

Use `grabbing` while the strip is moving, `grab` only when the strip is selected and `mode === 'draw'`, and `pointer` otherwise. Preserve the specialized cursor precedence already handled by the canvas and LED picker layers.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
cd lightweaver
npx playwright test tests/layout-selection-visibility.spec.ts --project=chromium --workers=1
```

Expected: PASS with zero failures.

- [ ] **Step 5: Run relevant Layout regression coverage**

Run:

```bash
cd lightweaver
npx playwright test tests/layout-selection-visibility.spec.ts tests/layout-hardening.spec.ts tests/layout-zoom.spec.ts --project=chromium --workers=1
```

Expected: PASS with zero failures.

- [ ] **Step 6: Commit the implementation**

```bash
git add lightweaver/src/components/layout/canvas/LayoutCanvas.jsx
git commit -m "feat: clarify selected LED strips in Studio"
```

### Task 3: Verify, publish, and deploy

**Files:**
- Modify only if verification exposes a defect in the files above.

- [ ] **Step 1: Run the complete source launch gate**

Run:

```bash
cd lightweaver
npm run launch:source
```

Expected: all tests, builds, staged Pages assertions, and mapper contracts pass.

- [ ] **Step 2: Review the complete diff against the design**

Confirm no project serialization, geometry, wiring, route, dependency, or deployment workflow changed.

- [ ] **Step 3: Push and open a ready pull request**

Push `codex/studio-selection-visibility`, open a ready PR against `main`, and include focused and full-gate evidence.

- [ ] **Step 4: Merge after required checks pass**

Merge only the reviewed head SHA. Follow any newer `main` commit if concurrency cancels an older run.

- [ ] **Step 5: Follow the live deployment**

Wait for both the signed `Tests` workflow and `Deploy site` workflow on the merged `main` SHA. Verify the live Studio root and its build graph identify the new deployment, then exercise the Layout selection treatment on `https://led.mandalacodes.com`.
