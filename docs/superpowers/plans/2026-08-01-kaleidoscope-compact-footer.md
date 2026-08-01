# Kaleidoscope Compact Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the multi-line Kaleidoscope calibration footer with one compact preview/action row and a Save & close action.

**Architecture:** Keep Kaleidoscope mapping persistence unchanged because edits already update project state immediately. Add one close callback from `LayoutScreen` to `DrawModePanel`, render a compact footer from the existing calibration result, and let closing the editor deactivate the existing calibration hook so its physical stream restores and stops normally.

**Tech Stack:** React 18, JavaScript/JSX, CSS, Node test runner, Playwright.

---

### Task 1: Lock the compact footer and save/close contract

**Files:**
- Modify: `lightweaver/tests/layout-kaleidoscope.spec.ts:20-210`
- Modify: `lightweaver/src/components/LayoutScreen.jsx:395-420`
- Modify: `lightweaver/src/components/layout/modes/DrawModePanel.jsx:70-100,1270-1370`
- Modify: `lightweaver/src/components/layout/hooks/useKaleidoscopeCalibration.js:118-132`
- Modify: `lightweaver/src/styles/v3-layout-extra.css:640-760`

- [ ] **Step 1: Write the failing browser assertions**

Update the existing Kaleidoscope browser coverage to expect the compact content and completion behavior:

```ts
const footer = page.getByRole('group', { name: 'Kaleidoscope preview and save' });
await expect(footer).toBeVisible();
await expect(page.getByText('Custom spacing')).toHaveCount(0);
await expect(page.getByText(/Red markers are reflection points/)).toHaveCount(0);
await expect(footer.getByRole('status')).toHaveText('Preview off');
await expect(footer.getByRole('button', { name: 'Connect card for live preview' })).toHaveText('Connect');

const savedSummary = await page.getByTestId('kaleidoscope-summary').innerText();
await footer.getByRole('button', { name: 'Save and close Kaleidoscope' }).click();
await expect(page.getByRole('region', { name: 'Kaleidoscope reflection points' })).toHaveCount(0);
await expect(page.locator('[data-testid="kaleidoscope-marker"]')).toHaveCount(0);

await page.getByRole('button', { name: 'Edit Kaleidoscope reflection points' }).click();
await expect(page.getByTestId('kaleidoscope-summary')).toHaveText(savedSummary);
await expect(page.getByRole('button', { name: 'Fine-tune LEDs' })).toHaveAttribute('aria-expanded', 'false');
```

Change the calibration availability assertion from the old sentence to the compact status:

```ts
const unavailable = page.getByRole('status').filter({ hasText: 'Preview off' });
await expect(unavailable).toBeVisible();
```

- [ ] **Step 2: Run the focused suite to verify RED**

Run:

```bash
cd lightweaver
LIGHTWEAVER_TEST_PORT=10141 npx playwright test tests/layout-kaleidoscope.spec.ts --project=chromium --workers=1
```

Expected: FAIL because the old Custom spacing/help/status blocks still render and Save & close does not exist.

- [ ] **Step 3: Add the close callback without changing persistence**

Pass an explicit close handler beside the existing calibration props in `LayoutScreen`:

```jsx
kaleidoscopeCalibration={kaleidoscopeCalibration}
onCloseKaleidoscope={() => setKaleidoscopeEditor(null)}
onConnectCard={onConnectCard}
onOpenConnectionCenter={onOpenConnectionCenter}
```

Accept `onCloseKaleidoscope` in `DrawModePanel`. The footer button also closes the local fine-tune disclosure so reopening begins collapsed:

```jsx
<button
  type="button"
  className="btn primary la-kaleidoscope-save"
  aria-label="Save and close Kaleidoscope"
  onClick={() => {
    setFineTuneOpenByStrip(current => ({ ...current, [s.id]: false }));
    onCloseKaleidoscope();
  }}>
  Save &amp; close
</button>
```

Do not add a persisted lock field or another save operation. Setting the editor to `null` makes the existing calibration hook inactive, which runs its established stream cleanup and restores the previous look.

- [ ] **Step 4: Replace the multi-line footer**

Shorten the hook's active delivery labels:

```js
message: active
  ? delivery.physicalDelivered
    ? 'Preview live'
    : 'Preview off'
  : '',
```

Delete the standalone Custom spacing and red-marker hints. Keep reset notices and validation errors above the footer. Render one compact group:

```jsx
<div className="la-kaleidoscope-footer" role="group" aria-label="Kaleidoscope preview and save">
  {kaleidoscopeCalibration?.message && (
    <span className={`la-kaleidoscope-preview${kaleidoscopeCalibration.physicalDelivered ? ' is-live' : ''}`}
          role="status" aria-live="polite">
      <span className="la-kaleidoscope-preview-dot" aria-hidden="true"/>
      {kaleidoscopeCalibration.message}
    </span>
  )}
  {kaleidoscopeCalibration?.active && !kaleidoscopeCalibration.physicalDelivered && (
    <button type="button" className="btn la-kaleidoscope-connect"
            aria-label="Connect card for live preview"
            title="Connect card for live preview"
            onClick={() => {
              if (onOpenConnectionCenter) onOpenConnectionCenter();
              else onConnectCard?.();
            }}>
      Connect
    </button>
  )}
  <button type="button" className="btn primary la-kaleidoscope-save"
          aria-label="Save and close Kaleidoscope"
          onClick={() => {
            setFineTuneOpenByStrip(current => ({ ...current, [s.id]: false }));
            onCloseKaleidoscope();
          }}>
    Save &amp; close
  </button>
</div>
```

- [ ] **Step 5: Add compact responsive styling**

Add scoped footer styles:

```css
.la-kaleidoscope-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.la-kaleidoscope-preview {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  margin-right: auto;
  color: var(--text-faint);
  font-size: 11px;
  white-space: nowrap;
}

.la-kaleidoscope-preview-dot {
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  border-radius: 50%;
  background: var(--text-faint);
}

.la-kaleidoscope-preview.is-live {
  color: var(--ok);
}

.la-kaleidoscope-preview.is-live .la-kaleidoscope-preview-dot {
  background: currentColor;
}

.la-kaleidoscope-footer .btn {
  min-height: 30px;
  padding-inline: 9px;
  white-space: nowrap;
}

@media (max-width: 600px) {
  .la-kaleidoscope-footer {
    flex-wrap: wrap;
  }
}
```

Preserve the full Save & close label when the row wraps.

- [ ] **Step 6: Run GREEN and production verification**

Run:

```bash
cd lightweaver
node --test src/lib/kaleidoscope.test.js src/lib/kaleidoscopeCalibration.test.js
LIGHTWEAVER_TEST_PORT=10141 npx playwright test tests/layout-kaleidoscope.spec.ts --project=chromium --workers=1
npm run build
cd ..
git diff --check
```

Expected: all Node tests and five focused browser tests pass, Vite builds successfully, and diff hygiene is clean.

- [ ] **Step 7: Inspect the live Layout footer**

Open `http://127.0.0.1:55837/#screen=layout`, enter fine-tuning, and verify:

- the normal footer stays on one row in the actual inspector;
- only Preview off, Connect, and Save & close remain;
- selected-point controls remain readable;
- Save & close removes the panel and markers;
- reopening preserves the mapping and starts with Fine-tune LEDs collapsed.

- [ ] **Step 8: Commit the implementation**

```bash
git add lightweaver/tests/layout-kaleidoscope.spec.ts \
  lightweaver/src/components/LayoutScreen.jsx \
  lightweaver/src/components/layout/modes/DrawModePanel.jsx \
  lightweaver/src/components/layout/hooks/useKaleidoscopeCalibration.js \
  lightweaver/src/styles/v3-layout-extra.css
git commit -m "feat(layout): compact kaleidoscope calibration footer"
```
