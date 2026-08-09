# Connected Firmware Update Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the operator when a verified connected card is behind the signed firmware release, offer the guarded installer, and separate the footer's left card identity from its right build controls.

**Architecture:** `App` remains the single owner of release verification and firmware classification. It passes the bounded classifier result and existing install-navigation callback to `CardConnectionCenter`; the panel renders only classified state and never fetches or mutates hardware. A flexible spacer in the existing footer DOM creates the desktop grouping while the current phone grid hides it.

**Tech Stack:** React, CSS flex/grid, Playwright, Node test runner, Vite.

---

### Task 1: Connected-card update prompt

**Files:**
- Modify: `lightweaver/tests/connection-center-quality.spec.ts`
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/v3-styles.css`

- [ ] **Step 1: Write the failing browser test**

Add a test that dispatches a fully ready verified card with `buildNumber: 1123`, opens the connection center, and asserts:

```ts
await expect(dialog.getByText('Your card firmware is out of date.')).toBeVisible();
await expect(dialog).toContainText('Installed build 1123; latest build 1154.');
await dialog.getByRole('button', { name: 'Update firmware' }).click();
await expect(page).toHaveURL(/#screen=card&section=install$/);
expect(await page.evaluate(() => window.__hardwareOperations)).toBe(0);
```

Add a second assertion path that clicks `Not now`, confirms the dialog closes, and confirms `card-link-status` still says `Connected`. Add current and release-unknown cases that assert the prompt is absent.

- [ ] **Step 2: Run the focused test and witness RED**

Run:

```bash
cd lightweaver
npx playwright test tests/connection-center-quality.spec.ts --project=chromium --workers=1 --grep "connected outdated firmware"
```

Expected: FAIL because the connection panel has no `Your card firmware is out of date.` notice or `Update firmware` button.

- [ ] **Step 3: Pass bounded firmware status into the panel**

Extend `CardConnectionCenter` with `firmwareStatus` and `onOpenFirmwareUpdate`. In `App`, pass the existing `firmwareStatus` value and a callback that closes the panel and calls `openCardSection('install')`.

- [ ] **Step 4: Render the prompt without creating a hardware path**

When `action.id === 'ready-local-card' && firmwareStatus?.state === 'update-available'`, render:

```jsx
<div className="card-firmware-update" role="note">
  <strong>Your card firmware is out of date.</strong>
  <p>Installed build {firmwareStatus.installedBuildNumber}; latest build {firmwareStatus.releaseBuildNumber}.</p>
  <div className="card-connection-actions">
    <button type="button" className="btn primary" onClick={onOpenFirmwareUpdate}>Update firmware</button>
    <button type="button" className="btn" onClick={onClose}>Not now</button>
  </div>
</div>
```

Suppress the redundant ready-state `Done` action only while this prompt is present. Style the notice with existing surface, border, spacing, text, and button tokens; do not add new colors or navigation behavior.

- [ ] **Step 5: Verify GREEN**

Run the focused prompt cases, then the complete connection-center quality spec. Expected: all pass, with zero hardware-operation events on update navigation.

### Task 2: Footer left/right grouping

**Files:**
- Modify: `lightweaver/tests/footer-build-status.spec.ts`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/v3-styles.css`

- [ ] **Step 1: Write the failing desktop geometry assertion**

Extend the existing desktop footer test to collect the card right edge, firmware left edge, Test strip right edge, and footer right edge. Assert a gap larger than 25% of the footer width and right alignment within 16px:

```ts
expect(layout.firmwareLeft - layout.cardRight).toBeGreaterThan(layout.footerWidth * 0.25);
expect(layout.footerRight - layout.testRight).toBeLessThanOrEqual(16);
```

- [ ] **Step 2: Run the focused footer test and witness RED**

Run:

```bash
cd lightweaver
npx playwright test tests/footer-build-status.spec.ts --project=chromium --workers=1 --grep "desktop footer"
```

Expected: FAIL because Card and Firmware are adjacent.

- [ ] **Step 3: Add the structural spacer**

Insert `<span className="sb-spring" aria-hidden="true" />` after `.sb-card`. Keep `.sb-spring { flex: 1; }` on desktop and the existing mobile rule `.sb-spring { display: none; }`. Preserve Card, Firmware, Studio, Test strip DOM and focus order because the spacer is non-interactive and ignored by accessibility APIs.

- [ ] **Step 4: Verify footer behavior**

Run all `footer-build-status.spec.ts` tests. Expected: desktop grouping passes, phone width remains overflow-free, and action routing remains unchanged.

### Task 3: Integrated verification and delivery

**Files:**
- Verify all files above.

- [ ] **Step 1: Run focused and build gates**

```bash
cd lightweaver
node --test src/lib/footerFirmwareStatus.test.js
npx playwright test tests/connection-center-quality.spec.ts tests/footer-build-status.spec.ts --project=chromium --workers=1
npm run build
```

Expected: all tests pass and Vite exits 0.

- [ ] **Step 2: Inspect the actual rendered desktop and phone footer**

Use the local preview to confirm the connected outdated notice, left/right footer grouping, phone reflow, and zero horizontal overflow.

- [ ] **Step 3: Commit, push, merge, deploy, and prove live**

Commit the implementation, push PR #92, require its aggregate `Tests / gate`, merge normally to main, wait for the protected firmware signer commit and real production deploy, then verify `/studio-release.json`, `/firmware/release-manifest.json`, the live footer, and the exact final build numbers.
