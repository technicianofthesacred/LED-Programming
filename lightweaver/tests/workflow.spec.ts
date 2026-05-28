import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeLayerFixture(tmp: string, fileName = 'workflow-layers.svg') {
  const fixture = path.join(tmp, fileName);
  fs.writeFileSync(fixture, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
  <g id="bg-layer" data-name="Background">
    <path d="M 20 20 H 380 V 280 H 20 Z" fill="none" stroke="#888" stroke-width="2"/>
  </g>
  <g id="circle-layer" data-name="Circle">
    <path d="M 200 130 m -70 0 a 70 70 0 1 0 140 0 a 70 70 0 1 0 -140 0" fill="none" stroke="#e74c3c" stroke-width="3"/>
  </g>
  <g id="bar-layer" data-name="Bar">
    <path d="M 60 230 H 340" fill="none" stroke="#27ae60" stroke-width="4"/>
  </g>
</svg>`);
  return fixture;
}

test('imports SVG, creates strips, saves, reloads, previews, and exports real ledmap', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-workflow-'));
  const fixture = writeLayerFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Import SVG' }).first()).toBeVisible();
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await expect(page.locator('.lw-layer-row')).toHaveCount(3);

  await page.getByRole('button', { name: /\+ All \(3\)/ }).click();
  await expect(page.locator('.lw-strip-row')).toHaveCount(3);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project JSON').click();
  const savedProject = await saveDownload;
  const projectPath = path.join(tmp, await savedProject.suggestedFilename());
  await savedProject.saveAs(projectPath);

  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  expect(projectData.version).toBe(3);
  expect(projectData.layout.strips).toHaveLength(3);
  expect(projectData.layout.strips[0].pixels.length).toBeGreaterThan(0);

  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".json"]', projectPath);
  await expect(page.locator('.lw-strip-row')).toHaveCount(3);

  await page.locator('.lw-rail-btn', { hasText: 'Pattern' }).click();
  await page.waitForSelector('canvas');
  await page.waitForTimeout(800);
  const canvasStats = await page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return { lit: 0, width: 0, height: 0 };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { lit: 0, width: canvas.width, height: canvas.height };
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 35) lit++;
    }
    return { lit, width: canvas.width, height: canvas.height };
  });
  expect(canvasStats.width).toBeGreaterThan(100);
  expect(canvasStats.height).toBeGreaterThan(100);
  expect(canvasStats.lit).toBeGreaterThan(100);

  await page.locator('.lw-rail-btn', { hasText: 'Export' }).click();
  await expect(page.getByText('3 strips')).toBeVisible();
  await expect(page.getByText(/No strips in project/)).toHaveCount(0);

  const exportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).first().click();
  const ledmap = await exportDownload;
  const ledmapPath = path.join(tmp, await ledmap.suggestedFilename());
  await ledmap.saveAs(ledmapPath);
  const ledmapData = JSON.parse(fs.readFileSync(ledmapPath, 'utf8'));
  expect(ledmapData.n).toBe(projectData.layout.strips.reduce((sum: number, strip: any) => sum + strip.pixels.length, 0));
  expect(ledmapData.map).toHaveLength(ledmapData.n);
});

test('groups selected strips and merges them into one composite strip', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-strip-groups-'));
  const fixture = writeLayerFixture(tmp, 'strip-groups.svg');

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(3\)/ }).click();
  await expect(page.locator('.lw-strip-row')).toHaveCount(3);

  await page.locator('.lw-strip-row').nth(0).click();
  await page.locator('.lw-strip-row').nth(1).click({ modifiers: ['Shift'] });
  await page.locator('.lw-strip-row').nth(2).click({ modifiers: ['Shift'] });
  await expect(page.getByText('3 strips selected')).toBeVisible();

  await page.locator('.lw-strip-batch-actions input').fill('Heart outline');
  await page.getByRole('button', { name: 'Group' }).click();
  await expect(page.getByText('Heart outline')).toBeVisible();
  await expect(page.locator('.lw-strip-row')).toHaveCount(3);

  await page.locator('.lw-strip-row').nth(0).click();
  await page.locator('.lw-strip-row').nth(1).click({ modifiers: ['Shift'] });
  await page.locator('.lw-strip-row').nth(2).click({ modifiers: ['Shift'] });
  await page.locator('.lw-strip-batch-actions input').fill('Heart merged');
  await page.getByRole('button', { name: 'Merge' }).click();

  await expect(page.locator('.lw-strip-row')).toHaveCount(1);
  await expect(page.locator('.lw-strip-row').getByText('Heart merged', { exact: true })).toBeVisible();
  await expect(page.getByText('3 strips selected')).toHaveCount(0);

  const stripPath = page.locator('path[data-strip-path]').first();
  const start = await stripPath.evaluate((path: SVGPathElement) => {
    const len = path.getTotalLength();
    const ctm = path.getScreenCTM();
    if (!ctm) return null;
    for (let i = 1; i < 20; i++) {
      const pt = path.getPointAtLength((i / 20) * len);
      const x = pt.x * ctm.a + pt.y * ctm.c + ctm.e;
      const y = pt.x * ctm.b + pt.y * ctm.d + ctm.f;
      if (x > 20 && y > 20 && x < window.innerWidth - 20 && y < window.innerHeight - 20) return { x, y };
    }
    return null;
  });
  expect(start).not.toBeNull();
  await page.mouse.move(start!.x, start!.y);
  await page.mouse.down();
  await page.mouse.move(start!.x + 36, start!.y + 24, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => {
    const moved = await stripPath.evaluate((path: SVGPathElement) => {
      const pt = path.getPointAtLength(path.getTotalLength() * 0.5);
      const ctm = path.getScreenCTM();
      if (!ctm) return null;
      return { x: pt.x * ctm.a + pt.y * ctm.c + ctm.e, y: pt.x * ctm.b + pt.y * ctm.d + ctm.f };
    });
    return Math.round((moved?.x || 0) - start!.x);
  }).not.toBe(0);

  await page.getByTitle('Directed glow — elongate bloom along strip direction').click();
  await expect.poll(() => page.locator('[data-light-cone]').count()).toBeGreaterThan(0);
});

test('clicked vector path can be deleted from the canvas with the keyboard', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-vector-delete-'));
  const fixture = path.join(tmp, 'vector-delete.svg');
  fs.writeFileSync(fixture, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
  <g id="bg-layer" data-name="Background">
    <path d="M 20 20 H 380 V 280 H 20 Z" fill="none" stroke="#888" stroke-width="2"/>
  </g>
  <g id="circle-layer" data-name="Circle">
    <path d="M 130 130 C 130 55 270 55 270 130 C 270 205 130 205 130 130" fill="none" stroke="#e74c3c" stroke-width="3"/>
  </g>
  <g id="bar-layer" data-name="Bar">
    <path d="M 60 230 H 340" fill="none" stroke="#27ae60" stroke-width="4"/>
  </g>
</svg>`);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(3\)/ }).click();
  await expect(page.locator('.lw-layer-row')).toHaveCount(3);
  await expect(page.locator('.lw-strip-row')).toHaveCount(3);

  const circlePath = page.locator('path[data-vector-path-id="circle-layer-p0"]').first();
  const target = await circlePath.evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() * 0.2);
    const ctm = path.getScreenCTM();
    if (!ctm) return null;
    return {
      x: point.x * ctm.a + point.y * ctm.c + ctm.e,
      y: point.x * ctm.b + point.y * ctm.d + ctm.f,
    };
  });
  expect(target).not.toBeNull();
  await page.mouse.click(target!.x, target!.y);

  await page.keyboard.press('Delete');

  await expect(page.locator('.lw-layer-row')).toHaveCount(2);
  await expect(page.locator('.lw-strip-row')).toHaveCount(2);
  await expect(page.locator('.lw-layer-row', { hasText: 'Circle' })).toHaveCount(0);
  await expect(page.locator('.lw-strip-row', { hasText: 'Circle' })).toHaveCount(0);
  await expect(page.locator('path[data-vector-path-id^="circle-layer-"]')).toHaveCount(0);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project JSON').click();
  const savedProject = await saveDownload;
  const projectPath = path.join(tmp, await savedProject.suggestedFilename());
  await savedProject.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  expect(projectData.layout.layers.map((layer: any) => layer.layerId)).toEqual(['bg-layer', 'bar-layer']);
  expect(projectData.layout.strips.map((strip: any) => strip.id)).toEqual(['bg-layer', 'bar-layer']);
});
