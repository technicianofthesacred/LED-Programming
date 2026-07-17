import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_CARD_ID = 'lw-wiring-tests';

async function installStableCardIdentity(page: any) {
  await page.addInitScript(cardId => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: cardId }));
  }, TEST_CARD_ID);
  await page.route('**/api/firmware-info', route => route.fulfill({ json: {
    app: 'Lightweaver', cardId: TEST_CARD_ID, firmwareVersion: '1.0.0', buildId: 'b'.repeat(40),
  } }));
  await page.route('**/api/status', route => route.fulfill({ json: {
    app: 'Lightweaver', ok: true, cardId: TEST_CARD_ID, firmwareVersion: '1.0.0', buildId: 'b'.repeat(40),
  } }));
}

async function openCommissioningStep(page: any, regionName: string, toggleName: string, target: (step: any) => any) {
  const step = page.getByRole('region', { name: regionName });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const child = target(step);
    if (await child.isVisible().catch(() => false)) return;
    const toggle = step.getByRole('button', { name: toggleName });
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await page.waitForTimeout(120);
  }
  await expect(target(step)).toBeVisible();
}

async function gotoWire(page: any, { expandDataWires = true } = {}) {
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => { await document.fonts?.ready; });
  if (expandDataWires) {
    await page.waitForTimeout(500);
    await openCommissioningStep(page, 'Step 1: Choose data wires', 'Edit data wire count', step => step.getByRole('group', { name: 'LED data wire count' }));
    await openCommissioningStep(page, 'Step 2: Map LED outputs', 'Edit LED output mapping', step => step.getByTestId('wiring-output-lane').first());
    await openCommissioningStep(page, 'Step 3: Plan the physical route', 'Open optional Auto Wire', step => step.getByRole('region', { name: 'Optional Auto Wire' }));
  }
}

async function openAdvanced(page: any) {
  const button = page.getByRole('button', { name: 'Advanced wiring settings' });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}

async function openInstallReview(page: any) {
  await openCommissioningStep(
    page,
    'Step 5: Review and install',
    'Open install review',
    step => step.locator('.lw-install-gate'),
  );
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
  await page.getByRole('region', { name: 'Step 1: Choose data wires' }).getByRole('button', { name: 'Edit data wire count' }).click();
  await page.getByRole('region', { name: 'Step 2: Map LED outputs' }).getByRole('button', { name: 'Edit LED output mapping' }).click();
  await page.getByRole('region', { name: 'Step 3: Plan the physical route' }).getByRole('button', { name: 'Open optional Auto Wire' }).click();
  await expect(page.getByTestId('wiring-run-row')).toHaveCount(4);
}

async function installFrameCard(page: any) {
  const controls: any[] = [];
  await page.addInitScript(cardId => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: cardId }));
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
  }, TEST_CARD_ID);
  await page.route('http://lightweaver.local/**', route => {
    const body = route.request().postData();
    if (body) controls.push(JSON.parse(body));
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/firmware-info' || pathname === '/api/status') {
      return route.fulfill({ json: { app: 'Lightweaver', ok: true, cardId: TEST_CARD_ID, firmwareVersion: '1.0.0', buildId: 'b'.repeat(40) } });
    }
    const recovery = route.request().url().includes('/api/recover-lights');
    return route.fulfill({ json: recovery
      ? { ok: true, accepted: true, diagnostics: { frameSubmitted: true, nonBlackPixels: 1, brightnessByte: 255 } }
      : { ok: true } });
  });
  return controls;
}

test('Wire is a compiler-derived physical output patch board', async ({ page }) => {
  await gotoWire(page);
  await openInstallReview(page);
  await expect(page.getByTestId('wiring-output-lane')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Output A' })).toBeVisible();
  await expect(page.getByTestId('wiring-run-row')).toHaveCount(2);
  await expect(page.locator('.lw-wiring-run-index')).toHaveCount(0);
  await expect(page.getByText('How many LED data wires leave the card?')).toBeVisible();
  await expect(page.getByRole('button', { name: '1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('GPIO 16', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Output A GPIO')).toHaveCount(0);
  await expect(page.getByText('Compiler preflight')).toHaveCount(0);
  await expect(page.getByText('Complete the physical LED check before installation.', { exact: true })).toBeVisible();
  await expect(page.getByText('Edit LED range')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add skipped pixels' })).toHaveCount(0);
});

test('Wire presents one staged commissioning path with routing before physical verification', async ({ page }) => {
  await gotoWire(page, { expandDataWires: false });
  const steps = page.getByTestId('commissioning-step');
  await expect(steps).toHaveCount(5);
  expect(await steps.evaluateAll(elements => elements.map(element => element.getAttribute('data-step-state')))).toEqual(['complete', 'complete', 'optional', 'current', 'blocked']);
  await expect(page.getByRole('region', { name: 'Step 1: Choose data wires' })).toContainText('1 data wire');
  await expect(page.getByRole('region', { name: 'Step 2: Map LED outputs' })).toContainText('1 LED output');
  await expect(page.getByRole('region', { name: 'Step 4: Check the real LEDs' })).toContainText('Confirm RGB color order');
  await expect(page.getByRole('region', { name: 'Step 5: Review and install' })).toContainText('Physical LED check required');

  const routeStep = page.getByRole('region', { name: 'Step 3: Plan the physical route' });
  const bench = page.getByTestId('wiring-bench-test');
  expect(await routeStep.evaluate((routeElement, benchElement) => Boolean(
    routeElement.compareDocumentPosition(benchElement as Node) & Node.DOCUMENT_POSITION_FOLLOWING
  ), await bench.elementHandle())).toBe(true);
});

test('physical LED check states its prerequisite before the disabled action', async ({ page }) => {
  await gotoWire(page);
  const bench = page.getByTestId('wiring-bench-test');
  const confirmation = bench.getByLabel('The LED strips are visible from here');
  const start = bench.getByRole('button', { name: 'Start physical LED check' });
  await expect(confirmation).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(bench.getByText('Confirm that you can see the LEDs to start the check.')).toBeVisible();
  expect(await confirmation.evaluate((confirmationElement, startElement) => Boolean(
    confirmationElement.compareDocumentPosition(startElement as Node) & Node.DOCUMENT_POSITION_FOLLOWING
  ), await start.elementHandle())).toBe(true);
  await confirmation.check();
  await expect(start).toBeEnabled();
});

test('review separates install from export and names the card connection state', async ({ page }) => {
  await gotoWire(page);
  const review = page.getByRole('region', { name: 'Step 5: Review and install' });
  await review.getByRole('button', { name: 'Open install review' }).click();
  await expect(review.getByText('Data wires')).toBeVisible();
  await expect(review.getByText('LED outputs')).toBeVisible();
  await expect(review.getByText('LED strips')).toBeVisible();
  await expect(review.getByText('Configured color order')).toBeVisible();
  await expect(review.getByRole('button', { name: /Install on card/ })).toContainText('Card not connected');
  await expect(review.getByRole('button', { name: 'Download WLED map' })).toHaveClass(/btn-ghost/);
});

test('narrow inspector uses container-aware stacked controls without clipping', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await gotoWire(page);
  const panel = page.getByTestId('layout-wire-panel');
  await panel.evaluate(element => { (element as HTMLElement).style.width = '300px'; });
  const outputStep = panel.getByRole('region', { name: 'Step 2: Map LED outputs' });
  const outputToggle = outputStep.locator('.lw-step-toggle');
  if (await outputToggle.getAttribute('aria-expanded') !== 'true') await outputToggle.click();
  const row = panel.getByTestId('wiring-run-row').first();
  await expect(row).toHaveCSS('grid-template-columns', /.+/);
  for (const target of [panel, panel.getByRole('region', { name: 'Step 2: Map LED outputs' }), row]) {
    const size = await target.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth);
  }
  await expect(panel.getByRole('button', { name: 'Remove Outer circle' })).toContainText('Remove');
  const controls = panel.getByTestId('wiring-output-lane').first().locator('header button, [data-testid="wiring-run-row"] button');
  for (const control of await controls.all()) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    expect(box?.width, await control.getAttribute('aria-label') || 'control width').toBeGreaterThanOrEqual(44);
    expect(box?.height, await control.getAttribute('aria-label') || 'control height').toBeGreaterThanOrEqual(44);
  }
});

test('Delete requests guarded removal instead of immediately deleting an LED strip', async ({ page }) => {
  await gotoWire(page);
  const rows = page.getByTestId('wiring-run-row');
  const row = rows.first();
  await row.focus();
  await page.keyboard.press('Delete');
  await expect(rows).toHaveCount(2);
  await expect(row.getByRole('button', { name: 'Confirm remove Outer circle' })).toBeVisible();
});

test('legacy wire-count review opens only the actual current commissioning step', async ({ page }) => {
  await gotoWire(page, { expandDataWires: false });
  const project = await saveProject(page);
  project.layout.patchBoard.dataWireCountNeedsReview = true;
  await page.addInitScript(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(project));
  await page.reload({ waitUntil: 'domcontentloaded' });
  const steps = page.getByTestId('commissioning-step');
  await expect(steps.nth(0)).toHaveAttribute('data-step-state', 'current');
  expect(await steps.locator('.lw-step-toggle').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-expanded')))).toEqual(['true', 'false', 'false', 'false', 'false']);
});

test('closing wire discovery stops the persistent card test before hiding it', async ({ page }) => {
  await installStableCardIdentity(page);
  const discoveryBodies: any[] = [];
  await page.route('**/api/wiring/discover', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    discoveryBodies.push(body);
    await route.fulfill({ json: body.stop
      ? { ok: true, state: 'known-good', assignments: [], requiresReboot: true }
      : { ok: true, state: 'rebooting-for-discovery', batch: 0, assignments: [{ pin: 16, color: '#ff0000', label: 'Red' }] } });
  });
  await gotoWire(page);

  await page.getByRole('button', { name: 'Find my LED wire' }).click();
  await expect(page.getByRole('region', { name: 'Find my LED wire' }).getByRole('button', { name: /Red/ })).toBeVisible();
  await page.getByRole('button', { name: 'Close wire finder' }).click();

  await expect.poll(() => discoveryBodies.some(body => body.stop === true)).toBe(true);
  await expect(page.getByRole('region', { name: 'Find my LED wire' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Find my LED wire' }).click();
  await expect.poll(() => discoveryBodies.filter(body => body.stop !== true).length).toBe(2);
  await page.evaluate(() => { window.location.hash = '#screen=patterns'; });
  await expect.poll(() => discoveryBodies.filter(body => body.stop === true).length).toBe(2);
});

test('optional Auto Wire precedes the physical check and installation', async ({ page }) => {
  await gotoWire(page);
  const bench = page.getByTestId('wiring-bench-test');
  const autoWire = page.getByRole('region', { name: 'Optional Auto Wire' });
  const installStep = page.getByRole('region', { name: 'Step 5: Review and install' });

  await expect(autoWire).toContainText('Optional');
  await expect(autoWire).toContainText('Uses your 1 data wire');
  await expect(autoWire.getByRole('combobox', { name: 'Auto Wire output count' })).toHaveCount(0);
  await expect(autoWire.getByText('Use a proposed strip order before checking the real LEDs. Applying a route later clears the physical check.', { exact: true })).toHaveCount(1);
  await expect(autoWire.getByRole('button', { name: 'Place card' })).toBeVisible();
  await expect(autoWire.getByRole('button', { name: 'Preview route' })).toHaveCount(0);
  await autoWire.getByRole('button', { name: 'Place card' }).click();
  await expect(autoWire.getByRole('button', { name: 'Preview route' })).toBeVisible();
  expect(await autoWire.evaluate((autoElement, benchElement) => Boolean(
    autoElement.compareDocumentPosition(benchElement as Node) & Node.DOCUMENT_POSITION_FOLLOWING
  ), await bench.elementHandle())).toBe(true);
  expect(await autoWire.evaluate((autoElement, installElement) => Boolean(
    autoElement.compareDocumentPosition(installElement as Node) & Node.DOCUMENT_POSITION_FOLLOWING
  ), await installStep.elementHandle())).toBe(true);
});

test('LED color order check lives beside the physical check and sends real card tests', async ({ page }) => {
  await installStableCardIdentity(page);
  const controlRequests: Record<string, unknown>[] = [];
  const testRequests: Record<string, unknown>[] = [];
  await page.route('**/api/control', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    controlRequests.push(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, colorOrder: body.colorOrder || 'RGB' }) });
  });
  await page.route('**/api/recover-lights', async route => {
    testRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ json: {
      ok: true,
      accepted: true,
      diagnostics: { frameSubmitted: true, nonBlackPixels: 1, brightnessByte: 255 },
    } });
  });
  await gotoWire(page);

  const check = page.getByRole('region', { name: 'LED color order' });
  const bench = page.getByTestId('wiring-bench-test');
  const autoWire = page.getByRole('region', { name: 'Optional Auto Wire' });
  await expect(check.getByTestId('strip-color-order')).toHaveText('RGB');
  await expect(check.getByText('If the test color is wrong, try the next order.', { exact: true })).toHaveCount(0);
  expect(await bench.evaluate((benchElement, checkElement) => Boolean(
    benchElement.compareDocumentPosition(checkElement as Node) & Node.DOCUMENT_POSITION_FOLLOWING
  ), await check.elementHandle())).toBe(true);
  expect(await autoWire.evaluate((autoElement, benchElement) => Boolean(
    autoElement.compareDocumentPosition(benchElement as Node) & Node.DOCUMENT_POSITION_FOLLOWING
  ), await bench.elementHandle())).toBe(true);

  await check.getByRole('button', { name: 'Check colors' }).click();
  await expect(check.getByText('If the test color is wrong, try the next order.', { exact: true })).toBeVisible();
  await expect.poll(() => testRequests.some(request => request.patternId === 'test-red')).toBe(true);
  await check.getByRole('button', { name: 'Green' }).click();
  await expect.poll(() => testRequests.some(request => request.patternId === 'test-green')).toBe(true);
  await check.getByRole('button', { name: 'Try next order' }).click();
  await expect(check.getByTestId('strip-color-order')).toHaveText('GRB');
  await expect.poll(() => controlRequests.some(request => request.colorOrder === 'GRB')).toBe(true);
  await expect.poll(() => testRequests.filter(request => request.patternId === 'test-green').length).toBeGreaterThan(1);
  expect((await saveProject(page)).devices.standaloneController.led.colorOrder).toBe('GRB');
});

test('color confirmation persists, unlocks install with verified wiring, and expires when the order changes', async ({ page }) => {
  await installStableCardIdentity(page);
  await page.route('**/api/control', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ json: { ok: true, colorOrder: body.colorOrder || 'RGB' } });
  });
  await page.route('**/api/recover-lights', route => route.fulfill({ json: {
    ok: true,
    accepted: true,
    diagnostics: { frameSubmitted: true, nonBlackPixels: 1, brightnessByte: 255 },
  } }));
  await gotoWire(page);

  const verifiedProject = await saveProject(page);
  verifiedProject.layout.wiring.verified = true;
  verifiedProject.layout.wiring.locked = false;
  verifiedProject.layout.wiring.runs.forEach((run: any) => { run.verified = true; });
  await page.evaluate(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(verifiedProject));
  await page.reload({ waitUntil: 'domcontentloaded' });

  const steps = page.getByTestId('commissioning-step');
  await expect(steps.nth(3)).toHaveAttribute('data-step-state', 'current');
  await expect(steps.nth(4)).toHaveAttribute('data-step-state', 'blocked');
  const check = page.getByRole('region', { name: 'LED color order' });
  await check.getByRole('button', { name: 'Check colors' }).click();
  await expect(check.getByRole('button', { name: 'Colors look correct' })).toBeEnabled();
  await check.getByRole('button', { name: 'Colors look correct' }).click();
  await expect(steps.nth(3)).toHaveAttribute('data-step-state', 'complete');
  await expect(steps.nth(3)).toContainText('Wiring and RGB color order verified');
  await expect(steps.nth(4)).toHaveAttribute('data-step-state', 'current');
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toBeEnabled();

  const confirmedProject = await saveProject(page);
  expect(confirmedProject.devices.standaloneController.led).toMatchObject({
    colorOrder: 'RGB',
    colorOrderConfirmed: true,
    confirmedColorOrder: 'RGB',
  });
  await page.evaluate(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(confirmedProject));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('commissioning-step').nth(3)).toHaveAttribute('data-step-state', 'complete');
  await expect(page.getByTestId('commissioning-step').nth(4)).toHaveAttribute('data-step-state', 'current');

  await openCommissioningStep(
    page,
    'Step 4: Check the real LEDs',
    'Open physical LED check',
    step => step.getByRole('region', { name: 'LED color order' }),
  );
  const persistedCheck = page.getByRole('region', { name: 'LED color order' });
  await persistedCheck.getByRole('button', { name: 'Check colors' }).click();
  await persistedCheck.getByRole('button', { name: 'Try next order' }).click();
  await expect(persistedCheck.getByTestId('strip-color-order')).toHaveText('GRB');
  await expect(page.getByTestId('commissioning-step').nth(3)).toHaveAttribute('data-step-state', 'current');
  await expect(page.getByTestId('commissioning-step').nth(4)).toHaveAttribute('data-step-state', 'blocked');
  const invalidatedProject = await saveProject(page);
  expect(invalidatedProject.devices.standaloneController.led.colorOrderConfirmed).toBe(false);
  expect(invalidatedProject.devices.standaloneController.led.confirmedColorOrder).toBe('');
});

test('color confirmation requires a successful live test for the current order', async ({ page }) => {
  await installStableCardIdentity(page);
  let cardReachable = false;
  await page.route('**/api/recover-lights', route => cardReachable
    ? route.fulfill({ json: {
        ok: true,
        accepted: true,
        diagnostics: { frameSubmitted: true, nonBlackPixels: 1, brightnessByte: 255 },
      } })
    : route.fulfill({ status: 503, json: { error: 'Card unreachable' } }));
  await gotoWire(page);

  const check = page.getByRole('region', { name: 'LED color order' });
  await check.getByRole('button', { name: 'Check colors' }).click();
  const confirm = check.getByRole('button', { name: 'Colors look correct' });
  await expect(check.getByRole('button', { name: 'Check colors' })).toBeEnabled();
  await expect(confirm).toBeDisabled();
  expect((await saveProject(page)).devices.standaloneController.led.colorOrderConfirmed).not.toBe(true);

  cardReachable = true;
  await check.getByRole('button', { name: 'Check colors' }).click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  expect((await saveProject(page)).devices.standaloneController.led).toMatchObject({
    colorOrderConfirmed: true,
    confirmedColorOrder: 'RGB',
  });
});

test('expanded commissioning step toggle names its visible Collapse action', async ({ page }) => {
  await gotoWire(page, { expandDataWires: false });
  const physicalStep = page.getByRole('region', { name: 'Step 4: Check the real LEDs' });
  const expandedToggle = physicalStep.getByRole('button', { name: 'Collapse Check the real LEDs' });
  await expect(expandedToggle).toHaveText('Collapse');
  await expect(expandedToggle).toHaveAttribute('aria-expanded', 'true');
  await expandedToggle.click();
  await expect(physicalStep.getByRole('button', { name: 'Open physical LED check' })).toHaveAttribute('aria-expanded', 'false');
});

test('every visible narrow commissioning form control keeps a 44px touch target', async ({ page }) => {
  await installFrameCard(page);
  await page.route('**/api/wiring/discover', route => route.fulfill({ json: {
    ok: true,
    assignments: [{ pin: 16, color: '#ff0000', label: 'Red' }],
  } }));
  await page.setViewportSize({ width: 1280, height: 820 });
  await gotoWire(page);
  const panel = page.getByTestId('layout-wire-panel');
  await panel.evaluate(element => { (element as HTMLElement).style.width = '300px'; });

  await panel.getByRole('group', { name: 'LED data wire count' }).getByRole('button', { name: '2', exact: true }).click();
  await panel.getByRole('button', { name: 'Find my LED wire' }).click();
  await expect(panel.getByRole('region', { name: 'Find my LED wire' }).getByRole('combobox')).toBeVisible();
  await panel.getByTestId('wiring-run-row').first().locator('.lw-wiring-run-name').click();
  await openAdvanced(page);
  await expect(panel.getByRole('spinbutton', { name: 'Start LED' })).toBeVisible();

  const autoWire = panel.getByRole('region', { name: 'Optional Auto Wire' });
  await autoWire.getByRole('button', { name: 'Place card' }).click();
  await autoWire.getByRole('button', { name: 'Preview route' }).click();
  await expect(panel.getByTestId('auto-wire-preview')).toBeVisible();
  const colorCheck = panel.getByRole('region', { name: 'LED color order' });
  await colorCheck.getByRole('button', { name: 'Check colors' }).click();
  const bench = panel.getByTestId('wiring-bench-test');
  await bench.getByRole('checkbox').check();
  await bench.getByRole('button', { name: 'Start physical LED check' }).click();
  await expect(bench).toContainText('Live');

  const controls = panel.locator('button:visible, input:visible, select:visible, textarea:visible, summary:visible');
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    const name = await control.getAttribute('aria-label') || await control.textContent() || await control.getAttribute('name') || control.toString();
    expect(box?.width, `${name.trim()} width`).toBeGreaterThanOrEqual(44);
    expect(box?.height, `${name.trim()} height`).toBeGreaterThanOrEqual(44);
  }
});

test('output GPIO and board controls reject conflicts while Expert mapping stays behind Advanced', async ({ page }) => {
  await gotoWire(page);
  await page.getByRole('group', { name: 'LED data wire count' }).getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced wiring settings' }).click();
  const gpioA = page.getByLabel('Output A GPIO');
  const gpioB = page.getByLabel('Output B GPIO');
  await expect(gpioB).toHaveValue('17');
  await expect(gpioB.locator('option[value="16"]')).toBeDisabled();
  await gpioA.selectOption('38');
  await expect(gpioA).toHaveValue('38');
  await expect(page.getByText('Board pins')).toBeVisible();
  await expect(page.getByText('Expert mapping')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add skipped pixels' })).toBeVisible();
  const encoderA = page.getByLabel('Encoder A pin');
  await expect(encoderA.locator('option[value="38"]')).toHaveAttribute('disabled', '');
  await encoderA.selectOption('10');
  await expect(encoderA).toHaveValue('10');
});

test('entire output lanes drag with their GPIO, support keyboard reorder, and only empty lanes remove', async ({ page }) => {
  await gotoWire(page);
  await page.getByRole('group', { name: 'LED data wire count' }).getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced wiring settings' }).click();
  const lanes = page.getByTestId('wiring-output-lane');
  await expect(lanes.nth(0).getByRole('button', { name: /Remove Output/ })).toBeDisabled();
  const handle = lanes.nth(0).getByRole('button', { name: 'Drag Output A' });
  const target = lanes.nth(1);
  await handle.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  if (!to) throw new Error('output lanes unavailable');
  await handle.dragTo(target, { targetPosition: { x: 20, y: Math.max(1, to.height - 2) } });
  await expect(lanes.nth(1)).toHaveAttribute('data-output-id', 'out1');
  await expect(lanes.nth(1).getByLabel('Output B GPIO')).toHaveValue('16');
  await lanes.nth(1).getByRole('button', { name: 'Drag Output B' }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(lanes.nth(0)).toHaveAttribute('data-output-id', 'out1');
  await page.getByRole('group', { name: 'LED data wire count' }).getByRole('button', { name: '1', exact: true }).click();
  await expect(lanes).toHaveCount(1);
});

test('changing logical sections never changes the explicit physical data-wire count', async ({ page }) => {
  await gotoWire(page);
  const outputs = page.getByTestId('wiring-output-lane');
  await expect(outputs).toHaveCount(1);
  const firstRun = page.getByTestId('wiring-run-row').first();
  await firstRun.getByRole('button', { name: 'Remove one pixel from Outer circle' }).click();
  await expect(outputs).toHaveCount(1);
  await firstRun.getByRole('button', { name: 'Flip' }).click();
  await expect(outputs).toHaveCount(1);
  await page.getByRole('group', { name: 'LED data wire count' }).getByRole('button', { name: '2', exact: true }).click();
  await expect(outputs).toHaveCount(2);
  await firstRun.getByRole('button', { name: 'Add one pixel to Outer circle' }).click();
  await expect(outputs).toHaveCount(2);
});

test('Find my LED wire maps a visible discovery color to the selected GPIO', async ({ page }) => {
  await installStableCardIdentity(page);
  await page.route('**/api/wiring/discover', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, assignments: [
      { pin: 16, color: '#e35b4f', label: 'Red' },
      { pin: 17, color: '#4e78d6', label: 'Blue' },
    ] }),
  }));
  await gotoWire(page);
  await page.getByRole('button', { name: 'Find my LED wire' }).click();
  const finder = page.getByRole('region', { name: 'Find my LED wire' });
  await expect(finder.getByText('Choose the color you see on the real LEDs.')).toBeVisible();
  await finder.getByRole('button', { name: /Blue GPIO 17/ }).click();
  await expect(page.getByText('GPIO 17', { exact: true })).toBeVisible();
  await expect(finder).toContainText('uses GPIO 17');
});

test('Wire panel and Auto Wire never scroll horizontally at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoWire(page);
  const panel = page.getByTestId('layout-wire-panel');
  await expect(panel).toBeAttached();
  const autoWire = panel.locator('.lw-auto-wire-controls');
  const colorOrder = panel.getByRole('region', { name: 'LED color order' });
  await expect(autoWire.getByRole('button', { name: 'Place card' })).toBeEnabled();
  await autoWire.getByRole('button', { name: 'Place card' }).click();
  await autoWire.getByRole('button', { name: 'Preview route' }).click();
  const preview = page.getByTestId('auto-wire-preview');
  const actions = preview.locator('.lw-auto-wire-actions');
  await expect(actions.getByRole('button', { name: 'Apply route' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Close' })).toBeVisible();
  const labels = await actions.getByRole('button').allTextContents();
  expect(labels.at(-1)).toBe('Apply route');
  const overflows = [
    { selector: 'Wire panel', ...(await panel.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'Auto Wire', ...(await autoWire.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'Auto Wire preview', ...(await preview.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'Auto Wire actions', ...(await actions.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'LED color order', ...(await colorOrder.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
  ];
  for (const item of overflows) expect(item.scrollWidth, item.selector).toBeLessThanOrEqual(item.clientWidth);
});

test('inline strip count controls resize the real project without selecting the row', async ({ page }) => {
  await gotoWire(page);
  await openInstallReview(page);
  const row = page.getByTestId('wiring-run-row').first();
  await expect(row).toHaveAttribute('aria-selected', 'false');
  await row.getByRole('button', { name: 'Remove one pixel from Outer circle' }).click();
  await expect(row.getByTestId('inline-run-count')).toHaveText('26');
  await expect(page.getByTestId('wiring-total-pixels')).toContainText('43');
  await expect(row).toHaveAttribute('aria-selected', 'false');
  await row.getByRole('button', { name: 'Add one pixel to Outer circle' }).click();
  await expect(row.getByTestId('inline-run-count')).toHaveText('27');
  await expect(page.getByTestId('wiring-total-pixels')).toContainText('44');
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
  await rows.nth(1).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByTestId('wiring-run-row').first()).toHaveAttribute('data-run-id', secondName!);
  await expect(page.getByRole('button', { name: 'Move earlier' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move later' })).toHaveCount(0);
  const physicalRows = page.getByTestId('wiring-run-row').filter({ has: page.getByRole('button', { name: 'Flip' }) });
  await physicalRows.nth(0).getByRole('button', { name: /OUT port/ }).click();
  await expect(physicalRows.nth(0).getByRole('button', { name: /OUT port/ })).toHaveAttribute('aria-pressed', 'true');
  await physicalRows.nth(1).getByRole('button', { name: /IN port/ }).click();
  await expect(page.getByTestId('wiring-run-row').getByText('Cable jump')).toBeVisible();
});

test('unverified wiring cannot lock or send and deterministic reserved runs consume addresses', async ({ page }) => {
  await gotoWire(page);
  await openInstallReview(page);
  await expect(page.getByTestId('layout-send-to-card')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toHaveCount(0);
  await openAdvanced(page);
  await page.getByRole('button', { name: 'Add skipped pixels' }).click();
  await page.getByRole('button', { name: 'Add skipped pixels' }).click();
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
  await page.getByRole('region', { name: 'Step 1: Choose data wires' }).getByRole('button', { name: 'Edit data wire count' }).click();
  await page.getByRole('group', { name: 'LED data wire count' }).getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('region', { name: 'Step 2: Map LED outputs' }).getByRole('button', { name: 'Edit LED output mapping' }).click();
  const run = page.getByTestId('wiring-run-row').first();
  const runId = await run.getAttribute('data-run-id');
  const handle = run.getByRole('button', { name: /Drag/ });
  const laneB = page.getByTestId('wiring-output-lane').nth(1).getByRole('heading', { name: 'Output B' });
  await handle.scrollIntoViewIfNeeded();
  await handle.dragTo(laneB);
  await expect(page.getByTestId('wiring-output-lane').nth(1)).not.toHaveCSS('background-color', 'rgb(77, 45, 25)');
  await expect(page.getByTestId('wiring-output-lane').nth(1).getByTestId('wiring-run-row')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__captures)).toBeGreaterThan(0);
  const project = await saveProject(page);
  const refs = project.layout.wiring.outputs.flatMap((output: any) => output.runIds);
  expect(refs.filter((id: string) => id === runId)).toHaveLength(1);
  expect(project.layout.wiring.outputs[1].runIds).toContain(runId);
  await expect(page.getByTestId('wiring-output-lane').nth(1).getByTestId('wiring-run-row')).toHaveAttribute('aria-selected', 'false');
});

test('bench boundary controls redistribute a fixed physical total and show the blue-to-red legend', async ({ page }) => {
  await installFrameCard(page);
  await gotoWire(page);
  await openInstallReview(page);
  const bench = page.getByTestId('wiring-bench-test');
  await bench.getByRole('checkbox').check();
  await bench.getByRole('button', { name: 'Start wiring test' }).click();
  await expect(bench.getByLabel('Pixel marker legend').getByText('Blue')).toBeVisible();
  await expect(bench.getByLabel('Pixel marker legend').getByText('Red')).toBeVisible();
  await expect(bench.getByTestId('active-output-count')).toHaveText('44 pixels');
  const frameCountBeforeOutputChange = await page.evaluate(() => (window as any).__wiringFrames.length);
  await bench.getByRole('button', { name: /Remove one pixel from Output/ }).click();
  await expect(bench.getByTestId('active-output-count')).toHaveText('43 pixels');
  await expect(page.getByTestId('wiring-total-pixels')).toContainText('43');
  await expect.poll(() => page.evaluate(() => (window as any).__wiringFrames.length)).toBeGreaterThan(frameCountBeforeOutputChange);
  await expect.poll(() => page.evaluate(() => {
    const frame = (window as any).__wiringFrames.at(-1);
    return `${frame?.[42]}:${frame?.[43]}`;
  })).toBe('1A0000:000000');
  const shortenedFrame = await page.evaluate(() => (window as any).__wiringFrames.at(-1));
  expect(shortenedFrame[0]).toBe('00001A');
  expect(shortenedFrame[42]).toBe('1A0000');
  expect(shortenedFrame[43]).toBe('000000');
  await bench.getByRole('button', { name: /Add one pixel to Output/ }).click();
  await expect(bench.getByTestId('active-output-count')).toHaveText('44 pixels');
  await expect(page.getByTestId('wiring-total-pixels')).toContainText('44');
  await bench.getByRole('button', { name: /I see Output/ }).click();
  await expect(bench.getByRole('button', { name: 'Add one pixel to Outer circle' })).toBeVisible();
  await expect(bench.getByTestId('active-run-count')).toHaveText('27 pixels');
  await expect(page.getByTestId('wiring-run-row').nth(0).getByTestId('inline-run-count')).toHaveText('27');
  await expect(page.getByTestId('wiring-run-row').nth(1).getByTestId('inline-run-count')).toHaveText('17');
  await expect(page.getByTestId('wiring-total-pixels')).toContainText('44');
});

test('leaving Wire stops the active physical test and its hidden frame loop', async ({ page }) => {
  const controls = await installFrameCard(page);
  await gotoWire(page);
  const bench = page.getByTestId('wiring-bench-test');
  await bench.getByRole('checkbox').check();
  await bench.getByRole('button', { name: 'Start wiring test' }).click();
  await expect(bench).toContainText('Live');
  await expect.poll(() => page.evaluate(() => (window as any).__wiringFrames.length)).toBeGreaterThan(0);

  await page.getByTestId('layout-mode-draw').click();
  await expect(page.getByTestId('wiring-bench-test')).toHaveCount(0);
  await expect.poll(() => controls.filter(body => body.cancelStream === true).length).toBe(1);
  const framesAfterUnmount = await page.evaluate(() => (window as any).__wiringFrames.length);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as any).__wiringFrames.length)).toBe(framesAfterUnmount);
  expect(controls.filter(body => body.cancelStream === true)).toHaveLength(1);
});

test('pointer cord drag from run DATA OUT to DATA IN creates one zero-address cable jump', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await gotoWire(page);
  await openInstallReview(page);
  const physicalRows = page.getByTestId('wiring-run-row').filter({ has: page.getByRole('button', { name: 'Flip' }) });
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
  await openAdvanced(page);
  await page.getByTestId('wiring-run-row').first().locator('.lw-wiring-run-name').click();
  await page.getByLabel('Direction').selectOption('fixed');
  await expect(page.getByTestId('wiring-run-row').first().getByRole('button', { name: 'Flip' })).toBeDisabled();
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
  await page.getByRole('button', { name: 'Place card' }).click();

  const anchor = page.getByTestId('controller-anchor');
  await expect(anchor).toBeVisible();
  await anchor.hover();
  const box = await anchor.boundingBox();
  if (!box) throw new Error('controller anchor unavailable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 30, { steps: 4 });
  await page.mouse.up();

  await expect(page.getByRole('region', { name: 'Optional Auto Wire' })).toContainText('Uses your 1 data wire');
  await page.getByTestId('wiring-run-row').first().locator('.lw-wiring-run-name').click();
  await openAdvanced(page);
  await expect(page.getByLabel('Direction policy')).toHaveValue('flexible');
  await expect(page.getByLabel('Physical DATA IN')).toHaveValue('source-forward');

  const before = (await saveProject(page)).layout.wiring;
  await page.getByRole('button', { name: 'Preview route' }).click();
  const preview = page.getByTestId('auto-wire-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(/Output A|Output B/);
  await expect(preview).toContainText('Outer circle');
  await expect(preview).toContainText('Inner circle');
  await expect(preview).not.toContainText(/run-/);
  await expect(preview.getByRole('button', { name: 'Route details' })).toHaveAttribute('aria-expanded', 'false');
  await expect(preview.getByText(/Cable length/i)).toHaveCount(0);
  await expect(preview.getByRole('button', { name: 'Apply route' })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Accept routing' })).toHaveCount(0);
  await preview.getByRole('button', { name: 'Route details' }).click();
  await expect(preview.getByText(/Cable length/i)).toBeVisible();
  await expect(preview.getByText(/Direction changes/i)).toBeVisible();
  await expect(preview.getByText(/Connector changes/i)).toBeVisible();
  const whilePreviewing = (await saveProject(page)).layout.wiring;
  expect(whilePreviewing).toEqual(before);

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(preview).toHaveCount(0);
  const afterCancel = (await saveProject(page)).layout.wiring;
  expect(afterCancel).toEqual(before);
});

test('Auto Wire acceptance applies the displayed proposal while fixed or verified seams refuse movement', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoWire(page);
  await page.getByRole('button', { name: 'Place card' }).click();
  const anchor = page.getByTestId('controller-anchor');
  await anchor.hover();
  const box = await anchor.boundingBox();
  if (!box) throw new Error('controller anchor unavailable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up();

  await page.getByRole('button', { name: 'Preview route' }).click();
  const preview = page.getByTestId('auto-wire-preview');
  const displayedLane = await preview.getByTestId('auto-wire-lane').first().getAttribute('data-run-order');
  await page.getByRole('button', { name: 'Apply route' }).click();
  await expect(preview).toHaveCount(0);
  const accepted = (await saveProject(page)).layout.wiring;
  expect(accepted.outputs[0].runIds.join(',')).toBe(displayedLane);

  await page.getByTestId('wiring-run-row').first().locator('.lw-wiring-run-name').click();
  await openAdvanced(page);
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
  const outputCount = page.getByRole('group', { name: 'LED data wire count' });

  for (const count of ['1', '2', '3', '4']) {
    await outputCount.getByRole('button', { name: count, exact: true }).click();
    await page.getByRole('button', { name: 'Preview route' }).click();
    const preview = page.getByTestId('auto-wire-preview');
    await expect(preview.getByTestId('auto-wire-lane')).toHaveCount(Number(count));
    await preview.getByRole('button', { name: 'Route details' }).click();
    await expect(preview).toContainText(/relative units|mm/);
    await expect(preview).toContainText(/Direction changes/i);
    await expect(preview).toContainText(/Connector changes/i);
    await expect(preview).toContainText(/Estimate notes/i);
    await page.getByRole('button', { name: 'Close' }).click();
  }

  await outputCount.getByRole('button', { name: '1', exact: true }).click();
  await page.getByRole('button', { name: 'Preview route' }).click();
  await expect(page.getByTestId('auto-wire-preview').getByTestId('auto-wire-lane')).toHaveCount(1);
  const alternative = page.getByRole('button', { name: 'Try another' });
  await expect(alternative).toBeVisible();
  await expect(page.getByTestId('auto-wire-preview')).toHaveAttribute('data-proposal-index', '0');
  await alternative.click();
  await expect(page.getByTestId('auto-wire-preview')).toHaveAttribute('data-proposal-index', '1');
});

test('closed-path seam and physical DATA IN are editable independently until fixed, then refuse movement', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoWire(page);
  await seedFourRunClosedFixture(page);
  const row = page.getByTestId('wiring-run-row').first();
  await row.locator('.lw-wiring-run-name').click();
  await openAdvanced(page);
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
  const stripRows = page.getByTestId('wiring-run-row').filter({ has: page.getByRole('button', { name: 'Flip' }) });
  await stripRows.nth(0).getByRole('button', { name: /OUT port/ }).click();
  await stripRows.nth(1).getByRole('button', { name: /IN port/ }).click();
  await openAdvanced(page);
  await page.getByRole('button', { name: 'Add skipped pixels' }).click();
  const bench = page.getByTestId('wiring-bench-test');
  await bench.getByRole('checkbox').check();
  await bench.getByRole('button', { name: 'Start wiring test' }).click();

  await expect(bench).toContainText('Live');
  await bench.getByRole('button', { name: /I see Output/ }).click();
  for (let run = 0; run < 2; run += 1) {
    await expect(bench).toContainText('Live');
    if (run === 0) {
      await expect.poll(() => page.evaluate(() => {
        const frame = (window as any).__wiringFrames.at(-1);
        return `${frame?.[0]}:${frame?.[26]}`;
      })).toBe('00001A:1A0000');
      const beforeCorrectionFrames = await page.evaluate(() => (window as any).__wiringFrames.length);
      await bench.getByRole('button', { name: 'Flip mapping' }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__wiringFrames.length)).toBeGreaterThan(beforeCorrectionFrames);
      await expect.poll(() => page.evaluate(() => {
        const frame = (window as any).__wiringFrames.at(-1);
        return `${frame?.[0]}:${frame?.[26]}`;
      })).toBe('00001A:1A0000');
      await expect(bench).toContainText('Live');
    }
    await bench.getByRole('button', { name: 'Boundary is correct' }).click();
    if (run === 0) {
      await expect(bench).toContainText('Cable jump');
      await expect(bench).toContainText('Live');
      await bench.getByRole('button', { name: 'Cable is connected' }).click();
    }
  }
  await expect(bench).toContainText('Reserved · unlit');
  await expect(bench).toContainText('Live');
  await bench.getByRole('button', { name: 'Reserved LEDs stay unlit' }).click();
  await expect(bench.getByRole('button', { name: 'Finish' })).toBeEnabled();
  await bench.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('region', { name: 'Step 4: Check the real LEDs' }).getByRole('button', { name: 'Collapse Check the real LEDs' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('region', { name: 'Step 5: Review and install' })).toHaveAttribute('data-step-state', 'blocked');
  const colorCheck = page.getByRole('region', { name: 'LED color order' });
  await colorCheck.getByRole('button', { name: 'Check colors' }).click();
  await colorCheck.getByRole('button', { name: 'Colors look correct' }).click();
  await expect(page.getByRole('region', { name: 'Step 4: Check the real LEDs' }).getByRole('button', { name: 'Open physical LED check' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('region', { name: 'Step 5: Review and install' }).getByRole('button', { name: 'Collapse Review and install' })).toHaveAttribute('aria-expanded', 'true');
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
  await expect(bench).toContainText(/Now checkingOutput/);
  await expect(bench).toContainText('Offline');
  await expect(bench.getByRole('button', { name: /I see Output/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toHaveCount(0);
  expect(controls.some(body => body.cancelStream === true)).toBe(true);

  await page.evaluate(() => { (window as any).__wiringFail = false; });
  await bench.getByRole('button', { name: 'Retry' }).click();
  await expect(bench).toContainText('Live');
  await expect(bench).toContainText(/Now checkingOutput/);
  await expect(bench.getByRole('button', { name: /I see Output/ })).toBeEnabled();
});
