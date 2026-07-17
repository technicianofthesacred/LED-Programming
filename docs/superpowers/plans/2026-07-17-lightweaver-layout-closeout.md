# Lightweaver Layout Experience Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining Layout mobile, keyboard, touch, performance, recovery, and motion requirements without changing the canonical wiring model.

**Architecture:** Keep Draw, Size, and Wire state in the current hooks. Add presentation state only for the mobile inspector, move selected-path measurement into memoized hook output, and extend existing Layout Playwright tests around observable behavior.

**Tech Stack:** React 18, SVG, CSS, Playwright, existing Layout hooks and reducer.

---

### Task 1: Make the mobile workspace and toolbar genuinely mode-aware

**Files:**
- Modify: `lightweaver/src/components/LayoutScreen.jsx`
- Modify: `lightweaver/src/styles/v3-layout-modes.css`
- Modify: `lightweaver/tests/layout-hardening.spec.ts`

- [ ] **Step 1: Write failing mobile and mode tests**

Require a 44-pixel button named `Collapse inspector`, a collapsed state leaving more than 300 pixels of usable canvas height, and an inverse `Expand inspector` action. Assert Import SVG and Draw appear only in Draw mode; Split and Link only in Wire mode; project actions remain in the named secondary group.

- [ ] **Step 2: Run and confirm RED**

```bash
cd lightweaver
npx playwright test tests/layout-hardening.spec.ts --grep "mobile Layout|mode toolbar" --project=chromium --workers=1
```

- [ ] **Step 3: Implement sheet state and compact groups**

Replace the passive handle with a button using `aria-expanded`. Toggle an `.is-collapsed` class that reduces the sheet to the handle height. Keep project and view actions secondary. Do not alter Layout data when the sheet changes.

- [ ] **Step 4: Verify and commit**

Run the focused tests and commit `fix(layout): preserve a usable mobile workspace`.

### Task 2: Make editing commit-level, touch-completable, and keyboard accessible

**Files:**
- Modify: `lightweaver/src/components/layout/modes/SizeModePanel.jsx`
- Modify: `lightweaver/src/components/layout/modes/DrawModePanel.jsx`
- Modify: `lightweaver/src/components/layout/canvas/LayoutCanvas.jsx`
- Modify: `lightweaver/src/components/layout/hooks/useLayoutCanvasInteraction.js`
- Modify: `lightweaver/tests/layout-hardening.spec.ts`

- [ ] **Step 1: Write failing interaction tests**

Add cases proving a multi-character LED count edit creates one undo entry, a completed pending path survives Size or Wire and returns to its naming prompt, touch drawing can finish from a visible `Finish path` button, and artwork vector paths expose button semantics, accessible names, Enter selection, Shift+Enter additive selection, and Delete where applicable.

- [ ] **Step 2: Run and confirm RED**

```bash
cd lightweaver
npx playwright test tests/layout-hardening.spec.ts --grep "count edit|pending path|Finish path|artwork vector" --project=chromium --workers=1
```

- [ ] **Step 3: Implement minimum interaction changes**

Buffer the count field locally while focused and call `setStripCount` once on blur or Enter. Keep Escape restorative. Surface the existing `confirmDraw` action as a visible button when two or more waypoints exist. Add `tabIndex=0`, `role="button"`, `aria-label`, and keyboard handlers to path hit targets while retaining pointer behavior.

- [ ] **Step 4: Verify and commit**

Run the focused command and commit `fix(layout): complete touch and keyboard editing`.

### Task 3: Restore Wire guidance and test mixed-content recovery

**Files:**
- Modify: `lightweaver/src/components/layout/modes/WireModePanel.jsx`
- Modify: `lightweaver/src/components/layout/shared/CardPushControl.jsx` only if deterministic injection is needed
- Modify: `lightweaver/tests/layout-hardening.spec.ts`
- Modify: `lightweaver/tests/layout-send-to-card.spec.ts`

- [ ] **Step 1: Write failing guidance and recovery tests**

Require concise text matching `Connect each physical run`, followed by order and validation guidance. Mock a mixed-content failure deterministically and assert visible `Copy payload`, `Open installer`, and `Retry`; verify Copy writes JSON, Open installer uses the expected handoff URL, and Retry repeats the same bounded attempt.

- [ ] **Step 2: Run and confirm RED**

```bash
cd lightweaver
npx playwright test tests/layout-hardening.spec.ts tests/layout-send-to-card.spec.ts --grep "wire scaffold|mixed-content" --project=chromium --workers=1
```

- [ ] **Step 3: Add guidance and deterministic recovery seam**

Place the scaffold before the first Wire decision, not in a modal. Prefer existing transport dependency injection; if none exists, add one narrow test-only failure seam rather than branching production behavior on environment globals.

- [ ] **Step 4: Verify and commit**

Run the focused tests and commit `fix(layout): restore wire guidance and recovery`.

### Task 4: Remove render-time SVG measurement and finish motion and touch rules

**Files:**
- Modify: `lightweaver/src/components/layout/hooks/useLayoutCanvasInteraction.js`
- Modify: `lightweaver/src/components/layout/canvas/LayoutCanvas.jsx`
- Modify: `lightweaver/src/styles/v3-layout-extra.css`
- Modify: `lightweaver/src/styles/v3-layout-modes.css`
- Modify: `lightweaver/tests/layout-hardening.spec.ts`

- [ ] **Step 1: Write failing performance and CSS tests**

Instrument `SVGPathElement.prototype.getTotalLength` and prove unrelated rerenders do not remeasure unchanged selected paths. Under `prefers-reduced-motion: reduce`, assert the marching selection has no animation. Under `(pointer: coarse)`, assert primary Layout buttons and wire controls have at least 44-pixel hit boxes.

- [ ] **Step 2: Run and confirm RED**

```bash
cd lightweaver
npx playwright test tests/layout-hardening.spec.ts --grep "selected path measurement|reduced motion|coarse targets" --project=chromium --workers=1
```

- [ ] **Step 3: Memoize decoration geometry and add media rules**

Create `selectedPathDecorations` with `useMemo`, keyed by each selected path ID and `pathData`, and pass ready midpoint coordinates into `LayoutCanvas`. Remove DOM path construction from JSX render. Add Layout-owned reduced-motion and coarse-pointer media queries without changing desktop density.

- [ ] **Step 4: Verify and commit**

Run the focused command, then the whole Layout suite:

```bash
npx playwright test tests/layout-hardening.spec.ts tests/layout-mode-switch.spec.ts tests/layout-size-mode.spec.ts tests/layout-send-to-card.spec.ts tests/wiring-workspace.spec.ts --project=chromium --workers=1
```

Commit `fix(layout): cache geometry and honor input preferences`.
