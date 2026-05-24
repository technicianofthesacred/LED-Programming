import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeFixture(tmp: string) {
  const fixture = path.join(tmp, 'patch-board-line.svg');
  fs.writeFileSync(fixture, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" width="120" height="40">
  <g id="line-layer" data-name="Line">
    <path d="M 10 20 H 110" fill="none" stroke="#fff" stroke-width="3"/>
  </g>
</svg>`);
  return fixture;
}

test('patch board edits persist and drive ledmap length', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-patch-board-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();
  await expect(page.locator('.lw-strip-row')).toHaveCount(1);

  await page.locator('.lw-patch-details > summary').click();
  await expect(page.locator('.lw-patch-screen.is-embedded')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Patch Board' })).toBeVisible();
  const firstRow = page.locator('.lw-patch-row').first();
  await firstRow.locator('input').nth(0).fill('1');
  await firstRow.locator('input').nth(1).fill('0');
  await page.locator('.lw-patch-add input').fill('2');
  await page.getByRole('button', { name: 'Add off block' }).click();
  await expect(page.locator('.lw-patch-row')).toHaveCount(2);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project JSON').click();
  const saved = await saveDownload;
  const projectPath = path.join(tmp, await saved.suggestedFilename());
  await saved.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  expect(projectData.layout.patchBoard.patches.some((patch: any) => patch.source?.type === 'off')).toBe(true);

  await page.locator('.lw-rail-btn', { hasText: 'Export' }).click();
  const exportDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).first().click();
  const ledmap = await exportDownload;
  const ledmapPath = path.join(tmp, await ledmap.suggestedFilename());
  await ledmap.saveAs(ledmapPath);
  const ledmapData = JSON.parse(fs.readFileSync(ledmapPath, 'utf8'));

  expect(ledmapData.n).toBe(4);
  expect(ledmapData.map).toHaveLength(4);
});
