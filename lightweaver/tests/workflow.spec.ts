import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function mockLocalCard(page: any, options: any = {}) {
  const card = {
    zones: options.zones || [
      { id: 'patch-default-outer-circle', label: 'Outer circle', ranges: [{ start: 0, count: 22 }] },
      { id: 'patch-default-inner-circle', label: 'Inner circle', ranges: [{ start: 22, count: 22 }] },
    ],
    savedConfig: null as any,
    operations: [] as string[],
    controls: [] as any[],
  };

  await page.route('http://lightweaver.local/**', async (route: any) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/status') {
      await route.fulfill({ json: { ok: true, led: { pixels: 44 }, wifi: { ip: 'lightweaver.local' } } });
      return;
    }
    if (pathname === '/api/zones') {
      card.operations.push('zones');
      await route.fulfill({ json: { ok: true, syncZones: false, zones: card.zones } });
      return;
    }
    if (pathname === '/api/firmware-info') {
      await route.fulfill({
        json: {
          ok: true,
          pixels: 44,
          outputs: [
            { id: 'out1', pin: 16, pixels: 22 },
            { id: 'out2', pin: 17, pixels: 22 },
          ],
        },
      });
      return;
    }
    if (pathname === '/api/config') {
      card.operations.push('config');
      if (options.configDelayMs) await new Promise(resolve => setTimeout(resolve, options.configDelayMs));
      card.savedConfig = JSON.parse(request.postData() || '{}');
      card.zones = card.savedConfig.zones || card.zones;
      await route.fulfill({ json: { ok: true, requiresReboot: false } });
      return;
    }
    if (pathname === '/api/control') {
      card.operations.push('control');
      card.controls.push(JSON.parse(request.postData() || '{}'));
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  return card;
}

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

test('imports SVG, creates strips, saves, reloads, and previews on the Show screen', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-workflow-'));
  const fixture = writeLayerFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Import SVG' }).first()).toBeVisible();
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await expect(page.locator('.layer-row')).toHaveCount(3);

  await page.getByRole('button', { name: /\+ All \(3\)/ }).click();
  await expect(page.locator('.la-strip-row')).toHaveCount(3);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project file').click();
  const savedProject = await saveDownload;
  const projectPath = path.join(tmp, await savedProject.suggestedFilename());
  await savedProject.saveAs(projectPath);

  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  expect(projectData.version).toBe(3);
  expect(projectData.layout.strips).toHaveLength(3);
  expect(projectData.layout.strips[0].pixels.length).toBeGreaterThan(0);

  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  // A cleared project reboots into the default two-circle hardware layout
  // (2 strips already present), so loading a project file now triggers the
  // "replace your current strips" confirm() the app didn't need to show
  // before strips.length could ever be > 0 at this point.
  page.once('dialog', dialog => dialog.accept());
  await page.setInputFiles('input[accept=".json"]', projectPath);
  await expect(page.locator('.la-strip-row')).toHaveCount(3);

  // Note: the old "Export" rail screen (ledmap.json download) no longer
  // exists in the current build — per docs/layout-redesign-plan.md, Send to
  // card + Export ledmap.json are Phase 3 work that hasn't shipped yet
  // ("exists in code with no button"). That portion of this test is dropped
  // until Phase 3 lands a real Export surface (plan step 14 names the future
  // `layout-export-ledmap` testid to repoint this at).
  //
  // The live LED preview also moved off the Patterns screen onto its own
  // "Show" screen (src/v3/lw-show.jsx): an always-on audio-reactive mandala
  // canvas rather than a per-pattern strip preview. Its idle/quiet state is
  // deliberately "barely-there" (src/lib/mandalaEngine.js fades to a dim coal
  // idle over ~8s when not listening to anything), so a bright-pixel-count
  // assertion like the old test's would be measuring the wrong thing here —
  // it can legitimately stay near-black. What still proves the reload
  // actually plumbed the strips through to a live screen is the pixel-count
  // readout, which is derived straight from `strips` in ProjectContext.
  const totalPixels = projectData.layout.strips.reduce((sum: number, strip: any) => sum + strip.pixels.length, 0);
  await page.locator('.rail-item', { hasText: 'Show' }).click();
  await page.waitForSelector('canvas');
  await expect(page.getByText(`${totalPixels} LEDs ready`)).toBeVisible();
  const canvasSize = await page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    return { width: canvas?.width || 0, height: canvas?.height || 0 };
  });
  expect(canvasSize.width).toBeGreaterThan(100);
  expect(canvasSize.height).toBeGreaterThan(100);
});

test('groups selected strips and merges them into one composite strip', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-strip-groups-'));
  const fixture = writeLayerFixture(tmp, 'strip-groups.svg');

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(3\)/ }).click();
  await expect(page.locator('.la-strip-row')).toHaveCount(3);

  await page.locator('.la-strip-row').nth(0).click();
  await page.locator('.la-strip-row').nth(1).click({ modifiers: ['Shift'] });
  await page.locator('.la-strip-row').nth(2).click({ modifiers: ['Shift'] });
  await expect(page.getByText('3 strips selected')).toBeVisible();

  await page.locator('.la-batch-actions input').fill('Heart outline');
  await page.getByRole('button', { name: 'Group' }).click();
  await expect(page.getByText('Heart outline')).toBeVisible();
  await expect(page.locator('.la-strip-row')).toHaveCount(3);

  await page.locator('.la-strip-row').nth(0).click();
  await page.locator('.la-strip-row').nth(1).click({ modifiers: ['Shift'] });
  await page.locator('.la-strip-row').nth(2).click({ modifiers: ['Shift'] });
  await page.locator('.la-batch-actions input').fill('Heart merged');
  await page.getByRole('button', { name: 'Merge' }).click();

  await expect(page.locator('.la-strip-row')).toHaveCount(1);
  await expect(page.locator('.la-strip-row').getByText('Heart merged', { exact: true })).toBeVisible();
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

  // Directed glow now lives behind the Light toolbar button's options
  // popover (right-click, or the "▾" affordance) instead of being directly
  // clickable — open it first.
  await page.getByTitle('Light glow options').click();
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
  await expect(page.locator('.layer-row')).toHaveCount(3);
  await expect(page.locator('.la-strip-row')).toHaveCount(3);

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

  await expect(page.locator('.layer-row')).toHaveCount(2);
  await expect(page.locator('.la-strip-row')).toHaveCount(2);
  await expect(page.locator('.layer-row', { hasText: 'Circle' })).toHaveCount(0);
  await expect(page.locator('.la-strip-row', { hasText: 'Circle' })).toHaveCount(0);
  await expect(page.locator('path[data-vector-path-id^="circle-layer-"]')).toHaveCount(0);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project file').click();
  const savedProject = await saveDownload;
  const projectPath = path.join(tmp, await savedProject.suggestedFilename());
  await savedProject.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  expect(projectData.layout.layers.map((layer: any) => layer.layerId)).toEqual(['bg-layer', 'bar-layer']);
  expect(projectData.layout.strips.map((strip: any) => strip.id)).toEqual(['bg-layer', 'bar-layer']);
});

test('quiet pattern preview does not render routine notifications', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await mockLocalCard(page);
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-link-status')).toContainText(/connected|direct/i, { timeout: 5000 });

  await page.locator('[data-pattern-id="aurora"]').click();
  await page.waitForTimeout(350);

  await expect(page.locator('.pmx-status')).toHaveCount(0);
});

test('quiet complete playlist sync writes and verifies all card sections', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  const card = await mockLocalCard(page);
  await page.goto('/#screen=playlist', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-link-status')).toContainText(/connected|direct/i, { timeout: 5000 });

  card.operations.length = 0;
  await page.getByRole('button', { name: 'Load playlist to card' }).click();
  await expect.poll(() => card.savedConfig).not.toBeNull();
  await expect.poll(() => card.operations).toEqual(['config', 'zones']);

  expect(card.savedConfig.zones.map((zone: any) => zone.id)).toEqual([
    'patch-default-outer-circle',
    'patch-default-inner-circle',
  ]);
  await expect(page.getByTestId('playlist-zone-fallback-note')).toHaveCount(0);
  await expect(page.getByTestId('playlist-card-status')).toHaveCount(0);
});

test('latest section preview installs dependencies once and wins rapid taps', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  const card = await mockLocalCard(page, {
    zones: [{ id: 'full-piece', label: 'Full piece', ranges: [{ start: 0, count: 44 }] }],
    configDelayMs: 1000,
  });
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-link-status')).toContainText(/connected|direct/i, { timeout: 5000 });

  card.operations.length = 0;
  await page.getByRole('button', { name: 'Outer circle', exact: true }).click();
  await expect.poll(() => card.operations.filter(item => item === 'config').length).toBe(1);
  await page.getByRole('button', { name: 'Inner circle', exact: true }).click();

  await page.waitForTimeout(1500);
  expect(card.operations.filter(item => item === 'config')).toHaveLength(1);
  expect(card.controls).toHaveLength(1);
  expect(card.controls[0].zone).toBe('patch-default-inner-circle');
  await expect(page.locator('.pmx-status')).toHaveCount(0);
});
