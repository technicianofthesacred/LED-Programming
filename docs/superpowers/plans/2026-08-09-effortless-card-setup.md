# Effortless Card Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development for every behavior change. Tasks are intentionally file-isolated for parallel execution.

**Goal:** Make Lightweaver card setup a single obvious Studio-led path with a passive, safely releasable local bridge.

**Architecture:** Firmware owns passive utility rendering and authenticated release. `cardBridge.js` owns bounded launch intent and WindowProxy lifecycle. The discovery overlay wraps existing hardware logic, while `lw-card.jsx` presents the four parent outcomes without duplicating discovery or install behavior.

**Tech Stack:** React, Vite, Playwright, Node test runner, ESP32-S3 Arduino/PlatformIO.

---

### Task 1: First-load bridge utility lifecycle

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Test: `firmware/lightweaver-controller/tests/blank-card-commissioning-surface.mjs`
- Test: `firmware/lightweaver-controller/tests/bridge-frame-protocol.mjs`

- [ ] Add failing contracts for first-load `bridgeUtility=1`, ordinary-page restoration, authenticated v5 release, and reboot persistence.
- [ ] Run the focused firmware contracts and confirm the expected failures.
- [ ] Implement strict utility-intent parsing, passive activation, visible-page restoration, and existing release behavior.
- [ ] Run focused contracts and `pio run -e esp32-s3-n16r8`.

### Task 2: Studio bridge launch intent

**Files:**
- Modify: `lightweaver/src/lib/cardBridge.js`
- Test: `lightweaver/src/lib/cardBridge.openLocalCardPage.test.js`

- [ ] Add failing tests proving bridge-only URLs include `bridgeUtility=1`, visible card URLs do not, and visible opens retain normal sizing.
- [ ] Confirm the focused Node test fails for missing intent.
- [ ] Implement the minimal URL/window-feature change without weakening current source/origin checks.
- [ ] Run the focused Node test and bridge handoff contract.

### Task 3: Discovery dismissal safety

**Files:**
- Modify: `lightweaver/src/components/card/CardSetupOverlay.jsx`
- Modify: `lightweaver/src/components/card/StripDiscoveryPanel.jsx`
- Test: `lightweaver/tests/strip-discovery.spec.ts`

- [ ] Add a failing Playwright assertion that the unsaved `record` phase blocks close, Escape, backdrop dismissal, and disconnect.
- [ ] Confirm the focused test fails at the record-phase guard.
- [ ] Extend the existing lifecycle callback with the minimum state needed for the guard.
- [ ] Run the focused and complete strip-discovery suite.

### Task 4: Four-phase Hardware overview

**Files:**
- Modify: `lightweaver/src/v3/lw-card.jsx`
- Modify: `lightweaver/src/v3/v3-screens.css`
- Test: `lightweaver/tests/card-workspace.spec.ts`

- [ ] Add failing tests for the four outcome labels, conditional blocker copy, one primary next action, and absence of redundant first-run support/actions.
- [ ] Confirm only the new IA assertions fail.
- [ ] Replace the five implementation milestones with Connect and identify, Find and verify lights, Build layout, and Test and save to card.
- [ ] Map existing commissioning/readiness evidence into those phases and keep advanced recovery available after first run.
- [ ] Run focused Hardware overview tests.

### Task 5: Integrated verification

**Files:**
- Verify all files above without adding deployment artifacts.

- [ ] Run bridge, discovery, Hardware overview, firmware, and production-build checks.
- [ ] Inspect desktop and mobile together, fix one bounded batch, and confirm once if needed.
- [ ] Run the Impeccable detector once over changed UI targets.
- [ ] Run `git diff --check` and report physical hardware proof as outstanding unless a card is explicitly made available.

No commit, push, deployment, signing, or flashing is part of this plan.
