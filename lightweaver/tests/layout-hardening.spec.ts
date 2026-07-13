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
  const canvas = page.locator('.lw-viewport');
  const sheet = page.locator('.la .side');
  await expect(canvas).toBeVisible();
  await expect(sheet).toHaveCSS('position', 'fixed');
  await expect(page.getByTestId('layout-sheet-handle')).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  const sheetBox = await sheet.boundingBox();
  if (!canvasBox || !sheetBox) throw new Error('mobile canvas or inspector unavailable');
  const nonOverlappedCanvasHeight = Math.min(canvasBox.y + canvasBox.height, sheetBox.y) - canvasBox.y;
  expect(nonOverlappedCanvasHeight).toBeGreaterThan(240);
});

test('toolbar names mode actions before Project and Card calibration groups', async ({ page }) => {
  await gotoLayout(page);
  const toolbar = page.locator('.la .toolbar');
  await expect(toolbar.getByRole('group', { name: 'Mode actions' })).toBeVisible();
  await expect(toolbar.getByRole('group', { name: 'Project' })).toBeVisible();
  await expect(toolbar.getByRole('group', { name: 'Card calibration' })).toBeVisible();
});

test('focusable SVG strip supports Select, arrow nudge, and Delete', async ({ page }) => {
  await gotoLayout(page);
  const strip = page.locator('path[data-strip-path]').first();
  await strip.focus();
  await page.keyboard.press('Enter');
  const parent = strip.locator('..');
  const before = await parent.getAttribute('transform');
  await page.keyboard.press('ArrowRight');
  await expect(parent).not.toHaveAttribute('transform', before || '');
  const count = await page.locator('path[data-strip-path]').count();
  await page.keyboard.press('Delete');
  await expect(page.locator('path[data-strip-path]')).toHaveCount(count - 1);
});

test('wire scaffold is concise and recovery actions stay hidden without a mixed-content failure', async ({ page }) => {
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/Connect each physical run/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy payload' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open installer' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});
