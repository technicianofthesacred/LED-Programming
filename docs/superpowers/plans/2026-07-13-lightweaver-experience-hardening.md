# Lightweaver Experience Hardening and Physical Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to implement this plan task-by-task. Use superpowers:using-git-worktrees before dispatch. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved experience hardening and replace Lightweaver's disconnected flat-chain/output configuration with a trustworthy output-lane wiring workspace, deterministic Auto Wire, guided bench verification, and assembly documentation.

**Architecture:** Geometry remains source-ordered; a new canonical `wiring` model owns physical output assignment and run order. One compiler derives offsets, ledmap coordinates, frame remapping, zones, card outputs, and assembly data. The Layout UI, Auto Wire solver, Studio trust work, and firmware visitor hardening consume stable contracts and run in isolated worktrees with no concurrent file ownership.

**Tech Stack:** React 18, Vite 6, JavaScript ES modules, Node test runner, Playwright, ESP32-S3/PlatformIO C++, existing Lightweaver JSON/card runtime contracts.

**Canonical spec:** `docs/superpowers/specs/2026-07-13-lightweaver-experience-hardening-design.md`

---

## Overnight execution contract

The root agent owns orchestration, integration, verification, and remote publication. Worker agents own bounded branches and return commits, test evidence, and remaining risks. They do not merge, deploy, or edit another stream's files.

### Worktrees and branches

First commit and push this plan and its canonical spec on `codex/lightweaver-hardening-plan`. Record that immutable remote planning commit, verify it descends from the current remote mainline, and create one integration worktree and two Phase A worker worktrees from it. Do not branch directly from `origin/main`, because it may not contain the approved planning documents:

```bash
git fetch origin
PLANNING_SHA=$(git rev-parse origin/codex/lightweaver-hardening-plan)
git merge-base --is-ancestor origin/main "$PLANNING_SHA"
test "$PLANNING_SHA" = "$(git ls-remote origin refs/heads/codex/lightweaver-hardening-plan | cut -f1)"
git worktree add ../led-hardening-integration -b codex/lightweaver-hardening "$PLANNING_SHA"
git worktree add ../led-hardening-model -b codex/lightweaver-wiring-model "$PLANNING_SHA"
git worktree add ../led-hardening-firmware -b codex/lightweaver-firmware-hardening "$PLANNING_SHA"
```

Studio, Layout, and Auto Wire workers are created only after the model milestone merges, from the updated integration branch. This avoids concurrent edits to `ProjectContext.jsx` and prevents three agents from loading a contract that is about to change:

```bash
git worktree add ../led-hardening-studio -b codex/lightweaver-studio-hardening codex/lightweaver-hardening
git worktree add ../led-hardening-layout -b codex/lightweaver-wiring-ui codex/lightweaver-hardening
git worktree add ../led-hardening-auto-wire -b codex/lightweaver-auto-wire codex/lightweaver-hardening
```

### Agent allocation

Use at most three workers at once. Empty capacity is preferred to overlapping ownership.

| Phase | Agent | Owns | Why this is independent |
|---|---|---|---|
| A | Wiring-model agent | Tasks 1–2 | Establishes the contract every wiring consumer needs; must finish first. |
| A | Firmware agent | Task 9 | Owns embedded visitor UI and focused firmware tests only. |
| Gate | Root + reviewer | Task 3 | Reviews and merges the addressing/compiler contract. |
| B | Layout agent | Task 4, then pauses | Builds manual wiring UI against the accepted model. |
| B | Auto Wire agent | Task 5 Steps 1–3 | Builds only the pure solver and fixtures. |
| B | Studio agent | Tasks 7–8 | Starts from the accepted model, then owns lifecycle and v3 surface work. |
| C | Root integration | First half of Task 10 | Merges Studio, manual Layout, solver, and firmware; runs the combined gate. |
| D | Layout agent | Task 5 Steps 4–6 and Task 6 | Refreshes from integration, then adds Auto Wire UI, bench chase, and assembly map. |
| E | Root integration | Rest of Tasks 10–12 | Performs integrated review, full verification, docs, and publication. |

Do not use a fresh agent for every small test. Reuse the same domain agent across its contiguous tasks to avoid reloading repository context. Use independent review only at two high-risk gates: after Task 3 (addressing/compiler) and after Task 10 (integrated UX/runtime).

### Subagent policy

The root agent is the orchestrator; Wiring-model, Firmware, Layout, Auto Wire, and Studio are domain agents, not nested microtasks. Use exactly two short-lived read-only review subagents: one at the model gate and one at the integrated UX/runtime gate. A domain agent may request one focused diagnostic subagent only when a failing test spans two contracts and the owner cannot isolate it locally; that subagent receives the failing command and relevant files, makes no edits, and returns evidence. Do not spawn subagents for test execution, summaries, or redundant code review. This preserves context and tokens while retaining independent scrutiny where an unnoticed mistake would be expensive.

### Merge gates

1. **Model gate:** Tasks 1–3 unit and contract suites pass before any wiring UI branch starts.
2. **Parallel product gate:** Manual Layout, pure Auto Wire, and Studio work start only from the accepted model. Firmware may have completed earlier. Workers cannot edit another stream's files to resolve failures.
3. **Wiring feature gate:** Task 4 and the pure solver merge before the Layout agent begins Auto Wire UI, bench verification, or assembly maps.
4. **Launch gate:** `npm run launch:check`, the named full Playwright set, and PlatformIO build pass before push.

If a worker is blocked, it commits no partial compatibility shim into another stream. It reports the failing contract to root, which decides whether the owning stream changes it.

---

## Task 0: Baseline, ownership, and reproducible evidence

**Owner:** Root agent

**Files:**
- Modify: `docs/superpowers/plans/2026-07-13-lightweaver-experience-hardening.md` only to check completed steps
- Do not modify user-owned working-tree changes

- [ ] **Step 1: Provision reproducible dependencies in every active worktree**

Run `npm ci` in `lightweaver/` once per newly created worktree before its worker starts. Browser binaries are shared by the user cache, so install Chromium once from the integration worktree. Verify tools without allowing an interactive on-demand install:

```bash
node --version
npm --version
for tree in ../led-hardening-integration ../led-hardening-model ../led-hardening-firmware; do (cd "$tree/lightweaver" && npm ci); done
cd ../led-hardening-integration/lightweaver
npx --no-install playwright --version
npx playwright install chromium
pio --version
```

After the Phase B worktrees are created, run `npm ci` in each of those three `lightweaver/` directories before dispatch. If Node, npm, Chromium, or PlatformIO is unavailable, stop only work that requires that tool and report the exact prerequisite; never accept an interactive `npx` package substitution.

- [ ] **Step 2: Record the baseline**

Run from the integration worktree:

```bash
git status --short
git rev-parse HEAD
cd lightweaver && npm run test:unit
```

Expected: clean worktree; HEAD equals the recorded planning SHA; the plan and spec exist; unit suite exits 0. If baseline tests fail, save the exact failure and stop only the affected stream.

- [ ] **Step 3: Run the known wiring contract tests**

```bash
cd lightweaver
node tests/layout-migration.mjs
node tests/card-runtime-contract.mjs
npx playwright test tests/patch-board.spec.ts tests/layout-send-to-card.spec.ts
```

Expected: capture actual baseline results. Existing green tests are not assumed to cover the reproduced reverse/gap/load defects.

- [ ] **Step 4: Dispatch Phase A with explicit file ownership**

Each prompt must include: canonical spec path, assigned tasks, owned files, forbidden files, exact focused tests, required commit messages, and the instruction to return commit SHAs plus evidence. Do not pass the entire conversation transcript.

---

## Task 1: Repair current addressing correctness before migration

**Owner:** Wiring-model agent

**Files:**
- Modify: `lightweaver/src/lib/projectModel.js`
- Modify: `lightweaver/src/lib/patchBoard.js`
- Modify: `lightweaver/src/lib/cardRuntimeContract.js`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`
- Modify: `lightweaver/src/components/layout/shared/CardPushControl.jsx`
- Test: `lightweaver/src/lib/patchBoard.test.js`
- Test: `lightweaver/tests/layout-migration.mjs`
- Test: `lightweaver/tests/card-runtime-contract.mjs`
- Create: `lightweaver/tests/hardware-capability-contract.mjs`

- [ ] **Step 1: Add failing regressions**

Add named cases proving:

```js
// saved and locked B → A order remains B → A after migrateProject()
// patch source 2 → 0 compiles to start 0, count 3, reversed true
// an inactive block before a run increases compiled total and later start
// card outputs, zones, ledmap rows, and frame length agree on the total
```

Run:

```bash
cd lightweaver
node tests/layout-migration.mjs
node tests/card-runtime-contract.mjs
node --test src/lib/patchBoard.test.js
```

Expected: new cases fail for the reproduced defects.

- [ ] **Step 2: Stop load migration from rewriting saved physical order**

Change migration so normalization removes invalid references but never calls a strip-order alignment over an existing saved chain. Only legacy projects with no saved physical chain may synthesize order from `strips[]`.

- [ ] **Step 3: Normalize inclusive reverse ranges correctly**

Use a single range helper:

```js
export function normalizeInclusiveRange(from, to) {
  const a = Math.trunc(Number(from));
  const b = Math.trunc(Number(to));
  return {
    start: Math.min(a, b),
    count: Math.abs(b - a) + 1,
    reversed: b < a,
  };
}
```

All zone compilation must consume this helper instead of `end - start + 1`.

- [ ] **Step 4: Unify reserved-address totals**

Card package pixel totals and push guards must use expanded physical addresses, including inactive rows, rather than summing only source-strip pixels. Cable jumps remain absent from totals.

- [ ] **Step 5: Align web and firmware limits**

Define one exported card capability contract for total pixels, output count, all supported output pins, maximum zones, and ranges per zone. Set the current total-pixel ceiling to the firmware's actual `LW_MAX_PIXELS` value and reject rather than silently truncate. Add a contract script that reads `LightweaverTypes.h` and the firmware supported-pin declaration and fails when the JavaScript values drift; do not rely on duplicated assertions that can be changed together.

- [ ] **Step 6: Verify and commit**

```bash
cd lightweaver
node tests/layout-migration.mjs
node tests/card-runtime-contract.mjs
node tests/hardware-capability-contract.mjs
node --test src/lib/patchBoard.test.js
git add src/lib/projectModel.js src/lib/patchBoard.js src/lib/cardRuntimeContract.js src/lib/cardRuntimeProject.js src/components/layout/shared/CardPushControl.jsx tests/layout-migration.mjs tests/card-runtime-contract.mjs tests/hardware-capability-contract.mjs
git commit -m "fix: preserve truthful physical LED addressing"
```

Expected: focused tests exit 0 and the commit contains only owned files.

---

## Task 2: Introduce the canonical wiring schema, migration, and compiler

**Owner:** Wiring-model agent

**Files:**
- Create: `lightweaver/src/lib/wiringModel.js`
- Create: `lightweaver/src/lib/wiringCompiler.js`
- Create: `lightweaver/src/lib/wiringModel.test.js`
- Create: `lightweaver/src/lib/wiringCompiler.test.js`
- Modify: `lightweaver/src/lib/projectModel.js`
- Modify: `lightweaver/src/lib/export.js`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`
- Modify: `lightweaver/src/lib/sectionLookModel.js`
- Modify: `lightweaver/src/state/ProjectContext.jsx`

- [ ] **Step 1: Write schema/normalization tests**

Cover one-to-four outputs, unique supported pins, unique IDs, every run referenced exactly once, no cycles or branches, inclusive ascending source ranges, positive inactive counts, separate `directionPolicy` and `physicalDirection`, movable/fixed seams, lock enforcement, legacy descending-range migration, legacy single-chain migration, and ambiguous legacy output-boundary warnings.

- [ ] **Step 2: Implement the model boundary**

Export these stable functions:

```js
export const WIRING_VERSION = 1;
export function makeDefaultWiring(strips, options = {}) {}
export function migrateWiring(project) {}
export function normalizeWiring(wiring, strips, capabilities) {}
export function validateWiring(wiring, strips, capabilities) {}
export function updateWiring(wiring, mutation, options = {}) {}
export function invalidatesVerifiedWiring(change) {}
export function wiringFingerprint(wiring) {}
```

`updateWiring` must refuse invalidating mutations while `locked === true` and return a structured error instead of partially mutating. `invalidatesVerifiedWiring` is the single guard used by ProjectContext for strip geometry, LED count, physical direction, route, output, seam, controller-anchor, and GPIO changes. Tests exercise every entry point and prove that explicit Unlock is the only way to permit them again; color, name, and creative-look edits remain allowed.

- [ ] **Step 3: Write compiler parity tests**

For the same fixture assert that every consumer agrees on:

```js
{
  totalPixels,
  outputs: [{ id, pin, start, count, runIds }],
  runs: [{ id, outputId, globalStart, count, reversed, active }],
  pixels,
  zones,
}
```

Include both physical directions, inactive pixels, multiple outputs, split source ranges, closed-path seam rotation, unreferenced/duplicate runs, and firmware-limit failures. Prove that creative/software reversal never changes the compiled physical endpoint direction.

- [ ] **Step 4: Implement one compiler**

Export:

```js
export function compileWiring({ wiring, strips, groups = [], capabilities }) {}
```

Return `{ ok, errors, warnings, totalPixels, outputs, runs, pixels, zones }`. Do not make ledmap, frame, zone, or runtime consumers recalculate offsets independently.

- [ ] **Step 5: Migrate consumers**

Make ledmap export, inactive-frame masking, section targeting, card outputs, and zones consume the compiler result. Keep a temporary read adapter for legacy `patchBoard` input only at project migration; do not maintain two live truths.

- [ ] **Step 6: Persist and expose wiring through ProjectContext**

Project save/load, browser library, undo/redo snapshots, and serialization must preserve `wiring`. Add history-aware `updateWiring` and derived `compiledWiring` context values. Route every geometry/count/direction/routing/output/seam/controller-anchor/GPIO mutation through the shared invalidation guard.

- [ ] **Step 7: Verify and commit**

```bash
cd lightweaver
node --test src/lib/wiringModel.test.js src/lib/wiringCompiler.test.js src/lib/patchBoard.test.js src/lib/export.test.js src/lib/sectionLookModel.test.js
node tests/layout-migration.mjs
node tests/card-runtime-contract.mjs
npm run test:core
git add src/lib/wiringModel.js src/lib/wiringCompiler.js src/lib/wiringModel.test.js src/lib/wiringCompiler.test.js src/lib/projectModel.js src/lib/export.js src/lib/cardRuntimeProject.js src/lib/sectionLookModel.js src/state/ProjectContext.jsx
git commit -m "feat: compile all physical wiring from one model"
```

Expected: all commands exit 0.

---

## Task 3: Independent model review and integration gate

**Owner:** Root plus one independent reviewer agent

- [ ] **Step 1: Review only correctness-critical questions**

Reviewer checks: migration order, physical-direction semantics, creative reversal isolation, inactive totals, output boundaries, lock enforcement across every invalidating entry point, compiler consumer parity, firmware limits, and project round-trip. It reports actionable findings with file/line evidence and does not edit.

- [ ] **Step 2: Model owner addresses verified findings**

Reject suggestions that recreate dual truths or silently coerce invalid hardware state. Re-run Task 2 verification after any change.

- [ ] **Step 3: Merge model branch into integration**

```bash
git -C ../led-hardening-integration merge --no-ff codex/lightweaver-wiring-model -m "merge: establish canonical Lightweaver wiring"
```

Expected: clean merge and Task 2 verification remains green in integration.

---

## Task 4: Build output lanes, cords, splitting, and accessible manual routing

**Owner:** Layout agent

**Files:**
- Create: `lightweaver/src/components/layout/wire/WiringOutputLane.jsx`
- Create: `lightweaver/src/components/layout/wire/WiringRunRow.jsx`
- Create: `lightweaver/src/components/layout/wire/WiringCordOverlay.jsx`
- Create: `lightweaver/src/components/layout/wire/WiringPreflight.jsx`
- Modify: `lightweaver/src/components/LayoutScreen.jsx`
- Modify: `lightweaver/src/components/layout/modes/WireModePanel.jsx`
- Modify: `lightweaver/src/components/layout/modes/SizeModePanel.jsx`
- Modify: `lightweaver/src/components/layout/canvas/LayoutCanvas.jsx`
- Modify: `lightweaver/src/components/layout/hooks/useLayoutCanvasInteraction.js`
- Modify: `lightweaver/src/components/layout/hooks/useLayoutSize.js`
- Modify: `lightweaver/src/components/layout/hooks/useLayoutWire.js`
- Modify: `lightweaver/src/styles/v3-layout-modes.css`
- Modify: `lightweaver/src/styles/v3-layout-extra.css`
- Create: `lightweaver/tests/layout-hardening.spec.ts`
- Create: `lightweaver/tests/wiring-workspace.spec.ts`
- Modify: `lightweaver/tests/patch-board.spec.ts`

- [ ] **Step 1: Write failing Playwright scenarios**

Test desktop and 390×844 behavior for: output lane rendering, run/canvas selection sync, pointer drag reorder, run move between outputs, OUT-to-IN cord connection, tap OUT then tap IN, cutter drop split, reserved-unlit naming, reverse/fixed-direction blocking, compiler preflight, and keyboard alternatives. In `layout-hardening.spec.ts`, first add failing cases for preserved pending waypoints across mode switches, explicit cancel, undoable count/reset, pointer capture, keyboard-selectable SVG paths with Select → arrow-key nudge → Delete, useful mobile canvas space with bottom-sheet inspector, the Wire scaffold, mixed-content Copy payload/Open installer/Retry recovery, and mode-relevant toolbar actions separated from named Project and Card calibration groups.

- [ ] **Step 2: Replace the flat Wire list with lanes**

Render compiler-derived counts and run order. Keep existing Reverse, Split, Remove, range edit, Send to card, and ledmap export actions. Move GPIO editing to an Advanced disclosure and show connector names first.

- [ ] **Step 3: Implement pointer and accessible connection state**

Use Pointer Events with capture for cords/cutter. Provide a tap state machine `{ idle, sourcePortSelected, draggingCord }`. Every endpoint is a real button with `aria-label`, `aria-pressed`, and visible focus. Prevent branch, cycle, duplicate, fixed-direction, and locked mutations before dispatch.

- [ ] **Step 4: Render canvas endpoints and cords**

Use source pixel coordinates for endpoints and compiler order for numbered cords. Cable jumps consume no addresses. Selecting a run in either canvas or lane updates the shared selection.

- [ ] **Step 5: Surface compiler preflight and lock**

Block Send for errors; show warnings with explicit acknowledgement only where the spec permits. Add Lock wiring/Unlock wiring with consequences. Do not expose a dead `physicalLocked` state without a control.

- [ ] **Step 6: Complete the approved general Layout hardening**

Preserve pending paths across mode switches; put manual count and reset changes into history; convert mouse-only drawing/editing to Pointer Events with capture; make editable SVG paths keyboard-selectable with deletion and existing nudge behavior; prioritize mode-relevant toolbar actions and move project/card calibration actions into clearly named secondary groups; turn the narrow inspector into a useful bottom sheet or stacked panel; add the short Wire scaffold; and replace raw mixed-content JSON with Copy payload, Open card installer, and Retry. The Layout import hook is deliberately excluded here because the Studio lifecycle owner handles it in Task 7.

- [ ] **Step 7: Verify and commit**

```bash
cd lightweaver
npx playwright test tests/wiring-workspace.spec.ts tests/layout-hardening.spec.ts tests/patch-board.spec.ts tests/layout-size-mode.spec.ts tests/layout-mode-switch.spec.ts tests/layout-send-to-card.spec.ts
npm run build
git add src/components/LayoutScreen.jsx src/components/layout src/styles/v3-layout-modes.css src/styles/v3-layout-extra.css tests/layout-hardening.spec.ts tests/wiring-workspace.spec.ts tests/patch-board.spec.ts
git commit -m "feat: make Wire a physical output patch board"
```

---

## Task 5: Add controller placement, closed-path seam controls, and deterministic Auto Wire

**Owners:** Auto Wire agent owns library/tests; Layout agent owns integration UI after solver commit

**Files:**
- Create: `lightweaver/src/lib/autoWire.js`
- Create: `lightweaver/src/lib/autoWire.test.js`
- Modify: `lightweaver/src/components/layout/modes/WireModePanel.jsx`
- Modify: `lightweaver/src/components/layout/canvas/LayoutCanvas.jsx`
- Modify: `lightweaver/tests/wiring-workspace.spec.ts`

- [ ] **Step 1: Define deterministic fixtures before implementation**

Fixtures cover: one output; automatic output count; two spatial clusters; fixed directions; flexible reversal; closed-ring seam movement; total and longest jumper tradeoff; output balance; equivalent alternatives; impossible fixed route; repeatability; and no mutation of input.

- [ ] **Step 2: Implement the pure solver**

Export:

```js
export function proposeAutoWiring({
  wiring,
  strips,
  controllerAnchor,
  availableOutputs,
  outputCount = 'auto',
  physicalScale,
  capabilities,
}) {}
```

Return `{ ok, proposal, alternatives, assumptions, errors, score }`. Score lexicographically by validity, output count, total jumper length, worst jumper, balance, reversals/seam moves, crossings, and stable IDs. Use exact search for small run counts and deterministic clustering plus route improvement beyond the tested threshold. Never use randomness.

Implement the canonical spec literally: exhaustive stable-ID search only through nine pixel runs/two outputs; 250,000 deterministic candidate operations for both exact and heuristic paths; balance as lowest largest output then lowest range; proper straight-segment intersections excluding shared endpoints; final tie-break from serialized IDs/direction/seam; and the exact 10 mm-or-2-percent alternative epsilon. Missing scale uses normalized artwork units, emits the required assumption, and never labels the result in physical units. Tests assert the operation cap, byte-for-byte repeatability, and stable output under input object-key reordering.

- [ ] **Step 3: Verify solver isolation and commit**

```bash
cd lightweaver
node --test src/lib/autoWire.test.js src/lib/wiringModel.test.js src/lib/wiringCompiler.test.js
git add src/lib/autoWire.js src/lib/autoWire.test.js
git commit -m "feat: propose deterministic physical LED routes"
```

- [ ] **Step 4: Integrate controller placement and physical-direction state**

Layout adds a draggable controller anchor, Automatic/1/2/3/4 output constraint, separate Fixed/Flexible `directionPolicy`, explicit physical `DATA IN` direction, and movable seam handles for flexible closed paths. Moving a verified or fixed seam is refused. UI copy never calls creative/software reversal a physical-direction repair.

- [ ] **Step 5: Add preview, accept, cancel, and alternative**

Auto Wire never mutates accepted wiring until Accept routing. Preview must show lane changes, reversals, seam moves, jumper lengths, output totals, and assumptions. Cancel restores the exact prior wiring. Try alternative cycles only through materially equivalent deterministic proposals.

- [ ] **Step 6: Verify and commit UI integration**

```bash
cd lightweaver
node --test src/lib/autoWire.test.js
npx playwright test tests/wiring-workspace.spec.ts
git add src/components/layout/modes/WireModePanel.jsx src/components/layout/canvas/LayoutCanvas.jsx tests/wiring-workspace.spec.ts
git commit -m "feat: integrate Auto Wire into Layout"
```

---

## Task 6: Add guided bench chase and assembly map

**Owner:** Layout agent

**Files:**
- Create: `lightweaver/src/lib/wiringAssembly.js`
- Create: `lightweaver/src/lib/wiringAssembly.test.js`
- Create: `lightweaver/src/lib/wiringChase.js`
- Create: `lightweaver/src/lib/wiringChase.test.js`
- Create: `lightweaver/src/components/layout/wire/WiringBenchTest.jsx`
- Create: `lightweaver/src/components/layout/wire/WiringAssemblyMap.jsx`
- Modify: `lightweaver/src/components/layout/modes/WireModePanel.jsx`
- Modify: `lightweaver/src/lib/cardLiveControl.js`
- Modify: `lightweaver/src/components/layout/shared/CardPushControl.jsx`
- Modify: `lightweaver/tests/wiring-workspace.spec.ts`
- Modify: `lightweaver/tests/layout-send-to-card.spec.ts`

- [ ] **Step 1: Test assembly derivation and chase state**

Assembly output must list controller anchor, connector/GPIO, ordered runs, ranges, counts, directions, jump destination/length, reserved pixels, and verified state. Chase state must support identify output, identify run, confirm first pixel, confirm/reverse direction, retry, previous, next, cancel, and complete. Contract tests cover bridge feature v1, direct transport, delivery acknowledgement, `wsOpen: false`, 1.5-second timeout, 4 fps refresh, 10-percent brightness ceiling, first-pixel marker, cancellation, and prior-look restoration.

- [ ] **Step 2: Implement safe low-brightness chase commands**

Use the existing complete-frame `RRGGBB[]` path through `cardFrameStream`: direct WebSocket when allowed or bridge `frame` feature version 1 from HTTPS. Non-target pixels are black and target channels never exceed 26/255. A step cannot expose Confirm until the frame is acknowledged with `ok` and not `wsOpen: false` within 1.5 seconds. Refresh the visible step at 4 fps. Missing bridge support offers Open Flash; delivery failure keeps the current step visible and offers Retry.

Capture the last Studio-confirmed look before starting. On cancel, completion, or failure, send `cancelStream: true`, then reapply that look. If no confirmed look exists, release the stream and allow the firmware watchdog to restore its prior state. Test restoration ordering and failure handling; a mocked UI transition without a successful transport acknowledgement is not acceptable evidence.

- [ ] **Step 3: Lock only after verification**

All runs and outputs must be confirmed before Complete and lock becomes available. Corrections update wiring through the canonical mutation API and invalidate downstream confirmations as necessary.

- [ ] **Step 4: Join Layout Send to the shared lifecycle/card-action contract**

This step deliberately occurs after the Layout branch refreshes from integrated Studio work. Replace `CardPushControl`'s private success truth with the shared pending/confirmed/failed reducer. Only an acknowledged card install records the current project revision as Installed on card in ProjectContext; failure retains the previous confirmed installed revision and offers Retry. Keep compiler preflight and mixed-content recovery. Add browser assertions for pending, confirmed revision, post-install edit, failure rollback, and retry.

- [ ] **Step 5: Add phone and print assembly views**

The phone view is reachable from Wire without leaving Layout. Print CSS removes Studio chrome and prints one connector lane at a time with legible labels.

- [ ] **Step 6: Verify and commit**

```bash
cd lightweaver
node --test src/lib/wiringAssembly.test.js src/lib/wiringChase.test.js
node tests/card-frame-stream.mjs
npx playwright test tests/wiring-workspace.spec.ts tests/layout-send-to-card.spec.ts
git add src/lib/wiringAssembly.js src/lib/wiringAssembly.test.js src/lib/wiringChase.js src/lib/wiringChase.test.js src/components/layout/wire src/components/layout/modes/WireModePanel.jsx src/components/layout/shared/CardPushControl.jsx src/lib/cardLiveControl.js tests/wiring-workspace.spec.ts tests/layout-send-to-card.spec.ts
git commit -m "feat: verify and document physical wiring"
```

---

## Task 7: Establish shared project lifecycle and card-action trust contracts

**Owner:** Studio agent

**Files:**
- Create: `lightweaver/src/lib/projectLifecycle.js`
- Create: `lightweaver/src/lib/projectLifecycle.test.js`
- Create: `lightweaver/src/lib/cardAction.js`
- Create: `lightweaver/src/lib/cardAction.test.js`
- Modify: `lightweaver/src/state/ProjectContext.jsx`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/lw-settings.jsx`
- Modify: `lightweaver/src/components/layout/hooks/useLayoutImport.js`
- Test: `lightweaver/tests/workflow.spec.ts`

- [ ] **Step 1: Test edited/saved/installed states and replacement guard**

Cover browser save, file download, card confirmation, post-save edit, failed import validation, unsaved replacement cancellation, and successful replacement only after validation. Browser scenarios exercise New, top-bar Load, Settings import, library Open, and Layout Load through the same guard and prove invalid files preserve both the current project and undo history.

- [ ] **Step 2: Implement shared lifecycle revision tracking**

Expose explicit edited, persisted destination/revision, and installed revision facts. Replace generic “saved” copy with destination-specific labels.

- [ ] **Step 3: Test and implement card action reducer**

Use `idle`, `pending`, `confirmed`, and `failed`. Pending disables conflicting actions; failed retains the last confirmed state and exposes retry.

- [ ] **Step 4: Route all project opening through one guard**

Cover top bar, Settings import, Layout load, project library Open/New, and new-project creation. Remove the Layout hook's local `window.confirm`/early history clearing; it calls the shared validate-then-replace contract and never clears history before successful application.

- [ ] **Step 5: Verify and commit**

```bash
cd lightweaver
node --test src/lib/projectLifecycle.test.js src/lib/cardAction.test.js
npx playwright test tests/workflow.spec.ts tests/modal-navigation.spec.ts
git add src/lib/projectLifecycle.js src/lib/projectLifecycle.test.js src/lib/cardAction.js src/lib/cardAction.test.js src/state/ProjectContext.jsx src/v3/app.jsx src/v3/lw-settings.jsx src/components/layout/hooks/useLayoutImport.js tests/workflow.spec.ts
git commit -m "feat: make project and card state truthful"
```

---

## Task 8: Harden Studio surfaces, preview geometry, accessibility, and loading

**Owner:** Studio agent

**Files:**
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Modify: `lightweaver/src/v3/lw-playlist.jsx`
- Modify: `lightweaver/src/v3/lw-show.jsx`
- Modify: `lightweaver/src/v3/lw-settings.jsx`
- Modify: `lightweaver/src/v3/lw-installer.jsx`
- Modify: `lightweaver/src/v3/lw-flash.jsx`
- Modify: `lightweaver/src/lib/previewVisuals.js`
- Modify: `lightweaver/src/v3/v3-styles.css`
- Modify: `lightweaver/tests/patterns-v3.spec.ts`
- Modify: `lightweaver/tests/screen-smoke.spec.ts`
- Modify: `lightweaver/tests/show-screen.spec.ts`
- Create: `lightweaver/tests/studio-hardening.spec.ts`

- [ ] **Step 1: Add failing surface tests**

Cover confirmed card actions, Pattern button semantics, real artwork preview geometry, LED counts, symmetry changes, canonical run reorder, physical reverse addressing, exactly 24 initial results, 24-result progressive batches at the 600px sentinel threshold/Load more, filters over full data, flash erase confirmation in `lw-flash.jsx`, persistent installer checklist, complete Studio/Daylight themes, labels, live status, focus return, reduced motion, route fallback, and lazy screen loading. Show tests prove playback/load/save only become live after confirmation and failures remain visible and retryable.

- [ ] **Step 2: Apply trust contracts to Patterns, Playlist, Settings, and installer**

Never mark selected/live/installed before confirmation. Keep failures local and retryable. This includes Show playback/load/save as well as Pattern, Playlist, Settings, and installer actions.

- [ ] **Step 3: Share current project geometry with Pattern previews**

Memoize by project revision and use the existing frame/geometry interpretation. Focused tests prove that changing symmetry changes the preview and that canonical run reorder/physical direction changes preview addressing. Do not introduce a second pattern engine or an independent physical-order calculator.

- [ ] **Step 4: Batch Pattern results and lazy-load major screens**

Render 24 initial Pattern cards, add 24 when the sentinel comes within 600 CSS pixels or Load more is activated, and reset to 24 after a full-catalog search/filter change. Dynamic imports preserve current route names and show a small loading state. Save the production manifest/chunk listing as test evidence and assert that the initial application chunk excludes Pattern, Show, Playlist, Settings, Flash, and Installer screen modules.

- [ ] **Step 5: Complete accessibility, themes, motion, and naming**

Use Lightweaver spelling, native/ARIA states, programmatic labels, 44px coarse-pointer targets, visible focus, polite announcements, and reduced-motion coverage.

- [ ] **Step 6: Verify and commit**

```bash
cd lightweaver
npx playwright test tests/studio-hardening.spec.ts tests/patterns-v3.spec.ts tests/show-screen.spec.ts tests/screen-smoke.spec.ts tests/workflow.spec.ts
npm run build
git add src/v3 src/lib/previewVisuals.js tests/studio-hardening.spec.ts tests/patterns-v3.spec.ts tests/show-screen.spec.ts tests/screen-smoke.spec.ts
git commit -m "feat: harden the Lightweaver Studio experience"
```

---

## Task 9: Harden the ESP32 visitor interface

**Owner:** Firmware agent

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Create: `firmware/lightweaver-controller/tests/visitor-control-rollback.mjs`
- Modify: `firmware/lightweaver-controller/tests/web-pattern-thumbnails.mjs`

- [ ] **Step 1: Add failing embedded-interface tests**

Inspect/exercise scene, brightness, and blackout pending state; confirmed commit; failed rollback; compact inline error; Retry; request supersession; and disabled conflicting controls.

- [ ] **Step 2: Implement last-confirmed rollback state**

Embedded JavaScript stores last confirmed values, associates responses with the active request, rolls failed optimistic controls back, and keeps failures visible until retry or a new confirmed change.

- [ ] **Step 3: Verify firmware tests and compile**

```bash
node firmware/lightweaver-controller/tests/visitor-control-rollback.mjs
node firmware/lightweaver-controller/tests/web-pattern-thumbnails.mjs
cd firmware/lightweaver-controller && pio run -e esp32-s3-n16r8
```

Expected: both Node tests and PlatformIO build exit 0.

- [ ] **Step 4: Commit**

```bash
git add firmware/lightweaver-controller/src/LightweaverWeb.cpp firmware/lightweaver-controller/tests/visitor-control-rollback.mjs firmware/lightweaver-controller/tests/web-pattern-thumbnails.mjs
git commit -m "fix: roll failed visitor controls back safely"
```

---

## Task 10: Integrate branches and resolve contract edges

**Owner:** Root agent

- [ ] **Step 1: Merge verified Phase B foundations at their exact SHAs**

Immediately after each worker's focused verification, root confirms its worktree is clean and records its HEAD. Before merging, assert the corresponding branch still points to that exact commit; merge the recorded SHA, never a mutable branch name:

```bash
STUDIO_SHA=$(git -C ../led-hardening-studio rev-parse HEAD)
FIRMWARE_SHA=$(git -C ../led-hardening-firmware rev-parse HEAD)
AUTO_WIRE_SHA=$(git -C ../led-hardening-auto-wire rev-parse HEAD)
LAYOUT_MANUAL_SHA=$(git -C ../led-hardening-layout rev-parse HEAD)
test -z "$(git -C ../led-hardening-studio status --porcelain)"
test -z "$(git -C ../led-hardening-firmware status --porcelain)"
test -z "$(git -C ../led-hardening-auto-wire status --porcelain)"
test -z "$(git -C ../led-hardening-layout status --porcelain)"
test "$STUDIO_SHA" = "$(git rev-parse codex/lightweaver-studio-hardening)"
test "$FIRMWARE_SHA" = "$(git rev-parse codex/lightweaver-firmware-hardening)"
test "$AUTO_WIRE_SHA" = "$(git rev-parse codex/lightweaver-auto-wire)"
test "$LAYOUT_MANUAL_SHA" = "$(git rev-parse codex/lightweaver-wiring-ui)"
git -C ../led-hardening-integration merge --no-ff "$STUDIO_SHA" -m "merge: harden Studio trust and usability"
git -C ../led-hardening-integration merge --no-ff "$FIRMWARE_SHA" -m "merge: harden card visitor reliability"
git -C ../led-hardening-integration merge --no-ff "$AUTO_WIRE_SHA" -m "merge: add deterministic Auto Wire solver"
git -C ../led-hardening-integration merge --no-ff "$LAYOUT_MANUAL_SHA" -m "merge: add manual physical wiring workspace"
```

- [ ] **Step 2: Run the pre-integration focused gate**

```bash
cd ../led-hardening-integration/lightweaver
node --test src/lib/wiringModel.test.js src/lib/wiringCompiler.test.js src/lib/autoWire.test.js src/lib/projectLifecycle.test.js src/lib/cardAction.test.js
npx playwright test tests/wiring-workspace.spec.ts tests/layout-hardening.spec.ts tests/workflow.spec.ts tests/studio-hardening.spec.ts tests/patterns-v3.spec.ts tests/show-screen.spec.ts tests/layout-size-mode.spec.ts tests/layout-mode-switch.spec.ts tests/layout-send-to-card.spec.ts
```

Expected: zero failures before downstream wiring features start.

- [ ] **Step 3: Refresh the Layout branch and complete Tasks 5–6**

```bash
git -C ../led-hardening-layout merge --no-ff codex/lightweaver-hardening -m "merge: refresh wiring UI on integrated contracts"
```

The Layout agent now performs Task 5 Steps 4–6 and Task 6. Do not resolve conflicts by choosing an entire side. Preserve lifecycle fields, canonical wiring fields, and manual wiring UI independently, then run the Task 5/6 focused gates.

- [ ] **Step 4: Merge the completed downstream Layout work**

```bash
LAYOUT_FINAL_SHA=$(git -C ../led-hardening-layout rev-parse HEAD)
test -z "$(git -C ../led-hardening-layout status --porcelain)"
test "$LAYOUT_FINAL_SHA" = "$(git rev-parse codex/lightweaver-wiring-ui)"
test "$LAYOUT_FINAL_SHA" != "$LAYOUT_MANUAL_SHA"
git -C ../led-hardening-integration merge --no-ff "$LAYOUT_FINAL_SHA" -m "merge: add Auto Wire verification and assembly flow"
```

- [ ] **Step 5: Run the complete combined focused gate**

```bash
cd ../led-hardening-integration/lightweaver
node --test src/lib/wiringModel.test.js src/lib/wiringCompiler.test.js src/lib/autoWire.test.js src/lib/wiringAssembly.test.js src/lib/wiringChase.test.js src/lib/projectLifecycle.test.js src/lib/cardAction.test.js
npx playwright test tests/wiring-workspace.spec.ts tests/layout-hardening.spec.ts tests/workflow.spec.ts tests/studio-hardening.spec.ts tests/patterns-v3.spec.ts tests/show-screen.spec.ts tests/layout-size-mode.spec.ts tests/layout-mode-switch.spec.ts tests/layout-send-to-card.spec.ts
```

Expected: zero failures.

- [ ] **Step 6: Independent integrated UX review**

One reviewer inspects the real Layout Wire screen at desktop and 390×844, plus Patterns, Settings, installer, and visitor page. Review against the approved spec, not the prototype alone. Return only P0/P1 actionable findings.

- [ ] **Step 7: Root fixes accepted integration findings**

Keep fixes within existing ownership boundaries. Re-run the smallest failing test followed by the combined focused gate, then commit those exact reviewed files as `fix: resolve integrated hardening findings` before starting documentation.

---

## Task 11: Full verification and hardware-boundary evidence

**Owner:** Root agent

- [ ] **Step 1: Run all JavaScript unit and contract checks**

```bash
cd lightweaver
npm run test:unit
npm run test:core
node tests/hardware-capability-contract.mjs
node tests/card-frame-stream.mjs
node ../firmware/lightweaver-controller/tests/visitor-control-rollback.mjs
node ../firmware/lightweaver-controller/tests/web-pattern-thumbnails.mjs
```

Expected: every command exits 0.

- [ ] **Step 2: Run the full relevant Playwright set**

```bash
npx playwright test tests/workflow.spec.ts tests/screen-smoke.spec.ts tests/layout-mode-switch.spec.ts tests/layout-size-mode.spec.ts tests/layout-hardening.spec.ts tests/patch-board.spec.ts tests/wiring-workspace.spec.ts tests/layout-send-to-card.spec.ts tests/patterns-v3.spec.ts tests/studio-hardening.spec.ts tests/show-screen.spec.ts
```

Expected: zero failures; intentional skips are explained in the handoff.

- [ ] **Step 3: Run production and firmware builds**

```bash
npm run launch:check
cd ../firmware/lightweaver-controller
pio run -e esp32-s3-n16r8
```

Expected: Vite production build, launch tests, and PlatformIO build exit 0.

- [ ] **Step 4: Perform browser visual QA**

At desktop and 390×844 verify Draw, Size, Wire, Auto Wire preview, manual cord correction, bench chase error/retry, lock/unlock, assembly print preview, Patterns, Settings, installer, and visitor rollback. Capture screenshots only for failures or the final handoff.

- [ ] **Step 5: Record hardware-only checks without claiming them complete**

Update `docs/deployment-checklist.md` with the real-card checks still requiring Adrian or bench hardware: output identification, first pixel, direction, jumper routing, color order, brightness cap, and saved locked wiring. Do not mark these passed from mocks.

---

## Task 12: Documentation, publication, and overnight handoff

**Owner:** Root agent

**Files:**
- Modify: `docs/deployment-checklist.md`
- Modify: `docs/roadmap.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-07-13-lightweaver-experience-hardening-design.md` only if implementation required an approved clarification

- [ ] **Step 1: Update sources of truth**

Remove stale statements that Layout is unmerged, that split-zone rendering is missing when current code proves otherwise, and that Send/export are unshipped. Record the canonical wiring model and remaining physical bench gate.

- [ ] **Step 2: Review the final diff and commit**

```bash
git status --short
git diff --check
git diff --stat
git add docs/deployment-checklist.md docs/roadmap.md TODO.md
# Add the canonical spec only when an approved implementation clarification changed it.
# git add docs/superpowers/specs/2026-07-13-lightweaver-experience-hardening-design.md
git diff --cached --name-only
git commit -m "docs: record Lightweaver hardening delivery state"
```

Review the staged path list against task ownership before committing. Feature work and integration fixes must already be committed at their task gates. Preserve unrelated working-tree changes and never use a broad directory add.

- [ ] **Step 3: Push only after Task 11 evidence is fresh**

```bash
git push -u origin codex/lightweaver-hardening
```

- [ ] **Step 4: Handoff by behavior and evidence**

Report: what the operator can now do, exact verification commands/results, commit and branch, hardware-only checks remaining, and any deliberately deferred scope. Do not report agent counts, token use, or line counts.

---

## Plan self-review checklist

- Every success criterion in the canonical spec maps to at least one task.
- No two concurrent workstreams own the same file.
- The model/compiler gate precedes all wiring UI and Auto Wire integration.
- Auto Wire is deterministic, preview-only, and constraint-driven.
- Fixed physical direction and closed-loop seam behavior are explicit.
- Cable jumps and reserved unlit pixels are distinct in model, UI, totals, and tests.
- Manual drag, tap, keyboard, and guided correction remain available when automation is wrong.
- Firmware limits are rejected before send rather than silently truncated.
- Hardware-only verification is never claimed from browser mocks.
- Full launch and firmware builds run after integration, not only in worker branches.
