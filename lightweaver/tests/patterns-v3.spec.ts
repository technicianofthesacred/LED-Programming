import { test, expect } from '@playwright/test';

test('v3 patterns show a chip-ready catalog with live local preview', async ({ page }) => {
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.locator('.lw-look-card')).toHaveCount(30);
  await expect(page.locator('.lw-pattern-led-preview canvas')).toBeVisible();
  await expect(page.getByText('30 chip-ready / 30 on knob')).toBeVisible();

  await page.locator('button[data-pattern-id="ocean"]').click();

  await expect(page.locator('.lw-look-card.is-selected strong')).toHaveText('Ocean');
  await expect(page.getByText('Blue and teal rolling wave movement.')).toBeVisible();
  await expect(page.locator('.lw-card-load-summary strong').first()).toHaveText('Ocean');
});
