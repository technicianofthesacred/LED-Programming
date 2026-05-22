import { test, expect } from '@playwright/test';

const SIMPLE_SVG = 'e2e/fixtures/simple-layers.svg';

/**
 * Verifies the led-art-mapper boots, an SVG can be imported via the file
 * picker, and at least one layer/strip row appears in the side panel.
 */
test.describe('SVG import', () => {
  test('app loads and renders the canvas + import controls', async ({ page }) => {
    await page.goto('/');

    // The drawing canvas SVG should mount
    await expect(page.locator('#drawing-canvas')).toBeVisible();

    // The hidden file input is what setInputFiles targets — it must exist
    await expect(page.locator('input#file-input')).toHaveCount(1);
  });

  test('importing a simple SVG populates the layers panel', async ({ page }) => {
    await page.goto('/');

    // The file input is `hidden` in markup but setInputFiles works regardless.
    await page.locator('input#file-input').setInputFiles(SIMPLE_SVG);

    // After import, the artwork-layers section should un-hide and show 3 layers
    const layersSection = page.locator('#artwork-layers-section');
    await expect(layersSection).not.toHaveClass(/hidden/, { timeout: 5000 });

    const layersList = page.locator('#artwork-layers-list');
    // Each top-level <g> in the SVG becomes one .alr-row.alr-layer
    // TODO: tighten selector — relies on internal class name `alr-row`
    const rows = layersList.locator('.alr-row.alr-layer');
    await expect(rows).toHaveCount(3);

    // Layer count badge should reflect the import
    await expect(page.locator('#artwork-layer-count')).toContainText(/3 layer/i);

    // The imported artwork should also be visible inside the canvas SVG
    const importedChildren = await page
      .locator('#imported-svg > *')
      .count();
    expect(importedChildren).toBeGreaterThan(0);
  });
});
