import { test, expect } from '@playwright/test';

test('live pattern changes record clips and crossfades into show', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.lw-rail-btn', { hasText: 'Live' }).click();
  await expect(page.locator('.lw-live-record-meta')).toContainText('free');
  await page.getByRole('button', { name: 'Start Recording to Show' }).click();
  await expect(page.locator('.lw-live-rec-status')).toBeVisible();

  await page.locator('.lw-live-card').nth(0).click();
  await page.waitForTimeout(250);
  await page.locator('.lw-live-card').nth(1).click();

  await expect.poll(async () => {
    return await page.evaluate(() => {
      const raw = localStorage.getItem('lw_autosave_v3');
      if (!raw) return { clips: 0, transitions: 0 };
      const project = JSON.parse(raw);
      return {
        clips: (project.show?.clips || []).filter((clip: any) => clip.recorded).length,
        transitions: (project.show?.transitions || []).filter((transition: any) => transition.recorded && transition.type === 'crossfade').length,
      };
    });
  }, { timeout: 3000 }).toEqual({ clips: 2, transitions: 1 });

  await expect(page.locator('.lw-live-record-meta')).toContainText('2 clips');
  await expect(page.locator('.lw-live-take-item')).toHaveCount(2);

  await page.getByRole('button', { name: 'Open Show' }).click();
  await expect(page.locator('.lw-tl-trans.recorded')).toHaveCount(1);
});
