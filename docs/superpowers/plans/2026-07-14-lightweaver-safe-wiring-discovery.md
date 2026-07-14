# Lightweaver Safe Wiring Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wiring changes safe for a first-time user: logical artwork sections never create physical outputs, GPIO discovery is guided, every wiring install is probationary, and the card automatically returns to its last confirmed wiring after a failed change.

**Architecture:** The ESP32 is the safety authority. It stores an immutable known-good configuration separately from a staged candidate, boots candidates only under a bounded probation marker, and promotes or rolls back through explicit APIs. Studio is a client of that transaction: it asks how many physical data wires exist, previews a candidate, guides wire and pixel verification, and confirms only after the user sees the expected light. Simple and Expert modes call the same firmware endpoints.

**Tech Stack:** ESP32-S3/Arduino C++ (Preferences, ArduinoJson, FastLED, WebServer), React/Vite, Node test runner, Playwright, PlatformIO.

---

## Task 1: Add a card-owned transactional wiring store

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverTypes.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Create: `firmware/lightweaver-controller/tests/wiring-candidate-storage.mjs`

- [ ] Write a failing source-contract test that requires distinct NVS keys for `knownGoodConfig`, `candidateConfig`, and `candidateState`; a 90-second probation constant; and public storage functions to stage, activate, confirm, roll back, and report candidate state.
- [ ] Add `WiringCandidateState` (`none`, `staged`, `booting`, `awaiting-confirmation`) and `WiringSafetyStatus` to `LightweaverTypes.h`.
- [ ] Refactor JSON parsing/validation so staging validates the complete candidate without mutating the active `RuntimeConfig`.
- [ ] On first upgraded boot, migrate the legacy `config` entry into `knownGoodConfig`; never erase the legacy entry until the new known-good write succeeds.
- [ ] Implement `stageRuntimeConfigJson`, `activateStagedRuntimeConfig`, `confirmCandidateRuntimeConfig`, `rollbackCandidateRuntimeConfig`, and `runtimeWiringSafetyStatusJson`.
- [ ] Make boot loading choose a candidate only once, mark it `awaiting-confirmation`, and automatically choose known-good after any reboot while confirmation is still pending.
- [ ] Run `node firmware/lightweaver-controller/tests/wiring-candidate-storage.mjs` and the complete firmware source-contract test set.

## Task 2: Enforce probation and rollback in the runtime

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Create: `firmware/lightweaver-controller/tests/wiring-probation-runtime.mjs`

- [ ] Write a failing test requiring a monotonic 90-second confirmation deadline, valid output initialization before probation starts, timeout rollback, and rollback before restart on invalid LED initialization.
- [ ] Expose runtime calls for candidate status, activation, confirmation, rollback, and safe discovery output.
- [ ] Start probation only after all configured outputs register successfully and a visible frame is submitted.
- [ ] On timeout or invalid output initialization, persist rollback state before restarting so a reboot loop cannot re-arm the same candidate.
- [ ] Ensure watchdog, brownout, reset, or manual reboot while `awaiting-confirmation` boots known-good on the next start.
- [ ] Keep pattern/zone edits that do not change physical outputs outside the wiring probation path.
- [ ] Run the new runtime contract test, all firmware tests, and `pio run -d firmware/lightweaver-controller`.

## Task 3: Add one safety API for Simple, Expert, recovery, and the card page

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.h`
- Modify: `lightweaver/src/lib/cardBridge.js`
- Create: `firmware/lightweaver-controller/tests/wiring-safety-api.mjs`
- Modify: `firmware/lightweaver-controller/tests/recover-lights-endpoint.mjs`

- [ ] Write failing endpoint/bridge tests for `GET /api/wiring/status`, `POST /api/wiring/candidate`, `POST /api/wiring/activate`, `POST /api/wiring/confirm`, `POST /api/wiring/rollback`, and `POST /api/wiring/discover`.
- [ ] Return structured state (`known-good`, `staged`, `testing`, `rolled-back`, `safe-mode`), current outputs, remaining probation milliseconds, and an actionable next step.
- [ ] Make `/api/config` update non-wiring content immediately but stage any physical output count, GPIO, or pixel-count change as a candidate instead of replacing the live/known-good config.
- [ ] Implement discovery in batches of at most four supported LED GPIOs using stable color assignments; discovery must not alter known-good storage.
- [ ] Extend the card-page bridge allowlist and relay handlers for every wiring safety operation.
- [ ] Add a compact safe-mode panel to the onboard card page with “Restore known-good wiring” and “Find my LED wire”; no JSON editing is required.
- [ ] Upgrade `/api/recover-lights` to cancel live streams, roll back any pending candidate, restore known-good wiring, restart if output topology changed, and then submit the visible recovery frame.
- [ ] Run endpoint tests and firmware build.

## Task 4: Make Studio use the transactional card API

**Files:**
- Create: `lightweaver/src/lib/cardWiringSafety.js`
- Create: `lightweaver/src/lib/cardWiringSafety.test.js`
- Modify: `lightweaver/src/lib/cardPushClient.js`
- Modify: `lightweaver/src/lib/cardLiveControl.js`
- Modify: `lightweaver/src/lib/cardBridge.js`
- Modify: `lightweaver/tests/card-live-preview.mjs`
- Modify: `lightweaver/tests/card-bridge-handoff.mjs`

- [ ] Write failing unit tests for direct and bridge transports, typed candidate states, activation/reconnect polling, confirmation, rollback, and recovery that first restores known-good wiring.
- [ ] Implement one `cardWiringSafety` client used by both Simple and Expert UI.
- [ ] Change card installation so output-topology changes return a candidate preview instead of automatically rebooting into an unconfirmed layout.
- [ ] Poll through reboot without losing the transaction, surface the card-owned deadline, and never claim success until `/api/wiring/confirm` succeeds.
- [ ] Make `recoverCardLights` query safety state, roll back pending wiring, reconnect, and then request the recovery frame; return a distinct `needs-wire-discovery` result if the card responds but the user still reports no visible light.
- [ ] Run the focused Node tests.

## Task 5: Separate logical sections from physical data wires

**Files:**
- Modify: `lightweaver/src/lib/projectModel.js`
- Modify: `lightweaver/src/lib/patchBoard.js`
- Modify: `lightweaver/src/lib/wiringCompiler.js`
- Modify: `lightweaver/src/lib/autoWire.js`
- Modify: `lightweaver/src/components/layout/modes/WireModePanel.jsx`
- Modify: `lightweaver/src/components/layout/shared/CardPushControl.jsx`
- Modify: `lightweaver/src/lib/wiringCompiler.test.js`
- Modify: `lightweaver/src/lib/autoWire.test.js`
- Modify: `lightweaver/tests/wiring-workspace.spec.ts`

- [ ] Add failing tests proving that adding, splitting, resizing, or reversing logical circles/runs leaves the physical output count and GPIO assignments unchanged.
- [ ] Make physical output count an explicit user-owned value (`dataWireCount`, default `1`) rather than an Auto Wire optimization result.
- [ ] Restrict Auto Wire to ordering runs within the selected physical output count; it may never add an output or select a GPIO silently.
- [ ] Compile zones/ranges independently from `standaloneController.outputs`; one physical output can contain many logical sections.
- [ ] Serialize the card package from compiled physical outputs, not from logical section count.
- [ ] Preserve existing projects by migrating their explicit outputs once and defaulting ambiguous projects to one output with a visible review requirement.
- [ ] Run model/compiler/Auto Wire tests and Playwright wiring tests.

## Task 6: Build the guided “Connect my lights” experience

**Files:**
- Create: `lightweaver/src/components/layout/wire/WiringSetupGuide.jsx`
- Create: `lightweaver/src/components/layout/wire/WireDiscovery.jsx`
- Modify: `lightweaver/src/components/layout/modes/WireModePanel.jsx`
- Modify: `lightweaver/src/components/layout/wire/WiringOutputLane.jsx`
- Modify: `lightweaver/src/components/layout/wire/WiringBenchTest.jsx`
- Modify: `lightweaver/src/styles.css`
- Modify: `lightweaver/tests/wiring-workspace.spec.ts`
- Modify: `lightweaver/tests/screen-smoke.spec.ts`

- [ ] Add failing browser tests for the complete novice path: choose one physical data wire, start discovery, pick the observed color/GPIO, set pixel count with inline +/−, see pixel 1 blue and final pixel red, activate candidate, confirm visible output, and promote known-good.
- [ ] Put the primary question first: “How many data wires leave the card?” with `1` selected by default and a short physical illustration/copy.
- [ ] Show output cards as “Output A · GPIO 16” with GPIO secondary in Simple mode and editable in the expanded Expert panel.
- [ ] Add “Find my LED wire”: show no more than four color-to-GPIO choices at once, let the user choose “none lit” for the next safe batch, and copy the chosen GPIO into the candidate only.
- [ ] Keep count and direction verification inline on each output. During count test, only the tested output is lit: first pixel blue, proposed final pixel red, all pixels outside the tested boundary off.
- [ ] Replace technical candidate terms in Simple mode with three statuses: “Current setup is safe”, “Testing a change”, and “Restored the last working setup”.
- [ ] Require the physical question “Do you see the expected lights?” before confirmation; “No” immediately rolls back and offers discovery.
- [ ] Keep Auto Wire below physical setup/verification and label it as optional ordering help.
- [ ] Remove horizontal overflow at phone and desktop widths and keep all controls within 44px touch targets.
- [ ] Run focused Playwright tests at mobile and desktop viewports.

## Task 7: Integrate, flash, and prove the failure paths

**Files:**
- Modify: `scripts/build-factory-bin.sh` only if the current build contract needs the new firmware artifact copied.
- Modify: `docs/deployment-checklist.md`
- Modify: `docs/superpowers/specs/2026-07-14-lightweaver-safe-wiring-discovery-design.md` only to record verified deviations.

- [ ] Run all Lightweaver unit tests, core suite, Pattern tests, Wiring tests, production build, firmware tests, and PlatformIO build.
- [ ] Rebuild the factory firmware binary and verify it is byte-fresh against the compiled firmware.
- [ ] Flash the bench card without erasing its current known-good 44-pixel configuration.
- [ ] Hardware acceptance: stage a deliberately wrong GPIO, verify no confirmation, wait past probation, and verify the card restores the 44-pixel known-good strip without Studio.
- [ ] Hardware acceptance: reboot during probation and verify the card restores known-good on boot.
- [ ] Hardware acceptance: run discovery, select the lit color, verify pixel 1 blue / pixel 44 red / pixels after 44 dark, then confirm and verify promotion.
- [ ] Hardware acceptance: start a live stream, activate a bad candidate, invoke Recover Lights, and verify stream cancellation, rollback, reconnect, and visible warm white.
- [ ] Update the deployment checklist with the novice wiring and automatic rollback smoke tests.
- [ ] Request one spec review and one code-quality review, fix all blocking findings, rerun the full relevant verification, then push the branch. Deploy only after the real-card acceptance steps pass.

