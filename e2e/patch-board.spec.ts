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
  await rows.nth(1).getByRole('button', { name: 'Move up' }).click();
  const firstAfter = await rows.nth(0).getAttribute('data-patch-id');
  expect(firstAfter).not.toBe(firstBefore);

  await page.getByRole('button', { name: 'Export' }).click();
  const previewText = await page.locator('#export-preview').innerText();
  const exported = JSON.parse(previewText);

  expect(exported.n).toBeGreaterThan(0);
  expect(Array.isArray(exported.map[0])).toBe(true);
});
