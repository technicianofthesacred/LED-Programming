import { test, expect } from '@playwright/test';

test('motion guide can be created from the Pattern preview and edited directly', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.lw-rail-btn', { hasText: 'Pattern' }).click();
  await page.getByRole('button', { name: 'Motion Guide' }).click();

  const overlay = page.locator('.lw-geometry-guide-overlay');
  await expect(overlay).toBeVisible();
  await expect(page.locator('.lw-panel-mode-btn.active')).toContainText('Geometry');
  await expect(page.locator('.lw-geometry-guide-arrow')).toHaveCount(3);
  await expect(page.locator('.lw-geometry-guide-band')).toHaveCount(6);

  const box = await page.locator('.lw-pattern-pan-content').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.38, box!.y + box!.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.63, box!.y + box!.height * 0.82, { steps: 5 });
  await page.mouse.up();

  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem('lw_autosave_v3');
    const project = raw ? JSON.parse(raw) : null;
    const settings = project?.pattern?.symSettings;
    if (!settings || settings.type !== 'guide-mirror') return null;
    return {
      type: settings.type,
      mode: settings.guide?.mode,
      x1: Math.round(settings.guide?.axis?.x1 * 100),
      x2: Math.round(settings.guide?.axis?.x2 * 100),
    };
  }), { timeout: 3000 }).toEqual({
    type: 'guide-mirror',
    mode: 'fold',
    x1: 38,
    x2: 63,
  });

  const handles = page.locator('.lw-geometry-guide-handle');
  await expect(handles).toHaveCount(2);
  const endHandle = handles.nth(1);
  const handleBox = await endHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x - box!.width * 0.18, handleBox!.y - box!.height * 0.18, { steps: 5 });
  await page.mouse.up();

  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem('lw_autosave_v3');
    const project = raw ? JSON.parse(raw) : null;
    const axis = project?.pattern?.symSettings?.guide?.axis;
    return axis ? Math.round(axis.x2 * 100) : null;
  }), { timeout: 3000 }).toBeLessThan(55);
});
