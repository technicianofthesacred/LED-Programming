import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeFixture(tmp: string) {
  const fixture = path.join(tmp, 'patch-board-line.svg');
  fs.writeFileSync(fixture, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 40" width="620" height="40">
  <g id="line-layer" data-name="Line">
    <path d="M 10 20 H 610" fill="none" stroke="#fff" stroke-width="3"/>
  </g>
</svg>`);
  return fixture;
}

test('wire path chops a visible source path into saved physical segments', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-patch-board-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();
  await expect(page.locator('.lw-strip-row')).toHaveCount(1);

  const mappingPanel = page.locator('.lw-patch-details');
  if (!(await mappingPanel.evaluate((el: HTMLDetailsElement) => el.open))) {
    await page.locator('.lw-patch-details > summary').click();
  }
  await expect(page.locator('.lw-wire-path.is-embedded')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wire Path' })).toBeVisible();
  await expect(page.getByText('Source Paths')).toBeVisible();
  await expect(page.locator('.lw-wire-segment-chip')).toHaveCount(1);

  await page.locator('.lw-wire-map').click({ position: { x: 190, y: 52 } });
  await expect(page.locator('.lw-wire-segment-chip')).toHaveCount(2);
  await page.getByRole('button', { name: 'Insert off LEDs' }).click();
  await expect(page.locator('.lw-wire-off-chip')).toBeVisible();

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project JSON').click();
  const saved = await saveDownload;
  const projectPath = path.join(tmp, await saved.suggestedFilename());
  await saved.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  expect(projectData.layout.patchBoard.patches.some((patch: any) => patch.source?.type === 'off')).toBe(true);
  expect(projectData.layout.patchBoard.patches.filter((patch: any) => patch.source?.type === 'strip')).toHaveLength(2);

  await page.locator('.lw-rail-btn', { hasText: 'Export' }).click();
  const exportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).first().click();
  const ledmap = await exportDownload;
  const ledmapPath = path.join(tmp, await ledmap.suggestedFilename());
  await ledmap.saveAs(ledmapPath);
  const ledmapData = JSON.parse(fs.readFileSync(ledmapPath, 'utf8'));

  expect(ledmapData.n).toBeGreaterThan(2);
  expect(ledmapData.map).toHaveLength(ledmapData.n);
});

test('canvas chop mode creates a cut marker on the artwork path', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-canvas-chop-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();
  await expect(page.locator('.lw-strip-row')).toHaveCount(1);

  await page.getByRole('button', { name: 'Chop' }).click();
  await expect(page.locator('.lw-route-mode-chip')).toContainText('Chop');

  const stripPath = page.locator('path[data-strip-path]').first();
  const target = await stripPath.evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() * 0.45);
    const ctm = path.getScreenCTM();
    if (!ctm) return null;
    return {
      x: point.x * ctm.a + point.y * ctm.c + ctm.e,
      y: point.x * ctm.b + point.y * ctm.d + ctm.f,
    };
  });
  expect(target).not.toBeNull();
  await page.mouse.click(target!.x, target!.y);

  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(1);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(2);
  await expect(page.getByText('Selected cut')).toBeVisible();
  await page.getByRole('button', { name: 'Move cut later' }).click();
  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear cuts' }).click();
  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(0);
  await expect(page.getByText('Selected cut')).toHaveCount(0);
  await page.mouse.click(target!.x, target!.y);
  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete cut' }).click();
  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(0);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(0);
  await page.mouse.click(target!.x, target!.y);
  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(1);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(2);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project JSON').click();
  const saved = await saveDownload;
  const projectPath = path.join(tmp, await saved.suggestedFilename());
  await saved.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  const stripPatches = projectData.layout.patchBoard.patches
    .filter((patch: any) => patch.source?.type === 'strip')
    .sort((a: any, b: any) => a.source.startLed - b.source.startLed);
  expect(stripPatches).toHaveLength(2);
  const [first, second] = stripPatches;
  const maxLed = projectData.layout.strips[0].pixelCount - 1;
  expect(first.source.startLed).toBe(0);
  expect(second.source.startLed).toBe(first.source.endLed + 1);
  expect(first.source.endLed).toBeGreaterThan(1);
  expect(first.source.endLed).toBeLessThan(maxLed);
});

test('canvas chop overlay includes one-led physical segments', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-canvas-one-led-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();

  await page.getByRole('button', { name: 'Chop' }).click();
  const stripPath = page.locator('path[data-strip-path]').first();
  const clickAt = async (ratio: number) => {
    const target = await stripPath.evaluate((path: SVGPathElement, ratioArg) => {
      const point = path.getPointAtLength(path.getTotalLength() * ratioArg);
      const ctm = path.getScreenCTM();
      if (!ctm) return null;
      return {
        x: point.x * ctm.a + point.y * ctm.c + ctm.e,
        y: point.x * ctm.b + point.y * ctm.d + ctm.f,
      };
    }, ratio);
    expect(target).not.toBeNull();
    await page.mouse.click(target!.x, target!.y);
  };

  await clickAt(2 / 9);
  await clickAt(3 / 9);

  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(2);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(3);
});

test('canvas link mode records clicked chopped segments as physical route order', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-canvas-link-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();

  await page.getByRole('button', { name: 'Chop' }).click();
  const stripPath = page.locator('path[data-strip-path]').first();
  const clickAt = async (ratio: number) => {
    const target = await stripPath.evaluate((path: SVGPathElement, ratioArg) => {
      const point = path.getPointAtLength(path.getTotalLength() * ratioArg);
      const ctm = path.getScreenCTM();
      if (!ctm) return null;
      return {
        x: point.x * ctm.a + point.y * ctm.c + ctm.e,
        y: point.x * ctm.b + point.y * ctm.d + ctm.f,
      };
    }, ratio);
    expect(target).not.toBeNull();
    await page.mouse.click(target!.x, target!.y);
  };
  await clickAt(0.33);
  await clickAt(0.66);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(3);
  await page.getByRole('button', { name: 'Chop' }).click();

  await page.getByRole('button', { name: 'Link' }).click();
  const segments = page.locator('.lw-wire-canvas-segment-hit');
  await expect(segments).toHaveCount(3);
  await segments.nth(2).click();
  await segments.nth(0).click();
  await expect(page.locator('.lw-route-badge')).toHaveCount(2);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project JSON').click();
  const saved = await saveDownload;
  const projectPath = path.join(tmp, await saved.suggestedFilename());
  await saved.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  const rowIds = projectData.layout.patchBoard.chains[0].rowIds;
  expect(rowIds).toEqual([
    'patch-line-layer-7-9',
    'patch-line-layer-0-3',
  ]);
});
