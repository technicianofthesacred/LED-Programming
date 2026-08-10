# Inline Firmware Update Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a quiet, right-aligned firmware update action beside an older exact card's Current version in Connection Center.

**Architecture:** Reuse `classifyFooterFirmwareStatus` as the single signed-release decision boundary, but classify the direct transport identity rather than waiting for the shared card link. Render the action inside the existing acknowledged-facts panel and route it through the existing `onOpenFirmwareUpdate`/installer callback. CSS owns desktop and narrow-screen alignment; no update transport or firmware behavior changes.

**Tech Stack:** React, existing Lightweaver V3 CSS, Playwright Chromium

---

## File structure

- Modify `lightweaver/tests/connection-center-quality.spec.ts` to reproduce the owner's direct-connected older-card state and lock down visibility, alignment, routing, and safe hidden states.
- Modify `lightweaver/src/components/card/CardConnectionCenter.jsx` to classify the direct identity and render the existing update action only for `update-available`.
- Modify `lightweaver/src/v3/v3-styles.css` to right-align version values and give the update button a restrained secondary treatment at desktop and narrow widths.

### Task 1: Direct-card regression and minimal UI

**Files:**
- Test: `lightweaver/tests/connection-center-quality.spec.ts`
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/src/v3/v3-styles.css`

- [x] **Step 1: Write the failing visible regression**

Add a test that serves a valid direct card on `lightweaver.local` with the signed release's build number minus one, opens Connection Center, connects, and asserts:

```ts
const identity = dialog.getByTestId('direct-card-identity');
const update = identity.getByRole('button', { name: 'Update firmware' });
await expect(update).toBeVisible();
await expect(identity.locator('.card-firmware-version')).toHaveCSS('text-align', 'right');
await expect(update).not.toHaveClass(/primary/);
await update.click();
await expect(page).toHaveURL(/#screen=card&section=install$/);
```

Extend the current-firmware direct fixture or add a second assertion proving the same identity panel contains no **Update firmware** button when installed build ID and number equal the signed release.

- [x] **Step 2: Run the regression and witness RED**

Run:

```bash
cd lightweaver
npx playwright test tests/connection-center-quality.spec.ts --project=chromium --workers=1 --grep "direct older firmware|direct current firmware"
```

Expected: FAIL because the direct identity facts contain no inline update action and no right-aligned version class.

- [x] **Step 3: Implement strict direct-release classification**

Import the existing classifier:

```jsx
import { classifyFooterFirmwareStatus } from '../../lib/footerFirmwareStatus.js';
```

Classify the already verified direct identity against the verified release:

```jsx
const directFirmwareStatus = classifyFooterFirmwareStatus(directIdentity, firmwareRelease);
const showDirectFirmwareUpdate = directAttempt?.connected
  && directFirmwareStatus.state === 'update-available';
```

Group each `dt`/`dd` pair in a fact row. Give Installed and Current values the `card-firmware-version` class. In Current's `dd`, render the existing safe action only when `showDirectFirmwareUpdate`:

```jsx
<button
  type="button"
  className="btn card-inline-firmware-update"
  onClick={onOpenFirmwareUpdate || openInstall}
>
  Update firmware
</button>
```

Do not call any updater or hardware method from this component.

- [x] **Step 4: Implement approved alignment and hierarchy**

Add focused CSS:

```css
.card-direct-firmware-facts .card-fact-row {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 12px;
  align-items: center;
}
.card-direct-firmware-facts .card-fact-value {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
}
.card-direct-firmware-facts .card-firmware-version { text-align: right; }
.card-inline-firmware-update {
  justify-self: end;
  min-height: 32px;
  padding: 6px 10px;
  border: 1px solid var(--border-soft);
  background: var(--bg-sel);
  color: var(--text-hi);
}
```

At the existing narrow-screen breakpoint, let Current's value wrap and keep the compact action at `justify-self: end`; do not make it orange or full-width.

- [x] **Step 5: Run focused GREEN and inspect both widths**

Run:

```bash
cd lightweaver
npx playwright test tests/connection-center-quality.spec.ts --project=chromium --workers=1
npm run build
```

Expected: all Connection Center tests pass and Vite exits zero. Capture or inspect the direct older-card state at approximately 818 px and 390 px widths; both version values are right-aligned, the secondary button is right-aligned, unclipped, and routes to the installer.

- [x] **Step 6: Run checkpoint and commit**

Run:

```bash
cd lightweaver
node ../scripts/lightweaver-dev.mjs checkpoint
cd ..
git diff --check
git status --short
```

Expected: unit/checkpoint and production build pass, diff check is clean, and only the approved component, CSS, browser test, spec, and plan are changed.

Commit:

```bash
git add lightweaver/src/components/card/CardConnectionCenter.jsx lightweaver/src/v3/v3-styles.css lightweaver/tests/connection-center-quality.spec.ts docs/superpowers/specs/2026-08-10-inline-firmware-update-action-design.md docs/superpowers/plans/2026-08-10-inline-firmware-update-action.md
git commit -m "feat(studio): add inline firmware update action"
```

## Self-review

- Spec coverage: placement, hierarchy, strict visibility, canonical routing, responsive behavior, and visual verification are all covered by Task 1.
- Scope: no firmware, release, updater transport, project, or live-control behavior changes.
- Type consistency: the plan uses the existing `firmwareRelease`, `directIdentity`, `onOpenFirmwareUpdate`, and `classifyFooterFirmwareStatus` interfaces without adding a new state model.
