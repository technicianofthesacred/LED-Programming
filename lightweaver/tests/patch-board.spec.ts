import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Wire panel presentation: ONE primary way to wire — the numbered "Wire order"
// list on the Match step — with every other wiring tool demoted to the single
// Advanced wiring disclosure. These tests pin that structure against the
// canonical wiring model (runs/outputs) via exported project JSON.

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

// The commissioning flow renders one step at a time; the StepRail (role=group
// "Steps") is the navigation affordance. The Wire order list lives on the
// Match step.
async function openStep(page: any, label: string) {
  await page.getByRole('group', { name: 'Steps' }).getByRole('button', { name: label }).click();
  await expect(page.getByTestId('commissioning-step')).toBeVisible();
}

async function enterWire(page: any) {
  await page.getByTestId('layout-mode-wire').click();
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
}

async function gotoDefaultWire(page: any) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
}

async function exportProject(page: any, tmp: string, name = 'saved.json') {
  const pending = page.waitForEvent('download');
  await page.getByTitle('Export a portable project file (.lw.json)').click();
  const download = await pending;
  const file = path.join(tmp, name);
  await download.saveAs(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function openAdvanced(page: any) {
  const toggle = page.getByTestId('advanced-wiring-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

async function loadVerifiedWiring(page: any, tmp: string) {
  const project = await exportProject(page, tmp, 'verification-source.json');
  project.layout.wiring.verified = true;
  project.layout.wiring.locked = false;
  project.layout.wiring.runs.forEach((run: any) => { run.verified = true; });
  const led = project.devices.standaloneController.led;
  led.colorOrder = led.colorOrder || 'RGB';
  led.colorOrderConfirmed = true;
  led.confirmedColorOrder = led.colorOrder;
  await page.addInitScript(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(project));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
}

async function clickStripPathAt(page: any, fraction: number) {
  const target = await page.locator('path[data-strip-path]').first().evaluate((node: SVGPathElement, at: number) => {
    const point = node.getPointAtLength(node.getTotalLength() * at);
    const ctm = node.getScreenCTM()!;
    return { x: point.x * ctm.a + point.y * ctm.c + ctm.e, y: point.x * ctm.b + point.y * ctm.d + ctm.f };
  }, fraction);
  await page.mouse.click(target.x, target.y);
}

test('wire order lists numbered strip rows and Move down reorders the canonical output', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-order-'));
  await gotoDefaultWire(page);
  await openStep(page, 'Match');

  const rows = page.getByTestId('wire-order-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.lw-order-n')).toHaveText('1');
  await expect(rows.nth(0)).toContainText('Outer circle');
  await expect(rows.nth(0)).toContainText('27 LEDs');
  await expect(rows.nth(1).locator('.lw-order-n')).toHaveText('2');
  await expect(rows.nth(1)).toContainText('Inner circle');
  await expect(rows.nth(0).getByRole('button', { name: 'Drag Outer circle' })).toBeVisible();
  await expect(page.getByText('Put the strips in the order the data cable visits them, starting from the card.')).toBeVisible();

  const firstId = await rows.nth(0).getAttribute('data-run-id');
  await rows.nth(0).getByRole('button', { name: 'Move Outer circle down' }).click();
  await expect(rows.nth(1)).toHaveAttribute('data-run-id', firstId!);
  await expect(rows.nth(1).locator('.lw-order-n')).toHaveText('2');
  await expect(page.getByTestId('wire-order-status')).toHaveText('Outer circle moved to position 2 of 2');

  const project = await exportProject(page, tmp);
  expect(project.layout.wiring.outputs).toHaveLength(1);
  expect(project.layout.wiring.outputs[0].runIds[1]).toBe(firstId);
});

test('Reverse toggle flips the run direction in the canonical model', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-reverse-'));
  await gotoDefaultWire(page);
  await openStep(page, 'Match');

  const row = page.getByTestId('wire-order-row').first();
  const runId = await row.getAttribute('data-run-id');
  const reverse = row.getByRole('button', { name: 'Reverse direction of Outer circle' });
  await expect(reverse).toHaveAttribute('aria-pressed', 'false');
  await reverse.click();
  await expect(reverse).toHaveAttribute('aria-pressed', 'true');

  const project = await exportProject(page, tmp);
  const run = project.layout.wiring.runs.find((item: any) => item.id === runId);
  expect(run.physicalDirection).toBe('source-reverse');

  await reverse.click();
  await expect(reverse).toHaveAttribute('aria-pressed', 'false');
  const restored = await exportProject(page, tmp, 'restored.json');
  expect(restored.layout.wiring.runs.find((item: any) => item.id === runId).physicalDirection).toBe('source-forward');
});

test('Advanced wiring is one collapsed disclosure and Split still cuts a run', async ({ page }) => {
  const tmp = await importLine(page);
  await enterWire(page);
  await openStep(page, 'Match');

  const toggle = page.getByTestId('advanced-wiring-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Split a strip mid-wire' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Paint the route by clicking strips' })).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Split a strip mid-wire' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Paint the route by clicking strips' })).toBeVisible();
  // The wire count and the shortest-order suggestion each keep exactly one
  // home — the Wires step chooser and the Route step — not the drawer.
  await expect(page.getByRole('group', { name: 'LED data wire count' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Suggest shortest order' })).toHaveCount(0);
  await openStep(page, 'Route');
  const shortest = page.getByTestId('commissioning-step');
  await expect(shortest).toContainText('Mark where the card physically sits on the drawing, and Lightweaver reorders the strips to use the least cable.');
  await expect(shortest.getByRole('button', { name: 'Mark card position on drawing' })).toBeVisible();
  await openStep(page, 'Match');

  await page.getByRole('button', { name: 'Split a strip mid-wire' }).click();
  await clickStripPathAt(page, 0.45);
  await expect(page.getByTestId('wire-order-row')).toHaveCount(2);
  await expect(page.getByText('Selected split')).toBeVisible();
  await page.getByRole('button', { name: 'Move split later' }).click();
  await page.getByRole('button', { name: 'Merge split runs' }).click();
  await expect(page.getByTestId('wire-order-row')).toHaveCount(1);

  const saved = await exportProject(page, tmp);
  expect(saved.layout.wiring.runs.filter((run: any) => run.type === 'strip')).toHaveLength(1);
});

test('locked wiring blocks reorder, direction, split, and skipped-pixel mutations', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-locked-wire-'));
  await gotoDefaultWire(page);
  await loadVerifiedWiring(page, tmp);

  // The seeded project is fully verified, so the panel auto-advances to the
  // Install step; wait for that settled state instead of clicking.
  await expect(page.getByTestId('commissioning-step')).toHaveAttribute('aria-label', 'Lock it in');
  await page.getByRole('button', { name: 'Lock wiring' }).click();
  await expect(page.getByRole('button', { name: 'Unlock wiring' })).toBeVisible();

  await openStep(page, 'Match');
  const row = page.getByTestId('wire-order-row').first();
  await expect(row.getByRole('button', { name: /Move .* up/ })).toBeDisabled();
  await expect(row.getByRole('button', { name: /Move .* down/ })).toBeDisabled();
  await expect(row.getByRole('button', { name: /Reverse direction of/ })).toBeDisabled();
  await expect(row.getByRole('button', { name: /Drag/ })).toBeDisabled();

  await openAdvanced(page);
  await expect(page.getByRole('button', { name: 'Add skipped pixels' })).toBeDisabled();
  await expect(page.getByTestId('wiring-run-row').first().getByRole('button', { name: 'Flip' })).toBeDisabled();

  await page.getByRole('button', { name: 'Split a strip mid-wire' }).click();
  const before = await page.getByTestId('wire-order-row').count();
  await clickStripPathAt(page, 0.4);
  await expect(page.getByTestId('wire-order-row')).toHaveCount(before);

  const project = await exportProject(page, tmp);
  expect(project.layout.wiring.locked).toBe(true);
  expect(project.layout.wiring.runs.every((run: any) => run.verified)).toBe(true);
});

test('disconnected card banner shows up front and clears when the card link connects', async ({ page }) => {
  await gotoDefaultWire(page);

  const banner = page.getByTestId('wire-card-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("To finish wiring you'll check the real LEDs.");
  await expect(banner).toContainText("Connect your Lightweaver card when you're ready — steps up to that point work without it.");
  await expect(banner).toContainText('Connect Lightweaver');

  await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    getSharedCardLink().dispatch({
      type: 'card-verified',
      via: 'direct',
      host: 'lightweaver.local',
      card: { id: 'lw-banner-test', name: 'Bench card', pixelCount: 44, firmwareVersion: '1.0.0' },
    });
  });
  await expect(banner).toHaveCount(0);
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
