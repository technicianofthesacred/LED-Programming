# Hardware Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish one tested multi-card project model, connection registry, output-calibration prerequisite, and voltage-aware power contract before changing the navigation.

**Architecture:** Project v4 stores controller instances only in `devices.cards[]`; compatibility selectors keep existing single-card screens working while they migrate. Card connections are keyed by logical card record and verified hardware identity. Power calculations are explicit inputs shared by recommendations and firmware/package limits.

**Tech Stack:** React 18, Vite, Node test runner, Playwright, ESP32-S3 C++ firmware, existing Lightweaver card JSON/bridge APIs.

---

### Task 1: Selectively port output correctness onto current production safety

**Files:**
- Reference source only: branch `codex/led-output-correctness`
- Modify: `firmware/lightweaver-controller/src/`
- Modify: `lightweaver/src/lib/cardRuntimeContract.js`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`
- Modify: `lightweaver/src/lib/standaloneController.js`
- Modify: `lightweaver/src/lib/productionJobPackage.js`
- Modify: `lightweaver/src/lib/productionJobPackage.test.js`
- Modify: `release/production-job.schema.json`
- Test: `lightweaver/tests/card-runtime-contract.mjs`
- Test: `lightweaver/tests/card-live-preview.mjs`

- [ ] **Step 1: Inventory the safe port boundary**

```bash
git status --short
git rev-parse HEAD
git merge-base main codex/led-output-correctness
git diff --name-status main..codex/led-output-correctness -- firmware/lightweaver-controller/src lightweaver/src/lib/cardRuntimeContract.js lightweaver/src/lib/cardRuntimeProject.js lightweaver/src/lib/standaloneController.js lightweaver/tests/card-runtime-contract.mjs lightweaver/tests/card-live-preview.mjs
cd lightweaver && npm run test:core:source
```

Expected: tests pass. Record output-color-specific files/commits as reference; do not merge or cherry-pick changes that delete current production, commissioning, native Bridge, identity, current-limit, or wiring-safety behavior.

- [ ] **Step 2: Write failing current-main contract tests**

Add runtime/package assertions:

```js
const normalized = normalizeCardRuntimeConfig({ led: {
  outputGammaEnabled: true,
  outputGammaValue: 2.4,
  calibration: { red: 0.8, green: 0.9, blue: 0.7 },
}});
assert.equal(normalized.led.outputGammaEnabled, true);
assert.equal(normalized.led.outputGammaValue, 2.4);
assert.deepEqual(normalized.led.calibration, { red: 0.8, green: 0.9, blue: 0.7 });
```

Extend production-package tests so a new selected-card schema accepts normalized output fields while the existing schema/version still validates old signed jobs unchanged.

- [ ] **Step 3: Run tests and verify RED**

```bash
cd lightweaver
node tests/card-runtime-contract.mjs
node tests/card-live-preview.mjs
node --test src/lib/productionJobPackage.test.js
```

Expected: FAIL because current main does not implement output gamma/RGB fields or the compatible production schema extension.

- [ ] **Step 4: Port only the output-color implementation**

Recreate the prerequisite's centralized output-color pipeline and parsers on top of current firmware. Preserve current `maxMilliamps` default/clamps, project/job identity, wiring evidence, commissioning, native Bridge, and production APIs. Extend the production schema with a new selected-card/config version whose output fields are optional and normalized; keep old signed-job validation compatible.

- [ ] **Step 5: Verify GREEN and retained production behavior**

```bash
cd lightweaver
node tests/card-runtime-contract.mjs
node tests/card-live-preview.mjs
node ../firmware/lightweaver-controller/tests/output-color-pipeline.mjs
node --test src/lib/productionJobPackage.test.js
npm run test:production
npm run test:core:source
npm run build
```

Expected: every command exits 0; old signed jobs still validate, selected-card packages preserve output calibration, and current production safety remains present.

- [ ] **Step 6: Commit**

```bash
git add firmware/lightweaver-controller/src lightweaver/src/lib/cardRuntimeContract.js lightweaver/src/lib/cardRuntimeProject.js lightweaver/src/lib/standaloneController.js lightweaver/src/lib/productionJobPackage.js lightweaver/src/lib/productionJobPackage.test.js lightweaver/tests/card-runtime-contract.mjs lightweaver/tests/card-live-preview.mjs release/production-job.schema.json
git commit -m "feat: port calibrated LED output onto current production"
```

### Task 2: Add the canonical project-v4 card model

**Files:**
- Create: `lightweaver/src/lib/hardwareCards.js`
- Create: `lightweaver/src/lib/hardwareCards.test.js`
- Modify: `lightweaver/src/lib/projectModel.js`
- Modify: `lightweaver/src/lib/projectModel.test.js`
- Modify: `lightweaver/src/state/ProjectContext.jsx`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`
- Modify: `lightweaver/src/lib/wiringModel.js`
- Modify: `lightweaver/src/lib/wiringModel.test.js`
- Test: `lightweaver/tests/card-runtime-contract.mjs`
- Test: `lightweaver/tests/layout-migration.mjs`

- [ ] **Step 1: Write failing normalization and migration tests**

Add tests proving this public shape:

```js
const card = normalizeHardwareCard({
  id: 'controller-north',
  name: 'North controller',
  cardId: 'lw-aabbccddeeff',
  hostHint: 'lightweaver-aabb.local',
  controller: defaultStandaloneController(),
});

assert.equal(card.id, 'controller-north');
assert.equal(card.cardId, 'lw-aabbccddeeff');
assert.notEqual(card.controller.outputs, DEFAULT_STANDALONE_OUTPUTS);
```

Add v3→v4 migration assertions:

```js
const migrated = migrateProject(v3Project);
assert.equal(migrated.version, 4);
assert.equal(migrated.devices.cards.length, 1);
assert.deepEqual(migrated.devices.cards[0].controller, v3Project.devices.standaloneController);
assert.equal(migrated.devices.cards[0].hostHint, v3Project.devices.wledIp);
assert.equal('standaloneController' in migrated.devices, false);
```

Also prove:

```js
assert.deepEqual(migrated.layout.wiring.routes[0].runIds, v3Project.layout.wiring.outputs[0].runIds);
assert.equal('pin' in migrated.layout.wiring.routes[0], false);
assert.equal(migrated.devices.cards[0].controller.outputs[0].pin, v3Project.layout.wiring.outputs[0].pin);
assert.equal(validateCardOutputs([{ pin: 5 }]).ok, true); // card A
assert.equal(validateCardOutputs([{ pin: 5 }]).ok, true); // card B may reuse GPIO 5
assert.equal(validateCardOutputs([{ pin: 5 }, { pin: 5 }]).ok, false); // duplicate within one card
```

Prove each card can independently use the supported full output count, two cards round-trip independently, v1/v2/v3 migration is idempotent, and mutating one card does not mutate another or its template source.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd lightweaver
node --test src/lib/hardwareCards.test.js src/lib/projectModel.test.js
```

Expected: FAIL because `hardwareCards.js` and project version 4 do not exist.

- [ ] **Step 3: Implement focused card normalization**

Create exports with these signatures:

```js
export const HARDWARE_CARD_SCHEMA_VERSION = 1;
export function createHardwareCardId() {}
export function normalizeHardwareCard(value = {}, options = {}) {}
export function normalizeHardwareCards(values, options = {}) {}
export function activeHardwareCard(cards, activeCardId) {}
export function updateHardwareCard(cards, cardId, updater) {}
export function migrateLegacyDevices(devices = {}) {}
```

The normalized card must contain `id`, `name`, `cardId`, `supersededCardIds`, `hostHint`, `transportHint`, `templateRef`, `controller`, `approval`, `verification`, and `history`. Generate IDs only when missing; preserve unknown legacy profile material under a migration note. Add route-only wiring normalization and card-scoped output validation; never validate GPIO uniqueness across different cards.

- [ ] **Step 4: Upgrade project serialization and compatibility state**

Set `PROJECT_VERSION = 4`. New and migrated projects serialize `devices.cards`, `devices.activeCardId`, `devices.powerDomains`, `devices.hardwareTemplates`, and `devices.hardwareSnapshots`. Split legacy `layout.wiring.outputs` into route-only geometry plus first-card output assignments. In `ProjectContext`, keep the existing `standaloneController` getter/setter API temporarily, but derive it from the active card and route writes through `updateHardwareCard`; never keep a second mutable copy.

Update card package construction to accept the active card's `controller` while preserving the legacy caller signature during the migration.

- [ ] **Step 5: Verify GREEN and compatibility**

```bash
cd lightweaver
node --test src/lib/hardwareCards.test.js src/lib/projectModel.test.js src/lib/wiringModel.test.js
node tests/card-runtime-contract.mjs
node tests/layout-migration.mjs
npm run test:core:source
```

Expected: PASS, including two-card round-trip and unchanged single-card runtime packages.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/hardwareCards.js lightweaver/src/lib/hardwareCards.test.js lightweaver/src/lib/projectModel.js lightweaver/src/lib/projectModel.test.js lightweaver/src/state/ProjectContext.jsx lightweaver/src/lib/cardRuntimeProject.js lightweaver/src/lib/wiringModel.js lightweaver/src/lib/wiringModel.test.js lightweaver/tests/card-runtime-contract.mjs lightweaver/tests/layout-migration.mjs
git commit -m "feat: add canonical multi-card project model"
```

### Task 3: Add a per-card connection registry with singleton compatibility

**Files:**
- Create: `lightweaver/src/lib/cardConnectionRegistry.js`
- Create: `lightweaver/src/lib/cardConnectionRegistry.test.js`
- Create: `lightweaver/src/hooks/useCardConnectionRegistry.js`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/lib/cardConnection.js`
- Modify: `lightweaver/src/lib/cardLink.js`
- Modify: `lightweaver/src/lib/cardIdentity.js`
- Modify: `lightweaver/src/lib/cardBridge.js`
- Test: `lightweaver/tests/card-link-state.mjs`
- Test: `lightweaver/tests/card-connection-mode.mjs`
- Test: `lightweaver/tests/card-bridge-handoff.mjs`

- [ ] **Step 1: Write failing registry tests**

Prove that two logical cards retain independent hosts, link states, verified physical identities, and errors:

```js
let state = createCardConnectionRegistry();
state = reduceCardConnectionRegistry(state, { type: 'REGISTER', projectCardId: 'north', hostHint: 'north.local' });
state = reduceCardConnectionRegistry(state, { type: 'REGISTER', projectCardId: 'south', hostHint: 'south.local' });
state = reduceCardConnectionRegistry(state, { type: 'VERIFIED', projectCardId: 'north', cardId: 'lw-north' });

assert.equal(selectCardConnection(state, 'north').cardId, 'lw-north');
assert.equal(selectCardConnection(state, 'south').hostHint, 'south.local');
assert.equal(selectCardConnection(state, 'south').cardId, '');
```

Add a rejection test for assigning the same verified hardware `cardId` to two active logical cards without an explicit supersession operation.

Add migration/adoption tests: scan the complete project library and adopt the existing singleton identity/host only when exactly one project contains exactly one eligible migrated unpaired card with an empty/matching host and no competing identity/host. Multiple candidate projects, unavailable library data, multiple cards, or conflicting evidence returns `needs-explicit-pairing`. Add a wrong-card reply test proving an expected identity for `north` cannot update `south`, and prove per-card card-page/native Bridge window/session names do not collide.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd lightweaver
node --test src/lib/cardConnectionRegistry.test.js
```

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement the pure registry and hook**

Expose:

```js
export function createCardConnectionRegistry(initialCards = []) {}
export function reduceCardConnectionRegistry(state, action) {}
export function selectCardConnection(state, projectCardId) {}
export function activeCardConnection(state, activeCardId) {}
```

Use the existing `cardLink` state values for each entry. Keep origin/host validation and verified identity checks in existing libraries; the registry coordinates them but must not weaken them.

The React hook owns one registry, synchronizes project card additions/removals, and exposes a compatibility active-card link so existing screens continue receiving one `cardLink` during UI migration. Every mutation injects the expected logical record and physical card identity. Preserve both the card-page Bridge and current native desktop Bridge; instance/window/session names are card-scoped.

- [ ] **Step 4: Wire the shell through the active-card adapter**

Replace the shell's single connection state ownership with the registry hook while preserving `cardHost`, `connected`, connection-center behavior, and status-bar behavior for the active card.

- [ ] **Step 5: Verify GREEN and existing link behavior**

```bash
cd lightweaver
node --test src/lib/cardConnectionRegistry.test.js
node tests/card-link-state.mjs
node tests/card-connection-mode.mjs
node tests/card-bridge-handoff.mjs
npm run test:screen-recovery
npm run build
```

Expected: PASS; the status bar still behaves as before for a single-card project.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/cardConnectionRegistry.js lightweaver/src/lib/cardConnectionRegistry.test.js lightweaver/src/hooks/useCardConnectionRegistry.js lightweaver/src/v3/app.jsx lightweaver/src/lib/cardConnection.js lightweaver/src/lib/cardLink.js lightweaver/src/lib/cardIdentity.js lightweaver/src/lib/cardBridge.js lightweaver/tests/card-link-state.mjs lightweaver/tests/card-connection-mode.mjs lightweaver/tests/card-bridge-handoff.mjs
git commit -m "feat: track connections per project card"
```

### Task 4: Unify voltage-aware power planning and firmware limits

**Files:**
- Create: `lightweaver/src/lib/powerDomains.js`
- Create: `lightweaver/src/lib/powerDomains.test.js`
- Create: `lightweaver/src/lib/ledPowerModel.js`
- Create: `lightweaver/src/lib/ledPowerModel.test.js`
- Modify: `lightweaver/src/lib/controllerProfiles.js`
- Create: `lightweaver/src/lib/controllerProfiles.test.js`
- Modify: `lightweaver/src/lib/productionJobPackage.js`
- Modify: `lightweaver/src/lib/cardRuntimeContract.js`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`
- Modify: `firmware/lightweaver-controller/src/LightweaverTypes.h`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Test: `lightweaver/src/lib/productionPhysicalTest.test.js`
- Test: `lightweaver/tests/card-runtime-contract.mjs`

- [ ] **Step 1: Write failing power-model tests**

Define explicit inputs and conservative results:

```js
const result = calculateLedPower({
  domain: { id: 'rail-a', volts: 12, supplyAmps: 15, supplyCount: 2, derating: 0.8 },
  assignedOutputs: [
    { cardId: 'north', outputId: 'out-1', pixels: 240, milliampsPerPixel: 12, brightnessLimit: 0.65 },
    { cardId: 'south', outputId: 'out-1', pixels: 240, milliampsPerPixel: 12, brightnessLimit: 0.65 },
  ],
  firmwareMaxMilliamps: 20000,
});

assert.equal(result.estimatedMilliamps, 3744);
assert.equal(result.usableSupplyMilliamps, 24000);
assert.equal(result.safe, true);
assert.equal(result.recommendedFirmwareLimitMilliamps, 20000);
```

Add 5V/60mA, invalid-voltage, missing-current-profile, over-budget, and firmware-clamp cases. Prove a shared domain is aggregated once across two cards and an output cannot be assigned to two power domains. Never infer voltage from strip marketing names.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd lightweaver
node --test src/lib/ledPowerModel.test.js
```

Expected: FAIL because the power model does not exist.

- [ ] **Step 3: Implement the shared pure calculation**

Export:

```js
export function normalizeLedElectricalProfile(input = {}) {}
export function calculateLedPower(input = {}) {}
export function recommendedSessionTestCap(input = {}) {}
```

`powerDomains.js` normalizes project-level domains and output assignments. Return normalized inputs, uncapped aggregate estimate, usable derated capacity, per-card recommended persistent limits, safe diagnostic frame intensities, margin, and reason codes. Do not silently substitute a voltage when it is absent; return an incomplete result that recommendations can explain.

- [ ] **Step 4: Replace conflicting profile math and align packages/readback**

Make `estimatePowerBudget` delegate to `calculateLedPower`. Ensure each selected-card package writes its approved `maxMilliamps`, and readback comparison checks it. Firmware must continue applying a per-card aggregate cap and self-reporting estimated, limited, and configured current evidence; project-level shared-domain aggregation remains in Studio. Low-power tests reduce diagnostic frame intensity and never rewrite persistent `maxMilliamps`.

- [ ] **Step 5: Verify GREEN and retained production safety**

```bash
cd lightweaver
node --test src/lib/powerDomains.test.js src/lib/ledPowerModel.test.js src/lib/controllerProfiles.test.js src/lib/productionPhysicalTest.test.js
node tests/card-runtime-contract.mjs
npm run test:production
npm run test:core:source
npm run build
```

Expected: PASS; production still rejects changed aggregate current evidence.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/powerDomains.js lightweaver/src/lib/powerDomains.test.js lightweaver/src/lib/ledPowerModel.js lightweaver/src/lib/ledPowerModel.test.js lightweaver/src/lib/controllerProfiles.js lightweaver/src/lib/controllerProfiles.test.js lightweaver/src/lib/productionJobPackage.js lightweaver/src/lib/cardRuntimeContract.js lightweaver/src/lib/cardRuntimeProject.js lightweaver/src/lib/productionPhysicalTest.test.js lightweaver/tests/card-runtime-contract.mjs firmware/lightweaver-controller/src/LightweaverTypes.h firmware/lightweaver-controller/src/main.cpp
git commit -m "feat: unify LED power and current-limit rules"
```

### Task 5: Foundation verification checkpoint

**Files:**
- Verify only

- [ ] **Step 1: Run the complete relevant verification**

```bash
cd lightweaver
npm run test:unit
npm run test:core:source
npm run test:production
npm run test:screen-recovery
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 2: Review serialized fixtures and repository diff**

```bash
git diff --check main...HEAD
git status --short
git log --oneline --decorate main..HEAD
```

Expected: no whitespace errors, no generated build artifacts, no unrelated files.
