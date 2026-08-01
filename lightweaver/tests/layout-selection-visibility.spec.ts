import { test, expect } from '@playwright/test';

async function gotoFreshLayout(page: any) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
}

async function createTwoLineStrips(page: any) {
  const picker = page.getByTestId('layout-primitive-picker');
  await picker.getByRole('button', { name: 'Create line' }).click();
  await page.getByTestId('layout-add-strip').click();
  await page.getByTestId('layout-add-strip-chooser').getByRole('button', { name: 'Line', exact: true }).click();
  await expect(page.locator('path[data-strip-path]')).toHaveCount(2);
}

async function stripDetails(page: any, stripId: string) {
  return page.evaluate(id => {
    const strips = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.layout?.strips || [];
    const strip = strips.find((item: any) => item.id === id);
    return strip ? { name: strip.name, pixelCount: strip.pixelCount } : null;
  }, stripId);
}

async function screenStrokeHeight(locator: any) {
  return locator.evaluate((node: SVGGraphicsElement) => node.getBoundingClientRect().height);
}

test('selected Draw strip has a clear, non-blocking visual identity that remains legible at minimum zoom', async ({ page }) => {
  await gotoFreshLayout(page);
  await createTwoLineStrips(page);

  const hitPaths = page.locator('path[data-strip-path]');
  const selectedHitPath = hitPaths.first();
  const unselectedHitPath = hitPaths.nth(1);
  const selectedId = await selectedHitPath.getAttribute('data-strip-path');
  if (!selectedId) throw new Error('Selected strip has no id.');
  await expect.poll(() => stripDetails(page, selectedId)).not.toBeNull();
  const selected = await stripDetails(page, selectedId);
  if (!selected) throw new Error('Selected strip was not saved.');

  // Use the inspector to select the first strip so this visual contract is
  // independent of whether either line is currently within the fitted canvas.
  await page.locator('.la-strip-row').first().click();

  const halo = page.getByTestId('selected-strip-halo');
  const core = page.getByTestId('selected-strip-core');
  const badge = page.getByTestId('selected-strip-badge');
  await expect(halo).toBeVisible();
  await expect(core).toBeVisible();
  await expect(badge).toContainText(selected.name);
  await expect(badge).toContainText(new RegExp(`${selected.pixelCount}\\s*LEDs?`));

  for (const overlay of [halo, core, badge]) {
    await expect(overlay).toHaveCSS('pointer-events', 'none');
  }
  await expect(selectedHitPath).toHaveCSS('cursor', 'grab');
  await expect(unselectedHitPath).toHaveCSS('cursor', 'pointer');

  // Selection weight is intentionally screen-legible rather than shrinking
  // away with the drawing as the maker zooms out to the supported minimum.
  const normalHaloHeight = await screenStrokeHeight(halo);
  const normalCoreHeight = await screenStrokeHeight(core);
  expect(normalHaloHeight).toBeGreaterThanOrEqual(3);
  expect(normalCoreHeight).toBeGreaterThanOrEqual(2);

  const zoomOut = page.getByTitle('Zoom out (-)');
  let previousViewBox = await page.locator('.lw-viewport svg').getAttribute('viewBox');
  for (let index = 0; index < 30; index += 1) {
    await zoomOut.click();
    const nextViewBox = await page.locator('.lw-viewport svg').getAttribute('viewBox');
    if (nextViewBox === previousViewBox) break;
    previousViewBox = nextViewBox;
  }

  const minHaloHeight = await screenStrokeHeight(halo);
  const minCoreHeight = await screenStrokeHeight(core);
  expect(minHaloHeight).toBeGreaterThanOrEqual(3);
  expect(minCoreHeight).toBeGreaterThanOrEqual(2);
  expect(minHaloHeight / normalHaloHeight).toBeGreaterThanOrEqual(0.75);
  expect(minCoreHeight / normalCoreHeight).toBeGreaterThanOrEqual(0.75);
});
