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

async function zoomToTerminal(page: any, controlTitle: string) {
  const svg = page.locator('.lw-viewport svg');
  const zoomControl = page.getByTitle(controlTitle);
  for (let index = 0; index < 80; index += 1) {
    const previousViewBox = await svg.getAttribute('viewBox');
    await zoomControl.click();
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
  const lastViewBox = await svg.getAttribute('viewBox');
  const zoomPercentage = await page.getByTestId('layout-zoom-percentage').textContent();
  throw new Error(`${controlTitle} did not reach its terminal clamp within 80 clicks (zoom ${zoomPercentage}, viewBox ${lastViewBox}).`);
}

async function fitSelectionView(page: any) {
  const svg = page.locator('.lw-viewport svg');
  const fitAll = page.getByRole('button', { name: 'Fit all' });
  for (let index = 0; index < 10; index += 1) {
    const previousViewBox = await svg.getAttribute('viewBox');
    await fitAll.click();
    try {
      await expect.poll(() => svg.getAttribute('viewBox'), {
        timeout: 1000,
        intervals: [50, 100, 200],
      }).not.toBe(previousViewBox);
    } catch {
      await expect.poll(() => svg.getAttribute('viewBox')).toBe(previousViewBox);
      return previousViewBox;
    }
  }
  return svg.getAttribute('viewBox');
}

test('selected Draw strip has a clear, non-blocking visual identity across drag and zoom extremes', async ({ page }) => {
  test.setTimeout(60_000);
  await gotoFreshLayout(page);
  await createTwoLineStrips(page);

  const hitPaths = page.locator('path[data-strip-path]');
  const selectedHitPath = hitPaths.first();
  const unselectedHitPath = hitPaths.nth(1);
  const selectedId = await selectedHitPath.getAttribute('data-strip-path');
  if (!selectedId) throw new Error('Selected strip has no id.');
  const selectedPathData = await selectedHitPath.getAttribute('d');
  if (!selectedPathData) throw new Error('Selected strip has no path geometry.');
  await expect.poll(() => stripDetails(page, selectedId)).not.toBeNull();
  const selected = await stripDetails(page, selectedId);
  if (!selected) throw new Error('Selected strip was not saved.');

  // Use the inspector to select the first strip so this visual contract is
  // independent of whether either line is currently within the fitted canvas.
  await page.locator('.la-strip-row').first().click();

  const halo = page.getByTestId('selected-strip-halo');
  const core = page.getByTestId('selected-strip-core');
  const badge = page.getByTestId('selected-strip-badge');
  await expect(halo).toHaveCount(1);
  await expect(core).toHaveCount(1);
  await expect(halo).toHaveAttribute('d', selectedPathData);
  await expect(core).toHaveAttribute('d', selectedPathData);
  await expect(halo).toHaveAttribute('stroke', 'oklch(0.78 0.16 205)');
  await expect(core).toHaveAttribute('stroke', 'white');
  for (const path of [halo, core]) {
    await expect(path).toHaveAttribute('fill', 'none');
    await expect(path).toHaveAttribute('stroke-linecap', 'round');
    await expect(path).toHaveAttribute('stroke-linejoin', 'round');
  }
  await expect(badge).toContainText(selected.name);
  await expect(badge).toContainText(new RegExp(`${selected.pixelCount}\\s*LEDs?`));
  const badgeRect = badge.locator('rect');
  await expect(badgeRect).toHaveAttribute('fill', 'oklch(0.18 0.02 220 / 0.88)');
  await expect(badgeRect).toHaveAttribute('stroke', 'oklch(0.78 0.16 205)');
  const badgeDimensions = await badgeRect.evaluate(rect => ({
    width: Number(rect.getAttribute('width')),
    height: Number(rect.getAttribute('height')),
  }));
  expect(badgeDimensions.width).toBeGreaterThan(0);
  expect(badgeDimensions.height).toBeGreaterThan(0);

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

  const terminalViewBox = await zoomToTerminal(page, 'Zoom out (-)');
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
  expect(minHaloWidth / normalHaloWidth).toBeLessThanOrEqual(1.25);
  expect(minCoreWidth / normalCoreWidth).toBeLessThanOrEqual(1.25);
  expect(minBadgeSize / normalBadgeSize).toBeLessThanOrEqual(1.25);

  const svg = page.locator('.lw-viewport svg');
  const fittedViewBox = await fitSelectionView(page);
  expect(fittedViewBox).not.toBe(terminalViewBox);
  const fitHaloWidth = await screenStrokeWidth(halo);
  const fitCoreWidth = await screenStrokeWidth(core);
  const fitBadgeSize = await screenBadgeTextSize(badge);

  const maximumViewBox = await zoomToTerminal(page, 'Zoom in (+)');
  const maximumWidth = Number(maximumViewBox?.trim().split(/\s+/)[2]);
  expect(maximumWidth).toBeLessThanOrEqual((640 / 1e6) * 1.001);
  const maxHaloWidth = await screenStrokeWidth(halo);
  const maxCoreWidth = await screenStrokeWidth(core);
  const maxBadgeSize = await screenBadgeTextSize(badge);
  expect(maxHaloWidth).toBeGreaterThanOrEqual(3);
  expect(maxCoreWidth).toBeGreaterThanOrEqual(2);
  expect(maxBadgeSize).toBeGreaterThanOrEqual(8);
  expect(maxHaloWidth / fitHaloWidth).toBeGreaterThanOrEqual(0.75);
  expect(maxCoreWidth / fitCoreWidth).toBeGreaterThanOrEqual(0.75);
  expect(maxBadgeSize / fitBadgeSize).toBeGreaterThanOrEqual(0.75);
  expect(maxHaloWidth / fitHaloWidth).toBeLessThanOrEqual(1.25);
  expect(maxCoreWidth / fitCoreWidth).toBeLessThanOrEqual(1.25);
  // Chromium rounds SVG text bounds more aggressively near the numerical
  // zoom ceiling, so allow up to a 2x text-size ratio while keeping it legible.
  expect(maxBadgeSize / fitBadgeSize).toBeLessThanOrEqual(2);

  const dragViewBox = await fitSelectionView(page);
  expect(dragViewBox).not.toBe(maximumViewBox);
  const selectedPathBox = await selectedHitPath.boundingBox();
  if (!selectedPathBox) throw new Error('Selected strip has no pointer target.');
  await page.mouse.move(
    selectedPathBox.x + selectedPathBox.width / 2,
    selectedPathBox.y + selectedPathBox.height / 2,
  );
  await page.mouse.down();
  await expect(selectedHitPath).toHaveCSS('cursor', 'grabbing');
  await expect(badge).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator('.la-strip-row').first()).toHaveClass(/sel/);
  await expect(halo).toHaveCount(1);
  await expect(badge).toContainText(selected.name);
});

test('a long selected strip name keeps a compact badge while exposing its full label', async ({ page }) => {
  await gotoFreshLayout(page);
  await createTwoLineStrips(page);

  const firstRow = page.locator('.la-strip-row').first();
  await firstRow.click();
  const selectedId = await page.locator('path[data-strip-path]').first().getAttribute('data-strip-path');
  if (!selectedId) throw new Error('Selected strip has no id.');
  await expect.poll(() => stripDetails(page, selectedId)).not.toBeNull();
  const ledCount = (await stripDetails(page, selectedId))?.pixelCount;
  const longName = 'Atrium north wall illuminated contour installation segment alpha';
  await firstRow.locator('.layer-name').dblclick();
  const renameInput = firstRow.locator('input').first();
  await renameInput.fill(longName);
  await renameInput.press('Enter');

  const badge = page.getByTestId('selected-strip-badge');
  await expect(badge).toContainText(longName);
  const fullLabel = `${longName} · ${ledCount} LEDs`;
  await expect(badge).toContainText(fullLabel);
  const screenWidth = await badge.locator('rect').evaluate(rect => rect.getBoundingClientRect().width);
  expect(screenWidth).toBeGreaterThan(0);
  expect(screenWidth).toBeLessThanOrEqual(240);
  const exposedLabel = await badge.evaluate(node =>
    node.getAttribute('aria-label') || node.getAttribute('title') || node.querySelector('title')?.textContent || '');
  expect(exposedLabel).toBe(fullLabel);
});
