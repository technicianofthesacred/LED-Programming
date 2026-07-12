import { test, expect, Page } from '@playwright/test';

/**
 * Exercises the hand-draw tool: activating Draw reveals the shape selector,
 * and each primitive (two-click line/ring + multi-click path) creates a strip.
 * Also confirms Escape is non-destructive (undoes the last point only).
 */
test.describe('Draw tool — shape primitives', () => {
  // The strip-name prompt is a custom modal (#prompt-input); accept its default.
  async function acceptStripName(page: Page) {
    const input = page.locator('#prompt-input');
    await input.waitFor({ state: 'visible', timeout: 3000 });
    await input.press('Enter');
  }

  test('activating Draw reveals the shape selector, deactivating hides it', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#draw-shapes')).toBeHidden();
    await page.locator('#tool-draw').click();
    await expect(page.locator('#draw-shapes')).toBeVisible();
    await expect(page.locator('#draw-hint')).toBeVisible();
    await page.locator('#tool-select').click();
    await expect(page.locator('#draw-shapes')).toBeHidden();
    await expect(page.locator('#draw-hint')).toBeHidden();
  });

  test('Line (two clicks) creates a strip', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tool-draw').click();
    await page.locator('.draw-shape[data-shape="line"]').click();

    const box = (await page.locator('#drawing-canvas').boundingBox())!;
    await page.mouse.click(box.x + 120, box.y + 120);
    await page.mouse.click(box.x + 320, box.y + 220);

    await acceptStripName(page);
    await expect(page.locator('#strips-layer g[data-strip-id]')).toHaveCount(1);
  });

  test('Ring (center + radius) creates a strip', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tool-draw').click();
    await page.locator('.draw-shape[data-shape="circle"]').click();

    const box = (await page.locator('#drawing-canvas').boundingBox())!;
    await page.mouse.click(box.x + 250, box.y + 200); // center
    await page.mouse.click(box.x + 330, box.y + 200); // radius

    await acceptStripName(page);
    await expect(page.locator('#strips-layer g[data-strip-id]')).toHaveCount(1);
  });

  test('Path: Escape undoes the last point without wiping the line; Enter finishes', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tool-draw').click();
    await page.locator('.draw-shape[data-shape="polyline"]').click();

    const box = (await page.locator('#drawing-canvas').boundingBox())!;
    await page.mouse.click(box.x + 100, box.y + 100);
    await page.mouse.click(box.x + 200, box.y + 140);
    await page.mouse.click(box.x + 300, box.y + 120);
    // A dashed ghost path should be present after placing points
    await expect(page.locator('#strips-layer path[stroke-dasharray]')).toHaveCount(1);

    // Escape drops only the last point — the ghost survives (was destructive before)
    await page.keyboard.press('Escape');
    await expect(page.locator('#strips-layer path[stroke-dasharray]')).toHaveCount(1);

    // Enter commits the remaining 2-point path
    await page.keyboard.press('Enter');
    await acceptStripName(page);
    await expect(page.locator('#strips-layer g[data-strip-id]')).toHaveCount(1);
  });
});
