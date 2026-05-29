# Lightweaver V3 Customer Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make V3 a customer-ready pattern, section, Look, and load workflow.

**Architecture:** Add a small shared section/look model used by Patterns, Load, and export. Patterns edits and saves Looks; Load reviews hardware and final chip config.

**Tech Stack:** React 18, Vite, Node test runner, Playwright, ESP32 card runtime JSON contract.

---

### Task 1: Shared Section/Look Model

**Files:**
- Create: `lightweaver/src/lib/sectionLookModel.js`
- Test: `lightweaver/src/lib/sectionLookModel.test.js`
- Modify: `lightweaver/src/lib/cardVisualLook.js`
- Modify: `lightweaver/src/lib/projectModel.js`

- [ ] Write failing tests for target derivation, all-section updates, single-section updates, saved Look normalization, and controller preservation.
- [ ] Implement `deriveSectionTargets`, `normalizeSectionVisualLook`, `applyLookToPatchBoard`, `normalizeSavedLooks`, and `saveLookToController`.
- [ ] Extend visual Looks with `speed` and `hueShift`.
- [ ] Preserve `looks` and `activeLookId` inside `defaultStandaloneController`.

### Task 2: Runtime Export

**Files:**
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`
- Modify: `lightweaver/tests/card-runtime-contract.mjs`

- [ ] Write failing tests proving section pattern, color, brightness, speed, and hue shift export to `config.zones[]`.
- [ ] Make export use the shared section Look values and include the active saved Look's pattern bank.
- [ ] Keep stale output protection from the previous default-circle work.

### Task 3: Patterns Workspace

**Files:**
- Modify: `lightweaver/src/components/PatternsScreen.jsx`
- Modify: `lightweaver/src/main.css`
- Modify: `lightweaver/tests/patterns-v3.spec.ts`

- [ ] Add section target selector.
- [ ] Add speed and hue shift controls next to color controls.
- [ ] Make pattern cards preview the selected target.
- [ ] Make live card preview send `zone` when the target is a section.
- [ ] Add Save Look and saved Looks list.
- [ ] Keep knob cycle in Patterns.

### Task 4: Load Cleanup

**Files:**
- Modify: `lightweaver/src/components/ChipScreen.jsx`
- Modify: `lightweaver/tests/screen-smoke.spec.ts` if needed

- [ ] Remove duplicate pattern-selection grids from Load.
- [ ] Keep card host, install steps, hardware layout, LED hardware, outputs, and paste config.
- [ ] Show read-only sections and Looks summaries with navigation buttons to Patterns/Layout.

### Task 5: Verification

**Commands:**
- `npm run test:unit`
- `npm run test:core`
- `npm run build`
- targeted Playwright checks for `tests/patterns-v3.spec.ts` and `tests/screen-smoke.spec.ts`

- [ ] Verify local browser at `http://127.0.0.1:9998/#screen=patterns`.
- [ ] Confirm no unrelated local files are staged.
- [ ] Commit and push the finished work.
