import { test, expect } from '@playwright/test';

async function dragHandle(page, selector: string, dx: number, dy = 0) {
  const handle = page.locator(selector).first();
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + dx, box!.y + box!.height / 2 + dy, { steps: 4 });
  await page.mouse.up();
}

test('workspace split panels resize and persist', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await dragHandle(page, '[data-resize-key="lw-layout-panel-width"]', -80);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw-layout-panel-width'))).not.toBeNull();

  await page.locator('.lw-rail-btn', { hasText: 'Pattern' }).click();
  await dragHandle(page, '[data-resize-key="lw-panel-width"]', -70);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw-panel-width'))).not.toBeNull();

  await page.locator('.lw-rail-btn', { hasText: 'Show' }).click();
  await dragHandle(page, '[data-resize-key="lw-show-inspector-width"]', -70);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw-show-inspector-width'))).not.toBeNull();

  await dragHandle(page, '[data-resize-key="lw-show-preview-height"]', 0, 50);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw-show-preview-height'))).not.toBeNull();

  await page.locator('.lw-rail-btn', { hasText: 'Live' }).click();
  await dragHandle(page, '[data-resize-key="lw-live-left-width"]', 90);
  const storedLiveWidth = await page.evaluate(() => Number(localStorage.getItem('lw-live-left-width') || 0));
  expect(storedLiveWidth).toBeGreaterThan(340);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.lw-rail-btn', { hasText: 'Live' }).click();
  const liveColumns = await page.locator('.lw-live-screen').evaluate(el => getComputedStyle(el).gridTemplateColumns);
  expect(parseFloat(liveColumns)).toBeCloseTo(storedLiveWidth, 0);
});
