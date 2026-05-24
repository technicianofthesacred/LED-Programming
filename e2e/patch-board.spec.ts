import { test, expect } from '@playwright/test';

const SIMPLE_SVG = 'e2e/fixtures/simple-layers.svg';

test('patch board reorder changes WLED export order', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.locator('input#file-input').setInputFiles(SIMPLE_SVG);

  await expect(page.locator('#artwork-layers-list .alr-row.alr-layer')).toHaveCount(3, {
    timeout: 5000,
  });

  await page.getByRole('button', { name: 'Patch Board' }).click();
  const rows = page.locator('.patch-row');
  await expect(rows).toHaveCount(3);

  const firstBefore = await rows.nth(0).getAttribute('data-patch-id');
  await page.getByRole('button', { name: 'Export' }).click();
  const previewBefore = await page.locator('#export-preview').innerText();
  const exportedBefore = JSON.parse(previewBefore);

  await page.getByRole('button', { name: 'Patch Board' }).click();
  await rows.nth(1).getByRole('button', { name: 'Move up' }).click();
  const firstAfter = await rows.nth(0).getAttribute('data-patch-id');
  expect(firstAfter).not.toBe(firstBefore);

  await page.getByRole('button', { name: 'Export' }).click();
  const previewText = await page.locator('#export-preview').innerText();
  const exported = JSON.parse(previewText);

  expect(exported.n).toBeGreaterThan(0);
  expect(Array.isArray(exported.map[0])).toBe(true);
  expect(exported.map[0]).not.toEqual(exportedBefore.map[0]);
});

test('patch board range edits and reverse controls update row state', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.locator('input#file-input').setInputFiles(SIMPLE_SVG);

  await expect(page.locator('#artwork-layers-list .alr-row.alr-layer')).toHaveCount(3, {
    timeout: 5000,
  });

  await page.getByRole('button', { name: 'Patch Board' }).click();
  const firstRow = page.locator('.patch-row').first();
  await expect(firstRow).toBeVisible();

  const start = firstRow.locator('.patch-start');
  const end = firstRow.locator('.patch-end');
  await start.fill('2');
  await start.blur();
  await end.fill('10');
  await end.blur();

  await expect(start).toHaveValue('2');
  await expect(end).toHaveValue('10');

  await firstRow.getByRole('button', { name: 'Reverse patch' }).click();
  await expect(firstRow.locator('.patch-start')).toHaveValue('10');
  await expect(firstRow.locator('.patch-end')).toHaveValue('2');
});

test('patch board off block reserves physical addresses in export', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.locator('input#file-input').setInputFiles(SIMPLE_SVG);

  await expect(page.locator('#artwork-layers-list .alr-row.alr-layer')).toHaveCount(3, {
    timeout: 5000,
  });

  await page.getByRole('button', { name: 'Patch Board' }).click();
  const rows = page.locator('.patch-row');
  const rowCountBefore = await rows.count();

  await page.getByRole('button', { name: 'Export' }).click();
  const previewBefore = await page.locator('#export-preview').innerText();
  const exportedBefore = JSON.parse(previewBefore);

  await page.getByRole('button', { name: 'Patch Board' }).click();
  await page.getByRole('button', { name: 'Add off block' }).click();
  await expect(page.locator('#prompt-overlay')).toBeVisible();
  await page.locator('#prompt-input').fill('3');
  await page.locator('#prompt-ok').click();

  await expect(rows).toHaveCount(rowCountBefore + 1);

  await page.getByRole('button', { name: 'Export' }).click();
  const previewAfter = await page.locator('#export-preview').innerText();
  const exportedAfter = JSON.parse(previewAfter);

  expect(exportedAfter.n).toBeGreaterThan(3);
  expect(exportedAfter.n).toBeGreaterThanOrEqual(exportedBefore.n + 3);
});
