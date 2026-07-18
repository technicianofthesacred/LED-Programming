# Reusable Card Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Lightweaver's reusable multi-project, multi-card hardware system without duplicating the Card workspace or Layout → Wire commissioning UX already shipped on `main`.

**Architecture:** Treat `origin/main` and its existing Card/Wire interfaces as the visual source of truth. Build the reusable system underneath them in compatibility-preserving layers: executable output-color verification, a canonical multi-card project model, per-card connection and production identity, voltage-aware power rules, and portable templates/history. UI work is deliberately last and may only extend the current Card workspace after the concurrent LED UX work lands.

**Tech Stack:** React 18, Vite, Node test runner, Playwright, PlatformIO/Arduino ESP32-S3, FastLED, strict JSON production packages.

---

## Non-overlap contract

These ownership rules are release gates, not suggestions:

- **Layout → Wire owns the signal path UX:** data-wire count, output/run mapping, GPIO assignment, route geometry, Auto Wire, boundary/direction checks, color-order confirmation, assembly map, and install readiness.
- **Card owns controller infrastructure:** identity, connection, firmware/update/recovery, selected-card synchronization, signed Workshop preparation, power domains, templates, approval/as-built history, replacement, and multi-card progress.
- Do not create a top-level Hardware route, a second card overview, a second output editor, a second physical-test flow, or a second installer shell.
- Do not edit `lightweaver/src/components/layout/` or `lightweaver/src/styles/v3-layout-*.css` while the other LED UX branch is active. Any later data-contract adaptation must preserve the public props and behavior of `WireModePanel`.
- The Raspberry Pi proxy and visitor UI remain deferred.

## Current integrated baseline

- [x] Rebase `codex/unified-hardware-workspace` onto `origin/main` at `1b0f85455390cd66196eb87aba61dbf93d09e148`.
- [x] Retain calibrated output commit as `11acde3f4c5f88a8a019667eb4284d24131fff6a`.
- [x] Confirm no textual merge conflicts and no changed-path intersection with the 34 newer `main` commits.
- [x] Verify 140 Card, Wire, production, installer, layout-send, and playlist Playwright tests.
- [x] Verify focused runtime tests, 25 production-package tests, `test:core:source`, Vite build, and `pio run` (RAM 38.6%, flash 17.0%).

The retained calibration foundation is valid but not fully closed: production still emits singleton-card schema v1, and the firmware pipeline test does not execute the C++ transform.

## Execution gates while the other LED UX work is active

- **Safe now:** Task 1 is isolated to firmware pipeline internals, its executable test, and the source-test command.
- **Wait for the concurrent UX branch to land or expose its changed paths:** Tasks 2–5 touch shared project/Card contracts even though they add no new visual workflow. Rebase and compare changed paths before starting them.
- **Strictly last:** Task 6 changes visible Card surfaces and cannot begin until that UX work is on `origin/main` and has passed a fresh conceptual-overlap audit.
- If any concurrent branch touches a file named by a task, integrate that branch first and revise the task against the resulting interface. Do not solve this with parallel edits to the same file.

## File map

### Existing surfaces that remain authoritative

- `lightweaver/src/v3/lw-card.jsx`: extend only after the UI integration gate; never replace.
- `lightweaver/src/v3/lw-settings.jsx`: eventually summarize selected-card infrastructure and deep-link output edits to Wire.
- `lightweaver/src/v3/lw-production.jsx`: retain the existing identity-bound Workshop state machine.
- `lightweaver/src/components/layout/modes/WireModePanel.jsx`: no visual edits in the backend phases.

### New focused domain files

- `firmware/lightweaver-controller/src/LightweaverColorPipelineCore.{h,cpp}`: host-testable RGB calibration/gamma/order transform without Arduino dependencies.
- `lightweaver/src/lib/controllerCards.js`: project card records, selection, migration, and compatibility projection.
- `lightweaver/src/lib/cardConnectionRegistry.js`: immutable per-project-card connection state keyed by logical and physical identity.
- `lightweaver/src/lib/hardwarePower.js`: voltage-aware domain aggregation and safe current ceilings.
- `lightweaver/src/lib/hardwareRecommendations.js`: versioned deterministic blockers/recommendations.
- `lightweaver/src/lib/hardwareRecords.js`: immutable templates, approvals, as-built snapshots, and replacement history.

## Task 1: Close the calibrated-output verification gap

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverColorPipelineCore.h`
- Create: `firmware/lightweaver-controller/src/LightweaverColorPipelineCore.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverColorPipeline.cpp`
- Create: `firmware/lightweaver-controller/tests/output-color-pipeline-native.cpp`
- Create: `firmware/lightweaver-controller/tests/output-color-pipeline-native.mjs`
- Modify: `lightweaver/package.json`

- [ ] **Step 1: Extract a platform-neutral transform contract**

Define the shared types and pure entry point:

```cpp
struct LightweaverRgb8 { uint8_t red; uint8_t green; uint8_t blue; };
struct LightweaverOutputTransform {
  bool gammaEnabled;
  float gamma;
  float red;
  float green;
  float blue;
  LightweaverColorOrder order;
};
LightweaverRgb8 applyLightweaverOutputTransform(
  LightweaverRgb8 input,
  const LightweaverOutputTransform& transform
);
```

Keep the FastLED-facing function as a thin adapter over this core so production and the native test execute the same code.

- [ ] **Step 2: Add executable native cases**

The native harness must assert:

```cpp
assert(apply(neutral, {255, 128, 0}) == rgb(255, 128, 0));
assert(apply(redHalf, {200, 100, 50}) == rgb(100, 100, 50));
assert(apply(grb, {200, 100, 50}) == rgb(100, 200, 50));
assert(apply(calibrationThenGammaThenOrder, {128, 64, 32}) == expectedBytes);
```

The Node wrapper compiles the harness with the system C++17 compiler into a temporary directory, runs it, and deletes the binary.

- [ ] **Step 3: Prove RED, then GREEN**

Run before extraction and expect compilation failure because the core files do not exist:

```bash
node firmware/lightweaver-controller/tests/output-color-pipeline-native.mjs
```

After implementation, expect `output-color-pipeline-native tests passed`.

- [ ] **Step 4: Add the native test to the source gate**

Insert the native test beside the existing output pipeline contract in `lightweaver/package.json`; do not remove the source-level parser/storage checks.

- [ ] **Step 5: Verify and commit**

```bash
cd lightweaver
npm run test:core:source
cd ../firmware/lightweaver-controller
pio run
git add src/ tests/ ../../lightweaver/package.json
git commit -m "test: execute output color pipeline behavior"
```

## Task 2: Add project-v4 cards behind a singleton compatibility adapter

**Gate:** Begin only after the concurrent LED UX branch has landed or supplied a non-overlapping changed-file list.

**Files:**
- Create: `lightweaver/src/lib/controllerCards.js`
- Create: `lightweaver/src/lib/controllerCards.test.js`
- Modify: `lightweaver/src/lib/projectModel.js`
- Modify: `lightweaver/src/lib/projectModel.test.js`
- Modify: `lightweaver/src/state/ProjectContext.jsx`
- Modify: `lightweaver/src/lib/cardCommissioningFlow.js`
- Modify: `lightweaver/src/components/card/CardCommissioningPanel.jsx`

- [ ] **Step 1: Write failing card-record tests**

Test this public API:

```js
normalizeControllerCard(input, index)
normalizeControllerCards(devices)
selectedControllerCard(devices)
updateSelectedController(devices, updater)
addControllerCard(devices, partial)
supersedePhysicalCard(devices, recordId, nextCardId, reason)
```

Required assertions: v3 singleton migration is idempotent; logical `recordId` survives pairing and physical replacement; duplicate GPIO numbers are allowed across different cards but rejected within one card; adding a card deep-clones controller state; unknown legacy data is preserved in `migrationNotes`.

- [ ] **Step 2: Implement the canonical record shape**

```js
{
  recordId: 'project-card-1',
  name: 'Controller 1',
  role: '',
  cardId: '',
  supersededCardIds: [],
  hostHint: '',
  controller: defaultStandaloneController(),
  templateRef: null,
  history: [],
}
```

`devices.cards[]` and `devices.activeCardRecordId` are canonical. `selectedControllerCard()` is the only compatibility selector.

- [ ] **Step 3: Migrate project version 3 to version 4**

Set `PROJECT_VERSION = 4`. Convert `devices.standaloneController` and `devices.wledIp` into the first card. Do not move or rewrite `layout.wiring.outputs` in this task; current Wire commissioning remains authoritative until its coordinated data adaptation.

- [ ] **Step 4: Preserve the current React contract without preserving duplicate storage**

`ProjectContext` continues to expose `standaloneController` and `setStandaloneController`, but derives and writes them through the selected card. `serializeProject()` emits `devices.cards` and no second mutable controller copy. Replace raw snapshot reads in commissioning with `selectedControllerCard(snapshot.devices).controller`.

- [ ] **Step 5: Verify no Wire UX changes**

```bash
cd lightweaver
node --test src/lib/controllerCards.test.js src/lib/projectModel.test.js
npx playwright test tests/wiring-workspace.spec.ts tests/layout-send-to-card.spec.ts --project=chromium --workers=1
cd ..
git diff --name-only origin/main...HEAD -- lightweaver/src/components/layout lightweaver/src/styles/v3-layout-modes.css
```

Expected final command: no files.

- [ ] **Step 6: Commit**

```bash
git add src/lib/controllerCards.js src/lib/controllerCards.test.js src/lib/projectModel.js src/lib/projectModel.test.js src/state/ProjectContext.jsx src/lib/cardCommissioningFlow.js src/components/card/CardCommissioningPanel.jsx
git commit -m "feat: add compatible multi-card project model"
```

## Task 3: Add per-card connections and production schema v2

**Files:**
- Create: `lightweaver/src/lib/cardConnectionRegistry.js`
- Create: `lightweaver/src/lib/cardConnectionRegistry.test.js`
- Modify: `lightweaver/src/lib/productionJobPackage.js`
- Modify: `lightweaver/src/lib/productionJobPackage.test.js`
- Modify: `release/production-job.schema.json`

- [ ] **Step 1: Write failing registry tests**

The reducer must require `{ projectCardRecordId, expectedCardId }` for every mutation, ignore stale responses for another record/card, retain inactive connection evidence, and expose the selected card through a singleton adapter for the existing shell.

- [ ] **Step 2: Implement the immutable registry**

```js
createCardConnectionRegistry(cards)
reduceCardConnection(registry, event)
selectCardConnection(registry, recordId)
adaptSelectedCardLink(registry, activeCardRecordId)
```

Do not connect the registry to the React shell in this backend task. Do not change bridge origin, commissioning return-code, expected-identity, retry, or install-lock behavior. The existing singleton card link remains the UI adapter until Task 6.

- [ ] **Step 3: Write schema-v1 compatibility and schema-v2 selection tests**

Keep the fixed signed v1 fixture byte-for-byte valid. New jobs emit schema v2 and contain `selectedCardRecordId` plus exactly one selected card configuration. A job may not silently serialize the first card when another card is selected.

- [ ] **Step 4: Implement dual-version parsing**

```js
const CURRENT_PRODUCTION_JOB_SCHEMA_VERSION = 2;
const SUPPORTED_PRODUCTION_JOB_SCHEMA_VERSIONS = new Set([1, 2]);
```

Parsing v1 retains its existing singleton contract. Building v2 uses `selectedControllerCard(project.restoreSnapshot.devices)` and binds the logical record ID, physical card ID when paired, project revision/fingerprint, wiring digest, and output calibration.

- [ ] **Step 5: Verify identity and production safety**

```bash
cd lightweaver
node --test src/lib/cardConnectionRegistry.test.js src/lib/productionJobPackage.test.js
npm run test:production
npx playwright test tests/card-workspace.spec.ts tests/production-setup.spec.ts tests/universal-install.spec.ts --project=chromium --workers=1
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/cardConnectionRegistry.js src/lib/cardConnectionRegistry.test.js src/lib/productionJobPackage.js src/lib/productionJobPackage.test.js ../release/production-job.schema.json
git commit -m "feat: bind production and connections per card"
```

## Task 4: Add voltage-aware power domains and deterministic recommendations

**Files:**
- Create: `lightweaver/src/lib/hardwarePower.js`
- Create: `lightweaver/src/lib/hardwarePower.test.js`
- Create: `lightweaver/src/lib/hardwareRecommendations.js`
- Create: `lightweaver/src/lib/hardwareRecommendations.test.js`
- Modify: `lightweaver/src/lib/controllerCards.js`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`

- [ ] **Step 1: Write failing power aggregation tests**

Cover shared 5V and 12V domains, supply derating, multiple cards sharing one supply, conservative unknown-current defaults, duplicate-output rejection, persistent ceiling clamping, and low-power test budgets that do not mutate `maxMilliamps`.

- [ ] **Step 2: Implement one pure calculation**

```js
calculatePowerDomain({ domain, cards }) => {
  requestedMilliamps,
  usableMilliamps,
  approvedCeilingMilliamps,
  headroomMilliamps,
  assumptions,
}
```

Every output is counted exactly once. Voltage and current-per-pixel are explicit inputs; conservative defaults are labeled assumptions, not measured facts.

- [ ] **Step 3: Implement versioned rules**

```js
evaluateHardwareRecommendations(project) => [{
  ruleId,
  ruleVersion,
  severity: 'safe' | 'recommendation' | 'blocker',
  inputs,
  explanation,
  affectedCardRecordIds,
  resolutionActions,
}]
```

At minimum block voltage mismatch, over-capacity domains, missing common-ground confirmation, duplicate GPIO within a card, and persistent ceilings above the calculated safe limit.

- [ ] **Step 4: Feed the approved ceiling into runtime packages**

`cardRuntimeProject.js` must select the active card's approved persistent ceiling. Diagnostic frame intensity stays an ephemeral bound beneath that ceiling.

- [ ] **Step 5: Verify and commit**

```bash
cd lightweaver
node --test src/lib/hardwarePower.test.js src/lib/hardwareRecommendations.test.js
node tests/card-runtime-contract.mjs
git add src/lib/hardwarePower.js src/lib/hardwarePower.test.js src/lib/hardwareRecommendations.js src/lib/hardwareRecommendations.test.js src/lib/controllerCards.js src/lib/cardRuntimeProject.js
git commit -m "feat: add shared power safety rules"
```

## Task 5: Add reusable templates and immutable installation records

**Files:**
- Create: `lightweaver/src/lib/hardwareRecords.js`
- Create: `lightweaver/src/lib/hardwareRecords.test.js`
- Modify: `lightweaver/src/lib/projectModel.js`
- Modify: `lightweaver/src/lib/projectStorage.test.js`

- [ ] **Step 1: Write failing record tests**

Assert template application creates an independent project-owned copy; cloning creates a new immutable ID/version; project duplication clears physical card IDs, connection sessions, approvals, production references, signoffs, and as-built history; snapshots are content-addressed; dangling imports are rejected or quarantined.

- [ ] **Step 2: Implement explicit record collections**

```js
devices.hardwareTemplates
devices.hardwareSnapshots
devices.powerDomains
cards[].history
```

Provide `applyHardwareTemplate`, `cloneHardwareTemplate`, `approveWorkshopBaseline`, `recordAsBuiltSnapshot`, `appendCardHistoryEvent`, and `duplicateHardwareForNewProject` as pure functions.

- [ ] **Step 3: Round-trip through project files and browser library**

Test save/load, import/export, duplicate, and migration without relying on local storage as the only durable copy.

- [ ] **Step 4: Verify and commit**

```bash
cd lightweaver
node --test src/lib/hardwareRecords.test.js src/lib/projectModel.test.js src/lib/projectStorage.test.js
git add src/lib/hardwareRecords.js src/lib/hardwareRecords.test.js src/lib/projectModel.js src/lib/projectStorage.test.js
git commit -m "feat: add reusable hardware records"
```

## Task 6: UI integration gate and minimal Card extensions

**Do not begin this task until the concurrent LED UX work has landed on `origin/main`.**

**Files:**
- Modify only after re-audit: `lightweaver/src/v3/lw-card.jsx`
- Modify only after re-audit: `lightweaver/src/v3/lw-settings.jsx`
- Modify only after re-audit: `lightweaver/src/v3/lw-production.jsx`
- Test: `lightweaver/tests/card-workspace.spec.ts`
- Test: `lightweaver/tests/wiring-workspace.spec.ts`

- [ ] **Step 1: Rebase and repeat the overlap audit**

```bash
git fetch origin
git diff --name-only HEAD..origin/main -- lightweaver/src lightweaver/tests
git rebase origin/main
git diff --check
```

If the new UX changed Card, Settings, Workshop, or project-state contracts, update this task before editing. Do not resolve conceptual overlap merely because Git reports no textual conflict.

- [ ] **Step 2: Lock the ownership boundary with failing tests**

Add assertions that Card shows the selected controller, power/readiness summary, sync state, templates/history entry points, and a single **Edit outputs in Wire** action. Assert Card contains no editable output lanes, Auto Wire, physical chase, color-order confirmation, or duplicate install gate.

- [ ] **Step 3: Extend the existing Card sections**

- Card overview: selected controller, other project cards, next infrastructure action.
- Card settings: identity/connection, power-domain assignment, calibration summary, and deep link to `#screen=layout&mode=wire`.
- Workshop setup: selected-card job plus project-level multi-card progress.
- Advanced & Support: preserve the existing technician, guide, JSON, and recovery tools unchanged.

Do not add a new rail destination or a new Card section unless a later explicit UX decision requires it.

- [ ] **Step 4: Remove the existing duplicate Card output editor**

Replace the editable output/GPIO/pixel controls in Card settings with a read-only selected-card summary and the Wire deep link. The underlying compatibility APIs stay available for imports and production packages.

- [ ] **Step 5: Verify desktop, mobile, keyboard, and existing workflows**

```bash
cd lightweaver
npx playwright test tests/card-workspace.spec.ts tests/wiring-workspace.spec.ts tests/layout-send-to-card.spec.ts tests/production-setup.spec.ts tests/universal-install.spec.ts --project=chromium --workers=1
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/v3/lw-card.jsx src/v3/lw-settings.jsx src/v3/lw-production.jsx tests/card-workspace.spec.ts tests/wiring-workspace.spec.ts
git commit -m "feat: expose reusable infrastructure in Card"
```

## Task 7: Rebuild the signed firmware release and run the launch gate

**Files:**
- Generated by protected CI: `lightweaver/public/firmware/lightweaver-controller-esp32s3-factory.bin`
- Generated by protected CI: `lightweaver/public/firmware/release-manifest.json`
- Generated by protected CI: `lightweaver/public/firmware/release-manifest.sig`
- Generated by protected CI: `lightweaver/public/firmware/release-provenance.json`
- Generated by protected CI: `lightweaver/public/firmware/releases/**`

- [ ] **Step 1: Run full source and UI verification**

```bash
cd lightweaver
npm run test:core:source
npm run test:production
npm run build
cd ../firmware/lightweaver-controller
pio run
```

- [ ] **Step 2: Publish through the protected firmware workflow**

Push the reviewed branch and let `.github/workflows/build-firmware.yml` build, sign, commit, and upload the immutable release set. Never read or reproduce the signing key locally.

- [ ] **Step 3: Rebase the CI release commit and verify freshness**

```bash
cd lightweaver
npm run firmware:check-bin
npm run launch:check
```

Expected: signed factory binary matches current firmware source; all source, production, Playwright, build, staging, and page-artifact gates pass.

- [ ] **Step 4: Final review**

Confirm there is still one Card rail destination and one Wire commissioning flow, v1 production fixtures remain valid, new v2 jobs bind one selected card, power blockers cannot be bypassed accidentally, and no Pi runtime work entered the diff.

## Deferred until real demand

- Route-only `layout.wiring.routes` migration. Current Wire uses `layout.wiring.outputs` as physical truth; moving it requires an atomic data-contract change with the active Layout UX, not a background refactor.
- Cloud fleet management, accounts, or a shared online hardware catalog.
- Raspberry Pi runtime/proxy work.
- New Art-Net/Madrix infrastructure beyond preserving the current external-source mode.

## Self-review result

- **Spec coverage:** retained multi-card, power safety, templates, history, sync/production identity, firmware calibration, replacement, and resumable multi-card progress. Removed only the superseded duplicate UI architecture.
- **Placeholder scan:** no TBD/TODO implementation steps remain.
- **Type consistency:** `recordId`, `activeCardRecordId`, `cardId`, `controller`, `powerDomains`, and production `selectedCardRecordId` are consistent across tasks.
- **Overlap control:** Tasks 1–5 avoid Layout visual files. Task 6 is explicitly blocked on the other UX landing and requires a fresh audit before UI edits.
