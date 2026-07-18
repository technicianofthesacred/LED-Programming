import { test, expect } from '@playwright/test';

// Phase 2 step 6 (docs/layout-redesign-plan.md) — the Draw | Size | Wire mode
// switch + hash sync + cancelActiveTool. Draw mode renders the existing side
// panel verbatim; Size renders the real Size panel (step 8); Wire renders the
// real Wire panel (step 9), so the old `layout-wire-stub` is gone.

async function gotoLayout(page: any, hash = '#screen=layout') {
  await page.goto(`/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
}

test('keyboard 1/2/3 update the hash mode param and the active segment', async ({ page }) => {
  await gotoLayout(page);

  await expect(page.getByTestId('layout-mode-switch')).toBeVisible();
  await expect(page.getByTestId('layout-mode-draw')).toHaveClass(/on/);

  await page.keyboard.press('2');
  await expect(page).toHaveURL(/mode=size/);
  await expect(page.getByTestId('layout-mode-size')).toHaveClass(/on/);
  await expect(page.getByTestId('layout-mode-draw')).not.toHaveClass(/on/);
  await expect(page.getByTestId('layout-size-panel')).toBeVisible();

  await page.keyboard.press('3');
  await expect(page).toHaveURL(/mode=wire/);
  await expect(page.getByTestId('layout-mode-wire')).toHaveClass(/on/);
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();

  await page.keyboard.press('1');
  await expect(page).toHaveURL(/mode=draw/);
  await expect(page.getByTestId('layout-mode-draw')).toHaveClass(/on/);
  await expect(page.getByTestId('layout-size-panel')).toHaveCount(0);
  await expect(page.getByTestId('layout-wire-panel')).toHaveCount(0);
});

test('the three equal mode tabs live at the top of the inspector and tint each section', async ({ page }) => {
  await gotoLayout(page);

  const inspector = page.locator('.la > .side');
  const modeSwitch = page.getByTestId('layout-mode-switch');
  await expect(inspector.locator('[data-testid="layout-mode-switch"]')).toHaveCount(1);
  await expect(page.locator('.toolbar [data-testid="layout-mode-switch"]')).toHaveCount(0);

  const widths = await modeSwitch.getByRole('button').evaluateAll(buttons =>
    buttons.map(button => Math.round(button.getBoundingClientRect().width)));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);

  const tintFor = async (mode: 'draw' | 'size' | 'wire') => {
    await page.getByTestId(`layout-mode-${mode}`).click();
    return inspector.locator('.la-mode-content').evaluate(element => getComputedStyle(element).backgroundImage);
  };
  const drawTint = await tintFor('draw');
  const sizeTint = await tintFor('size');
  const wireTint = await tintFor('wire');
  expect(new Set([drawTint, sizeTint, wireTint]).size).toBe(3);
});

test('reloading with #screen=layout&mode=wire opens directly in Wire mode', async ({ page }) => {
  await gotoLayout(page, '#screen=layout&mode=wire');

  await expect(page.getByTestId('layout-mode-wire')).toHaveClass(/on/);
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  await page.getByRole('region', { name: 'Step 5: Review and install' }).getByRole('button', { name: 'Open install review' }).click();
  await expect(page.getByTestId('layout-send-to-card')).toBeVisible();
});

test('switching modes and activating Wire tools suspend the in-progress strip until Draw resumes or Cancel clears it', async ({ page }) => {
  await gotoLayout(page);

  const drawBtn = page.getByTitle('Draw a new LED strip path on the artwork.');
  await drawBtn.click();
  await expect(drawBtn).toHaveClass(/active/);

  // Click twice in the empty top-left corner of the canvas — the default
  // two-circle hardware layout (viewBox 0 0 640 400, circles centered at
  // 320,200 with radius <=144) never reaches this corner.
  const svg = page.locator('.lw-viewport svg');
  const box = await svg.boundingBox();
  if (!box) throw new Error('canvas svg not found');
  await page.mouse.click(box.x + box.width * 0.06, box.y + box.height * 0.08);
  await page.mouse.click(box.x + box.width * 0.14, box.y + box.height * 0.16);
  await expect(page.locator('.la-draw-hint')).toContainText('2 points');

  await page.keyboard.press('2');
  await expect(page.getByTestId('layout-mode-size')).toHaveClass(/on/);
  await expect(page.getByTestId('layout-size-panel')).toBeVisible();
  await expect(page.locator('.la-draw-hint')).toHaveCount(0);

  await page.keyboard.press('1');
  await expect(page.getByTestId('layout-mode-draw')).toHaveClass(/on/);
  await expect(drawBtn).not.toHaveClass(/active/);
  await drawBtn.click();
  await expect(drawBtn).toHaveClass(/active/);
  await expect(page.locator('.la-draw-hint')).toContainText('2 points');

  await page.getByTestId('layout-mode-wire').click();
  await page.getByTitle('Split one physical strip where the wire jumps to a new spot.').click();
  await page.getByTestId('layout-mode-draw').click();
  await drawBtn.click();
  await expect(page.locator('.la-draw-hint')).toContainText('2 points');

  await page.getByTestId('layout-mode-wire').click();
  await page.getByTitle('Join two strips into one continuous run.').click();
  await page.getByTestId('layout-mode-draw').click();
  await drawBtn.click();
  await expect(page.locator('.la-draw-hint')).toContainText('2 points');

  await page.getByRole('button', { name: /Cancel \(Esc\)/ }).click();
  await expect(page.locator('.la-draw-hint')).toHaveCount(0);
  await expect(drawBtn).not.toHaveClass(/active/);
  await expect(drawBtn).toHaveText('Draw');
});

test('clicking the segments switches mode; other screens are unaffected', async ({ page }) => {
  await gotoLayout(page);

  await page.getByTestId('layout-mode-wire').click();
  await expect(page).toHaveURL(/mode=wire/);
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();

  await page.getByTestId('layout-mode-draw').click();
  await expect(page).toHaveURL(/mode=draw/);
  await expect(page.getByTestId('layout-wire-panel')).toHaveCount(0);

  // The canvas persists across modes, while Draw-only import stays out of Wire.
  await page.getByTestId('layout-mode-wire').click();
  await expect(page.getByRole('button', { name: 'Import SVG' })).toHaveCount(0);
  await expect(page.locator('.lw-viewport svg')).toBeVisible();

  // A totally different screen still loads fine — the mode hash-merge never
  // fights Shell's `#screen=` writes (src/v3/app.jsx).
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.chips[aria-label="Target sections"]')).toBeVisible();
  await expect(page.locator('.rail-item.active')).toContainText('Patterns');
});
