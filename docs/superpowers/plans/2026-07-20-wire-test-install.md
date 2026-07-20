# Wire and Test & Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the layout workflow to Wire and Test & Install, then replace the duplicated second-mode editor with a Draw-styled read-only plan summary and one commissioning action at a time.

**Architecture:** Preserve the internal `draw` and `wire` mode keys so hashes and saved state remain compatible. Keep Wire as the canonical editor, derive a read-only commissioning summary directly from `strips` and `wiring`, and retain existing bench-test, color-order, and card-install state transitions. Move specialist utilities under one closed disclosure and stop rendering normal wiring controls a second time.

**Tech Stack:** React 18, Vite 6, project CSS tokens and layout classes, Playwright.

---

## File structure

- Modify `lightweaver/src/components/layout/shared/ModeSwitch.jsx`: change user-facing mode labels only.
- Create `lightweaver/src/components/layout/wire/WiringPlanSummary.jsx`: render a read-only GPIO and strip-order summary using the first mode's existing visual classes.
- Modify `lightweaver/src/components/layout/modes/WireModePanel.jsx`: compose the read-only summary, single-next-action commissioning states, and reduced advanced tools.
- Modify `lightweaver/src/components/layout/wire/WiringBenchTest.jsx`: update user-facing Wire references and keep corrections contextual.
- Modify `lightweaver/src/components/layout/wire/WiringPreflight.jsx`: keep plain-language setup errors and route recovery to Wire.
- Modify `lightweaver/src/styles/lw-wire.css`: remove obsolete lane/editor styling from the normal flow and add only the Test & Install layout rules that are not already supplied by Draw classes.
- Modify `lightweaver/tests/layout-mode-switch.spec.ts`: assert new visible labels without changing hash keys.
- Modify `lightweaver/tests/wiring-workspace.spec.ts`: assert the read-only summary, sequential commissioning flow, and collapsed advanced tools.
- Modify `lightweaver/tests/layout-hardening.spec.ts`: verify touch targets and the narrow inspector after the duplicate editor is removed.
- Modify `lightweaver/tests/layout-send-to-card.spec.ts`: preserve the staged save, confirmation, and rollback path under the new surface.
- Modify `lightweaver/tests/patch-board.spec.ts`: remove expectations for normal second-mode mapping controls while preserving canonical Wire mutations.

### Task 1: Rename the visible workflow without breaking deep links

**Files:**
- Modify: `lightweaver/src/components/layout/shared/ModeSwitch.jsx`
- Modify: `lightweaver/tests/layout-mode-switch.spec.ts`

- [ ] **Step 1: Write the failing label and compatibility test**

Add these expectations after the mode switch becomes visible:

```ts
await expect(page.getByTestId('layout-mode-draw')).toHaveText('Wire');
await expect(page.getByTestId('layout-mode-wire')).toHaveText('Test & Install');
await page.getByTestId('layout-mode-wire').click();
await expect(page).toHaveURL(/mode=wire/);
await page.getByTestId('layout-mode-draw').click();
await expect(page).toHaveURL(/mode=draw/);
```

Keep the test IDs and URL assertions because the internal mode keys intentionally remain `draw` and `wire`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd lightweaver && npx playwright test tests/layout-mode-switch.spec.ts --project=chromium --workers=1
```

Expected: the new text assertions fail because the buttons still read Draw and Wire.

- [ ] **Step 3: Change only the user-facing labels**

Update `MODES` to:

```jsx
const MODES = [
  { key: 'draw', label: 'Wire' },
  { key: 'wire', label: 'Test & Install' },
];
```

Update the component comment to describe the new visible names and preserved internal keys.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same Playwright command. Expected: all `layout-mode-switch.spec.ts` tests pass.

- [ ] **Step 5: Commit the naming change**

```bash
git add lightweaver/src/components/layout/shared/ModeSwitch.jsx lightweaver/tests/layout-mode-switch.spec.ts
git commit -m "feat(layout): rename Wire and Test & Install modes"
```

### Task 2: Add the Draw-styled read-only wiring summary

**Files:**
- Create: `lightweaver/src/components/layout/wire/WiringPlanSummary.jsx`
- Modify: `lightweaver/src/components/layout/modes/WireModePanel.jsx`
- Modify: `lightweaver/src/styles/lw-wire.css`
- Modify: `lightweaver/tests/wiring-workspace.spec.ts`

- [ ] **Step 1: Write the failing summary test**

Seed the two default circles in `mode=wire`, then add:

```ts
test('Test & Install mirrors the Wire GPIO groups as a read-only summary', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'wire' });
  const summary = page.getByTestId('test-install-plan-summary');
  await expect(summary).toBeVisible();
  await expect(summary.getByText('GPIO 16')).toBeVisible();
  await expect(summary.getByText('first → last')).toBeVisible();
  await expect(summary.locator('[data-testid="test-install-strip-row"]')).toHaveCount(2);
  await expect(summary).toContainText('Outer circle');
  await expect(summary).toContainText('27 LEDs');
  await expect(summary.locator('select, input, [draggable="true"]')).toHaveCount(0);
  await expect(summary.getByRole('button')).toHaveCount(0);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd lightweaver && npx playwright test tests/wiring-workspace.spec.ts --project=chromium --workers=1 -g "read-only summary"
```

Expected: fail because `test-install-plan-summary` does not exist.

- [ ] **Step 3: Implement the focused summary component**

Create a component with this interface:

```jsx
export function WiringPlanSummary({ wiring, strips }) {
  const stripsById = new Map(strips.map(strip => [strip.id, strip]));
  const groups = wiring.outputs.map(output => {
    const seen = new Set();
    const ordered = output.runIds
      .map(id => wiring.runs.find(run => run.id === id))
      .filter(run => run?.type === 'strip')
      .map(run => stripsById.get(run.source.stripId))
      .filter(strip => strip && !seen.has(strip.id) && seen.add(strip.id));
    return { output, strips: ordered };
  }).filter(group => group.strips.length);

  return (
    <div className="lww-plan-summary" data-testid="test-install-plan-summary">
      {groups.map(({ output, strips: groupStrips }) => (
        <section key={output.id} className="la-gpio-group">
          <div className="la-gpio-group-head">
            <span>GPIO {output.pin}</span><span>first → last</span>
          </div>
          {groupStrips.map((strip, index) => (
            <div key={strip.id} className="la-strip-row lww-plan-strip" data-testid="test-install-strip-row">
              <span className="la-wire-n">{String(index + 1).padStart(2, '0')}</span>
              <span className="layer-swatch" style={{ borderRadius: '50%', background: strip.color }}/>
              <span className="layer-name">{strip.name}</span>
              <span className="layer-len">{strip.pixelCount} LEDs</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
```

Import it into `WireModePanel.jsx`. Place it after a compact heading that uses the current Draw pattern:

```jsx
<div className="panel-head lww-plan-head">
  <span className="ttl">Test & Install</span>
  <span className="meta">{stripRunCount} {stripWord} · {compiledWiring.totalPixels} LEDs · from Wire</span>
</div>
<WiringPlanSummary wiring={wiring} strips={strips}/>
```

Do not add a new card skin. Reuse `la-gpio-group`, `la-gpio-group-head`, `la-strip-row`, `la-wire-n`, `layer-swatch`, `layer-name`, and `layer-len` from Draw. Add only pointer, cursor, and spacing overrides needed to make the rows read-only.

- [ ] **Step 4: Run the summary test and the mode tests**

Run:

```bash
cd lightweaver && npx playwright test tests/wiring-workspace.spec.ts tests/layout-mode-switch.spec.ts --project=chromium --workers=1 -g "read-only summary|keyboard 1/2|two equal mode tabs"
```

Expected: the selected tests pass with no horizontal overflow.

- [ ] **Step 5: Commit the summary**

```bash
git add lightweaver/src/components/layout/wire/WiringPlanSummary.jsx lightweaver/src/components/layout/modes/WireModePanel.jsx lightweaver/src/styles/lw-wire.css lightweaver/tests/wiring-workspace.spec.ts
git commit -m "feat(layout): add read-only Test and Install summary"
```

### Task 3: Remove duplicated normal editing and keep one next action

**Files:**
- Modify: `lightweaver/src/components/layout/modes/WireModePanel.jsx`
- Modify: `lightweaver/src/components/layout/wire/WiringBenchTest.jsx`
- Modify: `lightweaver/src/components/layout/wire/WiringPreflight.jsx`
- Modify: `lightweaver/src/styles/lw-wire.css`
- Modify: `lightweaver/tests/wiring-workspace.spec.ts`
- Modify: `lightweaver/tests/patch-board.spec.ts`

- [ ] **Step 1: Write failing tests for the reduced surface**

Add assertions for the idle state:

```ts
await expect(page.getByTestId('start-led-check')).toBeVisible();
await expect(page.getByTestId('advanced-installation-tools')).toHaveJSProperty('open', false);
await expect(page.getByTestId('wiring-output-lane')).toHaveCount(0);
await expect(page.getByText('Data wire mapping')).toHaveCount(0);
await expect(page.getByText('Board pins', { exact: true })).toHaveCount(0);
await expect(page.getByLabel('Output A board pin')).toHaveCount(0);
await expect(page.getByLabel('Output A GPIO')).toHaveCount(0);
```

For incomplete wiring, assert that the only recovery edits the canonical first mode:

```ts
await expect(page.getByRole('button', { name: 'Edit in Wire' })).toBeVisible();
await page.getByRole('button', { name: 'Edit in Wire' }).click();
await expect(page.getByTestId('layout-mode-draw')).toHaveAttribute('aria-pressed', 'true');
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
cd lightweaver && npx playwright test tests/wiring-workspace.spec.ts tests/patch-board.spec.ts --project=chromium --workers=1 -g "reduced surface|Edit in Wire|compiler-derived"
```

Expected: failures show the old lane editor, Board pins, or Advanced wiring label.

- [ ] **Step 3: Replace the advanced editor with specialist tools**

In `WireModePanel.jsx`, remove the normal render path for `WiringOutputLane`, the Data wire mapping toolbar, duplicate LED-output pin selects, and the always-open expert editor.

Render one closed disclosure:

```jsx
<details className="lww-advanced-tools" data-testid="advanced-installation-tools">
  <summary>Advanced installation tools</summary>
  <div className="lww-advanced-tools-body">
    <WireDiscovery outputs={wiring.outputs} cardHost={cardHost} disabled={wiring.locked} onPinConfirmed={changeOutputPin}/>
    {compiledWiring.sendReady && (
      <button className="btn" onClick={() => setShowAssembly(value => !value)}>
        {showAssembly ? 'Hide assembly map' : 'Open assembly map'}
      </button>
    )}
    <button className="btn btn-ghost" onClick={exportLedmap}>Download WLED map</button>
    <details className="lww-custom-mapping">
      <summary>Custom mapping</summary>
      <button aria-pressed={wireOverlayMode === 'chop'} onClick={toggleSplitTool}>Split a strip mid-wire</button>
      <button className="btn" disabled={wiring.locked} onClick={addInactive}>Add skipped LEDs</button>
      {derivedCut && (
        <section className="lw-wire-selected-detail">
          <div className="lw-wire-section-title"><span>Selected split</span><strong>LED {derivedCut.cutLed}</strong></div>
          <div className="lw-wire-tool-row">
            <button className="btn" disabled={wiring.locked} aria-label="Move split earlier" onClick={() => nudgeSelectedWireCut(-1, derivedCut)}>−</button>
            <button className="btn" disabled={wiring.locked} aria-label="Move split later" onClick={() => nudgeSelectedWireCut(1, derivedCut)}>+</button>
            <button className="btn" disabled={wiring.locked} aria-label="Merge split runs" onClick={() => deleteSelectedWireCut(derivedCut)}>Merge</button>
          </div>
        </section>
      )}
      {selectedRun?.type === 'strip' && splitStripIds.has(selectedRun.source.stripId) && (
        <div className="lw-wiring-range">
          <strong>Custom source range</strong>
          <label>Start LED <input type="number" min="0" disabled={wiring.locked} value={selectedRun.source.from} onChange={event => updateSelectedRange('from', event.target.value)}/></label>
          <label>End LED <input type="number" min="0" disabled={wiring.locked} value={selectedRun.source.to} onChange={event => updateSelectedRange('to', event.target.value)}/></label>
          <label>Direction policy
            <select disabled={wiring.locked} value={selectedRun.directionPolicy} onChange={event => mutate(draft => {
              const run = draft.runs.find(item => item.id === selectedRun.id);
              if (run?.type === 'strip') run.directionPolicy = event.target.value;
            }, { changeKind: 'direction', runIds: [selectedRun.id] })}>
              <option value="flexible">Flexible</option><option value="fixed">Fixed</option>
            </select>
          </label>
          <label>Physical DATA IN
            <select disabled={wiring.locked || selectedRun.directionPolicy === 'fixed'} value={selectedRun.physicalDirection} onChange={event => mutate(draft => {
              const run = draft.runs.find(item => item.id === selectedRun.id);
              if (run?.type === 'strip') run.physicalDirection = event.target.value;
            }, { changeKind: 'direction', runIds: [selectedRun.id] })}>
              <option value="source-forward">Start LED</option><option value="source-reverse">End LED</option>
            </select>
          </label>
          <label>Connector seam LED
            <input type="number" min={selectedRun.source.from} max={selectedRun.source.to}
              disabled={wiring.locked || selectedRun.verified || selectedRun.directionPolicy === 'fixed'}
              value={selectedRun.seamLed ?? selectedRun.source.from}
              onChange={event => mutate(draft => {
                const run = draft.runs.find(item => item.id === selectedRun.id);
                if (!run || run.verified || run.directionPolicy === 'fixed') throw new Error('Verified or fixed connector seams cannot move.');
                run.seamLed = Math.max(run.source.from, Math.min(run.source.to, Math.trunc(Number(event.target.value))));
              }, { changeKind: 'seam', runIds: [selectedRun.id] })}/>
          </label>
        </div>
      )}
    </details>
    <details className="lww-card-hardware">
      <summary>Card hardware</summary>
      {/* Keep physical control-pin and power fields here. Do not repeat LED output GPIO selectors. */}
    </details>
  </div>
</details>
```

Define:

```jsx
const splitStripIds = new Set(
  wiring.runs
    .filter(run => run.type === 'strip')
    .map(run => run.source.stripId)
    .filter((stripId, index, ids) => ids.indexOf(stripId) !== index),
);
```

Keep the existing handler logic used by these specialist blocks. Remove imports and state that become unreachable after the duplicate lane editor is removed. Do not delete compiler, bench-test, assembly, color-order, or card-push behavior.

- [ ] **Step 4: Keep correction controls inside the active test**

In `WiringBenchTest.jsx`, retain direction and count correction only under **Something's wrong**. Change recovery copy from Draw to Wire and ensure a correction updates canonical wiring through `updateWiring`.

In `WireModePanel.jsx`, change incomplete-plan copy to **Finish the setup in Wire** and render:

```jsx
<button type="button" className="btn" onClick={() => {
  setDrawMode(false);
  setGhostPt(null);
  window.location.hash = '#screen=layout&mode=draw';
}}>Edit in Wire</button>
```

Use the existing mode state setter if it is available in `state`; prefer `setMode('draw')` over direct hash mutation.

- [ ] **Step 5: Run the focused commissioning tests**

Run:

```bash
cd lightweaver && npx playwright test tests/wiring-workspace.spec.ts tests/patch-board.spec.ts --project=chromium --workers=1
```

Expected: the summary and commissioning tests pass; expectations tied to the deleted normal lane editor are replaced by canonical Wire-mode assertions.

- [ ] **Step 6: Commit the reduced surface**

```bash
git add lightweaver/src/components/layout/modes/WireModePanel.jsx lightweaver/src/components/layout/wire/WiringBenchTest.jsx lightweaver/src/components/layout/wire/WiringPreflight.jsx lightweaver/src/styles/lw-wire.css lightweaver/tests/wiring-workspace.spec.ts lightweaver/tests/patch-board.spec.ts
git commit -m "feat(layout): focus Test and Install on commissioning"
```

### Task 4: Preserve install safety and validate the actual screen

**Files:**
- Modify: `lightweaver/tests/layout-send-to-card.spec.ts`
- Modify: `lightweaver/tests/layout-hardening.spec.ts`
- Modify: `lightweaver/src/styles/lw-wire.css`

- [ ] **Step 1: Update the save-to-card assertions for the sequential surface**

Keep the existing mocked card endpoints and assert:

```ts
await expect(page.getByTestId('layout-send-to-card')).toHaveCount(0);
// Seed or complete physical and color verification.
await expect(page.getByTestId('layout-send-to-card')).toBeVisible();
await page.getByTestId('layout-send-to-card').click();
await expect(page.getByRole('region', { name: 'Wiring safety check' })).toBeVisible();
await expect(page.getByRole('button', { name: 'Start 90-second test' })).toBeVisible();
```

Keep both branches: **Yes, everything lights correctly** commits the staged configuration; **No, restore working setup** rolls it back.

- [ ] **Step 2: Update narrow and touch tests**

Replace lane-editor target checks with the controls that remain:

```ts
for (const control of [
  page.getByTestId('start-led-check'),
  page.getByTestId('advanced-installation-tools').locator('summary'),
]) {
  const box = await control.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
}
```

At a 300-pixel inspector width, assert the plan summary and commissioning section have `scrollWidth <= clientWidth`.

- [ ] **Step 3: Run the focused safety and responsive tests**

Run:

```bash
cd lightweaver && npx playwright test tests/layout-send-to-card.spec.ts tests/layout-hardening.spec.ts --project=chromium --workers=1
```

Expected: all tests pass.

- [ ] **Step 4: Run the relevant full verification**

Run:

```bash
cd lightweaver && npx playwright test tests/layout-mode-switch.spec.ts tests/wiring-workspace.spec.ts tests/patch-board.spec.ts tests/layout-hardening.spec.ts tests/layout-send-to-card.spec.ts --project=chromium --workers=1
npm run build
```

Expected: all selected Playwright tests pass and Vite completes a production build.

- [ ] **Step 5: Inspect desktop and mobile screenshots**

Run the app with `npm run dev`, open `#screen=layout&mode=draw` and `#screen=layout&mode=wire`, and capture both at desktop inspector width and 390 × 844.

Verify:

- the two modes use the same panel heading, GPIO header, strip row, typography, borders, spacing, and orange accent;
- Test & Install has one obvious primary action;
- the advanced disclosure is closed by default;
- no duplicate GPIO, count, order, direction, or seam editor appears;
- the mobile bottom sheet shows the summary and action without horizontal clipping.

- [ ] **Step 6: Commit final verification adjustments**

```bash
git add lightweaver/tests/layout-send-to-card.spec.ts lightweaver/tests/layout-hardening.spec.ts lightweaver/src/styles/lw-wire.css
git commit -m "test(layout): verify Test and Install workflow"
```

Do not commit unrelated workspace files.
