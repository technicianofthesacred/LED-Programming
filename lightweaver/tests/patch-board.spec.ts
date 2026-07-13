import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeFixture(tmp: string) {
  const fixture = path.join(tmp, 'patch-board-line.svg');
  fs.writeFileSync(fixture, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 40"><g id="line-layer" data-name="Line"><path d="M 10 20 H 610" fill="none" stroke="#fff"/></g></svg>`);
  return fixture;
}

async function importLine(page: any) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-wire-'));
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', writeFixture(tmp));
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();
  return tmp;
}

async function enterWire(page: any) {
  await page.getByTestId('layout-mode-wire').click();
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
}

async function loadVerifiedWiring(page: any, tmp: string) {
  const pending = page.waitForEvent('download');
  await page.getByTitle('Save project file').click();
  const download = await pending;
  const source = path.join(tmp, 'verification-source.json');
  await download.saveAs(source);
  const project = JSON.parse(fs.readFileSync(source, 'utf8'));
  project.layout.wiring.verified = true;
  project.layout.wiring.locked = false;
  project.layout.wiring.runs.forEach((run: any) => { run.verified = true; });
  const verified = path.join(tmp, 'verified.json');
  fs.writeFileSync(verified, JSON.stringify(project));
  await page.addInitScript(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(project));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
}

test('cutter splits at the nearest sampled LED and persists canonical wiring', async ({ page }) => {
  const tmp = await importLine(page);
  await enterWire(page);
  await page.getByRole('button', { name: 'Split' }).click();
  const pathEl = page.locator('path[data-strip-path]').first();
  const target = await pathEl.evaluate((node: SVGPathElement) => {
    const point = node.getPointAtLength(node.getTotalLength() * .45);
    const ctm = node.getScreenCTM()!;
    return { x: point.x * ctm.a + point.y * ctm.c + ctm.e, y: point.x * ctm.b + point.y * ctm.d + ctm.f };
  });
  await page.mouse.click(target.x, target.y);
  await expect(page.getByTestId('wiring-run-row')).toHaveCount(2);
  await expect(page.getByText('Selected split')).toBeVisible();
  await page.getByRole('button', { name: 'Move split later' }).click();
  await page.getByRole('button', { name: 'Merge split runs' }).click();
  await expect(page.getByTestId('wiring-run-row')).toHaveCount(1);
  await page.mouse.click(target.x, target.y);
  await page.getByRole('button', { name: 'Delete split' }).click();
  await expect(page.getByTestId('wiring-run-row')).toHaveCount(1);
  const downloadPromise = page.waitForEvent('download');
  await page.getByTitle('Save project file').click();
  const download = await downloadPromise;
  const file = path.join(tmp, 'saved.json');
  await download.saveAs(file);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(saved.layout.wiring.runs.filter((run: any) => run.type === 'strip')).toHaveLength(1);
});

test('ports and accessible move controls reorder canonical output runs', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  const rows = page.getByTestId('wiring-run-row');
  const secondId = await rows.nth(1).getAttribute('data-run-id');
  await rows.nth(1).getByRole('button', { name: 'Move earlier' }).click();
  await expect(rows.first()).toHaveAttribute('data-run-id', secondId!);
  await rows.first().getByRole('button', { name: /OUT port/ }).click();
  await rows.nth(1).getByRole('button', { name: /IN port/ }).click();
  await expect(rows.first()).toHaveAttribute('data-run-id', secondId!);
});

test('locked wiring blocks direction, route, split, and reserved-unlit mutations', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-locked-wire-'));
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await loadVerifiedWiring(page, tmp);
  await page.getByRole('button', { name: 'Lock wiring' }).click();
  await expect(page.getByRole('button', { name: 'Unlock wiring' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add reserved-unlit LEDs' })).toBeDisabled();
  await expect(page.getByTestId('wiring-run-row').first().getByRole('button', { name: 'Reverse' })).toBeDisabled();
  await page.getByRole('button', { name: 'Split' }).click();
  const before = await page.getByTestId('wiring-run-row').count();
  const target = await page.locator('path[data-strip-path]').first().evaluate((node: SVGPathElement) => {
    const point = node.getPointAtLength(node.getTotalLength() * .4);
    const ctm = node.getScreenCTM()!;
    return { x: point.x * ctm.a + point.y * ctm.c + ctm.e, y: point.x * ctm.b + point.y * ctm.d + ctm.f };
  });
  await page.mouse.click(target.x, target.y);
  await expect(page.getByTestId('wiring-run-row')).toHaveCount(before);
});

test('numeric strip count replaces the full value with an exact accessible selector', async ({ page }) => {
  await importLine(page);
  await page.locator('.la-strip-row').first().click();
  const count = page.getByRole('spinbutton', { name: 'Strip LED count', exact: true });
  await count.fill('12');
  await count.blur();
  await count.click();
  await page.keyboard.press('3');
  await expect(count).toHaveValue('3');
});
