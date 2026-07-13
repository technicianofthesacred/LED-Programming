import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function gotoWire(page: any) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
}

async function saveProject(page: any) {
  await page.waitForTimeout(600);
  const pending = page.waitForEvent('download');
  await page.locator('.la .toolbar').getByRole('button', { name: 'Save', exact: true }).click();
  const download = await pending;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-wire-save-')), 'project.json');
  await download.saveAs(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('Wire is a compiler-derived physical output patch board', async ({ page }) => {
  await gotoWire(page);
  await expect(page.getByTestId('wiring-output-lane')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Output A' })).toBeVisible();
  await expect(page.getByText(/GPIO 16/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Advanced wiring settings' }).click();
  await expect(page.getByText(/GPIO 16/)).toBeVisible();
  await expect(page.getByTestId('wiring-run-row')).toHaveCount(2);
});

test('run selection stays synchronized with the artwork canvas', async ({ page }) => {
  await gotoWire(page);
  const row = page.getByTestId('wiring-run-row').first();
  await row.locator('.lw-wiring-run-name').click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-wiring-run].is-selected')).toHaveCount(1);
});

test('accessible ports connect by tap and keyboard alternatives reorder runs', async ({ page }) => {
  await gotoWire(page);
  const rows = page.getByTestId('wiring-run-row');
  const secondName = await rows.nth(1).getAttribute('data-run-id');
  await rows.nth(1).getByRole('button', { name: 'Move earlier' }).click();
  await expect(page.getByTestId('wiring-run-row').first()).toHaveAttribute('data-run-id', secondName!);
  const physicalRows = page.getByTestId('wiring-run-row').filter({ has: page.getByRole('button', { name: 'Reverse' }) });
  await physicalRows.nth(0).getByRole('button', { name: /OUT port/ }).click();
  await expect(physicalRows.nth(0).getByRole('button', { name: /OUT port/ })).toHaveAttribute('aria-pressed', 'true');
  await physicalRows.nth(1).getByRole('button', { name: /IN port/ }).click();
  await expect(page.getByTestId('wiring-run-row').getByText('Cable jump')).toBeVisible();
});

test('unverified wiring cannot lock or send and deterministic reserved runs consume addresses', async ({ page }) => {
  await gotoWire(page);
  await expect(page.getByTestId('layout-send-to-card')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toBeDisabled();
  await page.getByRole('button', { name: 'Add reserved-unlit LEDs' }).click();
  await page.getByRole('button', { name: 'Add reserved-unlit LEDs' }).click();
  await expect(page.getByTestId('wiring-run-row').getByText('Reserved · unlit')).toHaveCount(2);
  await expect(page.getByTestId('wiring-total-pixels')).toContainText('46');
  const ids = await page.getByTestId('wiring-run-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-run-id')));
  expect(ids).toContain('reserved-1');
  expect(ids).toContain('reserved-2');
  await expect(page.getByRole('button', { name: 'Add cable jump' })).toHaveCount(0);
});

test('pointer row drag captures the pointer and moves a canonical run between output lanes', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__captures = 0;
    const original = Element.prototype.setPointerCapture;
    Element.prototype.setPointerCapture = function(pointerId) {
      (window as any).__captures += 1;
      return original?.call(this, pointerId);
    };
  });
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add output' }).click();
  const run = page.getByTestId('wiring-run-row').first();
  const runId = await run.getAttribute('data-run-id');
  const handle = run.getByRole('button', { name: /Drag/ });
  const laneB = page.getByTestId('wiring-output-lane').nth(1).getByRole('heading', { name: 'Output B' });
  const from = await handle.boundingBox();
  const to = await laneB.boundingBox();
  if (!from || !to) throw new Error('ports unavailable');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('wiring-output-lane').nth(1).getByTestId('wiring-run-row')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__captures)).toBeGreaterThan(0);
  const project = await saveProject(page);
  const refs = project.layout.wiring.outputs.flatMap((output: any) => output.runIds);
  expect(refs.filter((id: string) => id === runId)).toHaveLength(1);
  expect(project.layout.wiring.outputs[1].runIds).toContain(runId);
});

test('pointer cord drag from run DATA OUT to DATA IN creates one zero-address cable jump', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await gotoWire(page);
  const physicalRows = page.getByTestId('wiring-run-row').filter({ has: page.getByRole('button', { name: 'Reverse' }) });
  const outPort = physicalRows.nth(0).getByRole('button', { name: /OUT port/ });
  const inPort = physicalRows.nth(1).getByRole('button', { name: /IN port/ });
  await inPort.scrollIntoViewIfNeeded();
  await outPort.hover();
  const from = await outPort.boundingBox();
  const to = await inPort.boundingBox();
  if (!from || !to) throw new Error('ports unavailable');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await expect(outPort).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(outPort).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('wiring-run-row').getByText('Cable jump')).toHaveCount(1);
  await expect(page.getByTestId('wiring-total-pixels')).toContainText('44');
  await page.waitForTimeout(700);
  const autosavedTypes = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}').layout?.wiring?.runs?.map((run: any) => `${run.id}:${run.type}`));
  expect(autosavedTypes).toContain('cable-1:cable');
  const project = await saveProject(page);
  expect(project.layout.wiring.runs.map((run: any) => `${run.id}:${run.type}`)).toContain('cable-1:cable');
  const cable = project.layout.wiring.runs.filter((run: any) => run.type === 'cable');
  expect(cable).toHaveLength(1);
  const refs = project.layout.wiring.outputs.flatMap((output: any) => output.runIds);
  expect(refs.filter((id: string) => id === cable[0].id)).toHaveLength(1);
});

test('fixed-direction runs refuse reverse and self-connections do not create cycles or duplicates', async ({ page }) => {
  await gotoWire(page);
  await page.getByTestId('wiring-run-row').first().locator('.lw-wiring-run-name').click();
  await page.getByText('Edit LED range').click();
  await page.getByLabel('Direction').selectOption('fixed');
  await expect(page.getByTestId('wiring-run-row').first().getByRole('button', { name: 'Reverse' })).toBeDisabled();
  const row = page.getByTestId('wiring-run-row').first();
  await row.getByRole('button', { name: /OUT port/ }).click();
  await row.getByRole('button', { name: /IN port/ }).click();
  const ids = await page.getByTestId('wiring-run-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-run-id')));
  expect(new Set(ids).size).toBe(ids.length);
  await expect(page.getByText(/cycle|duplicate|branch/i)).toHaveCount(0);
});
