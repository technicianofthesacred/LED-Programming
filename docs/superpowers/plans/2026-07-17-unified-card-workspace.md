# Unified Card Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace four overlapping setup destinations with one immediate, status-aware Card workspace and simplify playlist row controls to drag, Live, Copy, and ×.

**Architecture:** Add a Card route shell that composes the existing verified installer, settings, production, and support implementations instead of rewriting their safety logic. Preserve public legacy hashes as aliases, emit canonical Card section hashes for new navigation, and keep an active install locked to its install section. Keep playlist ordering in the existing `moveTo` path and add a focusable handle as the common pointer and keyboard input.

**Tech Stack:** React 18, Vite, Playwright, Node test runner, existing card-link/Web Serial libraries, existing v3 CSS tokens.

---

## File Map

- Create `lightweaver/src/v3/lw-card.jsx`: unified Card shell, visible section navigation, status-aware overview, alias-to-section resolution, and composition of existing screens.
- Modify `lightweaver/src/v3/app.jsx`: one Card rail item, Card route wiring, top-bar Preferences entry, alias-safe hash handling, and active-install lock.
- Modify `lightweaver/src/v3/lw-flash.jsx`: export installer and technician bodies for embedding without changing firmware verification behavior.
- Modify `lightweaver/src/v3/lw-settings.jsx`: support embedded Card and Preferences presentations while keeping existing project and card handlers.
- Modify `lightweaver/src/v3/lw-installer.jsx`: support an embedded support/GPIO presentation.
- Modify `lightweaver/src/v3/lw-production.jsx`: support embedding and preserve `job` deep-link behavior and production state.
- Modify `lightweaver/src/v3/lw-playlist.jsx`: focusable drag handle, keyboard ordering, live announcement, and compact actions.
- Modify `lightweaver/src/v3/v3-styles.css`: Card shell, visible section bar, top-bar Preferences, embedded production layout, and responsive treatment.
- Modify `lightweaver/src/v3/v3-screens.css`: playlist handle, × hit target, drag state, and narrow-row layout.
- Create `lightweaver/tests/card-workspace.spec.ts`: rail, overview, sections, Preferences, aliases, and install lock.
- Modify `lightweaver/tests/playlist-storage.spec.ts`: compact actions, pointer ordering, keyboard ordering, announcements, and accessible removal.
- Modify `lightweaver/tests/screen-smoke.spec.ts`, `lightweaver/tests/modal-navigation.spec.ts`, and `lightweaver/tests/studio-hardening.spec.ts`: replace assumptions about separate rail screens with Card-section expectations while retaining legacy coverage.
- Modify `lightweaver/tests/universal-install.spec.ts` and `lightweaver/tests/production-setup.spec.ts` only where selectors need the embedding context; do not weaken their safety assertions or change legacy public URLs.

### Task 1: Lock the Unified Navigation Contract with Failing Tests

**Files:**
- Create: `lightweaver/tests/card-workspace.spec.ts`
- Modify: `lightweaver/tests/screen-smoke.spec.ts`
- Modify: `lightweaver/tests/modal-navigation.spec.ts`
- Modify: `lightweaver/tests/studio-hardening.spec.ts`

- [ ] **Step 1: Write the failing rail and immediate-workspace tests**

Add Playwright coverage with these exact assertions:

```ts
test('Card replaces the four setup rail destinations and opens visible actions immediately', async ({ page }) => {
  await page.goto('/#screen=layout');
  await page.getByRole('button', { name: 'Card', exact: true }).click();
  await expect(page).toHaveURL(/#screen=card(?:&section=overview)?$/);
  await expect(page.getByRole('navigation', { name: 'Card sections' })).toBeVisible();
  for (const label of ['Install or update', 'Card settings', 'Workshop setup', 'Advanced & Support']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  for (const label of ['Flash', 'Installer', 'Production setup', 'Settings']) {
    await expect(page.locator('.rail').getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('menu')).toHaveCount(0);
});
```

Add a disconnected overview assertion for the ordered labels Connect, Install, WiFi, Load project, Test, plus a top-bar Preferences test that lands on `#screen=card&section=preferences`.

- [ ] **Step 2: Write legacy alias tests**

Use a table-driven test for the five routes in the design spec. Assert the Card rail item is active and the matching section heading is visible. Preserve the exact input hash for `#screen=flash&mode=install` and `#screen=production&job=moon-batch-7`; these are public compatibility contracts.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
cd lightweaver
npx playwright test tests/card-workspace.spec.ts tests/screen-smoke.spec.ts tests/modal-navigation.spec.ts tests/studio-hardening.spec.ts --project=chromium --workers=1
```

Expected: FAIL because the Card route and single rail item do not exist yet.

### Task 2: Add the Card Route Shell and Alias-Safe Navigation

**Files:**
- Create: `lightweaver/src/v3/lw-card.jsx`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/v3-styles.css`

- [ ] **Step 1: Implement one route and one rail item**

Set `SCREEN_KEYS` to the creative screens plus `card`, map the four legacy screen values to `card` in `normalizeView`, and replace the old rail entries with `['card', 'Card']`. Add a Card icon to the existing inline icon set.

The hash synchronization must leave a recognized legacy Card alias unchanged until the user chooses a Card section. New Card navigation writes `screen=card` and a `section` value. Preserve unrelated `job` values. During `lw-install-active`, force the install section represented by the current legacy or canonical hash and block rail navigation.

- [ ] **Step 2: Implement the visible Card section bar**

In `lw-card.jsx`, export `CardScreen`. Resolve sections with this exact map:

```js
const LEGACY_SECTION = Object.freeze({
  flash: params => params.get('mode') === 'install' ? 'install' : 'support',
  installer: () => 'support',
  production: () => 'workshop',
  settings: () => 'preferences',
});
```

Render an ordinary `<nav aria-label="Card sections">` whose controls are always visible and use `aria-current="page"` for the active section. The controls write `#screen=card&section=overview|install|settings|workshop|support|preferences`. Do not use `<details>`, `role="menu"`, or `aria-haspopup` for primary Card navigation.

- [ ] **Step 3: Add the status-aware overview**

Use the existing `connected`, `cardLink`, `cardHost`, and `onConnectCard` props. Render one detected-state sentence and the five-step sequence. A disconnected state makes Connect primary; a connected state shows identity/host when available and makes Load changes primary; ready and error copy must describe what was detected and avoid claiming a successful install or write without existing evidence.

- [ ] **Step 4: Add top-bar Preferences**

Add a Preferences button beside the project-file controls. It calls a dedicated `openCardSection('preferences')` callback and does not create a popup menu. Keep New project, Load project, Download file, and Save project unchanged.

- [ ] **Step 5: Run the focused navigation tests**

Run the command from Task 1. Expected: rail, immediate Card shell, Preferences, and alias tests PASS; embedded section tests may remain failing until Task 3.

### Task 3: Compose Existing Setup Capabilities Without Rewriting Safety Logic

**Files:**
- Modify: `lightweaver/src/v3/lw-flash.jsx`
- Modify: `lightweaver/src/v3/lw-settings.jsx`
- Modify: `lightweaver/src/v3/lw-installer.jsx`
- Modify: `lightweaver/src/v3/lw-production.jsx`
- Modify: `lightweaver/src/v3/lw-card.jsx`
- Modify: `lightweaver/src/v3/v3-styles.css`
- Modify: `lightweaver/tests/universal-install.spec.ts`
- Modify: `lightweaver/tests/production-setup.spec.ts`

- [ ] **Step 1: Export embeddable screen bodies**

Export `AutomaticInstallScreen` and `TechnicianFlashScreen` from `lw-flash.jsx`. Add an `embedded = false` prop to Settings, Installer, and Production so Card can omit duplicate `.screen` and `.screen-scroll` wrappers and redundant top-level titles while direct test imports retain their current structure. Do not duplicate installer, production, Web Serial, firmware-release, or card-write state.

- [ ] **Step 2: Map Card sections to existing capabilities**

Compose sections as follows:

```jsx
switch (section) {
  case 'install': return <AutomaticInstallScreen cardLink={cardLink} onConnectCard={onConnectCard} embedded />;
  case 'settings': return <SettingsScreen embedded mode="card" />;
  case 'workshop': return <ProductionScreen cardHost={cardHost} onConnectCard={onConnectCard} embedded />;
  case 'preferences': return <SettingsScreen embedded mode="preferences" />;
  case 'support': return <CardSupport embedded />;
  default: return <CardOverview {...overviewProps} />;
}
```

`CardSupport` presents visible links/buttons for Technician firmware and logs, GPIO/install guide, raw JSON, and recovery. Selecting one renders the existing technician, installer, or settings implementation below the persistent section bar. The first support view is a visible action grid, not a collapsed dropdown.

- [ ] **Step 3: Separate preference and card-setting content**

In Settings, `mode="preferences"` renders Project, Pattern palette, Look defaults, Rendering, Project file, and Project library. `mode="card"` renders Card connection, Card & hardware, Dial/encoder, Hardware layout, and output routing. `mode="advanced"` renders Designer config JSON. Preserve all current handlers and ProjectContext writes.

- [ ] **Step 4: Keep legacy installer and production URLs stable**

Do not change `SECURE_INSTALLER_URL` in `src/lib/platformCapabilities.js` or `productionSetupUrl` in `src/lib/productionDeploymentCheck.js`. Their legacy hashes now resolve into Card but remain stable for iframe escape, QR/job links, deployment checks, and external documentation. Update only selectors or heading expectations in the two Playwright suites.

- [ ] **Step 5: Run safety-focused suites**

Run:

```bash
cd lightweaver
npx playwright test tests/card-workspace.spec.ts tests/universal-install.spec.ts --project=chromium --workers=1
npm run test:production
```

Expected: all PASS. Production assertions for one-card binding, one-time mutation, read-back, recovery, pass records, and `job` retention remain present.

### Task 4: Replace Playlist Order Buttons with One Accessible Handle

**Files:**
- Modify: `lightweaver/tests/playlist-storage.spec.ts`
- Modify: `lightweaver/src/v3/lw-playlist.jsx`
- Modify: `lightweaver/src/v3/v3-screens.css`

- [ ] **Step 1: Write failing compact-control tests**

Using `makePlaylistProject({ count: 3 })`, assert each row has Live, Copy, and an item-specific remove button, and has no Up, Down, Make first, or Remove text button:

```ts
const first = page.locator('.pl-row').first();
await expect(first.getByRole('button', { name: 'Live' })).toBeVisible();
await expect(first.getByRole('button', { name: 'Copy' })).toBeVisible();
await expect(first.getByRole('button', { name: /^Remove / })).toHaveText('×');
for (const label of ['Up', 'Down', 'Make first', 'Remove']) {
  await expect(first.getByRole('button', { name: label, exact: true })).toHaveCount(0);
}
```

Add tests that Arrow Down on the first row handle moves it to position 2, Home/End reach the bounds, the live region announces the new position, and clicking × removes only the named row. Add one pointer drag test using the handle as the drag source.

- [ ] **Step 2: Run the playlist test and confirm RED**

Run:

```bash
cd lightweaver
npx playwright test tests/playlist-storage.spec.ts --project=chromium --workers=1
```

Expected: FAIL because the current row still has four redundant text actions and no keyboard handle.

- [ ] **Step 3: Implement the common ordering handle**

Keep `moveTo` as the only reorder mutation. Move `draggable` and drag-start behavior from the entire article to a focusable handle button. Give it `aria-label={`Reorder ${item.label}`}` and handle Arrow Up, Arrow Down, Home, and End with `preventDefault()`. After a move, announce `${item.label} moved to position ${position} of ${playlist.length}` in a visually hidden `aria-live="polite"` region.

- [ ] **Step 4: Reduce visible actions**

Delete the `move` and `first` helpers if unused. Render only Live, Copy, and:

```jsx
<button
  className="plbtn danger pl-remove"
  aria-label={`Remove ${item.label}`}
  title={`Remove ${item.label}`}
  onClick={() => remove(i)}
>
  ×
</button>
```

Keep the numeric position and startup/press label. Style the handle and × for clear focus, grab/grabbing state, and at least a 36px square pointer target. At narrow widths, allow the action group to wrap without page overflow.

- [ ] **Step 5: Run the playlist suite**

Run the Task 4 command. Expected: PASS.

### Task 5: Integrated Regression and Browser Verification

**Files:**
- Modify only files required by failures found in this task.

- [ ] **Step 1: Run all focused UI regressions**

```bash
cd lightweaver
npx playwright test tests/card-workspace.spec.ts tests/screen-smoke.spec.ts tests/modal-navigation.spec.ts tests/studio-hardening.spec.ts tests/universal-install.spec.ts tests/playlist-storage.spec.ts --project=chromium --workers=1
npm run test:production
npm run test:screen-recovery
```

Expected: PASS with no skipped new coverage.

- [ ] **Step 2: Inspect the actual screen in the browser**

Start `npm run dev -- --host 127.0.0.1`, then use the in-app browser at the printed URL. Verify and capture screenshots for:

- desktop Card overview with all section actions visible;
- `#screen=flash&mode=install` rendering inside Card with its URL preserved;
- `#screen=production&job=moon-batch-7` retaining the job;
- top-bar Preferences at desktop and 390px width;
- playlist rows at desktop and 390px width, including keyboard focus on the drag handle and the × accessible name.

Check for clipping, nested scroll traps, duplicate headings, hidden primary actions, and horizontal overflow. Test both Studio and Daylight themes and reduced motion.

- [ ] **Step 3: Run the full relevant verification once**

```bash
cd lightweaver
npm run test:core
npm run launch:source
```

Expected: all Node and Playwright suites PASS, the Vite production build succeeds, `.pages/lightweaver` is staged, and `verify:pages` passes.

- [ ] **Step 4: Review the final diff against the approved design**

Confirm one Card rail destination, always-visible section navigation, status-aware copy, top-bar Preferences, complete Advanced & Support access, preserved legacy hashes and safety flows, and playlist actions limited to drag, Live, Copy, and ×. Confirm no unrelated runtime, firmware, server, or Pi changes.
