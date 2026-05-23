# Color Journey Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a looped, addable, draggable color journey in the Pattern Builder.

**Architecture:** Keep the journey data inside `params.__journey.colorStops`, but stop truncating it to three colors. Render color stops as a reusable list in `GraphMode`, with native drag/drop for reorder and palette-to-stop assignment. Cover the behavior in the existing Playwright AI assistant suite.

**Tech Stack:** React, Vite, Playwright, native HTML drag/drop.

---

### Task 1: Add Failing Playwright Coverage

**Files:**
- Modify: `lightweaver/tests/ai-pattern-assistant.spec.ts`

- [ ] **Step 1: Add a test named `lets color journey loop, grow, reorder, and accept palette drops`**

The test opens Pattern > Graph, verifies `Loops back to first`, clicks `Add color stop`, drags the first journey stop onto the third journey stop, then drags the first palette swatch onto the first journey stop and expects that stop's color input to match the palette color.

- [ ] **Step 2: Run focused test and verify it fails**

Run: `npx playwright test tests/ai-pattern-assistant.spec.ts -g "color journey loop"`

Expected: FAIL because the current UI has no `Add color stop`, no journey stop drag targets, and no loop-back label.

### Task 2: Implement Journey Stops

**Files:**
- Modify: `lightweaver/src/components/PatternModes.jsx`
- Modify: `lightweaver/src/main.css`

- [ ] **Step 1: Preserve variable stop counts**

Change `getPatternJourney` so `colorStops` normalizes every saved stop and only falls back to the default three when no stops exist.

- [ ] **Step 2: Add color stop helpers in `GraphMode`**

Add helpers for `addJourneyColor`, `moveJourneyColor`, and `setJourneyColorFromDrop`. Keep updates flowing through `updateJourney`.

- [ ] **Step 3: Replace the fixed Start / Middle / End grid**

Render `.lw-journey-stop-list` with draggable `.lw-journey-stop` items, per-stop labels, color inputs, and a `+ Add color stop` button.

- [ ] **Step 4: Make palette swatches draggable**

Give palette swatches a `draggable` attribute and set `application/x-lightweaver-color` plus `text/plain` drag data.

- [ ] **Step 5: Add focused CSS**

Style the stop list, stop chips, drag handle, swatches, and add button without increasing the top-of-panel scroll burden.

### Task 3: Verify and Commit

**Files:**
- Test: `lightweaver/tests/ai-pattern-assistant.spec.ts`
- Verify: app build and browser view

- [ ] **Step 1: Run focused test**

Run: `npx playwright test tests/ai-pattern-assistant.spec.ts -g "color journey loop"`

Expected: PASS.

- [ ] **Step 2: Run full AI/UI suite**

Run: `npm run test:ai`

Expected: 12+ tests pass.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Expected: build exits 0. The existing Vite chunk-size warning may remain.

- [ ] **Step 4: Commit**

Commit the app and test changes after generated screenshots are restored.
