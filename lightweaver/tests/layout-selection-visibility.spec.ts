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

async function screenStrokeWidth(locator: any) {
  return locator.evaluate((node: SVGGraphicsElement) => {
    const ctm = node.getScreenCTM();
    if (!ctm) throw new Error('Selected strip has no screen transform.');
    return parseFloat(getComputedStyle(node).strokeWidth) * Math.hypot(ctm.a, ctm.b);
  });
}

async function screenBadgeTextSize(locator: any) {
  return locator.evaluate((node: SVGGraphicsElement) => {
    const text = node.matches('text') ? node : node.querySelector('text');
    if (!text) throw new Error('Selected strip badge has no text.');
    const ctm = text.getScreenCTM();
    if (!ctm) throw new Error('Selected strip badge has no screen transform.');
    const fontSize = parseFloat(getComputedStyle(text).fontSize) * Math.hypot(ctm.a, ctm.b);
    return Math.max(fontSize, text.getBoundingClientRect().height);
  });
}

async function zoomToMinimum(page: any) {
  const svg = page.locator('.lw-viewport svg');
  const zoomOut = page.getByTitle('Zoom out (-)');
  for (let index = 0; index < 80; index += 1) {
    const previousViewBox = await svg.getAttribute('viewBox');
    await zoomOut.click();
    try {
      await expect.poll(() => svg.getAttribute('viewBox'), {
        timeout: 1000,
        intervals: [50, 100, 200],
      }).not.toBe(previousViewBox);
    } catch {
      // A clamp is terminal only after the post-click value is confirmed
      // unchanged, rather than treating a render race as the minimum zoom.
      await expect.poll(() => svg.getAttribute('viewBox'), {
        timeout: 500,
        intervals: [50, 100, 200],
      }).toBe(previousViewBox);
      return previousViewBox;
    }
  }
  throw new Error('Zoom out did not reach its terminal clamp within 80 clicks.');
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
  const normalHaloWidth = await screenStrokeWidth(halo);
  const normalCoreWidth = await screenStrokeWidth(core);
  const normalBadgeSize = await screenBadgeTextSize(badge);
  expect(normalHaloWidth).toBeGreaterThanOrEqual(3);
  expect(normalCoreWidth).toBeGreaterThanOrEqual(2);
  expect(normalBadgeSize).toBeGreaterThanOrEqual(8);

  const terminalViewBox = await zoomToMinimum(page);
  const terminalWidth = Number(terminalViewBox?.trim().split(/\s+/)[2]);
  // Fresh layouts have a 640-unit viewBox; the terminal width demonstrates
  // that the zoom clamp, rather than an intermediate render, was reached.
  expect(terminalWidth).toBeGreaterThanOrEqual(640 / 1e-6);

  const minHaloWidth = await screenStrokeWidth(halo);
  const minCoreWidth = await screenStrokeWidth(core);
  const minBadgeSize = await screenBadgeTextSize(badge);
  expect(minHaloWidth).toBeGreaterThanOrEqual(3);
  expect(minCoreWidth).toBeGreaterThanOrEqual(2);
  expect(minBadgeSize).toBeGreaterThanOrEqual(8);
  expect(minHaloWidth / normalHaloWidth).toBeGreaterThanOrEqual(0.75);
  expect(minCoreWidth / normalCoreWidth).toBeGreaterThanOrEqual(0.75);
  expect(minBadgeSize / normalBadgeSize).toBeGreaterThanOrEqual(0.75);
});
