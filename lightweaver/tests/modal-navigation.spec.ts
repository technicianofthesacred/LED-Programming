import { test, expect } from '@playwright/test';

test('card tools menu closes when navigating to Card preferences', async ({ page }) => {
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Card tools/ }).click();

  await expect(page.getByRole('menu', { name: 'Card tools' })).toBeVisible();
  await page.evaluate(() => { window.location.hash = 'screen=settings'; });

  await expect(page.getByRole('menu', { name: 'Card tools' })).toHaveCount(0);
  await expect(page.locator('.rail-item.active', { hasText: 'Card' })).toBeVisible();
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
