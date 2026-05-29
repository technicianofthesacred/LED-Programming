import { test, expect } from '@playwright/test';

const SCREENS = ['Patterns', 'Layout', 'Load'];

test('layout opens with the default two-circle hardware layout', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('default-circle-layout-panel')).toBeVisible();
  await expect(page.locator('.lw-strip-row')).toHaveCount(2);
  await expect(page.locator('path[data-strip-path]')).toHaveCount(2);
  await expect(page.locator('.lw-strip-row', { hasText: 'Outer circle' })).toContainText('22');
  await expect(page.locator('.lw-strip-row', { hasText: 'Inner circle' })).toContainText('22');
  await expect(page.getByText('Default two-circle hardware')).toBeVisible();
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`main screens load without overflow or console errors on ${viewport.name}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    for (const label of SCREENS) {
      await page.locator('.lw-rail-btn', { hasText: label }).click();
      await expect(page.locator('.lw-app')).toBeVisible();
      await expect.poll(async () => page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }))).toEqual({ scrollW: viewport.width, clientW: viewport.width });
    }

    expect(consoleErrors).toEqual([]);
  });
}
