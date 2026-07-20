# Lightweaver Repeatable Card Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a genuinely blank ESP32-S3 into a project-loaded, visibly verified Lightweaver card through Studio without dead ends or unverified green states.

**Architecture:** Firmware exposes one authoritative provisioning/readiness envelope and keeps factory output separate from known-good project output. Studio normalizes that envelope into a fail-closed state machine shared by direct HTTP and the HTTPS card-page bridge, then correlates flash, WiFi handoff, project readback, physical confirmation, and final readiness to one card/run/boot. Existing transactional wiring candidates and production jobs remain the mutation path; this work hardens their evidence and batch reset behavior rather than replacing them.

**Tech Stack:** ESP32-S3 Arduino/C++ with FastLED and ArduinoJson; React 18/Vite; Node `node:test`; Playwright; PlatformIO; GitHub Actions.

---

## File map

- `firmware/lightweaver-controller/src/LightweaverProvisioningPolicy.h`: pure constants and fail-closed phase/readiness helpers that native tests can compile without Arduino hardware.
- `firmware/lightweaver-controller/src/LightweaverTypes.h`: runtime configuration/load metadata extended with known-good and validity truth.
- `firmware/lightweaver-controller/src/LightweaverStorage.cpp`: blank/default behavior, configuration-source truth, removable-storage reset rules, and status serialization.
- `firmware/lightweaver-controller/src/main.cpp`: per-boot identity, output readiness, factory beacon sequencing, and exact command acknowledgements.
- `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h`: narrow accessors used by the web/status layer.
- `firmware/lightweaver-controller/src/LightweaverWeb.cpp`: readiness responses, bridge relay fields, sequential discovery API, and truthful reset/control errors.
- `firmware/lightweaver-controller/tests/provisioning-policy.cpp`: native tests for blank readiness and safe GPIO sequencing.
- `firmware/lightweaver-controller/tests/provisioning-status-contract.mjs`: source/API contract checks for the hardware-bound status implementation.
- `lightweaver/src/lib/cardReadiness.js`: one Studio parser and state classifier for fresh firmware evidence.
- `lightweaver/src/lib/cardReadiness.test.js`: unit tests for unknown, blank, reboot, mismatch, and ready states.
- `lightweaver/src/lib/cardLink.js`: direct/bridge keepalive validation and reboot demotion.
- `lightweaver/src/lib/cardCommissioningFlow.js`: persisted pairing separated from fresh readiness and clean next-card reset.
- `lightweaver/src/lib/cardPushClient.js`: exact card/project/boot evidence and independent readback.
- `lightweaver/src/v3/lw-production.jsx`: post-flash boot verification, AP-to-LAN reacquisition, project verification, and final run gate.
- `lightweaver/src/components/production/ProductionPhysicalTest.jsx`: sequential pin discovery and final promoted-config readiness probe.
- `lightweaver/tests/card-link-state.mjs`: direct/bridge keepalive and reboot tests.
- `lightweaver/tests/production-setup.spec.ts`: complete fail-closed production workflow tests.
- `lightweaver/tests/card-workspace.spec.ts`: worker-visible blank/reconnecting/readiness copy tests.
- `lightweaver/package.json` and `lightweaver/scripts/run-core-source-tests.mjs`: complete launch-gate coverage.
- `.github/workflows/test.yml`, `.github/workflows/build-firmware.yml`, `.github/workflows/deploy-site.yml`: relevant source/job trigger coverage and native firmware test execution.
- `docs/card-provisioning-audit.md`: final evidence-backed audit, replacing speculative statements.
- `docs/card-provisioning-checklist.md`: one-page worker checklist.
- `docs/card-provisioning-fixes.md`: implemented-control map and remaining release dependency, not a future-tense wish list.
- `docs/card-provisioning-hardware-acceptance.md`: witnessed real-card record.

### Task 1: Define the fail-closed readiness contract in Studio

**Files:**
- Create: `lightweaver/src/lib/cardReadiness.js`
- Create: `lightweaver/src/lib/cardReadiness.test.js`
- Modify: `lightweaver/src/lib/cardConnectionFlow.js`
- Modify: `lightweaver/src/lib/cardConnectionFlow.test.js`

- [ ] **Step 1: Write failing parser tests**

Add `node:test` cases showing that missing `knownGoodProject`, `commandReady`, `outputReady`, `bootId`, or valid identity yields `checking`, factory evidence yields `blank`, an unexpected card yields `identity-mismatch`, and only complete fresh evidence yields `connected`.

```js
test('unknown project state never becomes connected', () => {
  const result = classifyCardReadiness({
    cardId: 'lw-aabbccddeeff', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
    bootId: 'boot-1', runtimePhase: 'ready', commandReady: true, outputReady: true,
  }, { expectedCardId: 'lw-aabbccddeeff' });
  assert.equal(result.state, 'checking');
  assert.equal(result.connected, false);
});

test('factory card is blank even though its command API is alive', () => {
  const result = classifyCardReadiness(readyEnvelope({
    runtimePhase: 'factory', knownGoodProject: false,
  }), { expectedCardId: 'lw-aabbccddeeff' });
  assert.equal(result.state, 'blank');
  assert.equal(result.connected, false);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd lightweaver && node --test src/lib/cardReadiness.test.js src/lib/cardConnectionFlow.test.js`

Expected: FAIL because `cardReadiness.js` and fail-closed connection transitions do not exist.

- [ ] **Step 3: Implement the minimal normalizer and classifier**

Export `normalizeCardReadiness(raw)` and `classifyCardReadiness(raw, { expectedCardId, previousBootId })`. Require Lightweaver identity, a supported contract version, explicit booleans, and nonempty boot ID. Return immutable fields including `state`, `connected`, `blank`, `cardId`, `bootId`, `runtimePhase`, and `reason`.

```js
if (!normalized.identityValid || normalized.knownGoodProject === null
  || normalized.commandReady === null || normalized.outputReady === null
  || !normalized.bootId) return result('checking', normalized);
if (expectedCardId && normalized.cardId !== expectedCardId) return result('identity-mismatch', normalized);
if (!normalized.knownGoodProject || normalized.runtimePhase === 'factory') return result('blank', normalized);
if (previousBootId && normalized.bootId !== previousBootId) return result('revalidating', normalized);
if (normalized.runtimePhase !== 'ready' || !normalized.commandReady || !normalized.outputReady) return result('not-ready', normalized);
return result('connected', normalized, { connected: true });
```

Update `cardConnectionFlow.js` so persistence never substitutes `false` for an unknown blank state and so `isCardLinkConnected` consumes classified fresh evidence rather than transport state alone.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `cd lightweaver && node --test src/lib/cardReadiness.test.js src/lib/cardConnectionFlow.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lightweaver/src/lib/cardReadiness.js lightweaver/src/lib/cardReadiness.test.js lightweaver/src/lib/cardConnectionFlow.js lightweaver/src/lib/cardConnectionFlow.test.js
git commit -m "feat(studio): define truthful card readiness"
```

### Task 2: Make firmware report authoritative provisioning truth

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverProvisioningPolicy.h`
- Create: `firmware/lightweaver-controller/tests/provisioning-policy.cpp`
- Create: `firmware/lightweaver-controller/tests/provisioning-status-contract.mjs`
- Modify: `firmware/lightweaver-controller/src/LightweaverTypes.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h`
- Modify: `firmware/lightweaver-controller/src/main.cpp`

- [ ] **Step 1: Write failing native and source-contract tests**

Cover explicit factory/known-good/corrupt phases, readiness requiring initialized outputs for a known-good project, approved GPIO order `{16,17,18,21}`, per-boot ID/uptime fields, and config truth fields in `/api/status`.

```cpp
TEST_CASE("factory runtime is blank and never command-ready") {
  ProvisioningInputs input{false, true, false, false, false};
  CHECK(lightweaverProvisioningPhase(input) == ProvisioningPhase::Factory);
  CHECK_FALSE(lightweaverCommandReady(input));
}
```

The source contract must assert serialized fields: `provisioningContractVersion`, `bootId`, `uptimeMs`, `runtimePhase`, `commandReady`, `outputReady`, `configValid`, `knownGoodProject`, `projectRevision`, `projectFingerprint`, `productionJobId`, `productionJobDigest`, and `wiringRevision`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
g++ -std=c++17 firmware/lightweaver-controller/tests/provisioning-policy.cpp -o /tmp/lw-provisioning-policy && /tmp/lw-provisioning-policy
node firmware/lightweaver-controller/tests/provisioning-status-contract.mjs
```

Expected: FAIL because the policy/header and authoritative fields are missing.

- [ ] **Step 3: Add load truth and boot identity**

Extend `RuntimeLoadResult` with `configValid`, `knownGoodProject`, and a phase enum. Generate a boot ID once during `setup()` from `esp_random()` plus the stable card suffix; never persist it. Expose uptime from `millis()`, output initialization, probation/recovery/fault state, and last reset reason through narrow runtime accessors.

Known-good means a successfully parsed canonical known-good NVS value or explicitly accepted SD project. Defaults and corruption fallback both report `knownGoodProject: false`; corruption reports recovery/fault rather than factory-ready.

- [ ] **Step 4: Serialize the complete status envelope**

Keep `/api/status` backward-compatible while adding the provisioning fields. Include card-owned project/job/wiring identity on both `/api/status` and `/api/firmware-info`. Set `commandReady` only when the web runtime is serving, no restart/recovery transition is pending, and the configured output runtime is valid for the reported phase.

- [ ] **Step 5: Make command acknowledgements truthful**

Reject invalid color order, unknown zone, unknown pattern, and commands that affect zero outputs with 4xx JSON. Return the card-owned state revision/affected-output count; do not echo the caller's revision as confirmation unless firmware applied that operation.

- [ ] **Step 6: Run tests and verify GREEN**

Run the two RED commands plus:

```bash
cd lightweaver && node ../firmware/lightweaver-controller/tests/project-identity-contract.mjs
cd lightweaver && node ../firmware/lightweaver-controller/tests/card-identity-capabilities.mjs
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add firmware/lightweaver-controller/src firmware/lightweaver-controller/tests/provisioning-policy.cpp firmware/lightweaver-controller/tests/provisioning-status-contract.mjs
git commit -m "feat(firmware): expose provisioning readiness truth"
```

### Task 3: Replace unsafe factory defaults with a visible bounded beacon

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverProvisioningPolicy.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/tests/provisioning-policy.cpp`
- Create: `firmware/lightweaver-controller/tests/factory-beacon-safety.mjs`
- Modify: `firmware/lightweaver-controller/tests/wiring-safety-api.mjs`
- Modify: `firmware/lightweaver-controller/tests/wiring-safety-regressions.mjs`

- [ ] **Step 1: Write failing factory-beacon tests**

Assert compiled defaults do not claim GPIO16/44/RGB/Aurora as known-good, eligible pins are exactly 16/17/18/21, only one pin carries a nonblack diagnostic at a time, the pixel ceiling and brightness/current caps are conservative, and explicit discovery returns one assignment per step.

```js
assert.deepEqual(readApprovedPins(source), [16, 17, 18, 21]);
assert.match(source, /LW_FACTORY_BEACON_PIXELS\s*=\s*(?:8|16)/);
assert.match(source, /activeDiscoveryPin/);
assert.doesNotMatch(source, /fill_solid\([^;]+Red[^;]+Green[^;]+Blue/s);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node firmware/lightweaver-controller/tests/factory-beacon-safety.mjs
node firmware/lightweaver-controller/tests/wiring-safety-api.mjs
node firmware/lightweaver-controller/tests/wiring-safety-regressions.mjs
```

Expected: FAIL because defaults still drive the GPIO16/44-pixel project and discovery lights four outputs concurrently.

- [ ] **Step 3: Implement factory beacon and sequential discovery**

Change compiled defaults to no project identity and no normal project output. In factory phase, run a separate beacon controller that cycles the four approved outputs with all buffers cleared before each dim pulse. At most one candidate pin may contain nonblack pixels in a frame. Stop the beacon while a command, WiFi transition, candidate test, recovery, or normal known-good runtime owns output.

Change `/api/wiring/discover` from four-color batches to one explicit step with `pin`, `step`, `stepCount`, `brightnessLimit`, `pixelLimit`, and `nextStep`. Preserve the worker confirmation gate; discovery never persists project wiring.

- [ ] **Step 4: Make full reset truthful across storage sources**

The factory-reset handler clears WiFi, legacy/canonical/candidate NVS keys, discovery/recovery markers, and `/lightweaver.json` when writable. If SD removal fails, return an error naming `sd` and do not claim a complete erase. After reboot, `/api/status` must show defaults, `knownGoodProject:false`, and factory phase.

- [ ] **Step 5: Run tests and compile firmware**

Run the three RED commands, then:

```bash
pio run -d firmware/lightweaver-controller -e esp32-s3-n16r8
```

Expected: all tests PASS and PlatformIO exits 0.

- [ ] **Step 6: Commit**

```bash
git add firmware/lightweaver-controller/src firmware/lightweaver-controller/tests
git commit -m "feat(firmware): add safe blank-card beacon"
```

### Task 4: Revalidate exact identity and readiness on direct and bridge links

**Files:**
- Modify: `lightweaver/src/lib/cardLink.js`
- Modify: `lightweaver/src/lib/cardCommissioningFlow.js`
- Modify: `lightweaver/src/lib/cardPushClient.js`
- Modify: `lightweaver/src/lib/cardBridge.js`
- Modify: `lightweaver/src/components/card/CardCommissioningPanel.jsx`
- Modify: `lightweaver/src/components/card/CardStatusControl.jsx`
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/tests/card-link-state.mjs`
- Modify: `lightweaver/tests/card-bridge-handoff.mjs`
- Modify: `lightweaver/tests/card-workspace.spec.ts`

- [ ] **Step 1: Write failing link and UI tests**

Cover unknown blank evidence, blank but reachable card copy, cached bridge ping that lacks readiness, changed boot ID, silent drop, unexpected card, exact-card recovery, and ordinary Connect refusing silent adoption.

```js
link.dispatch({ type: 'bridge-ping-ok', response: { cardId: expectedCardId } });
assert.notEqual(link.getState().state, 'connected-bridge');

link.dispatch({ type: 'status-ok', response: readyEnvelope({ bootId: 'new-boot' }) });
assert.equal(link.getState().state, 'revalidating');
```

Playwright must assert the footer never shows green Connected for `blank`, `checking`, `revalidating`, or `reconnecting` fixtures.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cd lightweaver && node tests/card-link-state.mjs
cd lightweaver && node tests/card-bridge-handoff.mjs
cd lightweaver && npx playwright test tests/card-workspace.spec.ts --project=chromium --workers=1
```

Expected: new cases FAIL against transport-only/cached identity behavior.

- [ ] **Step 3: Require full readiness envelopes on every keepalive**

Direct ping fetches `/api/status` uncached. Bridge ping relays the same endpoint and returns the response body. Feed both through `classifyCardReadiness`; a ping without full evidence only proves transport reachability. A boot change clears command readiness and triggers independent blank/project readback before reconnecting.

- [ ] **Step 4: Make commissioning persistence non-authoritative**

Persist only expected card identity and user acknowledgement. Do not persist `connected`, fresh readiness, or physical success as live state. `clearCardCommissioning({ preserveJob: true })` must erase transient card/boot/operation/activation evidence for the next card.

- [ ] **Step 5: Update worker-visible states**

Use explicit copy: **Blank—load a project**, **Checking card**, **Card restarted—verifying**, **Card stopped responding**, **Wrong card**, and **Ready for light check**. Green Connected appears only for classified `connected` evidence.

- [ ] **Step 6: Run tests and verify GREEN**

Run all three RED commands. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lightweaver/src/lib lightweaver/src/components/card lightweaver/tests/card-link-state.mjs lightweaver/tests/card-bridge-handoff.mjs lightweaver/tests/card-workspace.spec.ts
git commit -m "fix(studio): revalidate card readiness across transports"
```

### Task 5: Verify flash, WiFi return, and project installation in Production Setup

**Files:**
- Modify: `lightweaver/src/v3/lw-production.jsx`
- Modify: `lightweaver/src/lib/cardPushClient.js`
- Modify: `lightweaver/src/lib/productionRun.js`
- Modify: `lightweaver/src/lib/productionRun.test.js`
- Modify: `lightweaver/tests/production-setup.spec.ts`

- [ ] **Step 1: Write failing production transition tests**

Add cases where flash byte transfer completes but no runtime returns, AP disappears before LAN response, another card answers, blank is unknown, readback mismatches, card reboots after readback, and a prior card's completed acknowledgement remains in browser storage.

```js
await driver.finishFlashTransfer();
await expect(page.getByText('Firmware installed')).not.toBeVisible();
await expect(page.getByText('Waiting for the flashed card to boot')).toBeVisible();

await driver.answerLanStatus(readyEnvelope({ cardId: 'lw-wrong' }));
await expect(page.getByText(/Wrong card/)).toBeVisible();
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cd lightweaver && node --test src/lib/productionRun.test.js
cd lightweaver && npx playwright test tests/production-setup.spec.ts --project=chromium --workers=1
```

Expected: new cases FAIL because transfer/transport acknowledgements can still advance the run.

- [ ] **Step 3: Split flash transfer from verified boot**

After `flashFirmwareAndRelease`, transition to `await-runtime`, not restore. Reacquire through the appropriate direct/bridge path and require exact stable card ID, signed version/build, provisioning contract, new boot ID, and factory/blank truth. On timeout, retain a retry/manual-address recovery action and never display install success.

- [ ] **Step 4: Complete AP-to-LAN handoff without a dead address**

Store the expected card ID before the AP drops. Poll all permitted LAN candidates with bounded uncached requests. On HTTPS, reopen/resume the card-page bridge and demand its full fresh status. Add manual address entry after timeout. Advance only on the same card; discard stale flow/operation replies.

- [ ] **Step 5: Require independent project readback**

After staging/activation/reboot, issue a separate GET and compare card ID, boot ID, firmware version/build, project revision/fingerprint, production job ID/digest, wiring revision/digest, and readiness. A POST response or locally expected object cannot satisfy `verify-card`.

- [ ] **Step 6: Run tests and verify GREEN**

Run both RED commands. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lightweaver/src/v3/lw-production.jsx lightweaver/src/lib/cardPushClient.js lightweaver/src/lib/productionRun.js lightweaver/src/lib/productionRun.test.js lightweaver/tests/production-setup.spec.ts
git commit -m "fix(production): verify flash and project evidence"
```

### Task 6: Gate completion on sequential physical confirmation and final readiness

**Files:**
- Modify: `lightweaver/src/components/production/ProductionPhysicalTest.jsx`
- Modify: `lightweaver/src/lib/productionPhysicalTest.js`
- Modify: `lightweaver/src/lib/productionPhysicalTest.test.js`
- Modify: `lightweaver/src/lib/productionRecords.js`
- Modify: `lightweaver/src/lib/productionRecords.test.js`
- Modify: `lightweaver/src/v3/lw-production.jsx`
- Modify: `lightweaver/tests/production-setup.spec.ts`

- [ ] **Step 1: Write failing physical and record tests**

Cover sequential discovery across 16/17/18/21, no persistence from selection alone, failure/timeout rollback, same-run observation correlation, final boot/readiness failure, and Next Card clearing all transient evidence.

```js
assert.deepEqual(nextDiscoveryStep(0), { pin: 16, step: 0, stepCount: 4 });
assert.equal(canCompleteProductionRun({ physicalConfirmed: true, finalReadiness: null }), false);
assert.equal(canCompleteProductionRun({ physicalConfirmed: true, finalReadiness: { connected: true } }), true);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cd lightweaver && node --test src/lib/productionPhysicalTest.test.js src/lib/productionRecords.test.js
cd lightweaver && npx playwright test tests/production-setup.spec.ts --project=chromium --workers=1
```

Expected: new cases FAIL because physical confirmation does not yet include the final readiness gate.

- [ ] **Step 3: Implement the guided discovery and observation gate**

Present one approved pin at a time, use position plus color language, and require the worker to answer **This strip lit** or **No light**. Stage the chosen pin only after confirmation. Continue using blue-first/red-last/dim-middle frames and the existing candidate probation/rollback API.

- [ ] **Step 4: Add final promoted-config verification**

After the last physical observation and candidate promotion, stop frame streaming, perform independent wiring/project readback, then a harmless status/readiness probe. Record completion only if all evidence belongs to the current run/card/boot and the exact promoted config. Network loss returns to reconnecting.

- [ ] **Step 5: Make batch reset complete**

`Next card` clears expected card ID, boot ID, operation/activation IDs, transport state, observations, cached acknowledgements, and recovery state. Preserve the immutable job only when batch mode is explicitly active.

- [ ] **Step 6: Run tests and verify GREEN**

Run both RED commands. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lightweaver/src/components/production/ProductionPhysicalTest.jsx lightweaver/src/lib/productionPhysicalTest.js lightweaver/src/lib/productionPhysicalTest.test.js lightweaver/src/lib/productionRecords.js lightweaver/src/lib/productionRecords.test.js lightweaver/src/v3/lw-production.jsx lightweaver/tests/production-setup.spec.ts
git commit -m "feat(production): require witnessed final light check"
```

### Task 7: Put all relevant contracts in CI and replace speculative documentation

**Files:**
- Modify: `lightweaver/package.json`
- Modify: `lightweaver/scripts/run-core-source-tests.mjs`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/build-firmware.yml`
- Modify: `.github/workflows/deploy-site.yml`
- Modify: `docs/card-provisioning-audit.md`
- Modify: `docs/card-provisioning-fixes.md`
- Modify: `docs/card-provisioning-checklist.md`
- Create: `docs/card-provisioning-hardware-acceptance.md`
- Modify: `docs/deployment-checklist.md`

- [ ] **Step 1: Write failing launch-gate/path assertions**

Add a Node contract test that requires all firmware safety suites, the native provisioning test, job generator inputs, `release/job-generators/**`, `release/job-sources/**`, `scripts/rebuild-production-jobs.mjs`, and commissioning source paths to be covered by the test/deploy workflows.

- [ ] **Step 2: Run the contract and verify RED**

Run: `cd lightweaver && node tests/provisioning-launch-gate.mjs`

Expected: FAIL listing omitted suites and workflow paths.

- [ ] **Step 3: Expand the source launch gate and CI triggers**

Add the omitted current-limit, output-color, direction, candidate storage/probation, wiring safety, WLED compatibility, provisioning status, and native parser/policy commands. Update workflow path filters for every production job/release generator input. Keep signed-binary freshness exclusive to the protected main gate.

- [ ] **Step 4: Rewrite the audit and checklist from verified behavior**

The audit must enumerate all seven stages, every former success assumption, the implemented verification, automated test evidence, and the one unavoidable human visual gate. Remove claims that software can see LED light without a sensor. The checklist must fit a single worker-facing page, require shared ground and correct strip voltage, and say STOP whenever a verified Studio gate is absent.

- [ ] **Step 5: Run the complete software verification**

Run:

```bash
cd lightweaver && npm run test:core:source
cd lightweaver && npm run test:unit
cd lightweaver && npm run test:production
cd lightweaver && npm run test:release-ui
cd lightweaver && npm run build
pio run -d firmware/lightweaver-controller -e esp32-s3-n16r8
pio test -d firmware/lightweaver-controller -e native-output-color-parser
```

Expected: all commands exit 0 with no skipped provisioning suites.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/package.json lightweaver/scripts .github/workflows docs
git commit -m "test: gate the complete provisioning pipeline"
```

### Task 8: Perform and record the real-card acceptance run

**Files:**
- Modify: `docs/card-provisioning-hardware-acceptance.md`
- Modify only if a reproduced defect requires it: files owned by the failing task above, with a new failing regression test first.

- [ ] **Step 1: Establish the exact fixture and erase target**

Record USB path, stable card ID, strip type/voltage, shared-ground check, physical data connector, immutable job digest, and build ID. Confirm the destructive erase target is the one connected ESP32-S3 before erasing.

- [ ] **Step 2: Flash a clean local release candidate and verify factory truth**

Build the merged image, erase only the confirmed ESP32-S3, flash it, and capture `/api/status`. Require a new boot ID, factory phase, `knownGoodProject:false`, and no green Connected UI.

- [ ] **Step 3: Witness the factory beacon and WiFi handoff**

With the 12 V WS2815 fixture powered and common ground checked, observe which approved pin lights during the dim sequential beacon. Enter gallery WiFi in the AP page, return the workstation to gallery WiFi, and require Studio to reacquire the same stable card automatically.

- [ ] **Step 4: Install the immutable project and witness the diagnostic**

Install the project, reboot, compare independent card readback, and observe first pixel blue, last pixel red, correct intermediate extent, direction, color order, and current-limited brightness. Confirm only after the physical observation.

- [ ] **Step 5: Exercise fault recovery and batch reset**

Power-cycle or disconnect WiFi while green; verify Studio immediately demotes the card and later revalidates the same card/boot/project. Complete the run, select Next Card, and prove no previous identity or physical success survives.

- [ ] **Step 6: Record evidence and fix any reproduced defect with TDD**

For any failure: write a focused failing automated test, verify RED, implement the smallest fix, verify GREEN, rerun the affected hardware stage, and append observed evidence. Do not mark the run accepted from mocked Playwright results.

- [ ] **Step 7: Verify the production artifact dependency**

The public signed Web Serial path is accepted only after the protected main firmware workflow builds/signs the same source and the live site serves that manifest. If the branch is not merged, record **Local hardware candidate passed; signed production artifact pending protected-main build** rather than claiming production completion.

- [ ] **Step 8: Commit the witnessed result**

```bash
git add docs/card-provisioning-hardware-acceptance.md
git commit -m "test(hardware): record card provisioning acceptance"
```

## Self-review results

- **Spec coverage:** Tasks 1–8 cover the truth model, flash verification, safe blank signal, AP handoff, exact pairing, project readback, physical confirmation, silent-drop/reboot handling, batch reset, CI, audit, checklist, and real-card acceptance.
- **Existing work preserved:** commit `a680454` remains the base for honest connection labels, `f1652e1` remains the base for LAN return detection, and `9e6c2ac` remains the base for idle keepalive; tasks extend their evidence rather than replacing them.
- **Type consistency:** `bootId`, `runtimePhase`, `commandReady`, `outputReady`, `configValid`, and `knownGoodProject` use the same field names from firmware serialization through `cardReadiness.js`, direct/bridge keepalive, production transitions, tests, and records.
- **No false hardware automation:** physical illumination remains a required worker observation; firmware reports only initialization/frame submission.
