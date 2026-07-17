# Hardware Installation Toolkit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the reusable Lightweaver toolkit with explainable recommendations, calibration/tests, Workshop-to-Install handoff, templates, as-built history, card replacement, and mobile/offline-safe behavior.

**Architecture:** Pure versioned rules evaluate the canonical card model and emit findings with evidence. Install mode records a versioned baseline and deviations without creating a second configuration. Templates and as-built snapshots are immutable copies stored inside portable project files and export artifacts.

**Tech Stack:** React 18, Vite, Node test runner, Playwright, ESP32-S3 card APIs, existing production evidence and wiring-invalidation logic.

---

### Task 1: Add versioned deterministic recommendations

**Files:**
- Create: `lightweaver/src/lib/hardwareRecommendations.js`
- Create: `lightweaver/src/lib/hardwareRecommendations.test.js`
- Create: `lightweaver/src/v3/hardware/HardwareFindings.jsx`
- Modify: `lightweaver/src/lib/controllerProfiles.js`
- Modify: `lightweaver/src/v3/hardware/HardwareOverview.jsx`
- Modify: `lightweaver/src/v3/hardware/PowerWiringSection.jsx`
- Test: `lightweaver/tests/hardware-recommendations.spec.ts`

- [ ] **Step 1: Write failing rule-contract tests**

Every finding must match:

```js
{
  id: 'power.capacity',
  ruleVersion: 1,
  severity: 'safe',
  cardId: 'controller-north',
  outputIds: [],
  inputs: { estimatedMilliamps: 3744, usableSupplyMilliamps: 24000 },
  explanation: 'Estimated load is within the derated supply capacity.',
  actions: [],
}
```

Add tests for incomplete electrical facts, duplicate GPIO, output-count mismatch, missing common ground, unsafe capacity, long-run injection recommendation, stale firmware, card/project mismatch, and complete/safe configuration. Prove identical inputs produce identical ordered findings.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
node --test src/lib/hardwareRecommendations.test.js
```

Expected: FAIL because the recommendation engine does not exist.

- [ ] **Step 3: Implement pure versioned rules**

Export:

```js
export const HARDWARE_RULESET_VERSION = 1;
export function evaluateHardwareRecommendations(input) {}
export function hardwareBlockers(findings) {}
export function explainHardwareFinding(finding) {}
```

Delegate power calculations to `ledPowerModel.js`. Salvage profile readiness and Art-Net notes, but do not persist profile records or call AI/network services.

- [ ] **Step 4: Render explanations and block unsafe writes**

Show severity, explanation, calculation inputs, and resolution actions. Card-write entry points receive the computed blockers and fail closed with the exact finding IDs; recommendations alone do not block.

- [ ] **Step 5: Verify GREEN**

```bash
cd lightweaver
node --test src/lib/hardwareRecommendations.test.js
npx playwright test tests/hardware-recommendations.spec.ts --project=chromium --workers=1
npm run test:core:source
```

Expected: PASS; blockers are deterministic and explainable.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/hardwareRecommendations.js lightweaver/src/lib/hardwareRecommendations.test.js lightweaver/src/v3/hardware/HardwareFindings.jsx lightweaver/src/lib/controllerProfiles.js lightweaver/src/v3/hardware/HardwareOverview.jsx lightweaver/src/v3/hardware/PowerWiringSection.jsx lightweaver/tests/hardware-recommendations.spec.ts
git commit -m "feat: add explainable hardware recommendations"
```

### Task 2: Add safe project/card comparison and evidence pull

**Files:**
- Create: `lightweaver/src/lib/cardEvidenceMerge.js`
- Create: `lightweaver/src/lib/cardEvidenceMerge.test.js`
- Create: `lightweaver/src/v3/hardware/CardSyncPanel.jsx`
- Modify: `lightweaver/src/v3/hardware/ControllersOutputsSection.jsx`
- Modify: `lightweaver/src/lib/wiringModel.js`
- Test: `lightweaver/tests/hardware-card-sync.spec.ts`

- [ ] **Step 1: Write failing compare/merge tests**

Define the only pullable fields:

```js
const comparison = compareCardEvidence(projectCard, {
  cardId: 'lw-north',
  firmwareVersion: '1.4.0',
  buildId: 'abc123',
  colorOrder: 'GRB',
  outputGammaEnabled: true,
  outputGammaValue: 2.2,
  calibration: { red: 1, green: 0.9, blue: 0.8 },
  maxMilliamps: 1500,
  outputs: [{ pin: 16, pixels: 120 }],
  wiringRevision: 3,
  wiringDigest: 'digest',
});
assert.equal(comparison.identity.matches, true);
assert.equal(comparison.fields.some(field => field.path === 'layout.strips'), false);
```

Prove wrong-card/stale evidence cannot merge, creative/Layout/template/history fields are rejected, and accepting a physical difference returns the exact Workshop approval invalidation kind.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
node --test src/lib/cardEvidenceMerge.test.js
```

Expected: FAIL because safe evidence merge does not exist.

- [ ] **Step 3: Implement field-level compare and explicit resolution**

Export:

```js
export const CARD_PULLABLE_FIELDS = [];
export function compareCardEvidence(projectCard, evidence, expectedIdentity) {}
export function applyCardEvidenceSelection(projectCard, comparison, selectedPaths) {}
```

Each field is push, pull, preserve, or unsupported. Pull is limited to card-owned runtime/evidence fields and routes accepted differences through baseline/wiring invalidation. Never reconstruct project geometry or content from the card.

- [ ] **Step 4: Build the compare/sync panel**

Show identity first, then field-level differences and consequences. Disable mutation until transport and expected identity are verified. Provide copy/download handoff when direct or Bridge transport is unavailable.

- [ ] **Step 5: Verify GREEN**

```bash
cd lightweaver
node --test src/lib/cardEvidenceMerge.test.js
npx playwright test tests/hardware-card-sync.spec.ts --project=chromium --workers=1
node tests/card-bridge-handoff.mjs
```

Expected: PASS; wrong/stale evidence cannot update another card.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/cardEvidenceMerge.js lightweaver/src/lib/cardEvidenceMerge.test.js lightweaver/src/v3/hardware/CardSyncPanel.jsx lightweaver/src/v3/hardware/ControllersOutputsSection.jsx lightweaver/src/lib/wiringModel.js lightweaver/tests/hardware-card-sync.spec.ts
git commit -m "feat: compare and safely merge card evidence"
```

### Task 3: Build calibration and guided verification

**Files:**
- Create: `lightweaver/src/lib/hardwareTestRun.js`
- Create: `lightweaver/src/lib/hardwareTestRun.test.js`
- Create: `lightweaver/src/v3/hardware/CalibrateTestSection.jsx`
- Modify: `lightweaver/src/lib/controllerProfiles.js`
- Modify: `lightweaver/src/lib/cardLiveControl.js`
- Modify: `lightweaver/src/lib/productionPhysicalTest.js`
- Modify: `lightweaver/src/v3/lw-hardware.jsx`
- Test: `lightweaver/tests/hardware-calibration.spec.ts`
- Test: `lightweaver/tests/hardware-test-run.spec.ts`

- [ ] **Step 1: Write failing test-run state tests**

Define a resumable run:

```js
const run = createHardwareTestRun({ cardRecordId: 'north', baselineId: 'baseline-1' });
assert.deepEqual(run.steps.map(step => step.id), [
  'identity', 'count', 'direction', 'color-order', 'sections',
  'output-calibration', 'blackout', 'staged-load', 'readback',
]);
```

Prove a step may be pending/pass/fail/skipped-with-reason, results are card-specific, test-strip override blocks evidence capture, and safe-load tests constrain diagnostic frame intensity without writing the approved persistent current limit. Reconnect must verify that persistent limit by readback.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
node --test src/lib/hardwareTestRun.test.js
```

Expected: FAIL because the test-run model does not exist.

- [ ] **Step 3: Implement the state model and reuse existing probes**

Reuse pixel marker/count/every-N states from `controllerProfiles`, live color-order preview, output-gamma/RGB contract, production physical boundaries, blackout frames, and card evidence readback. Do not create alternate frame protocols.

- [ ] **Step 4: Implement the guided section**

Show one test at a time with expected observation, start/stop controls, pass/fail recording, recovery, and explicit readback. Calibration changes remain reversible until saved. Label browser-preview gamma separately and never bind it to card output calibration.

- [ ] **Step 5: Verify GREEN**

```bash
cd lightweaver
node --test src/lib/hardwareTestRun.test.js src/lib/productionPhysicalTest.test.js
npx playwright test tests/hardware-calibration.spec.ts tests/hardware-test-run.spec.ts --project=chromium --workers=1
node tests/card-live-preview.mjs
npm run build
```

Expected: PASS; controls change card-package output fields and verification evidence, not creative preview gamma.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/hardwareTestRun.js lightweaver/src/lib/hardwareTestRun.test.js lightweaver/src/v3/hardware/CalibrateTestSection.jsx lightweaver/src/lib/controllerProfiles.js lightweaver/src/lib/cardLiveControl.js lightweaver/src/lib/productionPhysicalTest.js lightweaver/src/v3/lw-hardware.jsx lightweaver/tests/hardware-calibration.spec.ts lightweaver/tests/hardware-test-run.spec.ts
git commit -m "feat: add guided card calibration and tests"
```

### Task 4: Add Workshop baselines, Install mode, and deviation approval

**Files:**
- Create: `lightweaver/src/lib/hardwareBaseline.js`
- Create: `lightweaver/src/lib/hardwareBaseline.test.js`
- Create: `lightweaver/src/v3/hardware/InstallHandoffSection.jsx`
- Modify: `lightweaver/src/lib/wiringModel.js`
- Modify: `lightweaver/src/state/ProjectContext.jsx`
- Modify: `lightweaver/src/v3/lw-hardware.jsx`
- Test: `lightweaver/tests/hardware-install-mode.spec.ts`

- [ ] **Step 1: Write failing baseline/deviation tests**

Prove:

```js
const baseline = approveHardwareBaseline({ project, card, findings, testRun });
assert.equal(baseline.status, 'approved');

const cosmetic = classifyHardwareDeviation(baseline, { calibration: { red: 0.9 } });
assert.equal(cosmetic.requiresWorkshopApproval, false);

const structural = classifyHardwareDeviation(baseline, { controller: { outputs: [{ pin: 18 }] } });
assert.equal(structural.requiresWorkshopApproval, true);
assert.equal(structural.kind, 'gpio');
```

Add voltage, PSU, topology, persistent power limit, direction, color order, labels, count, and temporary-session-cap cases. Use existing `standaloneControllerPhysicalChangeKind` and wiring invalidation boundaries where applicable.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
node --test src/lib/hardwareBaseline.test.js
```

Expected: FAIL because baselines do not exist.

- [ ] **Step 3: Implement immutable baselines and deviations**

Export:

```js
export function approveHardwareBaseline(input) {}
export function classifyHardwareDeviation(baseline, nextCard) {}
export function recordHardwareDeviation(baseline, deviation, note) {}
export function approveStructuralDeviation(project, cardId, deviationId) {}
```

Approval is a local project transition with timestamp, rule-set version, firmware evidence, wiring revision/digest, test-run ID, and project fingerprint. It does not introduce authentication.

- [ ] **Step 4: Build Install mode over the same record**

The Workshop/Install toggle changes presentation and permitted actions, not data sources. Install mode shows identify card, generated wiring, safe power-on, tests, deviations, notes, and signoff. Structural deviations route back to Workshop approval and prevent final signoff.

- [ ] **Step 5: Verify GREEN**

```bash
cd lightweaver
node --test src/lib/hardwareBaseline.test.js src/lib/wiringModel.test.js
npx playwright test tests/hardware-install-mode.spec.ts --project=chromium --workers=1
npm run test:production
```

Expected: PASS; production evidence rules and wiring invalidation remain intact.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/hardwareBaseline.js lightweaver/src/lib/hardwareBaseline.test.js lightweaver/src/v3/hardware/InstallHandoffSection.jsx lightweaver/src/lib/wiringModel.js lightweaver/src/state/ProjectContext.jsx lightweaver/src/v3/lw-hardware.jsx lightweaver/tests/hardware-install-mode.spec.ts
git commit -m "feat: add Workshop approval and Install handoff"
```

### Task 5: Add portable templates and as-built history

**Files:**
- Create: `lightweaver/src/lib/hardwareTemplates.js`
- Create: `lightweaver/src/lib/hardwareTemplates.test.js`
- Create: `lightweaver/src/lib/hardwareHistory.js`
- Create: `lightweaver/src/lib/hardwareHistory.test.js`
- Create: `lightweaver/src/v3/hardware/HardwareTemplateLibrary.jsx`
- Modify: `lightweaver/src/v3/hardware/HistoryRepairSection.jsx`
- Modify: `lightweaver/src/lib/projectModel.js`
- Modify: `lightweaver/src/state/ProjectContext.jsx`
- Modify: `lightweaver/src/lib/projectStorage.js`
- Modify: `lightweaver/src/lib/projectStorage.test.js`
- Test: `lightweaver/tests/hardware-templates-history.spec.ts`

- [ ] **Step 1: Write failing copy/version/round-trip tests**

Prove applying a template copies values without shared references:

```js
const template = createHardwareTemplate({ name: 'Four-output 5V', controller, electrical });
const card = applyHardwareTemplate(template, { name: 'North' });
card.controller.outputs[0].pixels = 240;
assert.notEqual(card.controller.outputs[0].pixels, template.controller.outputs[0].pixels);
```

Prove template versions are immutable, project export/import retains templates and history, and an as-built snapshot contains card identity, superseded identities, firmware evidence, baseline, deviations, tests, final controller config, wiring digest, and readback. Prove project duplication retains creative content/templates/component and power definitions while clearing card IDs, host hints, commissioning/connection state, approvals, deviations, production references, signoffs, and as-built history.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
node --test src/lib/hardwareTemplates.test.js src/lib/hardwareHistory.test.js src/lib/projectModel.test.js src/lib/projectStorage.test.js
```

Expected: FAIL because template/history records do not exist.

- [ ] **Step 3: Implement immutable portable records**

Store project templates under `devices.hardwareTemplates` and snapshots under each card's history index plus a project-level deduplicated record collection. Normalize on load; serialize deterministically. Local storage may cache but exports are authoritative portable copies.

- [ ] **Step 4: Build library and history interfaces**

Support create from current card, apply as independent copy, duplicate with a new version/name, export/import template file, view snapshot, and export installation record. Do not add cloud publishing.

- [ ] **Step 5: Verify GREEN**

```bash
cd lightweaver
node --test src/lib/hardwareTemplates.test.js src/lib/hardwareHistory.test.js src/lib/projectModel.test.js src/lib/projectStorage.test.js
npx playwright test tests/hardware-templates-history.spec.ts --project=chromium --workers=1
npm run test:core:source
```

Expected: PASS; project round-trip preserves all records.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/hardwareTemplates.js lightweaver/src/lib/hardwareTemplates.test.js lightweaver/src/lib/hardwareHistory.js lightweaver/src/lib/hardwareHistory.test.js lightweaver/src/v3/hardware/HardwareTemplateLibrary.jsx lightweaver/src/v3/hardware/HistoryRepairSection.jsx lightweaver/src/lib/projectModel.js lightweaver/src/state/ProjectContext.jsx lightweaver/src/lib/projectStorage.js lightweaver/src/lib/projectStorage.test.js lightweaver/tests/hardware-templates-history.spec.ts
git commit -m "feat: add portable hardware templates and history"
```

### Task 6: Add failed-card replacement and multi-card install progress

**Files:**
- Create: `lightweaver/src/lib/cardReplacement.js`
- Create: `lightweaver/src/lib/cardReplacement.test.js`
- Modify: `lightweaver/src/v3/hardware/ControllersOutputsSection.jsx`
- Modify: `lightweaver/src/v3/hardware/InstallHandoffSection.jsx`
- Modify: `lightweaver/src/lib/hardwareHistory.js`
- Modify: `lightweaver/src/lib/cardConnectionRegistry.js`
- Modify: `lightweaver/src/lib/productionRun.js`
- Modify: `lightweaver/src/lib/productionRecords.js`
- Modify: `lightweaver/src/lib/productionRun.test.js`
- Modify: `lightweaver/src/lib/productionRecords.test.js`
- Test: `lightweaver/tests/hardware-card-replacement.spec.ts`
- Test: `lightweaver/tests/hardware-multi-card-install.spec.ts`

- [ ] **Step 1: Write failing replacement and resume tests**

Prove a replacement requires explicit confirmation, preserves the old identity, copies the approved configuration, clears old connection evidence, and creates a new verification requirement:

```js
const replaced = supersedeHardwareCard(card, { newCardId: 'lw-new', reason: 'failed controller' });
assert.deepEqual(replaced.supersededCardIds, ['lw-old']);
assert.equal(replaced.cardId, 'lw-new');
assert.equal(replaced.verification.status, 'required');
assert.equal(replaced.history.at(-1).type, 'card-replaced');
```

Prove multi-card install progress coordinates independent per-card signed job/run references: one card can complete, the project session can pause/reload, and the next card can resume without losing evidence. Prove only one Web Serial production run may be active on a workstation and that no project-level progress update can alter a signed job digest, exact project revision, release binding, or same-card enforcement.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
node --test src/lib/cardReplacement.test.js
npx playwright test tests/hardware-multi-card-install.spec.ts --project=chromium --workers=1
```

Expected: FAIL because replacement/progress is absent.

- [ ] **Step 3: Implement explicit identity supersession**

Never silently accept a different physical card where an expected identity is pinned. The replacement action records the old/new identities and reason, releases registry ownership, requires a new independent per-card production job/run, requires firmware/config push to the new card, and requires full card-specific verification before signoff.

- [ ] **Step 4: Implement project-level installation progress**

Show every card with pending/current/complete/blocked state and its immutable job/run/record reference, resume the first incomplete required action, and allow per-card notes/signoff. Preserve existing strict same-card rules inside each production run; the project installation session coordinates references only. Replacement is a separate workflow outside the failed run.

- [ ] **Step 5: Verify GREEN**

```bash
cd lightweaver
node --test src/lib/cardReplacement.test.js src/lib/hardwareHistory.test.js src/lib/cardConnectionRegistry.test.js src/lib/productionRun.test.js src/lib/productionRecords.test.js
npx playwright test tests/hardware-card-replacement.spec.ts tests/hardware-multi-card-install.spec.ts tests/production-setup.spec.ts --project=chromium --workers=1
```

Expected: PASS; strict production identity and explicit repair replacement coexist.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/cardReplacement.js lightweaver/src/lib/cardReplacement.test.js lightweaver/src/v3/hardware/ControllersOutputsSection.jsx lightweaver/src/v3/hardware/InstallHandoffSection.jsx lightweaver/src/lib/hardwareHistory.js lightweaver/src/lib/cardConnectionRegistry.js lightweaver/src/lib/productionRun.js lightweaver/src/lib/productionRecords.js lightweaver/src/lib/productionRun.test.js lightweaver/src/lib/productionRecords.test.js lightweaver/tests/hardware-card-replacement.spec.ts lightweaver/tests/hardware-multi-card-install.spec.ts
git commit -m "feat: support card replacement and multi-card install"
```

### Task 7: Finish mobile/offline handoffs and retire redundant screens

**Files:**
- Modify: `lightweaver/src/v3/lw-hardware.jsx`
- Modify: `lightweaver/src/v3/hardware/CardFirmwareSection.jsx`
- Modify: `lightweaver/src/v3/hardware/InstallHandoffSection.jsx`
- Modify: `lightweaver/src/v3/lw-installer.jsx`
- Modify: `lightweaver/src/v3/lw-settings.jsx`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/lw.css`
- Modify: `lightweaver/package.json` (scripts only)
- Modify: `lightweaver/scripts/run-core-source-tests.mjs`
- Modify: `docs/deployment-checklist.md`
- Test: `lightweaver/tests/hardware-mobile-handoff.spec.ts`
- Test: `lightweaver/tests/hardware-legacy-retirement.spec.ts`

- [ ] **Step 1: Write failing capability/handoff tests**

At phone viewport/public HTTPS, prove Install, wiring reference, card-page bridge tests, notes, and signoff remain available; Web Serial actions show an explicit desktop handoff. Prove unreachable card operations offer copy/download/card-page handoff rather than enabled dead buttons.

Prove the rail has no Flash/Installer/Setup/Settings entries and legacy hashes still resolve with exact `job`, `mode`, `card`, commissioning, and return-code parameters plus install lock. Prove the static hardcoded GPIO table is no longer rendered. Add a launch-script audit assertion proving every new unit/Playwright suite is enumerated by a committed verification script.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
npx playwright test tests/hardware-mobile-handoff.spec.ts tests/hardware-legacy-retirement.spec.ts --project=chromium --workers=1
```

Expected: FAIL until capability-aware Hardware behavior and retirement are complete.

- [ ] **Step 3: Implement capability-aware actions and handoffs**

Reuse `platformCapabilities`, `canPushDirectlyToCard`, the card-page bridge, commissioning resume codes, and existing copy/download fallbacks. Every action declares its required transport and renders the supported alternative.

- [ ] **Step 4: Retire redundant UI after parity**

Remove the static Installer route/component from normal routing, remove duplicate hardware controls and links from old Settings, and retain only legacy redirect modules needed for bookmarked URLs/tests. Migrate or archive `lw_installer_signoff_v1` into the new history model without treating it as verified evidence.

Add the new unit suites to `run-core-source-tests.mjs` and a `test:hardware` Playwright script to `package.json`; include it in `launch:source`. Extend the deployment checklist with a two-real-card smoke test, partial signoff/reload/resume, explicit failed-card replacement, and shared-domain/full-load current verification.

- [ ] **Step 5: Verify GREEN and full launch gate**

```bash
cd lightweaver
npx playwright test tests/hardware-mobile-handoff.spec.ts tests/hardware-legacy-retirement.spec.ts tests/hardware-workspace.spec.ts tests/universal-install.spec.ts tests/production-setup.spec.ts --project=chromium --workers=1
npm run launch:check
```

Expected: all commands exit 0. Complete the hardware/site smoke-test items in `docs/deployment-checklist.md` that are possible without a physical installation; leave physical full-load checks explicitly recorded, never simulated.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/v3/lw-hardware.jsx lightweaver/src/v3/hardware/CardFirmwareSection.jsx lightweaver/src/v3/hardware/InstallHandoffSection.jsx lightweaver/src/v3/lw-installer.jsx lightweaver/src/v3/lw-settings.jsx lightweaver/src/v3/app.jsx lightweaver/src/v3/lw.css lightweaver/package.json lightweaver/scripts/run-core-source-tests.mjs docs/deployment-checklist.md lightweaver/tests/hardware-mobile-handoff.spec.ts lightweaver/tests/hardware-legacy-retirement.spec.ts
git commit -m "refactor: complete unified Hardware installation workflow"
```
