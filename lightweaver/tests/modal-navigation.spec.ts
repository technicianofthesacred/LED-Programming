import { test, expect } from '@playwright/test';

test('export dialog closes when navigating from the rail', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.lw-rail-btn', { hasText: 'Show' }).click();
  await page.getByRole('button', { name: 'Export Show →' }).click();

  await expect(page.locator('.lw-export-backdrop')).toBeVisible();
  await page.locator('.lw-rail-btn', { hasText: 'Settings' }).click();

  await expect(page.locator('.lw-export-backdrop')).toHaveCount(0);
  await expect(page.locator('.lw-rail-btn.active', { hasText: 'Settings' })).toBeVisible();
});

test('export dialog closes with Escape', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.lw-rail-btn', { hasText: 'Show' }).click();
  await page.getByRole('button', { name: 'Export Show →' }).click();

  await expect(page.locator('.lw-export-backdrop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.lw-export-backdrop')).toHaveCount(0);
});
