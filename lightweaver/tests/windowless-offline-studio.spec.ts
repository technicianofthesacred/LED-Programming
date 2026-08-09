import { expect, test } from '@playwright/test';

test('simulated installed browser cold-reloads the complete Studio with the network offline', async ({ page, context }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => fetch('/sw.js', { cache: 'no-store' }).then(response => response.status))).toBe(200);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller != null)).toBe(true);

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.locator('body')).toContainText(/Lightweaver|Project|Patterns/i);
});
