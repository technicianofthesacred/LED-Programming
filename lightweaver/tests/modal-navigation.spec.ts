import { test, expect } from '@playwright/test';

test('card tools menu closes when navigating to Card preferences', async ({ page }) => {
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Card tools/ }).click();

  await expect(page.getByRole('menu', { name: 'Card tools' })).toBeVisible();
  await page.evaluate(() => { window.location.hash = 'screen=settings'; });

  await expect(page.getByRole('menu', { name: 'Card tools' })).toHaveCount(0);
  // Preferences opens as a section of Card Home, so Card is the lit rail entry.
  // Matched on aria-label, which is the button's own accessible name, rather
  // than inner text — the previous text match went stale twice (#152, then the
  // Card consolidation that removed the separate Setup entry).
  await expect(page.locator('.rail-item.active[aria-label="Card"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Preferences', level: 1 })).toBeVisible();
});

test('card tools menu closes with Escape and returns focus to its trigger', async ({ page }) => {
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  const trigger = page.getByRole('button', { name: /Card tools/ });
  await trigger.click();

  await expect(page.getByRole('menu', { name: 'Card tools' })).toBeVisible();
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Card tools' })).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
