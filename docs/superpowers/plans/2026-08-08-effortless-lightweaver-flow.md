# Effortless Lightweaver Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make save/load, card discovery, installer handoff, staged configuration, and live control form one resumable, evidence-driven journey that never reports success before the card or browser storage proves it.

**Architecture:** Preserve the existing ESP32-only architecture and local card-page bridge. Studio reserves the named bridge window synchronously, persists projects in an offline-first browser library, and models staged installation as a resumable transaction discovered from card readback. Firmware exposes accurate transaction errors and processes installer payloads whenever a reused card window receives a new hash.

**Tech Stack:** React/Vite Studio, Node source-contract tests, ESP32-S3 Arduino/PlatformIO firmware, embedded card-page JavaScript.

---

### Task 1: One-click discovery and reusable bridge handoff

**Files:**
- Modify: `lightweaver/src/lib/cardBridge.js`
- Modify: `lightweaver/src/v3/lw-setup.jsx`
- Test: `lightweaver/src/lib/cardBridge.openLocalCardPage.test.js`
- Test: `lightweaver/src/v3/lw-setup.test.jsx`

- [ ] **Step 1: Write failing discovery tests**

Add tests proving that the synchronous Find-my-card click reserves the named `lightweaver-card-bridge` window before subnet discovery begins, discovery later navigates that same `WindowProxy`, a blocked reservation produces an honest one-click retry state, and no second popup is requested after the asynchronous scan.

- [ ] **Step 2: Verify the discovery tests fail**

Run the focused Node/Vitest command already used by the surrounding test files. Confirm failure because no reserved-window acquisition API is wired into `findMyCard`.

- [ ] **Step 3: Implement the reserved bridge acquisition**

Add a small `cardBridge.js` API that synchronously opens a safe named placeholder from the user gesture, then accepts a verified local host and navigates the same target with `buildCardBridgeLaunchUrl`. It must revoke stale authority only when a real target exists, preserve identity verification requirements, and never navigate a non-local origin.

- [ ] **Step 4: Wire Setup discovery to the reservation**

In `lw-setup.jsx`, reserve before `await sweepKnownSubnetsForCard`, navigate the reservation after a host is found, and report separate `popup-blocked`, `scan-failed`, and `bridge-timeout` states. A successful subnet probe is not a successful connection; the setup step advances only after the bridge/card link reports verified readiness.

- [ ] **Step 5: Run focused tests and commit**

Run the card bridge, setup, card-link, and connection-flow tests. Commit only the Task 1 files.

### Task 2: Unified offline-first Save and Load

**Files:**
- Modify: `lightweaver/src/components/projects/TopBarProjectDialogs.jsx`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/state/ProjectContext.jsx`
- Test: `lightweaver/src/components/projects/TopBarProjectDialogs.test.jsx`
- Test: `lightweaver/src/state/ProjectContext.test.jsx`
- Test: `lightweaver/src/lib/projectLifecycle.test.js`

- [ ] **Step 1: Write failing library tests**

Add tests with one record in `lw_project_library_v1` and no authenticated session. The Load dialog must list that browser record, open it through the same guarded project-replacement path as other project switches, preserve its library association, and leave online sign-in as an optional secondary action.

- [ ] **Step 2: Verify the library tests fail**

Run the focused component and lifecycle tests. Confirm the dialog currently renders only online projects and import controls.

- [ ] **Step 3: Implement one Load surface**

Render `library.browserProjects` under a `Saved in this browser` section for every session state and `library.activeProjects` under `Saved online` when authenticated. Pass an explicit `onOpenBrowserProject(record)` callback from `app.jsx`; use `replaceProject`, guarded browser association, lifecycle persistence, and existing save barriers rather than copying project state directly.

- [ ] **Step 4: Preserve lifecycle identity**

Ensure save/load/reload preserves the project lifecycle revision used for installation fingerprints. Browser records must carry the authoritative persisted revision metadata or restore it from the associated lifecycle record; opening a saved record must not silently reset it to zero. New Project may replace a clean saved document, but the previous browser record must remain visible and recoverable from Load.

- [ ] **Step 5: Run focused tests and commit**

Run project storage, project lifecycle, ProjectContext, cloud-library, and top-bar dialog tests. Commit only Task 2 files.

### Task 3: Resumable staged installation and accurate firmware handoff

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Test: `firmware/lightweaver-controller/tests/wiring-safety-api.mjs`
- Test: `firmware/lightweaver-controller/tests/bridge-config-reboot-ordering.mjs`
- Create: `firmware/lightweaver-controller/tests/card-installer-hash-resume.mjs`

- [ ] **Step 1: Write failing firmware contract tests**

Add tests proving an already-staged candidate is reported as `wiring transaction is active; activate, confirm, or roll back before staging another project`, not `prior promotion cleanup failed`; `installFromHash` runs on initial load and on `hashchange`; duplicate events cannot submit the same payload concurrently; and the existing reboot ordering remains unchanged.

- [ ] **Step 2: Verify the firmware tests fail**

Run the new wrapper plus wiring safety and reboot-ordering tests. Confirm the current staged state falls through to the generic cleanup error and the card page lacks a hash-change listener.

- [ ] **Step 3: Implement accurate transaction reporting**

In `stageRuntimeConfigJson`, return a distinct active-transaction error before `finalizeCommittedPromotion` whenever candidate state is not `none`. Preserve known-good output and every crash boundary. Do not automatically activate, confirm, or roll back from firmware.

- [ ] **Step 4: Make reused installer windows consume new payloads**

Refactor the duplicated embedded installer script to register `hashchange`, serialize submissions with an in-flight guard, clear only successfully accepted payloads, and display the exact firmware error on failure. Keep staged installs staged for the Studio physical-test flow.

- [ ] **Step 5: Build and commit**

Run all focused firmware source-contract tests and `pio run -e esp32-s3-n16r8`. Commit only Task 3 files.

### Task 4: Resume the exact installation transaction in Studio

**Files:**
- Modify: `lightweaver/src/components/layout/shared/CardPushControl.jsx`
- Modify: `lightweaver/src/components/layout/wire/WiringBenchTest.jsx`
- Modify: `lightweaver/src/lib/cardWiringSafety.js`
- Modify: `lightweaver/src/lib/cardDeployment.js`
- Test: `lightweaver/src/lib/cardWiringSafety.test.js`
- Test: `lightweaver/src/lib/cardDeployment.test.js`
- Test: `lightweaver/src/components/layout/shared/CardPushControl.test.jsx`

- [ ] **Step 1: Write failing resume tests**

Model readback with a staged candidate whose project revision, fingerprint, wiring, and activation ID match the prepared install. Prove Studio resumes that activation instead of POSTing the config again. A non-matching candidate must produce explicit rollback/replace guidance and must not mutate the card automatically.

- [ ] **Step 2: Verify the resume tests fail**

Run the focused deployment and wiring tests and confirm the current flow attempts a second staging request.

- [ ] **Step 3: Add a deterministic resume classifier**

Create a pure classifier returning `stage-new`, `resume-physical-test`, `resume-activation`, `resume-confirmation`, or `candidate-conflict` from prepared identity plus `/api/wiring/status`. Require exact card, firmware build, project revision/fingerprint, activation ID, wiring revision/digest, and production job identity where present.

- [ ] **Step 4: Integrate the classifier**

Before every config push, read wiring status. Resume a matching candidate at its next card-reported step. Keep a conflicting candidate untouched and present one explicit rollback/replacement action. Mark install complete only after post-reboot `/api/status` matches the intended project and reports `knownGoodProject`, `commandReady`, and `playbackReady`.

- [ ] **Step 5: Run focused tests and commit**

Run deployment, wiring safety, card-push, project resolver, and commissioning-flow tests. Commit only Task 4 files.

### Task 5: Centralize live-control project authority

**Files:**
- Modify: `lightweaver/src/lib/cardLiveControl.js`
- Modify: `lightweaver/src/v3/lw-playlist.jsx`
- Modify: `lightweaver/src/v3/lw-show.jsx`
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Test: `lightweaver/src/lib/cardLiveControl.test.js`
- Test: `lightweaver/src/v3/lw-playlist.test.jsx`

- [ ] **Step 1: Write failing control-authority tests**

Prove Patterns, Playlist, and Show all reject control when card project identity differs from the active Studio project. Playlist must not select an absent pattern, and Reset Live must request recovery of the installed startup look and verify the returned status.

- [ ] **Step 2: Verify the tests fail**

Run the focused live-control and screen tests and confirm Playlist currently bypasses the mismatch gate.

- [ ] **Step 3: Implement one authority helper**

Expose one pure project-authority decision from `cardLiveControl.js` and use it in all three screens before any `control` or `frame` request. Keep connection/readiness and project-mismatch messages distinct.

- [ ] **Step 4: Verify readback-driven Reset Live**

After recovery, fetch status and require the card's installed current/startup look to be valid before showing success. If the card cannot restore it, show the exact readback discrepancy.

- [ ] **Step 5: Run focused tests and commit**

Run live-control, playlist, pattern, show, card-identity, and card-project-resolver tests. Commit only Task 5 files.

### Task 6: Integrated verification and browser regression

**Files:**
- Modify only tests or documentation needed to describe verified behavior.

- [ ] **Step 1: Run Studio source gates**

From `lightweaver/`, run `npm test`, the source/core launch gate, and the production build.

- [ ] **Step 2: Run firmware gates**

Run every firmware contract wrapper affected by the change and `pio run -e esp32-s3-n16r8`.

- [ ] **Step 3: Run the browser journey twice**

Use ego-browser against the local production build with the physical card available at its discovered LAN address. Exercise save → load → connect → stage/resume → Patterns/Playlist/Show readback. Do not activate or replace a staged candidate without existing physical evidence; record physical-only checks for Adrian.

- [ ] **Step 4: Review the integrated diff**

Verify no Pi, OTA, cloud command path, or Phase 2 scope entered the implementation. Run `git diff --check` and an independent whole-diff review.

- [ ] **Step 5: Push and open a PR**

Push `codex/effortless-lightweaver-flow`, create a ready PR with exact tests and remaining hardware gates, and watch required checks. Do not merge or deploy unless explicitly requested after the new hardware-sensitive build is available.
