# Card Connection Setup List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the connection popup's three setup instructions in one readable vertical column at every popup width.

**Architecture:** Separate the popup list from the Card workspace tracker by giving it a component-specific class. Protect the layout with a browser geometry test at 320px, 390px, and desktop widths.

**Tech Stack:** React, CSS, Playwright

---

### Task 1: Add the responsive regression test

**Files:**
- Modify: `lightweaver/tests/connection-center-quality.spec.ts`

- [ ] **Step 1: Write the failing browser test**

Add a test after the eight-pixel recovery test. For each viewport width, open the factory-beacon recovery route and measure the ordered list:

```ts
test('setup-network instructions stay in one full-width vertical column', async ({ page }) => {
  for (const width of [320, 390, 900]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('lw_card_identity_v1', JSON.stringify({
        version: 1,
        id: 'lw-layout-card',
        hostname: 'layout-card.local',
        address: '192.168.18.70',
      }));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
    await page.getByRole('button', { name: 'Eight lights flash twice, then pause' }).click();

    const list = actionRegion(page).getByRole('list');
    const geometry = await list.evaluate(element => {
      const listRect = element.getBoundingClientRect();
      const items = [...element.querySelectorAll('li')].map(item => item.getBoundingClientRect());
      return {
        listWidth: listRect.width,
        items: items.map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });

    expect(geometry.items).toHaveLength(3);
    for (const item of geometry.items) expect(item.width).toBeGreaterThan(geometry.listWidth - 40);
    expect(geometry.items[1].y).toBeGreaterThanOrEqual(geometry.items[0].y + geometry.items[0].height - 1);
    expect(geometry.items[2].y).toBeGreaterThanOrEqual(geometry.items[1].y + geometry.items[1].height - 1);
    expect(geometry.scrollWidth).toBe(geometry.clientWidth);
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd lightweaver
npx playwright test tests/connection-center-quality.spec.ts --project=chromium --workers=1 --grep 'setup-network instructions stay'
```

Expected: FAIL at the desktop viewport because the popup list inherits five narrow grid tracks from the Card workspace tracker.

### Task 2: Isolate and stack the popup list

**Files:**
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx:424-429`
- Modify: `lightweaver/src/v3/v3-styles.css:686`

- [ ] **Step 1: Give the popup list a component-specific class**

Change the popup markup to:

```jsx
<ol className="card-connection-setup-steps">
  <li>Power the Lightweaver card.</li>
  <li>Join the <strong>Lightweaver-XXXX</strong> Wi-Fi network.</li>
  <li>{setupRecovery ? 'Return to Studio, then press Continue after joining.' : 'Finish setup, return to Studio, then press Continue.'}</li>
</ol>
```

- [ ] **Step 2: Define the isolated vertical layout**

Replace the connection popup's generic rule with:

```css
.card-connection-setup-steps {
  display: grid;
  gap: 4px;
  margin: 12px 0 0;
  padding-left: 24px;
  color: var(--text-mid);
  font-size: 12.5px;
  line-height: 1.55;
}
.card-connection-setup-steps li {
  min-width: 0;
  padding-left: 2px;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run the Task 1 command again.

Expected: 1 passed, with all three widths remaining vertical and overflow-free.

### Task 3: Verify the complete connection surface

**Files:**
- Test: `lightweaver/tests/connection-center-quality.spec.ts`
- Test: `lightweaver/tests/screen-smoke.spec.ts`

- [ ] **Step 1: Run the complete relevant browser suites**

```bash
cd lightweaver
npx playwright test tests/connection-center-quality.spec.ts tests/screen-smoke.spec.ts --project=chromium --workers=1
```

Expected: all tests pass.

- [ ] **Step 2: Build production assets**

```bash
cd lightweaver
npm run build
```

Expected: Vite production build exits successfully.

- [ ] **Step 3: Inspect the actual popup at 390px**

Capture the setup-network recovery popup at 390px. Confirm the three instructions are full-width vertical rows, the Continue action follows them, and no horizontal overflow appears.

- [ ] **Step 4: Commit the implementation**

```bash
git add lightweaver/src/components/card/CardConnectionCenter.jsx lightweaver/src/v3/v3-styles.css lightweaver/tests/connection-center-quality.spec.ts docs/superpowers/plans/2026-08-04-card-connection-setup-list.md
git commit -m "Fix card setup list layout"
```
