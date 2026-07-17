# Unified Hardware Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the top-level Flash, Installer, Production Setup, and hardware Settings maze with one immediate Hardware workspace while preserving every working deep link and safety state machine.

**Architecture:** A route-normalization layer maps legacy hashes to Hardware section routes. Existing automatic install, production, technician repair, and settings components are re-housed before being redesigned. The Hardware landing page selects one next action from deterministic card/project readiness.

**Tech Stack:** React 18, Vite lazy routes, Node test runner, Playwright, existing Lightweaver CSS and card-link APIs.

---

### Task 1: Add canonical Hardware routes and permanent legacy aliases

**Files:**
- Create: `lightweaver/src/lib/hardwareRoutes.js`
- Create: `lightweaver/src/lib/hardwareRoutes.test.js`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/tests/screen-smoke.spec.ts`
- Modify: `lightweaver/tests/modal-navigation.spec.ts`
- Modify: `lightweaver/tests/universal-install.spec.ts`
- Modify: `lightweaver/tests/production-setup.spec.ts`

- [ ] **Step 1: Write failing route tests**

Test these exact normalizations:

```js
assert.deepEqual(normalizeStudioRoute('#screen=flash'), { screen: 'hardware', section: 'firmware' });
assert.deepEqual(normalizeStudioRoute('#screen=flash&mode=install'), { screen: 'hardware', section: 'firmware', mode: 'install' });
assert.deepEqual(normalizeStudioRoute('#screen=installer'), { screen: 'hardware', section: 'install' });
assert.deepEqual(normalizeStudioRoute('#screen=production&job=ABC123'), { screen: 'hardware', section: 'firmware', action: 'prepare', job: 'ABC123' });
assert.deepEqual(normalizeStudioRoute('#screen=hardware&section=tests&card=north'), { screen: 'hardware', section: 'tests', card: 'north' });
```

Also prove serialization retains `job`, `card`, `mode`, and install-lock state.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
node --test src/lib/hardwareRoutes.test.js
```

Expected: FAIL because route normalization does not exist.

- [ ] **Step 3: Implement route parsing/serialization**

Expose:

```js
export const HARDWARE_SECTIONS = ['overview', 'controllers', 'power', 'firmware', 'tests', 'install', 'history'];
export function normalizeStudioRoute(hash = '') {}
export function hardwareRoute(section = 'overview', params = {}) {}
export function isInstallLockedRoute(route) {}
```

Unknown sections fall back to `overview`. Never drop a production `job` code.

- [ ] **Step 4: Route the shell through canonical routes**

Update `app.jsx` so legacy hashes mount Hardware while the browser URL may be replaced with the canonical hash only after required parameters are captured. Preserve back/forward behavior and the active install navigation lock.

- [ ] **Step 5: Verify GREEN and route compatibility**

```bash
cd lightweaver
node --test src/lib/hardwareRoutes.test.js
npx playwright test tests/screen-smoke.spec.ts tests/modal-navigation.spec.ts tests/universal-install.spec.ts tests/production-setup.spec.ts --project=chromium --workers=1
```

Expected: PASS; old URLs still reach working flows.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/hardwareRoutes.js lightweaver/src/lib/hardwareRoutes.test.js lightweaver/src/v3/app.jsx lightweaver/tests/screen-smoke.spec.ts lightweaver/tests/modal-navigation.spec.ts lightweaver/tests/universal-install.spec.ts lightweaver/tests/production-setup.spec.ts
git commit -m "feat: add unified Hardware routes"
```

### Task 2: Build the Hardware shell and re-house working flows

**Files:**
- Create: `lightweaver/src/v3/lw-hardware.jsx`
- Create: `lightweaver/src/v3/hardware/HardwareNav.jsx`
- Create: `lightweaver/src/v3/hardware/HardwareOverview.jsx`
- Create: `lightweaver/src/v3/hardware/CardFirmwareSection.jsx`
- Create: `lightweaver/src/v3/hardware/HistoryRepairSection.jsx`
- Modify: `lightweaver/src/v3/lw-flash.jsx`
- Modify: `lightweaver/src/v3/lw-production.jsx`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/lw.css`
- Test: `lightweaver/tests/hardware-workspace.spec.ts`

- [ ] **Step 1: Write failing workspace navigation tests**

Add Playwright coverage proving:

```ts
await page.goto('/#screen=hardware');
await expect(page.getByRole('heading', { name: 'Project hardware' })).toBeVisible();
await expect(page.getByRole('navigation', { name: 'Hardware sections' })).toBeVisible();
await expect(page.getByRole('link', { name: 'Card & firmware' })).toHaveAttribute('href', /section=firmware/);
await expect(page.getByRole('button', { name: 'Flash' })).toHaveCount(0);
await expect(page.getByRole('button', { name: 'Installer' })).toHaveCount(0);
await expect(page.getByRole('button', { name: 'Setup' })).toHaveCount(0);
```

Prove Hardware is an immediate route, not a dropdown or disclosure.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
npx playwright test tests/hardware-workspace.spec.ts --project=chromium --workers=1
```

Expected: FAIL because Hardware is not in the rail.

- [ ] **Step 3: Export existing flow components without changing behavior**

Export the automatic installer and technician flash components from `lw-flash.jsx`. Keep their internal behavior and tests intact. Keep `ProductionScreen` intact and mount it from `CardFirmwareSection` when `action=prepare` or a `job` exists. Mount technician tools under a closed **Advanced repair** disclosure in History & repair.

- [ ] **Step 4: Implement the shell and section routing**

`HardwareScreen` accepts the existing shell props plus cards, active card, connection registry, and canonical route. It renders a card selector, Workshop/Install mode control, section navigation, and a lazy/error-bounded section body.

The rail contains exactly Layout, Patterns, Playlist, Show, Hardware; Project and Preferences appear in the footer.

- [ ] **Step 5: Verify GREEN and retained flows**

```bash
cd lightweaver
npx playwright test tests/hardware-workspace.spec.ts tests/universal-install.spec.ts tests/production-setup.spec.ts tests/screen-recovery.spec.ts --project=chromium --workers=1
npm run build
```

Expected: PASS; no firmware or production state machine was rewritten.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/v3/lw-hardware.jsx lightweaver/src/v3/hardware lightweaver/src/v3/lw-flash.jsx lightweaver/src/v3/lw-production.jsx lightweaver/src/v3/app.jsx lightweaver/src/v3/lw.css lightweaver/tests/hardware-workspace.spec.ts
git commit -m "feat: add unified Hardware workspace shell"
```

### Task 3: Relocate hardware controls and split Project from Preferences

**Files:**
- Create: `lightweaver/src/v3/hardware/ControllersOutputsSection.jsx`
- Create: `lightweaver/src/v3/hardware/PowerWiringSection.jsx`
- Create: `lightweaver/src/v3/lw-project.jsx`
- Create: `lightweaver/src/v3/lw-preferences.jsx`
- Modify: `lightweaver/src/v3/lw-settings.jsx`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/lw.css`
- Test: `lightweaver/tests/hardware-settings-relocation.spec.ts`
- Test: `lightweaver/tests/project-preferences.spec.ts`

- [ ] **Step 1: Write failing ownership tests**

Prove the destination of each current setting:

```ts
await page.goto('/#screen=hardware&section=controllers');
await expect(page.getByLabel('Total LEDs')).toBeVisible();
await expect(page.getByText('Output routing')).toBeVisible();

await page.goto('/#screen=project');
await expect(page.getByLabel('Project name')).toBeVisible();
await expect(page.getByText('Project library')).toBeVisible();

await page.goto('/#screen=preferences');
await expect(page.getByText('Theme')).toBeVisible();
await expect(page.getByText('Preview quality')).toBeVisible();
await expect(page.getByText('GPIO')).toHaveCount(0);
```

Also prove old Settings links resolve to Project and offer contextual navigation to Hardware/Preferences. Add an assertion that the active card's runtime/source mode can preserve an external Art-Net/Madrix source without exposing deferred Pi controls.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
npx playwright test tests/hardware-settings-relocation.spec.ts tests/project-preferences.spec.ts --project=chromium --workers=1
```

Expected: FAIL because Settings remains monolithic.

- [ ] **Step 3: Extract controls into focused components**

Move, do not duplicate, the existing hardware layout/output/controls/current-limit controls into Hardware sections. Bind them to the active `devices.cards[]` record through ProjectContext compatibility APIs.

Project receives name, BPM, palette/look defaults, library, save/load/import/export. Preferences receives theme, preview quality/performance, and application behavior. Remove Flash/Installer links from settings content.

- [ ] **Step 4: Preserve keyboard, status, and save behavior**

Keep current accessible labels and project autosave events. Card writes remain explicit actions with existing result/status messaging. General preferences must not dirty project data; project/hardware changes must.

- [ ] **Step 5: Verify GREEN**

```bash
cd lightweaver
npx playwright test tests/hardware-settings-relocation.spec.ts tests/project-preferences.spec.ts tests/workflow.spec.ts --project=chromium --workers=1
npm run test:core:source
npm run build
```

Expected: PASS; each setting has exactly one editable home.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/v3/hardware/ControllersOutputsSection.jsx lightweaver/src/v3/hardware/PowerWiringSection.jsx lightweaver/src/v3/lw-project.jsx lightweaver/src/v3/lw-preferences.jsx lightweaver/src/v3/lw-settings.jsx lightweaver/src/v3/app.jsx lightweaver/src/v3/lw.css lightweaver/tests/hardware-settings-relocation.spec.ts lightweaver/tests/project-preferences.spec.ts
git commit -m "refactor: give hardware and project settings one home"
```

### Task 4: Build the one-next-action readiness dashboard

**Files:**
- Create: `lightweaver/src/lib/hardwareReadiness.js`
- Create: `lightweaver/src/lib/hardwareReadiness.test.js`
- Modify: `lightweaver/src/v3/hardware/HardwareOverview.jsx`
- Modify: `lightweaver/src/v3/lw.css`
- Test: `lightweaver/tests/hardware-readiness.spec.ts`

- [ ] **Step 1: Write failing priority tests**

Define deterministic priority:

```js
assert.equal(nextHardwareAction({ cards: [] }).id, 'add-controller');
assert.equal(nextHardwareAction({ card, connection: { state: 'offline' } }).id, 'connect-card');
assert.equal(nextHardwareAction({ card, connection: connected, blockers: [{ id: 'output-mismatch' }] }).id, 'resolve-output-mismatch');
assert.equal(nextHardwareAction({ card, connection: connected, firmware: { state: 'blank' } }).id, 'install-firmware');
assert.equal(nextHardwareAction({ card, connection: connected, tests: { complete: false } }).id, 'continue-tests');
assert.equal(nextHardwareAction({ card, connection: connected, tests: { complete: true }, blockers: [] }).id, 'ready-to-install');
```

Each action must include label, explanation, route, card ID, and supported transport requirement.

- [ ] **Step 2: Run and verify RED**

```bash
cd lightweaver
node --test src/lib/hardwareReadiness.test.js
```

Expected: FAIL because the readiness selector does not exist.

- [ ] **Step 3: Implement the pure selector using existing evidence**

Salvage readiness checks from `controllerProfiles.js`, production evidence, connection state, firmware release comparison, wiring verification, and power blockers. Do not fetch or mutate inside the selector.

- [ ] **Step 4: Render the dashboard decision surface**

Show the selected card, one primary next action, secondary readiness details, recommendations/blockers, installation progress, and last snapshot. Six section links may remain navigation, but must not compete visually with the primary action.

- [ ] **Step 5: Verify GREEN and responsive behavior**

```bash
cd lightweaver
node --test src/lib/hardwareReadiness.test.js
npx playwright test tests/hardware-readiness.spec.ts --project=chromium --workers=1
npx playwright test tests/hardware-workspace.spec.ts --project=chromium --workers=1
npm run build
```

Expected: PASS at desktop and mobile viewport assertions.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/hardwareReadiness.js lightweaver/src/lib/hardwareReadiness.test.js lightweaver/src/v3/hardware/HardwareOverview.jsx lightweaver/src/v3/lw.css lightweaver/tests/hardware-readiness.spec.ts
git commit -m "feat: guide Hardware with one next action"
```

### Task 5: Workspace verification checkpoint

**Files:**
- Verify only

- [ ] **Step 1: Run all retained screen and production checks**

```bash
cd lightweaver
npm run test:core:source
npx playwright test tests/hardware-workspace.spec.ts tests/hardware-settings-relocation.spec.ts tests/project-preferences.spec.ts tests/hardware-readiness.spec.ts tests/universal-install.spec.ts tests/production-setup.spec.ts tests/screen-recovery.spec.ts --project=chromium --workers=1
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 2: Check navigation and bundle boundaries**

```bash
git diff --check
git status --short
```

Manually inspect the built chunk list: Hardware sub-sections must remain lazy/error-bounded rather than merging production and flashing into the initial main bundle.
