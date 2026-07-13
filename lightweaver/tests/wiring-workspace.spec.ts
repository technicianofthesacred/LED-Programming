import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function gotoWire(page: any) {
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
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

async function seedFourRunClosedFixture(page: any) {
  const project = await saveProject(page);
  project.layout.strips.forEach((strip: any) => { strip.closed = true; });
  const runs: any[] = [];
  const runIds: string[] = [];
  for (const run of project.layout.wiring.runs.filter((item: any) => item.type === 'strip')) {
    const middle = Math.floor((run.source.from + run.source.to) / 2);
    const left = { ...run, id: `${run.id}-left`, source: { ...run.source, to: middle }, seamLed: middle, verified: false };
    const right = { ...run, id: `${run.id}-right`, source: { ...run.source, from: middle + 1 }, seamLed: run.source.to, verified: false };
    runs.push(left, right);
    runIds.push(left.id, right.id);
  }
  project.layout.wiring.runs = runs;
  project.layout.wiring.outputs = [{ id: 'out1', name: 'Output A', pin: 16, runIds }];
  project.layout.wiring.controllerAnchor = { x: 320, y: 200 };
  project.layout.wiring.verified = false;
  project.layout.wiring.locked = false;
  await page.addInitScript(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(project));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('wiring-run-row')).toHaveCount(4);
}

async function installFrameCard(page: any) {
  const controls: any[] = [];
  await page.addInitScript(() => {
    (window as any).__wiringFrames = [];
    class FrameSocket {
      readyState = 0;
      bufferedAmount = 0;
      onopen: any;
      onclose: any;
      onerror: any;
      constructor() { setTimeout(() => { if ((window as any).__wiringFail) this.onclose?.(); else { this.readyState = 1; this.onopen?.(); } }, 5); }
      send(payload: string) { (window as any).__wiringFrames.push(JSON.parse(payload).seg[0].i); }
      close() { this.readyState = 3; }
    }
    (window as any).WebSocket = FrameSocket;
  });
  await page.route('http://lightweaver.local/**', route => { const body = route.request().postData(); if (body) controls.push(JSON.parse(body)); return route.fulfill({ json: { ok: true } }); });
  return controls;
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

test('controller placement and physical DATA IN controls feed a preview-only Auto Wire proposal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoWire(page);

  const anchor = page.getByTestId('controller-anchor');
  await expect(anchor).toBeVisible();
  await anchor.hover();
  const box = await anchor.boundingBox();
  if (!box) throw new Error('controller anchor unavailable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 30, { steps: 4 });
  await page.mouse.up();

  await expect(page.getByLabel('Auto Wire output count')).toHaveValue('auto');
  await page.getByTestId('wiring-run-row').first().locator('.lw-wiring-run-name').click();
  await page.getByText('Edit LED range').click();
  await expect(page.getByLabel('Direction policy')).toHaveValue('flexible');
  await expect(page.getByLabel('Physical DATA IN')).toHaveValue('source-forward');

  const before = (await saveProject(page)).layout.wiring;
  await page.getByRole('button', { name: 'Auto Wire' }).click();
  const preview = page.getByTestId('auto-wire-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(/Output A|Output B/);
  await expect(preview).toContainText(/jumper/i);
  await expect(preview).toContainText(/assumption|physical estimate/i);
  const whilePreviewing = (await saveProject(page)).layout.wiring;
  expect(whilePreviewing).toEqual(before);

  await page.getByRole('button', { name: 'Cancel Auto Wire' }).click();
  await expect(preview).toHaveCount(0);
  const afterCancel = (await saveProject(page)).layout.wiring;
  expect(afterCancel).toEqual(before);
});

test('Auto Wire acceptance applies the displayed proposal while fixed or verified seams refuse movement', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoWire(page);
  const anchor = page.getByTestId('controller-anchor');
  await anchor.hover();
  const box = await anchor.boundingBox();
  if (!box) throw new Error('controller anchor unavailable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up();

  await page.getByRole('button', { name: 'Auto Wire' }).click();
  const preview = page.getByTestId('auto-wire-preview');
  const displayedLane = await preview.getByTestId('auto-wire-lane').first().getAttribute('data-run-order');
  await page.getByRole('button', { name: 'Accept routing' }).click();
  await expect(preview).toHaveCount(0);
  const accepted = (await saveProject(page)).layout.wiring;
  expect(accepted.outputs[0].runIds.join(',')).toBe(displayedLane);

  await page.getByTestId('wiring-run-row').first().locator('.lw-wiring-run-name').click();
  await page.getByText('Edit LED range').click();
  const seam = page.getByLabel('Connector seam LED');
  if (await seam.count()) {
    await page.getByLabel('Direction policy').selectOption('fixed');
    await expect(seam).toBeDisabled();
  }
});

test('Auto Wire honors each output constraint and exposes only solver-approved equivalent alternatives', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await gotoWire(page);
  await seedFourRunClosedFixture(page);
  const outputCount = page.getByLabel('Auto Wire output count');

  for (const count of ['1', '2', '3', '4']) {
    await outputCount.selectOption(count);
    await page.getByRole('button', { name: 'Auto Wire' }).click();
    const preview = page.getByTestId('auto-wire-preview');
    await expect(preview.getByTestId('auto-wire-lane')).toHaveCount(Number(count));
    await expect(preview).toContainText(/relative units|mm/);
    await expect(preview).toContainText(/physical DATA IN reversal/i);
    await expect(preview).toContainText(/seam move/i);
    await expect(preview).toContainText(/Assumptions:/);
    await page.getByRole('button', { name: 'Cancel Auto Wire' }).click();
  }

  await outputCount.selectOption('auto');
  await page.getByRole('button', { name: 'Auto Wire' }).click();
  await expect(page.getByTestId('auto-wire-preview').getByTestId('auto-wire-lane')).toHaveCount(1);
  const alternative = page.getByRole('button', { name: 'Try alternative' });
  await expect(alternative).toBeVisible();
  const firstOrder = await page.getByTestId('auto-wire-lane').first().getAttribute('data-run-order');
  await alternative.click();
  await expect(page.getByTestId('auto-wire-lane').first()).not.toHaveAttribute('data-run-order', firstOrder || '');
});

test('closed-path seam and physical DATA IN are editable independently until fixed, then refuse movement', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoWire(page);
  await seedFourRunClosedFixture(page);
  const row = page.getByTestId('wiring-run-row').first();
  await row.locator('.lw-wiring-run-name').click();
  await page.getByText('Edit LED range').click();
  const policy = page.getByLabel('Direction policy');
  const dataIn = page.getByLabel('Physical DATA IN');
  const seam = page.getByLabel('Connector seam LED');
  await expect(seam).toBeEnabled();
  const originalSeam = Number(await seam.inputValue());
  await seam.fill(String(originalSeam > 0 ? originalSeam - 1 : originalSeam + 1));
  await seam.blur();
  await dataIn.selectOption('source-reverse');
  await expect(policy).toHaveValue('flexible');
  await expect(dataIn).toHaveValue('source-reverse');
  await policy.selectOption('fixed');
  await expect(dataIn).toHaveValue('source-reverse');
  await expect(dataIn).toBeDisabled();
  await expect(seam).toBeDisabled();
  await expect(page.getByTestId('connector-seam-handle')).toHaveAttribute('aria-disabled', 'true');
});

test('guided chase acknowledges full low-brightness frames, verifies every fact, then unlocks assembly documentation', async ({ page }) => {
  await installFrameCard(page);
  await gotoWire(page);
  const stripRows = page.getByTestId('wiring-run-row').filter({ has: page.getByRole('button', { name: 'Reverse' }) });
  await stripRows.nth(0).getByRole('button', { name: /OUT port/ }).click();
  await stripRows.nth(1).getByRole('button', { name: /IN port/ }).click();
  await page.getByRole('button', { name: 'Add reserved-unlit LEDs' }).click();
  const bench = page.getByTestId('wiring-bench-test');
  await bench.getByRole('checkbox').check();
  await bench.getByRole('button', { name: 'Start wiring test' }).click();

  await expect(bench).toContainText('Frame confirmed');
  await bench.getByRole('button', { name: /I see Output/ }).click();
  for (let run = 0; run < 2; run += 1) {
    await expect(bench).toContainText('Frame confirmed');
    if (run === 0) {
      const beforeCorrectionFrames = await page.evaluate(() => (window as any).__wiringFrames.length);
      await bench.getByRole('button', { name: 'Reverse direction' }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__wiringFrames.length)).toBeGreaterThan(beforeCorrectionFrames);
      await expect(bench).toContainText('Frame confirmed');
    }
    await bench.getByRole('button', { name: 'First pixel is correct' }).click();
    await bench.getByRole('button', { name: 'Direction is correct' }).click();
    if (run === 0) {
      await expect(bench).toContainText('Cable jump');
      await expect(bench).toContainText('Frame confirmed');
      await bench.getByRole('button', { name: 'Cable is connected' }).click();
    }
  }
  await expect(bench).toContainText('Reserved · unlit');
  await expect(bench).toContainText('Frame confirmed');
  await bench.getByRole('button', { name: 'Reserved LEDs stay unlit' }).click();
  await expect(bench.getByRole('button', { name: 'Complete verification' })).toBeEnabled();
  await bench.getByRole('button', { name: 'Complete verification' }).click();
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toBeEnabled();
  const correctedProject = await saveProject(page);
  expect(correctedProject.layout.wiring.runs.find((run: any) => run.type === 'strip').physicalDirection).toBe('source-reverse');
  expect(correctedProject.layout.wiring.runs.map((run: any) => `${run.id}:${run.verified}`)).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^cable-\d+:true$/),
      expect.stringMatching(/^reserved-\d+:true$/),
    ]),
  );

  const frames = await page.evaluate(() => (window as any).__wiringFrames);
  expect(frames.length).toBeGreaterThanOrEqual(3);
  for (const frame of frames) {
    expect(frame).toHaveLength(45);
    expect(frame.flatMap((pixel: string) => pixel.match(/../g)!.map(value => parseInt(value, 16))).every((channel: number) => channel <= 26)).toBe(true);
  }

  await page.getByRole('button', { name: 'Lock wiring' }).click();
  await page.getByRole('button', { name: 'Open assembly map' }).click();
  const assembly = page.getByTestId('wiring-assembly-map');
  await expect(assembly).toContainText(/GPIO 16/);
  await expect(assembly).toContainText(/LED 0/);
  await expect(assembly).toContainText('End LED → start LED');
  await expect(assembly).toContainText(/Verified/);
  await expect(assembly.getByRole('button', { name: 'Print assembly map' })).toBeVisible();
});

test('failed chase stays on the same step, cancels without false verification, and Retry requires a fresh acknowledgement', async ({ page }) => {
  const controls = await installFrameCard(page);
  await gotoWire(page);
  await page.evaluate(() => { (window as any).__wiringFail = true; });
  const bench = page.getByTestId('wiring-bench-test');
  await bench.getByRole('checkbox').check();
  await bench.getByRole('button', { name: 'Start wiring test' }).click();
  await expect(bench).toContainText(/Identify Output/);
  await expect(bench).toContainText('Delivery failed');
  await expect(bench.getByRole('button', { name: /I see Output/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toBeDisabled();
  expect(controls.some(body => body.cancelStream === true)).toBe(true);

  await page.evaluate(() => { (window as any).__wiringFail = false; });
  await bench.getByRole('button', { name: 'Retry' }).click();
  await expect(bench).toContainText('Frame confirmed');
  await expect(bench).toContainText(/Identify Output/);
  await expect(bench.getByRole('button', { name: /I see Output/ })).toBeEnabled();
});
