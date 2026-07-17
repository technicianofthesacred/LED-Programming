# Lightweaver Studio Experience Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Studio trust, status, responsive, accessibility, installer, and theme gaps from the approved experience-hardening design.

**Architecture:** Keep the existing lifecycle and card-action reducers as the single sources of truth. Add the missing replacement-dialog boundary in `ProjectProvider`, improve existing screen components in place, and extend current Playwright coverage rather than introducing another state library.

**Tech Stack:** React 18, Vite 6, JavaScript ES modules, Node test runner, Playwright.

---

### Task 1: Separate saving from installation and present a truthful replacement guard

**Files:**
- Modify: `lightweaver/src/lib/projectLifecycle.js`
- Modify: `lightweaver/src/lib/projectLifecycle.test.js`
- Modify: `lightweaver/src/state/ProjectContext.jsx`
- Modify: `lightweaver/src/v3/v3-styles.css`
- Modify: `lightweaver/tests/studio-hardening.spec.ts`

- [ ] **Step 1: Write failing lifecycle and dialog tests**

Add a unit case proving an installed-only edit remains unsaved:

```js
const installedOnly = markInstalled(markEdited(createProjectLifecycle()));
assert.equal(hasUnsavedChanges(installedOnly), true);
assert.equal(lifecycleLabel(installedOnly), 'Installed on card');
```

Add a Playwright case that edits a named project, attempts replacement, expects a dialog naming the current and incoming projects, cancels with `Keep editing`, then repeats and accepts with `Replace project`.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cd lightweaver
node --test src/lib/projectLifecycle.test.js
npx playwright test tests/studio-hardening.spec.ts --grep "replacement guard" --project=chromium --workers=1
```

Expected: installed-only dirty-state and custom-dialog assertions fail.

- [ ] **Step 3: Implement the lifecycle and dialog contract**

Make `hasUnsavedChanges()` depend only on a matching browser or file persistence revision. In `ProjectProvider`, add a promise-backed pending replacement request with this public behavior:

```js
requestReplacementConfirmation({ currentName, incomingName })
// resolves true only from Replace project; false from Keep editing or Escape
```

Render one accessible `role="dialog"`, label it with a visible heading, focus `Keep editing` first, restore focus on dismissal, and keep validation before confirmation so malformed files never interrupt current work.

- [ ] **Step 4: Verify GREEN and commit**

Run the two focused commands above, then commit only the owned files with:

```bash
git commit -m "fix(studio): keep project replacement truthful"
```

### Task 2: Complete Playlist action states and error recovery

**Files:**
- Modify: `lightweaver/src/lib/studioActionStatus.js`
- Modify: `lightweaver/tests/studio-action-status.mjs`
- Modify: `lightweaver/src/v3/lw-playlist.jsx`
- Modify: `lightweaver/tests/playlist-storage.spec.ts`

- [ ] **Step 1: Write failing state and browser tests**

Require the status helper to return concrete pending and confirmed output:

```js
assert.deepEqual(actionStatus({ status: 'pending' }), { kind: 'pending', text: 'Installing playlist on card…' });
assert.deepEqual(actionStatus({ status: 'confirmed' }), { kind: 'ok', text: 'Playlist installed on card.' });
```

Add browser coverage for visible pending, confirmed, failed, Retry, and a failed `Reset live` action that remains visible instead of being swallowed.

- [ ] **Step 2: Run tests and confirm RED**

```bash
cd lightweaver
node tests/studio-action-status.mjs
npx playwright test tests/playlist-storage.spec.ts --project=chromium --workers=1
```

- [ ] **Step 3: Implement minimal status rendering**

Reuse the current action reducer. Keep confirmed status visible until the next playlist edit or action. Replace the best-effort reset catch with the existing bounded card-error message and Retry closure.

- [ ] **Step 4: Verify and commit**

Run the focused commands and commit:

```bash
git commit -m "fix(studio): show confirmed playlist actions"
```

### Task 3: Complete installer signoff and Settings accessibility

**Files:**
- Modify: `lightweaver/src/v3/lw-installer.jsx`
- Modify: `lightweaver/src/v3/lw-settings.jsx`
- Modify: `lightweaver/src/v3/v3-screens.css`
- Modify: `lightweaver/tests/studio-hardening.spec.ts`

- [ ] **Step 1: Write failing accessibility and signoff tests**

Extend Playwright coverage to require:

```ts
await expect(page.getByRole('button', { name: 'Reset bench signoff' })).toBeVisible();
await expect(page.getByTestId('installer-ready-summary')).toContainText(/firmware|project|card|physical/i);
await expect(page.getByRole('slider', { name: 'Master brightness' })).toBeVisible();
await expect(page.getByRole('button', { name: 'Gamma correction' })).toHaveAttribute('aria-pressed');
```

Cover every Settings input class named in the approved spec with either a native `<label>` or an accessible name.

- [ ] **Step 2: Run and confirm RED**

```bash
cd lightweaver
npx playwright test tests/studio-hardening.spec.ts --grep "installer|Settings controls" --project=chromium --workers=1
```

- [ ] **Step 3: Implement signoff summary and labels**

Add explicit `Mark ready` and `Reset bench signoff` actions. The ready summary must show available firmware version, project name and installed revision, card identity or “Not recorded,” and the next physical check. Give `Row` a stable generated ID contract and pass it into `Range`, inputs, groups, and textareas. Add `aria-pressed` to binary icon toggles and accessible names to palette buttons.

- [ ] **Step 4: Verify and commit**

Run the focused Playwright command and commit:

```bash
git commit -m "fix(studio): finish signoff and settings labels"
```

### Task 4: Finish responsive Show, warm Daylight, and reduced motion

**Files:**
- Modify: `lightweaver/src/v3/v3-screens.css`
- Modify: `lightweaver/src/v3/v3-styles.css`
- Modify: `lightweaver/tests/show-screen.spec.ts`
- Modify: `lightweaver/tests/studio-hardening.spec.ts`

- [ ] **Step 1: Write failing visual-contract tests**

At 390 by 844, require `.sh-body` to use one column and `.sh-insp` to sit below the canvas without horizontal overflow. In Daylight, assert warm-hued surface tokens and readable computed contrast on Layout, Patterns, Show, Settings, and Installer. Under reduced motion, assert stream pulse and other status animations are disabled.

- [ ] **Step 2: Run and confirm RED**

```bash
cd lightweaver
npx playwright test tests/show-screen.spec.ts tests/studio-hardening.spec.ts --grep "mobile Show|Daylight|reduced motion" --project=chromium --workers=1
```

- [ ] **Step 3: Implement CSS-only corrections**

At the existing mobile breakpoint, set Show to a single-column document flow with a bordered top inspector. Shift Daylight neutral hues from cool 260 toward the existing warm brand family while keeping the current OKLCH contrast hierarchy. Add missing reduced-motion overrides with `animation: none` and `transition-duration: 0.01ms` where appropriate.

- [ ] **Step 4: Verify and commit**

Run the focused command and commit:

```bash
git commit -m "fix(studio): adapt Show and Daylight for real use"
```

### Task 5: Stabilize existing Studio hardening coverage

**Files:**
- Modify only if a product defect is reproduced: `lightweaver/src/v3/lw-pattern.jsx`, `lightweaver/src/v3/app.jsx`, or their focused tests
- Test: `lightweaver/tests/studio-hardening.spec.ts`

- [ ] **Step 1: Reproduce failures on the isolated server**

Run the whole file twice with one worker. Treat the 24-card pagination contract as already correct unless it fails in the isolated worktree. Replace `networkidle` with a stable shell-ready assertion only if the lazy-route test alone times out while module exclusion remains correct.

- [ ] **Step 2: Preserve red-green discipline for real defects**

For each reproducible product failure, add or tighten one assertion, watch it fail, make the minimum source change, and rerun the single test. Do not weaken expected behavior to silence a failure.

- [ ] **Step 3: Run the complete Studio closeout suite and commit**

```bash
cd lightweaver
node --test src/lib/projectLifecycle.test.js src/lib/cardAction.test.js src/lib/previewVisuals.test.js
node tests/studio-action-status.mjs
npx playwright test tests/studio-hardening.spec.ts tests/playlist-storage.spec.ts tests/show-screen.spec.ts --project=chromium --workers=1
```

Commit any test-harness-only correction separately with `test: stabilize Studio hardening coverage`.
