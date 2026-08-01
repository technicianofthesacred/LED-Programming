# Kaleidoscope Inline Steppers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Kaleidoscope point-count input and shared fine-tune nudge row with compact inline left/right steppers.

**Architecture:** Keep the existing Kaleidoscope state and mutation callbacks unchanged. Reshape only `DrawModePanel` markup and Layout CSS so quantity and each reflection point expose their own arrow controls, then extend the existing browser regression to prove selection, bounds, confirmation, nudge, collision, and persistence behavior.

**Tech Stack:** React 18, JavaScript/JSX, CSS, Playwright.

---

### Task 1: Lock the inline-stepper interaction contract

**Files:**
- Modify: `lightweaver/tests/layout-kaleidoscope.spec.ts:20-68`

- [ ] **Step 1: Write the failing browser assertions**

Replace direct number-input interaction with button assertions and add a per-point nudge that begins on an unselected point:

```ts
const countStepper = page.getByRole('group', { name: 'Reflection point count' });
await expect(countStepper.getByRole('button')).toHaveCount(2);
await expect(countStepper.getByTestId('kaleidoscope-count-value')).toHaveText('4 points');
await countStepper.getByRole('button', { name: 'Increase reflection point count' }).click();
await expect(countStepper.getByTestId('kaleidoscope-count-value')).toHaveText('5 points');

await fineTune.click();
const point2 = page.getByRole('listitem').nth(1);
await expect(point2.getByRole('button')).toHaveCount(3);
await expect(point2.getByRole('button', { name: 'Fine-tune reflection point 2' })).toHaveText('2: LED 4');
await point2.getByRole('button', { name: 'Move reflection point 2 forward one LED' }).click();
await expect(point2.getByRole('button', { name: 'Fine-tune reflection point 2' })).toHaveText('2: LED 5');
```

Add assertions that:

- the quantity decrement button is disabled at two;
- the quantity increment button is disabled at `pixelCount`;
- a count change with custom spacing still uses the existing confirmation;
- the separate `Fine tune selected reflection point` group no longer exists;
- clicking a point arrow selects that point before moving it;
- collision rejection and undo behavior remain covered by the existing second test.

- [ ] **Step 2: Run RED**

Run:

```bash
cd lightweaver
LIGHTWEAVER_TEST_PORT=10137 npx playwright test tests/layout-kaleidoscope.spec.ts --project=chromium --workers=1
```

Expected: FAIL because the current quantity is a number input, each point has only one button, and the old shared fine-tune group is still present.

### Task 2: Implement quantity and per-point inline steppers

**Files:**
- Modify: `lightweaver/src/components/layout/modes/DrawModePanel.jsx:1275-1330`
- Modify: `lightweaver/src/styles/v3-layout-extra.css:650-705`

- [ ] **Step 1: Replace the point-count input**

Render one accessible group with two buttons and a center value label. The arrows retain the existing count callback and bounds:

```jsx
<div className="la-kaleidoscope-stepper la-kaleidoscope-count"
     role="group" aria-label="Reflection point count">
  <button type="button" className="btn la-stepper-arrow"
          aria-label="Decrease reflection point count"
          disabled={s.kaleidoscope.pointCount <= 2}
          onClick={() => onChangeKaleidoscopeCount(s.id, s.kaleidoscope.pointCount - 1)}>←</button>
  <span className="btn la-stepper-value" data-testid="kaleidoscope-count-value"
        aria-live="polite">{s.kaleidoscope.pointCount} points</span>
  <button type="button" className="btn la-stepper-arrow"
          aria-label="Increase reflection point count"
          disabled={s.kaleidoscope.pointCount >= s.pixelCount}
          onClick={() => onChangeKaleidoscopeCount(s.id, s.kaleidoscope.pointCount + 1)}>→</button>
</div>
```

The center is a readable value label; only the arrows are interactive.

- [ ] **Step 2: Replace each fine-tune tile**

Each `role=listitem` becomes an inline stepper. Arrow handlers select the point first, then call the existing nudge callback:

```jsx
<span className={`la-kaleidoscope-point-stepper${selected ? ' active' : ''}`}
      key={pointIndex} role="listitem">
  <button type="button" className="btn la-stepper-arrow"
          aria-label={`Move reflection point ${pointIndex + 1} backward one LED`}
          onClick={() => {
            onSelectKaleidoscopePoint(s.id, pointIndex);
            onNudgeKaleidoscopePoint(s.id, pointIndex, -1);
          }}>←</button>
  <button type="button" className="btn la-stepper-value"
          aria-label={`Fine-tune reflection point ${pointIndex + 1}`}
          onClick={() => onSelectKaleidoscopePoint(s.id, pointIndex)}>
    {pointIndex + 1}: LED {ledIndex + 1}
  </button>
  <button type="button" className="btn la-stepper-arrow"
          aria-label={`Move reflection point ${pointIndex + 1} forward one LED`}
          onClick={() => {
            onSelectKaleidoscopePoint(s.id, pointIndex);
            onNudgeKaleidoscopePoint(s.id, pointIndex, 1);
          }}>→</button>
</span>
```

Delete the old conditional `la-kaleidoscope-fine` row. Do not change `LayoutScreen` mutation logic.

- [ ] **Step 3: Add compact responsive styling**

Use one reusable grid-based stepper:

```css
.la-kaleidoscope-stepper,
.la-kaleidoscope-point-stepper {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 36px;
  align-items: stretch;
  gap: 5px;
}

.la-kaleidoscope-point-stepper.active {
  outline: 1px solid var(--accent);
  border-radius: 9px;
}

.la-stepper-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Keep the two-column point grid at normal width. At the existing narrow Layout breakpoint, allow it to collapse to one column. Reuse existing `.btn`, `.active`, and disabled styling rather than introducing new colors.

- [ ] **Step 4: Run GREEN**

Run:

```bash
cd lightweaver
LIGHTWEAVER_TEST_PORT=10137 npx playwright test tests/layout-kaleidoscope.spec.ts --project=chromium --workers=1
npm run build
```

Expected: all Kaleidoscope browser tests pass and Vite builds successfully.

### Task 3: Inspect the live Layout result and commit

**Files:**
- Verify: `lightweaver/src/components/layout/modes/DrawModePanel.jsx`
- Verify: `lightweaver/src/styles/v3-layout-extra.css`
- Verify: `lightweaver/tests/layout-kaleidoscope.spec.ts`

- [ ] **Step 1: Run the Studio on a fresh port**

```bash
cd lightweaver
npm run dev -- --host 127.0.0.1 --port 55837 --strictPort
```

Open `http://127.0.0.1:55837/#screen=layout`, create a representative strip, and verify desktop and narrow panel widths. Confirm quantity and every point read as `← value →`, selected orange styling is coherent, labels do not clip, and touch targets remain usable.

- [ ] **Step 2: Run final focused verification**

```bash
cd lightweaver
node --test src/lib/kaleidoscope.test.js
LIGHTWEAVER_TEST_PORT=10137 npx playwright test tests/layout-kaleidoscope.spec.ts --project=chromium --workers=1
npm run build
cd ..
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 3: Commit**

```bash
git add lightweaver/src/components/layout/modes/DrawModePanel.jsx \
  lightweaver/src/styles/v3-layout-extra.css \
  lightweaver/tests/layout-kaleidoscope.spec.ts
git commit -m "feat(layout): add kaleidoscope inline steppers"
```
