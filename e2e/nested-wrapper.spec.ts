import { test, expect } from '@playwright/test';

const NESTED_SVG = 'e2e/fixtures/nested-wrapper.svg';

/**
 * Illustrator (and some Inkscape) exports wrap real layers inside one outer
 * <g>. The mapper must unwrap that single-child group so the inner layers
 * still surface individually in the layers panel.
 */
test('nested-wrapper SVG: inner layers are still detected as separate rows', async ({ page }) => {
  await page.goto('/');
  await page.locator('input#file-input').setInputFiles(NESTED_SVG);

  const layersSection = page.locator('#artwork-layers-section');
  await expect(layersSection).not.toHaveClass(/hidden/, { timeout: 5000 });

  // Three inner layers should be detected even though they're nested
  // inside #outer-wrapper. If unwrapping fails, count would be 1.
  // TODO: tighten selector — relies on internal class name `alr-row`
  const rows = page.locator('#artwork-layers-list .alr-row.alr-layer');
  await expect(rows).toHaveCount(3, { timeout: 5000 });

  // The badge should also report 3
  await expect(page.locator('#artwork-layer-count')).toContainText(/3 layer/i);

  // And in the canvas DOM, #imported-svg should expose more than just the
  // outer wrapper as a single child — either the wrapper got flattened or
  // we can reach the inner <g> elements via a deeper query.
  const innerCount = await page
    .locator('#imported-svg g[id$="-layer"]')
    .count();
  expect(innerCount).toBe(3);
});
