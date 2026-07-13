import { test, expect } from '@playwright/test';

async function gotoLayout(page: any) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
}

test('pending drawing survives a mode visit until explicitly cancelled', async ({ page }) => {
  await gotoLayout(page);
  await page.getByTitle('Draw a new LED strip path on the artwork.').click();
  const svg = page.locator('.lw-viewport svg');
  const box = await svg.boundingBox();
  if (!box) throw new Error('canvas unavailable');
  await page.mouse.click(box.x + 30, box.y + 30);
  await page.mouse.click(box.x + 80, box.y + 60);
  await page.getByTestId('layout-mode-size').click();
  await page.getByTestId('layout-mode-draw').click();
  await page.getByTitle('Draw a new LED strip path on the artwork.').click();
  await expect(page.locator('.la-draw-hint')).toContainText('2 points');
  await page.getByRole('button', { name: /Cancel \(Esc\)/ }).click();
  await expect(page.locator('.la-draw-hint')).toHaveCount(0);
});

test('manual counts and reset are independently undoable', async ({ page }) => {
  await gotoLayout(page);
  await page.getByTestId('layout-mode-size').click();
  const count = page.getByTestId('layout-size-strip-row').first().getByRole('spinbutton');
  const original = await count.inputValue();
  await count.fill('77');
  await count.blur();
  await page.getByTitle('Reset to the computed count').click();
  await page.getByTitle(/Undo/).click();
  await expect(count).toHaveValue('77');
  await page.getByTitle(/Undo/).click();
  await expect(count).toHaveValue(original);
  await page.getByTitle(/Redo/).click();
  await expect(count).toHaveValue('77');
});

test('mobile Layout keeps a useful canvas and presents the inspector as a bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoLayout(page);
  await expect(page.locator('.lw-viewport')).toBeVisible();
  const box = await page.locator('.lw-viewport').boundingBox();
  expect(box?.height).toBeGreaterThan(240);
  await expect(page.locator('.la .side')).toHaveCSS('position', 'fixed');
});

test('toolbar names mode actions before Project and Card calibration groups', async ({ page }) => {
  await gotoLayout(page);
  const toolbar = page.locator('.la .toolbar');
  await expect(toolbar.getByRole('group', { name: 'Mode actions' })).toBeVisible();
  await expect(toolbar.getByRole('group', { name: 'Project' })).toBeVisible();
  await expect(toolbar.getByRole('group', { name: 'Card calibration' })).toBeVisible();
});
