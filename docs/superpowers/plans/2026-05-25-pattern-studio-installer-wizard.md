# Pattern Studio + Installer Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first working slice of Lightweaver Pattern Studio and a guarded WLED installer wizard so pattern creation and controller integration become easier and safer.

**Architecture:** Keep pattern quality and install gating in small pure helper modules with tests, then wire those helpers into the existing Pattern and Devices panels. The UI does not write presets to WLED yet; it prepares the package, exposes blockers, and keeps the backup-first installer path explicit.

**Tech Stack:** Vite, React, existing Lightweaver CSS tokens, WLED JSON API helpers, Node-based project audit tests.

---

### Task 1: Pattern Studio Model

**Files:**
- Create: `lightweaver/src/lib/patternStudio.js`
- Modify: `lightweaver/tests/project-frame-audit.mjs`

- [x] Add tests for `makePatternStudioSummary()` covering compatibility, installability, quality score, and next actions.
- [x] Implement `makePatternStudioSummary(pattern, options)` using pattern compatibility gates, parameter metadata, palette usage, and controller target.
- [x] Run `npm run test:core` and keep the new tests green.

### Task 2: Installer Wizard Model

**Files:**
- Create: `lightweaver/src/lib/wledInstallWizard.js`
- Modify: `lightweaver/tests/project-frame-audit.mjs`

- [x] Add tests for `buildWledInstallWizardPlan()` covering controller blockers, backup gate, generated WLED package, and disabled install state.
- [x] Implement `buildWledInstallWizardPlan({ controllerAudit, wledPackage, backupSaved })`.
- [x] Run `npm run test:core` and keep the new tests green.

### Task 3: Pattern Screen Integration

**Files:**
- Modify: `lightweaver/src/components/PatternModes.jsx`
- Modify: `lightweaver/src/main.css`

- [x] Add a compact Pattern Studio panel to the existing effect inspector.
- [x] Show runtime gate, quality score, portability, parameter count, palette status, and concrete next actions.
- [x] Keep the surface dense and restrained, matching the existing professional tool UI.

### Task 4: Devices Installer Wizard Integration

**Files:**
- Modify: `lightweaver/src/components/DevicesPanel.jsx`
- Modify: `lightweaver/src/main.css`

- [x] Add a WLED Basic installer readiness panel.
- [x] Reuse the controller compatibility audit and WLED package builder.
- [x] Show blockers and the next safe action, with install disabled until backup and geometry gates are clear.

### Task 5: Verification

**Files:**
- No new files.

- [x] Run `npm run test:core`.
- [x] Run `npm run test:standalone`.
- [x] Run `npm run build`.
- [x] Run `git diff --check`.
- [x] Browser-check Pattern and Devices panels at `http://127.0.0.1:5176`.
