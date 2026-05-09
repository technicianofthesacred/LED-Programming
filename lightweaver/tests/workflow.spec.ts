import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('imports SVG, creates strips, saves, reloads, previews, and exports real ledmap', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-workflow-'));
  const fixture = path.join(tmp, 'workflow-layers.svg');
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
