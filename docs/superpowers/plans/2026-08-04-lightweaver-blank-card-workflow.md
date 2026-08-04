# Lightweaver Blank-Card Re-entry Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route blank, Ready, and recovery cards safely, keep prohibited pattern taps local, and offer the exact installed Studio project without ever replacing unrelated work silently.

**Architecture:** Firmware sends factory cards to Layout and every configured/recovery card to Hardware overview with edit intent preserved. Studio classifies a complete exact-paired readiness envelope before any card side effect, then a pure resolver compares the card's embedded project ID and commissioning FNV fingerprint against the current workspace, trusted production jobs, active cloud projects, and active browser records in that priority order. Existing `replaceProject`/`cloudLibrary.openProject` guards remain the only project-replacement boundary.

**Tech Stack:** ESP32-S3 C++/Arduino WebServer, React 18, Vite, Node test runner, Playwright.

---

## File map

- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp` — emit state-specific Studio URLs and commissioning CTA copy.
- Test: `firmware/lightweaver-controller/tests/blank-card-commissioning-surface.mjs` — source-contract coverage for factory, recovery, and Ready routes.
- Modify: `lightweaver/src/lib/cardReadiness.js` — classify only explicit factory evidence as blank and expose recovery/checking distinctly.
- Test: `lightweaver/src/lib/cardReadiness.test.js` — readiness truth table and incomplete/wrong-card rejection.
- Modify: `lightweaver/src/v3/lw-pattern.jsx` — update local pattern state first and gate popup/control/config effects on exact Ready evidence.
- Modify: `lightweaver/src/components/card/CardStatusControl.jsx` — label factory setup, recovery, and checking without presenting them as connected.
- Test: `lightweaver/tests/patterns-v3.spec.ts` — blank/recovery local-only taps and Ready acknowledged preview.
- Modify: `lightweaver/src/lib/cardIdentity.js` — preserve `piece.id` as `projectId` in normalized firmware evidence.
- Test: `lightweaver/src/lib/cardIdentity.test.js` — prove exact embedded project identity survives normalization.
- Create: `lightweaver/src/lib/cardProjectResolver.js` — pure exact-match resolver and commissioning snapshot fingerprint helper use.
- Create: `lightweaver/src/lib/cardProjectResolver.test.js` — priority, equality, ambiguity, false-match, and stale-response tests.
- Modify: `lightweaver/src/v3/lw-card.jsx` — resolve/offer/load the installed project, then consume pending edit intent once.
- Modify: `lightweaver/src/v3/app.jsx` — pass current serialized project and cloud-library candidates/loaders into Card overview.
- Test: `lightweaver/tests/card-workspace.spec.ts` — end-to-end resolver, cancellation, and preserved-intent coverage.

### Task 1: Firmware state-specific Studio routing

- [ ] **Step 1: Write the failing firmware source-contract assertions**

In `blank-card-commissioning-surface.mjs`, require `studioSetupUrl()` to end in `#screen=layout`, `studioBridgeUrl()` to end in `#screen=card&section=overview`, both `studioUrlForPattern` copies to preserve `editPattern`/`editLook` while using Hardware overview, and factory markup to say `Set up LED strips and install on card`. Keep recovery copy `Recover and verify card` and the AP instruction to rejoin gallery WiFi.

- [ ] **Step 2: Run the focused test and verify the route assertions fail**

Run: `node firmware/lightweaver-controller/tests/blank-card-commissioning-surface.mjs`

Expected: FAIL because `studioBridgeUrl` and `lwOpenStudio` still use `#screen=patterns` and `studioSetupUrl` does not exist.

- [ ] **Step 3: Implement the fixed routes in `LightweaverWeb.cpp`**

Add `studioSetupUrl(const RuntimeConfig&)` beside `studioBridgeUrl`. Both retain fixed `https://led.mandalacodes.com`, `cardBridge=1`, and `cardHost=cardBridgeHost(cfg)`; setup appends `#screen=layout`, while bridge appends `#screen=card&section=overview`. Make `lwOpenStudio` preserve only bounded `editPattern`/`editLook` and the requested safe hash. Use `factoryBlank ? studioSetupUrl(cfg) : studioBridgeUrl(cfg)` for commissioning and route both Ready edit helpers through overview.

- [ ] **Step 4: Run the firmware tests**

Run: `node firmware/lightweaver-controller/tests/blank-card-commissioning-surface.mjs && node firmware/lightweaver-controller/tests/project-identity-contract.mjs && node firmware/lightweaver-controller/tests/wifi-project-preservation.mjs`

Expected: all three print their `tests passed` messages.

- [ ] **Step 5: Commit the firmware slice**

```bash
git add firmware/lightweaver-controller/src/LightweaverWeb.cpp firmware/lightweaver-controller/tests/blank-card-commissioning-surface.mjs
git commit -m "fix: route cards through safe Studio entry"
```

### Task 2: Studio readiness and pattern side-effect guard

- [ ] **Step 1: Add failing readiness and Playwright cases**

In `cardReadiness.test.js`, assert these exact results: factory + `knownGoodProject:false` + `mode:'factory-flash'` + `source:'defaults'` is `blank`; recovering + `knownGoodProject:true` is `not-ready`; recovering + `knownGoodProject:false` is also `not-ready`; missing booleans, unsupported contract, wrong card/build, or changed boot is never blank/connected. In `patterns-v3.spec.ts`, click Ocean for exact factory, recovery, and Ready envelopes and record `window.open`, `/api/control`, and `/api/config` calls.

- [ ] **Step 2: Run the tests and verify unsafe cases fail**

Run: `cd lightweaver && node --test src/lib/cardReadiness.test.js && npx playwright test tests/patterns-v3.spec.ts --project=chromium --workers=1`

Expected: FAIL because non-factory `knownGoodProject:false` is currently classified blank and pattern taps can begin card acquisition before readiness is proven.

- [ ] **Step 3: Tighten classification and guard the pattern path**

In `classifyCardReadiness`, return `blank` only when the exact paired complete envelope has `runtimePhase === 'factory'`, `knownGoodProject === false`, `commandReady === false`, and raw `mode === 'factory-flash'`/`source === 'defaults'`; return `not-ready` for every complete non-factory envelope that is not exact Ready. In `lw-pattern.jsx`, keep `setActivePatternId` and `updatePreviewLook(..., {push:false})` first, then stop unless `cardLink.readiness` matches the paired card/build/boot and all four Ready fields. On stop, increment the preview sequence so a late response cannot replay the tap; show `Set up LED strips and install on card` for blank and `Recover and verify card` for recovery. Do not call `openLocalCardPage`, `/api/control`, or `/api/config` from prohibited branches.

- [ ] **Step 4: Prove all three paths**

Run: `cd lightweaver && node --test src/lib/cardReadiness.test.js && npx playwright test tests/patterns-v3.spec.ts --project=chromium --workers=1`

Expected: PASS; Ocean is selected locally in all states, blank/recovery have zero popup/control/config calls, and Ready receives an acknowledged Ocean control response.

- [ ] **Step 5: Commit the Studio safety slice**

```bash
git add lightweaver/src/lib/cardReadiness.js lightweaver/src/lib/cardReadiness.test.js lightweaver/src/v3/lw-pattern.jsx lightweaver/src/components/card/CardStatusControl.jsx lightweaver/tests/patterns-v3.spec.ts
git commit -m "fix: guard pattern preview by exact card readiness"
```

### Task 3: Exact active-project resolver and guarded loading

- [ ] **Step 1: Write resolver and normalization tests first**

Create table-driven tests with evidence `{projectId:'piece-7', projectRevision:12, projectFingerprint:'a'.repeat(16), productionJobId:'job-7', productionJobDigest:'b'.repeat(64)}`. Prove priority `current > production > active-cloud > active-browser`; cloud candidates require exact `embeddedProjectId` then fetched-document FNV equality; browser candidates require exact `record.project.id` plus FNV equality; production requires all four job fields; current requires ID plus FNV. Assert title-only, ID-only, SHA-256 `hash`, stale revision/fingerprint/digest, archived-only, and duplicate exact matches return no automatic selection. Add a normalization assertion that `piece:{id:'piece-7'}` becomes `projectId:'piece-7'`.

- [ ] **Step 2: Run the focused unit tests and verify they fail**

Run: `cd lightweaver && node --test src/lib/cardIdentity.test.js src/lib/cardProjectResolver.test.js`

Expected: FAIL because `piece.id` is dropped and `cardProjectResolver.js` does not exist.

- [ ] **Step 3: Implement the pure resolver contract**

Export `resolveInstalledCardProject({ evidence, currentProject, productionJobs, cloudProjects, browserRecords })` returning `{status:'current'|'single'|'ambiguous'|'none', priority, matches}`; each match is `{kind,id,label,document,open}`. Compute only `fingerprintCommissioningProject(cardRestoreSnapshot(candidate))`, where the snapshot contains version/id/name, layout strips/patchBoard/wiring, and standaloneController. Never compare cloud SHA-256 metadata. Filter `cloudProjects` to `archived === false`; use `listProjectLibraryRecords()` for active browser records. If more than one exact match exists at the winning priority, return `ambiguous`.

- [ ] **Step 4: Integrate the offer without silent replacement**

In `app.jsx`, pass `serializeProject()`, `cloudLibrary.activeProjects`, `cloudLibrary.openProject`, and browser records to `CardScreen`. In `lw-card.jsx`, capture `editPattern`/`editLook` as pending intent on overview, resolve against fresh exact firmware evidence, and render: `Already open` for current, a named `Open matching project` button for one match, explicit buttons for ambiguity, or recovery guidance for none. Delegate cloud loads to `cloudLibrary.openProject` and document/production/browser loads to `replaceProject`; on cancellation or failure leave the URL intent and workspace untouched. Only after a successful/current exact match, navigate to `#screen=patterns` with the same search intent so `lw-pattern.jsx` consumes it once.

- [ ] **Step 5: Run resolver and browser acceptance tests**

Run: `cd lightweaver && node --test src/lib/cardIdentity.test.js src/lib/cardProjectResolver.test.js && npx playwright test tests/card-workspace.spec.ts --project=chromium --workers=1`

Expected: PASS for current, production, active-cloud, active-browser, ambiguous, no-match, dirty-cancel, and preserved-intent cases.

- [ ] **Step 6: Commit the resolver slice**

```bash
git add lightweaver/src/lib/cardIdentity.js lightweaver/src/lib/cardIdentity.test.js lightweaver/src/lib/cardProjectResolver.js lightweaver/src/lib/cardProjectResolver.test.js lightweaver/src/v3/lw-card.jsx lightweaver/src/v3/app.jsx lightweaver/tests/card-workspace.spec.ts
git commit -m "feat: resolve the exact project installed on a card"
```

### Task 4: Integration and staged-install regression verification

- [ ] **Step 1: Extend workflow coverage for races and the existing install boundary**

In `card-workspace.spec.ts`, delay resolver reads, then change card ID, host, build, boot ID, and project generation one at a time; each stale result must be ignored. In `layout-send-to-card.spec.ts`, retain assertions that config is staged, physical LEDs are activated/tested, matching activation is explicitly confirmed, and timeout/rejection/reboot/abandonment leaves known-good identity unchanged.

- [ ] **Step 2: Run the cross-surface regression set**

Run: `cd lightweaver && npx playwright test tests/patterns-v3.spec.ts tests/card-workspace.spec.ts tests/layout-send-to-card.spec.ts --project=chromium --workers=1`

Expected: all tests pass with no prohibited card writes and no staged-wiring regression.

- [ ] **Step 3: Run source-contract and production build verification**

Run: `cd lightweaver && npm run test:core:source && npm run build`

Expected: source tests pass and Vite completes a production build without errors.

- [ ] **Step 4: Run the launch gate**

Run: `cd lightweaver && npm run launch:check`

Expected: the complete Studio, firmware-contract, artifact, and firmware-binary freshness checks pass.

- [ ] **Step 5: Commit any integration-only test additions**

```bash
git add lightweaver/tests/card-workspace.spec.ts lightweaver/tests/layout-send-to-card.spec.ts
git commit -m "test: lock card re-entry workflow end to end"
```
