# Lightweaver Setup Journey Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the checklist-style Setup screen with one truthful four-phase journey from exact-card connection through physically confirmed installation, while reusing the existing Lightweaver card, discovery, Layout, install, readback, recovery, and bridge contracts.

**Architecture:** Keep `setupJourney.js` as the pure source of phase/blocker state and keep `lw-setup.jsx` as orchestration, not a second hardware stack. Embed the existing discovery surface and route its measured output/color/count/last-light evidence into the existing Layout/Wire model, where direction remains canonical. The final phase tests a recoverable candidate on the physical lights and requires the owner's visible confirmation before committing the project to the card; exact committed readback then proves digital completion. Setup completion makes the local card page passive/minimal but keeps it alive as the HTTPS-to-HTTP bridge for Patterns and later card commands; release occurs only on explicit card-session disconnect or Studio/opener teardown.

**Tech Stack:** React, Vite, Node test runner, Playwright, existing Lightweaver card bridge and firmware HTTP APIs.

---

## File map

- Modify `lightweaver/src/lib/setupJourney.js` — derive four outcome phases, conditional blockers, next action, and truthful completion.
- Modify `lightweaver/src/lib/setupJourney.test.js` — pure contracts for blank, bench, existing-installed, layout, readback, and visible-confirmation states.
- Modify `lightweaver/tests/setup-ladder.spec.ts` — replace the six-step/“Any time” contracts with the four-phase Setup journey.
- Modify `lightweaver/tests/strip-discovery.spec.ts` — embedded discovery, Stop/recovery, ordered color/count/boundary progress, and bridge persistence.
- Modify focused cases in `lightweaver/tests/card-workspace.spec.ts` — exact-card identity, installed-project adoption, Card status handoff, and compact mobile behavior.
- Modify `lightweaver/src/v3/lw-setup.jsx` and `lightweaver/src/v3/lw-setup.css` — focused Setup task column, identity row, active phase surface, Layout handoff, final verification, focus, responsiveness, and reduced motion.
- Reuse `lightweaver/src/components/card/StripDiscoveryPanel.jsx`, `lightweaver/src/v3/lw-layout.jsx`, `lightweaver/src/lib/benchInstall.js`, `lightweaver/src/lib/cardSetupDeploy.js`, `lightweaver/src/lib/cardPushClient.js`, `lightweaver/src/lib/cardFrameStream.js`, and recovery helpers; extend only where embedding or lifecycle callbacks are missing.
- Selectively port late from `/Users/adrianrasmussen/.codex/worktrees/c5c4/led`: `lightweaver/src/components/card/CardSetupOverlay.jsx`, compatible hunks in `StripDiscoveryPanel.jsx`, `cardBridge.js`, `cardBridge.openLocalCardPage.test.js`, `v3/app.jsx`, `tests/strip-discovery.spec.ts`, and the matching `LightweaverWeb.cpp` plus three firmware contract tests. Inspect `lw-flash.jsx`/`v3-screens.css` separately and take only Setup-required installer behavior. Never copy whole files or `.impeccable/`.

### Task 1: Write the journey contracts and witness RED

- [ ] Replace the old step assertions in `lightweaver/src/lib/setupJourney.test.js` with explicit contracts for phase ids `connect`, `lights`, `layout`, and `verify`:
  - no trusted exact card: automatic diagnosis selects `connect`;
  - firmware and Wi-Fi appear only as blockers inside `connect`;
  - factory-blank exact card advances to `lights`, not Layout;
  - color order must be confirmed before count/last-light-boundary progress is meaningful;
  - phase 2 consumes only existing StripDiscovery evidence: output, measured color, count, and last-light/next-dark boundary; it does not invent or persist `discovery.directionConfirmed`;
  - temporary bench config completes neither Setup nor final install;
  - discovered output/count/color/boundary evidence unlocks `layout`;
  - phase 3 reads direction from the canonical Layout/Wire model and reports it in phase status/copy;
  - Layout completion, including its canonical direction, unlocks `verify`;
  - candidate transport/API success without `visibleConfirmation` remains in `verify` and cannot commit the project;
  - visible confirmation authorizes final card commit, but Setup completes only after the committed project has exact readback;
  - an existing installed matching card returns an ongoing-card-status/Patterns destination without replaying first-run work;
  - a saved matching card returns an adopt/resolve action rather than blank setup.

- [ ] Update `lightweaver/tests/setup-ladder.spec.ts` with browser contracts named exactly:
  - `Setup presents four outcome phases with one active task`
  - `blank card enters embedded light discovery before Layout`
  - `Setup carries discovered wiring into Layout and removes optional shelf actions`
  - `Strip discovery completes without inventing direction evidence`
  - `Layout phase reports direction from canonical Wire data`
  - `final verification requires visible confirmation before card commit and exact readback after commit`
  - `Setup identity row names exact card project and installed match`

  Assert there is no “Any time”, Setup-level Save project, controls task, duplicate Layout skip, iframe, or API-only completion claim. Assert the visible owner copy uses “lights” and “output”; GPIO appears only as secondary technical detail.

- [ ] Add focused contracts to `lightweaver/tests/strip-discovery.spec.ts` and `lightweaver/tests/card-workspace.spec.ts` named exactly:
  - `embedded discovery keeps Stop lights available through every physical check`
  - `closing or completing Setup keeps the verified bridge alive for Layout Patterns and later commands`
  - `explicit card-session disconnect or Studio teardown releases the verified bridge`
  - `installed matching card resumes at Card status or Patterns`
  - `Setup remains one focused task column at mobile width`

- [ ] Run the pure and browser contracts before implementation and save the failing assertion names in the implementation notes:

```bash
cd lightweaver
node --test src/lib/setupJourney.test.js
npx playwright test tests/setup-ladder.spec.ts tests/strip-discovery.spec.ts tests/card-workspace.spec.ts --project=chromium --workers=1 --grep "Setup presents four outcome phases|blank card enters embedded|carries discovered wiring|completes without inventing direction|reports direction from canonical Wire|final verification requires visible confirmation|identity row names|embedded discovery keeps Stop|closing or completing Setup keeps|explicit card-session disconnect or Studio teardown releases|installed matching card resumes|focused task column"
```

Expected: RED because the current model still exposes nine step ids and the current UI still renders the six required rows plus the “Any time” shelf.

### Task 2: Apply the approved Impeccable craft floor before UI edits

- [ ] Run context once against the Setup source, then read the approved-direction playbooks. Treat the four-phase product brief above as already confirmed; do not restart discovery or ask aesthetic questions.

```bash
node /Users/adrianrasmussen/.agents/skills/impeccable/scripts/context.mjs --target lightweaver/src/v3/lw-setup.jsx
sed -n '1,260p' /Users/adrianrasmussen/.agents/skills/impeccable/reference/distill.md
sed -n '1,260p' /Users/adrianrasmussen/.agents/skills/impeccable/reference/shape.md
sed -n '1,320p' /Users/adrianrasmussen/.agents/skills/impeccable/reference/layout.md
sed -n '1,360p' /Users/adrianrasmussen/.agents/skills/impeccable/reference/craft-floor.md
```

- [ ] Record the spatial thesis before editing: one 660–800px task column; compact persistent identity/status row; numbered outcome rail; exactly one expanded phase surface; contextual blockers and recovery inline; Layout is core; one primary action; 44px controls; DOM, visual, and focus order agree on desktop and mobile.

### Task 3: Make the pure journey model GREEN

- [ ] Replace `SETUP_STEP_IDS`/optional-step bookkeeping in `lightweaver/src/lib/setupJourney.js` with four stable phase records. Keep automatic diagnosis before progress and return explicit data for `currentPhaseId`, conditional `blockers`, `nextAction`, `setupComplete`, and completed-card destination.

- [ ] Derive evidence only from existing truth: verified exact-card link/readiness; StripDiscovery's output, measured color, count, and last-light/next-dark boundary; canonical Layout/Wire placement and direction; card project resolution; explicit owner confirmation of the recoverable candidate; and final exact committed readback. Do not add a discovery-direction persistence field. Never treat a temporary bench install, candidate transport/API success, deployment POST success, or optimistic local state as physical completion.

- [ ] Run:

```bash
cd lightweaver
node --test src/lib/setupJourney.test.js
```

Expected: PASS for every blank, bench, installed, adoption, Layout, readback, and visible-confirmation case.

### Task 4: Build the four-phase Setup surface using shared hardware paths

- [ ] Refactor `lightweaver/src/v3/lw-setup.jsx` so it renders:
  1. automatic diagnosis and compact exact-card/project/connection/installed-match identity;
  2. `Connect and identify exact card`, with firmware/Wi-Fi only when evidence blocks progress;
  3. `Find and verify the lights`, embedding the real StripDiscovery flow and its existing output, measured color, count, and first/final/next-dark last-light-boundary subprogress; do not ask or persist direction here;
  4. `Place lights in the artwork`, routing into real Layout with discovered outputs/counts/color already in project state and showing direction from the canonical Layout/Wire property as phase-3 status/copy;
  5. `Test and save to card`, showing exact card/project/output/count/color/direction/power summary, sending a bounded recoverable candidate, testing its visible result, and requiring `The lights look correct` before final project commit. Only after that confirmation call the existing final deploy/install path, perform independent exact committed readback, and expose the Patterns finish action.

- [ ] Keep Stop lights persistent during physical checks and call existing frame-stream stop/recovery/rollback behavior. Keep safe brightness defaults. Do not fork `StripDiscoveryPanel`, deployment, project serialization, readback, or recovery logic.

- [ ] Remove the old optional shelf, duplicate Layout skip, Setup-level Save project, and controls task. Leave controls in Wire/Hardware settings, firmware/support contextual, and Preferences outside first-run progress.

- [ ] In `lightweaver/src/v3/lw-setup.css`, preserve Lightweaver tokens and visual language while enforcing the focused measure, accessible state text, 44px minimum controls, responsive reflow, visible keyboard focus, and `prefers-reduced-motion` behavior. Advance focus to each newly active phase heading and announce asynchronous state through bounded live regions.

- [ ] Run:

```bash
cd lightweaver
node --test src/lib/setupJourney.test.js
npx playwright test tests/setup-ladder.spec.ts --project=chromium --workers=1
```

Expected: PASS.

### Task 5: Port only the compatible overlay and bridge lifecycle late

- [ ] Inspect—not copy—the older worktree against the current branch:

```bash
git -C /Users/adrianrasmussen/.codex/worktrees/c5c4/led diff -- lightweaver/src/components/card/StripDiscoveryPanel.jsx lightweaver/src/lib/cardBridge.js lightweaver/src/lib/cardBridge.openLocalCardPage.test.js lightweaver/src/v3/app.jsx lightweaver/src/v3/lw-flash.jsx lightweaver/src/v3/v3-screens.css lightweaver/tests/strip-discovery.spec.ts firmware/lightweaver-controller/src/LightweaverWeb.cpp firmware/lightweaver-controller/tests/blank-card-commissioning-surface.mjs firmware/lightweaver-controller/tests/bridge-config-reboot-ordering.mjs firmware/lightweaver-controller/tests/bridge-frame-protocol.mjs
sed -n '1,240p' /Users/adrianrasmussen/.codex/worktrees/c5c4/led/lightweaver/src/components/card/CardSetupOverlay.jsx
```

- [ ] Port the overlay/drawer and passive bridge behavior onto current source: no iframe; discovery can be embedded; ordinary panel dismissal and successful Setup completion both preserve the live bridge through Layout, install, Patterns, and later card commands. Completion changes the card page to its passive/minimal state without sending `release-bridge`, closing the window, or revoking Studio's verified handle. Only explicit card-session disconnect or Studio/opener teardown sends the release request and revokes the window handle; protected discovery/bench/install operations cannot be dismissed mid-mutation.

- [ ] Port firmware release-message handling and its three focused contract assertions only if required by the Studio release handshake. Preserve current interfaces and current `origin/main` changes. Do not port `.impeccable/`; do not modify deferred Pi/visitor-ui paths.

- [ ] Run:

```bash
cd lightweaver
node --test src/lib/cardBridge.openLocalCardPage.test.js
npx playwright test tests/strip-discovery.spec.ts --project=chromium --workers=1
node ../firmware/lightweaver-controller/tests/blank-card-commissioning-surface.mjs
node ../firmware/lightweaver-controller/tests/bridge-config-reboot-ordering.mjs
node ../firmware/lightweaver-controller/tests/bridge-frame-protocol.mjs
```

Expected: PASS; bridge tests prove passive persistence across panel dismissal, Setup completion, Patterns, and later commands, while release occurs only for explicit card-session disconnect or Studio/opener teardown. Firmware tests prove only the compatible handshake surface.

### Task 6: Run the detector and one bounded visual pass

- [ ] Run the Impeccable detector over only changed Setup markup/styles and resolve every unexplained finding:

```bash
node /Users/adrianrasmussen/.agents/skills/impeccable/scripts/detect.mjs --json --scope layout lightweaver/src/v3/lw-setup.jsx lightweaver/src/v3/lw-setup.css lightweaver/src/components/card/CardSetupOverlay.jsx lightweaver/src/components/card/StripDiscoveryPanel.jsx lightweaver/src/v3/v3-screens.css
```

- [ ] Start one stable preview and inspect the real Setup flow at 1440×1000 and 390×844: disconnected diagnosis, blank-card discovery, active Layout handoff, final verification, completed handoff to Patterns with the passive bridge still alive, and existing installed-card resume. Check reading order, one obvious next action, long state text, keyboard focus advancement, Stop lights visibility, drawer behavior, no horizontal overflow, 44px targets, and reduced motion.

```bash
cd lightweaver
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
```

- [ ] Fix all desktop/mobile findings in one batch, rerun the focused Setup tests, and perform one confirmation inspection only. Stop the preview afterward.

### Task 7: Integrated checkpoint, self-review, and local commit

- [ ] Run focused verification:

```bash
cd lightweaver
node --test src/lib/setupJourney.test.js src/lib/cardBridge.openLocalCardPage.test.js
npx playwright test tests/setup-ladder.spec.ts tests/strip-discovery.spec.ts --project=chromium --workers=1
npx playwright test tests/card-workspace.spec.ts --project=chromium --workers=1 --grep "installed matching card resumes|focused task column|exact current project|temporary bench|independent exact final wiring GET"
npm run build
```

- [ ] If the focused suite and build are green and the change remains bounded, run the repository launch checkpoint once:

```bash
cd lightweaver
npm run launch:check
```

- [ ] Self-review the diff against every approved constraint: four outcomes; conditional firmware/Wi-Fi; blank-card discovery before Layout; phase 2 uses only existing StripDiscovery output/measured-color/count/last-light-boundary evidence; no invented discovery-direction persistence; direction remains canonical Layout/Wire work and appears in phase 3; Layout is core; exact summary; recoverable candidate and explicit physical confirmation before final card commit; exact committed readback afterward; identity row; installed-project adoption; passive bridge remains alive after Setup completion for Patterns and later commands; release only on explicit card-session disconnect or Studio/opener teardown; no iframe; no old shelf/skip/save/controls; no Pi/visitor-ui work; no physical claims from API success.

- [ ] Commit the verified coherent change locally:

```bash
git add docs/superpowers/plans/2026-08-09-lightweaver-setup-journey-redesign.md lightweaver/src lightweaver/tests firmware/lightweaver-controller/src/LightweaverWeb.cpp firmware/lightweaver-controller/tests
git commit -m "feat: redesign Lightweaver setup journey"
```

Do not push, deploy, flash hardware, rebuild/sign a firmware release, or claim the lights physically correct. Report the commit, exact automated evidence, desktop/mobile inspection evidence, and the remaining hardware-only checks: real output mapping, color order, count/direction/boundary, visible final result, power recovery, and safe Stop/recovery on a physical ESP32-S3 card.
