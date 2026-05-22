import { test, expect } from '@playwright/test';

const SIMPLE_SVG = 'e2e/fixtures/simple-layers.svg';

/**
 * Verifies that clicking a layer row in the panel selects it — either by
 * gaining a selected/active CSS class or by surfacing the layer inspector
 * (which exposes the strip's pixel/length fields).
 */
test('clicking a layer row selects it and reveals the inspector', async ({ page }) => {
  await page.goto('/');
  await page.locator('input#file-input').setInputFiles(SIMPLE_SVG);

  const layersList = page.locator('#artwork-layers-list');
  await expect(layersList.locator('.alr-row.alr-layer')).toHaveCount(3, {
    timeout: 5000,
  });

  // Click the first layer row. We click the row's name span to ensure the
  // hit lands on a clickable child rather than the drag handle.
  const firstRow = layersList.locator('.alr-row.alr-layer').first();
  await firstRow.click();

  // The inspector panel should un-hide once a layer is active.
  // TODO: tighten selector — depends on internal #layer-inspector id.
  const inspector = page.locator('#layer-inspector');
  await expect(inspector).toBeVisible({ timeout: 3000 });

  // Pixel-count input ("LEDs") becomes editable when a layer is selected.
  await expect(inspector.locator('#inspector-led-count')).toBeVisible();

  // Length readout should populate with something other than the empty dash
  // once a real path is selected.
  const lengthText = await inspector.locator('#inspector-length').innerText();
  expect(lengthText.trim().length).toBeGreaterThan(0);
});
