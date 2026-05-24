import { test, expect } from '@playwright/test';

const SIMPLE_SVG = 'e2e/fixtures/simple-layers.svg';

async function disableExportNormalization(page) {
  await page.getByRole('button', { name: 'Export' }).click();
  const normalize = page.locator('#export-normalize');
  if (await normalize.isChecked()) {
    await normalize.uncheck();
  }
}

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
  const originalStart = parseInt(await firstRow.locator('.patch-start').inputValue(), 10);
  const originalEnd = parseInt(await firstRow.locator('.patch-end').inputValue(), 10);
  const originalFirstPatchCount = Math.abs(originalEnd - originalStart) + 1;

  await disableExportNormalization(page);
  const fullExport = JSON.parse(await page.locator('#export-preview').innerText());
  const sourceAt2 = fullExport.map[2];
  const sourceAt10 = fullExport.map[10];

  await page.getByRole('button', { name: 'Patch Board' }).click();

  const start = firstRow.locator('.patch-start');
  const end = firstRow.locator('.patch-end');
  await start.fill('2');
  await start.blur();
  await end.fill('10');
  await end.blur();

  await expect(start).toHaveValue('2');
  await expect(end).toHaveValue('10');

  await page.getByRole('button', { name: 'Export' }).click();
  const rangedExport = JSON.parse(await page.locator('#export-preview').innerText());
  expect(rangedExport.n).toBe(fullExport.n - originalFirstPatchCount + 9);
  expect(rangedExport.map[0]).toEqual(sourceAt2);
  expect(rangedExport.map[8]).toEqual(sourceAt10);

  await page.getByRole('button', { name: 'Patch Board' }).click();
  await firstRow.getByRole('button', { name: 'Reverse patch' }).click();
  await expect(firstRow.locator('.patch-start')).toHaveValue('10');
  await expect(firstRow.locator('.patch-end')).toHaveValue('2');

  await page.getByRole('button', { name: 'Export' }).click();
  const reversedExport = JSON.parse(await page.locator('#export-preview').innerText());
  expect(reversedExport.n).toBe(fullExport.n - originalFirstPatchCount + 9);
  expect(reversedExport.map[0]).toEqual(sourceAt10);
  expect(reversedExport.map[8]).toEqual(sourceAt2);
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
  const firstPatchStart = parseInt(await rows.first().locator('.patch-start').inputValue(), 10);
  const firstPatchEnd = parseInt(await rows.first().locator('.patch-end').inputValue(), 10);
  const firstPatchCount = Math.abs(firstPatchEnd - firstPatchStart) + 1;

  await disableExportNormalization(page);
  const previewBefore = await page.locator('#export-preview').innerText();
  const exportedBefore = JSON.parse(previewBefore);
  const originalSecondPatchFirstPoint = exportedBefore.map[firstPatchCount];

  await page.getByRole('button', { name: 'Patch Board' }).click();
  await page.getByRole('button', { name: 'Add off block' }).click();
  await expect(page.locator('#prompt-overlay')).toBeVisible();
  await page.locator('#prompt-input').fill('3');
  await page.locator('#prompt-ok').click();

  await expect(rows).toHaveCount(rowCountBefore + 1);
  const offPatchId = await rows.nth(rowCountBefore).getAttribute('data-patch-id');
  const offRow = page.locator(`.patch-row[data-patch-id="${offPatchId}"]`);
  for (let index = rowCountBefore; index > 1; index -= 1) {
    await offRow.getByRole('button', { name: 'Move up' }).click();
  }

  await page.getByRole('button', { name: 'Export' }).click();
  const previewAfter = await page.locator('#export-preview').innerText();
  const exportedAfter = JSON.parse(previewAfter);

  expect(exportedAfter.n).toBe(exportedBefore.n + 3);
  expect(exportedAfter.map[firstPatchCount]).toEqual([0, 0]);
  expect(exportedAfter.map[firstPatchCount + 1]).toEqual([0, 0]);
  expect(exportedAfter.map[firstPatchCount + 2]).toEqual([0, 0]);
  expect(exportedAfter.map[firstPatchCount + 3]).toEqual(originalSecondPatchFirstPoint);
});
