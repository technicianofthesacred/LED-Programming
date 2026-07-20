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

// ── Single-flow helpers ──────────────────────────────────────────────────────
// Test & Install is one page with a Wire-derived plan summary and one next
// action (LED check → color quiz → install). Specialist tools stay behind
// one closed disclosure; verification auto-locks without a manual lock step.
const planMeta = (page: any) => page.locator('.lww-plan-head .meta');

async function startLedCheck(page: any) {
  await page.getByTestId('start-led-check').click();
  await expect(page.getByTestId('wiring-bench-test')).toBeVisible();
}

async function gotoWire(page: any) {
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => { await document.fonts?.ready; });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  await expect(page.getByTestId('commissioning-step')).toBeVisible();
}

// The lane/port editors, board pins, and expert mapping all live behind the
// single top-level Advanced wiring disclosure (its inner details cards start
// open).
async function openAdvanced(page: any) {
  const details = page.getByTestId('advanced-installation-tools');
  if (!await details.evaluate((element: HTMLDetailsElement) => element.open)) {
    await details.locator('summary').first().click();
  }
}

async function openCustomMapping(page: any) {
  await openAdvanced(page);
  const details = page.locator('.lww-custom-mapping');
  if (!await details.evaluate((element: HTMLDetailsElement) => element.open)) {
    await details.locator('summary').click();
  }
}

async function saveProject(page: any) {
  await page.waitForTimeout(600);
  const pending = page.waitForEvent('download');
  await page.locator('.la .toolbar').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await pending;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-wire-save-')), 'project.json');
  await download.saveAs(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Seeds the current project back with bench-verified (but color-unconfirmed)
// wiring, so the check flow resumes at the color question. Color stays
// unconfirmed on purpose: a fully verified project would auto-lock on load.
async function seedBenchVerified(page: any) {
  const project = await saveProject(page);
  project.layout.starterPending = false;
  project.layout.wiring.verified = true;
  project.layout.wiring.locked = false;
  project.layout.wiring.runs.forEach((run: any) => { run.verified = true; });
  await page.evaluate(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(project));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  return project;
}

// Seeds the two default circles through the legacy-autosave path so the Draw
// strip list renders immediately (the built-in default keeps the starter
// picker up until the first physical edit). Wiring is bootstrapped by the
// loader: one output on GPIO 16 with run-<stripId> runs.
async function seedDefaultCircles(page: any, { needsReview = false, mode = 'draw' } = {}) {
  await page.goto(`/#screen=layout&mode=${mode}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((flag: boolean) => {
    const circle = (id: string, name: string, radius: number, pixelCount: number) => ({
      id,
      name,
      pathData: `M ${320 - radius} 200 A ${radius} ${radius} 0 1 0 ${320 + radius} 200 A ${radius} ${radius} 0 1 0 ${320 - radius} 200 Z`,
      closed: true,
      pixelCount,
      generatedLayout: 'default-circle-v1',
      x: 0, y: 0, emit: 'omni', angle: 0, reversed: false,
      speed: 1, brightness: 1, hueShift: 0, patternId: null,
    });
    localStorage.clear();
    localStorage.setItem('lw_autosave_v3', JSON.stringify({
      version: 3,
      id: 'seeded-circles',
      name: 'Seeded circle project',
      layout: {
        strips: [
          circle('default-outer-circle', 'Outer circle', 144, 27),
          circle('default-inner-circle', 'Inner circle', 64, 17),
        ],
        viewBox: '0 0 640 400',
        svgText: null,
        layers: [],
        density: 60,
        pxPerMm: 3.7795,
        // A patch board without an explicit dataWireCount is the legacy shape
        // that flags dataWireCountNeedsReview on load.
        patchBoard: flag ? { physicalLocked: false, chains: [{ id: 'main', name: 'Main', rowIds: [] }], patches: [], groups: [] } : null,
        wiring: null,
      },
    }));
  }, needsReview);
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (mode === 'draw') await expect(page.locator('.la-strip-row')).toHaveCount(2);
  else await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
}

async function switchMode(page: any, mode: 'draw' | 'wire') {
  await page.getByTestId(`layout-mode-${mode}`).click();
  if (mode === 'wire') await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  else await expect(page.getByTestId('layout-wire-panel')).toHaveCount(0);
}

// Expand a Draw strip row's detail (click toggles selection + expansion).
// Split strips list one row per run, so scope to the first matching row.
async function expandDrawStrip(page: any, name: string) {
  const strip = page.locator('[data-strip-id]').filter({ hasText: name }).first();
  if (!await strip.locator('.la-strip-detail').first().isVisible()) await strip.locator('.la-strip-row').first().click();
  await expect(strip.locator('.la-strip-detail').first()).toBeVisible();
  return strip;
}

async function seedFourRunClosedFixture(page: any) {
  const project = await saveProject(page);
  project.layout.starterPending = false;
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
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
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

test('Test & Install is a compiler-derived read-only commissioning surface', async ({ page }) => {
  await gotoWire(page);
  await expect(page.getByRole('button', { name: 'Add skipped LEDs' })).toHaveCount(0);
  const summary = page.getByTestId('test-install-plan-summary');
  await expect(summary.locator('.la-gpio-group')).toHaveCount(1);
  await expect(summary.getByText('GPIO 16')).toBeVisible();
  await expect(summary.getByTestId('test-install-strip-row')).toHaveCount(2);
  await expect(page.getByText('Compiler preflight')).toHaveCount(0);
  await expect(page.getByText('Edit LED range')).toHaveCount(0);
  await expect(summary.locator('input, select, button, [draggable="true"]')).toHaveCount(0);

  // No install surface exists before verification — the LED check is the one
  // next action.
  await expect(page.getByTestId('layout-send-to-card')).toHaveCount(0);
  await expect(page.getByTestId('start-led-check')).toBeVisible();
});

test('Test & Install shows a compact Wire summary and one next-action CTA instead of step chrome', async ({ page }) => {
  await gotoWire(page);
  await expect(planMeta(page)).toHaveText('2 strips · 44 LEDs · from Wire');
  // Deleted chrome: the step rail, stat tiles, card step titles/pills.
  await expect(page.getByRole('group', { name: 'Steps' })).toHaveCount(0);
  await expect(page.locator('.lwui-tile')).toHaveCount(0);
  await expect(page.locator('[class*="lwui-rail"]')).toHaveCount(0);
  const step = page.getByTestId('commissioning-step');
  await expect(step).toHaveCount(1);
  expect(await step.getAttribute('data-step-state')).toBeNull();
  expect(await step.getAttribute('aria-label')).toBeNull();
  // The guided check only mounts once the CTA opens it.
  await expect(page.getByTestId('wiring-bench-test')).toHaveCount(0);
  const cta = page.getByTestId('start-led-check');
  await expect(cta).toHaveText('Start LED check');
  await expect(page.getByTestId('advanced-installation-tools')).toHaveJSProperty('open', false);
  await expect(page.getByTestId('wire-power-section')).not.toBeVisible();
  // Within budget by default: no red warning line.
  await expect(page.locator('.lww-power-warning')).toHaveCount(0);

  await cta.click();
  await expect(page.getByTestId('wiring-bench-test')).toBeVisible();
  await expect(page.getByTestId('start-led-check')).toHaveCount(0);
});

test('Test & Install owns neither wire count nor ordering and keeps specialist tools closed', async ({ page }) => {
  await gotoWire(page);
  // Deleted surfaces: the wire-count picker, the wire-order list, and the
  // auto-route step all moved to Draw (count is derived from GPIO
  // assignments; ordering is Draw's GPIO-grouped strip list).
  await expect(page.getByRole('group', { name: 'How many wires leave the card?' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'LED data wire count' })).toHaveCount(0);
  await expect(page.getByTestId('wire-order')).toHaveCount(0);
  await expect(page.getByTestId('wire-order-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark card position on drawing' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Suggest shortest order' })).toHaveCount(0);

  await expect(page.getByTestId('advanced-installation-tools')).toHaveJSProperty('open', false);
  await expect(page.getByRole('button', { name: 'Split a strip mid-wire' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a cable jump' })).toHaveCount(0);
  await openAdvanced(page);
  await expect(page.locator('.lww-custom-mapping')).toHaveJSProperty('open', false);
  await openCustomMapping(page);
  await expect(page.getByRole('button', { name: 'Split a strip mid-wire' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a cable jump' })).toBeVisible();
});

test('Custom mapping inserts and removes a zero-address cable jump without changing Wire order', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'draw' });
  await page.locator('[data-strip-id="default-outer-circle"] .la-strip-row').click();
  await switchMode(page, 'wire');
  await openCustomMapping(page);

  const addJump = page.getByRole('button', { name: 'Add a cable jump' });
  await expect(addJump).toBeEnabled();
  await addJump.click();
  const jumpRow = page.getByTestId('cable-jump-row');
  await expect(jumpRow).toContainText('Outer circle → Inner circle');

  const inserted = await saveProject(page);
  const outputRunIds = inserted.layout.wiring.outputs[0].runIds;
  const runsById = new Map(inserted.layout.wiring.runs.map((run: any) => [run.id, run]));
  expect(outputRunIds.map((id: string) => (runsById.get(id) as any)?.type)).toEqual(['strip', 'cable', 'strip']);
  expect(inserted.layout.wiring.runs.map((run: any) => run.type)).toEqual(['strip', 'cable', 'strip']);
  expect(inserted.layout.wiring.runs.find((run: any) => run.type === 'cable')?.count).toBeUndefined();
  expect(outputRunIds
    .map((id: string) => runsById.get(id) as any)
    .filter((run: any) => run?.type === 'strip')
    .map((run: any) => run.source.stripId))
    .toEqual(['default-outer-circle', 'default-inner-circle']);
  await expect(planMeta(page)).toHaveText('2 strips · 44 LEDs · from Wire');

  await jumpRow.getByRole('button', { name: 'Remove cable jump' }).click();
  await expect(jumpRow).toHaveCount(0);
  const removed = await saveProject(page);
  expect(removed.layout.wiring.runs.some((run: any) => run.type === 'cable')).toBe(false);
  const removedRunsById = new Map(removed.layout.wiring.runs.map((run: any) => [run.id, run]));
  expect(removed.layout.wiring.outputs[0].runIds.map((id: string) => (removedRunsById.get(id) as any)?.source?.stripId))
    .toEqual(['default-outer-circle', 'default-inner-circle']);

  await switchMode(page, 'draw');
  await page.locator('[data-strip-id="default-inner-circle"] .la-strip-row').click();
  await switchMode(page, 'wire');
  await openCustomMapping(page);
  await expect(page.getByRole('button', { name: 'Add a cable jump' })).toBeDisabled();
});

test('Test & Install reports a missing run without repairing it; Wire owns reconciliation', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'draw' });
  const project = await saveProject(page);
  const missingRunId = project.layout.wiring.runs.find((run: any) => run.type === 'strip' && run.source.stripId === 'default-inner-circle').id;
  project.layout.wiring.runs = project.layout.wiring.runs.filter((run: any) => run.id !== missingRunId);
  project.layout.wiring.outputs.forEach((output: any) => {
    output.runIds = output.runIds.filter((runId: string) => runId !== missingRunId);
  });
  const missingWiring = structuredClone(project.layout.wiring);
  await page.addInitScript(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(project));
  await page.goto('/?fixture=missing-run#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Finish the setup in Wire' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit in Wire' })).toBeVisible();

  const unchanged = await saveProject(page);
  expect(unchanged.layout.wiring).toEqual(missingWiring);

  await page.getByRole('button', { name: 'Edit in Wire' }).click();
  await expect(page.getByTestId('layout-mode-draw')).toHaveClass(/on/);
  const repaired = await saveProject(page);
  const repairedRun = repaired.layout.wiring.runs.find((run: any) => run.type === 'strip' && run.source.stripId === 'default-inner-circle');
  expect(repairedRun).toBeTruthy();
  expect(repaired.layout.wiring.outputs[0].runIds).toContain(repairedRun.id);
});

test('physical LED check requires the visibility acknowledgement before the chase starts', async ({ page }) => {
  await installFrameCard(page);
  await gotoWire(page);
  await startLedCheck(page);
  const bench = page.getByTestId('wiring-bench-test');
  // First screen: stand where you can see the strips. No chase question, no
  // frame is sent until the user acknowledges visibility.
  await expect(bench.getByRole('heading', { name: 'Stand where you can see the LED strips' })).toBeVisible();
  await expect(bench.getByText(/LED CHECK · 1 OF \d+/)).toBeVisible();
  const start = bench.getByRole('button', { name: 'I can see the LED strips' });
  await expect(start).toBeVisible();
  await expect(bench.getByRole('button', { name: /^Yes — / })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__wiringFrames.length)).toBe(0);
  await start.click();
  await expect(bench.getByText(/LED CHECK · 2 OF \d+/)).toBeVisible();
  await expect(bench.getByRole('button', { name: /Yes — I see Wire A/ })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__wiringFrames.length)).toBeGreaterThan(0);
});

test('narrow inspector uses container-aware stacked controls without clipping', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await gotoWire(page);
  const panel = page.getByTestId('layout-wire-panel');
  await panel.evaluate(element => { (element as HTMLElement).style.width = '300px'; });
  const summary = panel.getByTestId('test-install-plan-summary');
  for (const target of [panel, panel.getByTestId('commissioning-step'), summary]) {
    const size = await target.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth);
  }
  await expect(panel.getByTestId('wiring-output-lane')).toHaveCount(0);
});

test('legacy wire-count review is confirmed in Draw and clears the Wire warning', async ({ page }) => {
  await seedDefaultCircles(page, { needsReview: true, mode: 'wire' });
  // Wire: the primary flow carries a one-line pointer to Draw.
  await expect(page.getByText('Finish the setup in Wire')).toBeVisible();
  await expect(page.getByText('This older project needs each strip’s GPIO confirmed before the physical check.')).toBeVisible();

  // Draw: the legacy banner confirms the derived GPIO assignments.
  await switchMode(page, 'draw');
  const banner = page.getByTestId('legacy-gpio-confirm');
  await expect(banner).toContainText("Older project — confirm each strip's GPIO looks right.");
  await banner.getByRole('button', { name: 'Looks right' }).click();
  await expect(banner).toHaveCount(0);

  // Back in Wire, the pointer is gone and the check is the next action.
  await switchMode(page, 'wire');
  await expect(page.getByText('Finish the setup in Wire')).toHaveCount(0);
  await expect(page.getByTestId('start-led-check')).toBeVisible();
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
  await openAdvanced(page);

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

test('the color quiz chains in as the final part of the LED check and sends real card tests', async ({ page }) => {
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
  await seedBenchVerified(page);

  // Bench done, color pending: the CTA names the remaining work instead of
  // restarting from scratch.
  const cta = page.getByTestId('start-led-check');
  await expect(cta).toHaveText('Finish the LED check');
  await cta.click();

  // The color question presents itself — no separate start button, and the
  // first test frame is already on its way to the card.
  const check = page.getByRole('region', { name: 'LED color order' });
  await expect(check.getByText('The whole strip just lit up. Tap the color you actually see.')).toBeVisible();
  await expect(check.getByRole('button', { name: 'Check colors' })).toHaveCount(0);
  await expect(page.getByTestId('wiring-bench-test')).toHaveCount(0);
  await expect(check.getByTestId('strip-color-order')).toHaveText('RGB');
  await expect.poll(() => testRequests.some(request => request.patternId === 'test-red')).toBe(true);

  await check.getByRole('button', { name: 'Send Green test' }).click();
  await expect.poll(() => testRequests.some(request => request.patternId === 'test-green')).toBe(true);
  await check.getByRole('button', { name: 'Try next order' }).click();
  await expect(check.getByTestId('strip-color-order')).toHaveText('GRB');
  await expect.poll(() => controlRequests.some(request => request.colorOrder === 'GRB')).toBe(true);
  await expect.poll(() => testRequests.filter(request => request.patternId === 'test-green').length).toBeGreaterThan(1);
  const saved = await saveProject(page);
  expect(saved.devices.standaloneController.led.colorOrder).toBe('GRB');
  // Changing the order always expires any confirmation.
  expect(saved.devices.standaloneController.led.colorOrderConfirmed).toBe(false);
  expect(saved.devices.standaloneController.led.confirmedColorOrder).toBe('');

  // The ghost escape hatch returns to the single CTA.
  await page.getByTestId('commissioning-step').getByRole('button', { name: 'Do this later' }).click();
  await expect(page.getByTestId('start-led-check')).toBeVisible();
});

test('confirming the color auto-locks verified wiring and a Draw GPIO edit reopens it', async ({ page }) => {
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
  await seedBenchVerified(page);

  await page.getByTestId('start-led-check').click();
  const check = page.getByRole('region', { name: 'LED color order' });
  await expect(check.getByText('Red test is live.')).toBeVisible();
  await check.getByRole('button', { name: 'Red', exact: true }).click();

  // Verified: no manual lock button anywhere — the wiring locks itself and
  // install becomes the one CTA.
  await expect(page.getByText('Checked ✓ — install it on the card.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toHaveCount(0);
  await expect(page.getByTestId('layout-send-to-card')).toBeEnabled();
  await openAdvanced(page);
  await expect(page.getByTestId('layout-export-ledmap')).toHaveClass(/btn-ghost/);
  const confirmedProject = await saveProject(page);
  expect(confirmedProject.layout.wiring.locked).toBe(true);
  expect(confirmedProject.layout.wiring.verified).toBe(true);
  expect(confirmedProject.devices.standaloneController.led).toMatchObject({
    colorOrder: 'RGB',
    colorOrderConfirmed: true,
    confirmedColorOrder: 'RGB',
  });

  // The checked state survives a reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  await expect(page.getByText('Checked ✓ — install it on the card.')).toBeVisible();
  await expect(page.getByTestId('layout-send-to-card')).toBeEnabled();

  // A GPIO edit in Draw is an intentional physical change: it unlocks the
  // wiring and clears the bench verification in the same step.
  await switchMode(page, 'draw');
  const inner = await expandDrawStrip(page, 'Inner circle');
  await inner.getByLabel('GPIO output').selectOption('17');
  await switchMode(page, 'wire');
  await expect(page.getByTestId('start-led-check')).toHaveText('Start LED check');
  const reopened = await saveProject(page);
  expect(reopened.layout.wiring.locked).toBe(false);
  expect(reopened.layout.wiring.verified).toBe(false);
  expect(reopened.layout.wiring.runs.every((run: any) => run.verified === false)).toBe(true);
});

test('editing the canonical Wire plan after the bench check invalidates it', async ({ page }) => {
  await gotoWire(page);
  await seedBenchVerified(page);
  await expect(page.getByTestId('start-led-check')).toHaveText('Finish the LED check');
  await switchMode(page, 'draw');
  const outer = await expandDrawStrip(page, 'Outer circle');
  await outer.getByRole('spinbutton', { name: 'Strip LED count', exact: true }).fill('26');
  await outer.getByRole('spinbutton', { name: 'Strip LED count', exact: true }).blur();
  await switchMode(page, 'wire');
  await expect(planMeta(page)).toContainText('43 LEDs');
  // The bench verification is gone, so the CTA is back to the full check.
  await expect(page.getByTestId('start-led-check')).toHaveText('Start LED check');
  const project = await saveProject(page);
  expect(project.layout.wiring.verified).toBe(false);
});

test('a loaded locked-but-unchecked project points at Unlock to edit under Advanced', async ({ page }) => {
  await gotoWire(page);
  const project = await saveProject(page);
  project.layout.wiring.locked = true; // verified stays false — loaded-state edge
  await page.evaluate(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(project));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();

  await expect(page.getByText(/locked but not fully checked/)).toBeVisible();
  await expect(page.getByTestId('start-led-check')).toHaveCount(0);
  await openAdvanced(page);
  await page.getByTestId('unlock-wiring').click();
  await expect(page.getByTestId('start-led-check')).toBeVisible();
});

test('color confirmation requires a successful live test for the current order', async ({ page }) => {
  await installStableCardIdentity(page);
  let cardReachable = false;
  let recoverAttempts = 0;
  await page.route('**/api/recover-lights', route => {
    recoverAttempts += 1;
    return cardReachable
      ? route.fulfill({ json: {
          ok: true,
          accepted: true,
          diagnostics: { frameSubmitted: true, nonBlackPixels: 1, brightnessByte: 255 },
        } })
      : route.fulfill({ status: 503, json: { error: 'Card unreachable' } });
  });
  await gotoWire(page);
  await seedBenchVerified(page);
  await page.getByTestId('start-led-check').click();

  const check = page.getByRole('region', { name: 'LED color order' });
  // The chained auto-test failed (card unreachable). Answering the matching
  // color must NOT confirm the order — it replays the test instead.
  await expect(check.locator('.lwb-quiz-status.is-err')).toBeVisible();
  const attemptsBeforeReplay = recoverAttempts;
  await check.getByRole('button', { name: 'Red', exact: true }).click();
  // Let the replayed test fully settle as a failure before restoring the
  // card — recoverCardLights keeps retrying for a while after a 503, and an
  // in-flight replay succeeding mid-test would confirm early.
  await expect.poll(() => recoverAttempts).toBeGreaterThan(attemptsBeforeReplay);
  await expect(check.locator('.lwb-quiz-status.is-err')).toBeVisible();
  expect((await saveProject(page)).devices.standaloneController.led.colorOrderConfirmed).not.toBe(true);

  cardReachable = true;
  await check.getByRole('button', { name: 'Red', exact: true }).click();
  await expect(check.getByText('Red test is live.')).toBeVisible();
  await check.getByRole('button', { name: 'Red', exact: true }).click();
  // Confirmation completes the whole check: the panel flips to install.
  await expect(page.getByText('Checked ✓ — install it on the card.')).toBeVisible();
  expect((await saveProject(page)).devices.standaloneController.led).toMatchObject({
    colorOrderConfirmed: true,
    confirmedColorOrder: 'RGB',
  });
});

test('every visible narrow commissioning form control keeps a 44px touch target', async ({ page }) => {
  await installFrameCard(page);
  await page.route('**/api/wiring/discover', route => route.fulfill({ json: {
    ok: true,
    assignments: [{ pin: 16, color: '#ff0000', label: 'Red' }],
  } }));
  await page.setViewportSize({ width: 1280, height: 820 });
  // Two data wires (built in Draw) so the wire finder shows its output picker.
  await seedDefaultCircles(page, { mode: 'draw' });
  const legacy = page.getByTestId('legacy-gpio-confirm');
  if (await legacy.isVisible()) await legacy.getByRole('button', { name: 'Looks right' }).click();
  const inner = await expandDrawStrip(page, 'Inner circle');
  await inner.getByLabel('GPIO output').selectOption('17');
  await switchMode(page, 'wire');
  const panel = page.getByTestId('layout-wire-panel');
  await panel.evaluate(element => { (element as HTMLElement).style.width = '300px'; });

  const assertTargets = async () => {
    const controls = panel.locator('button:visible, input:visible, select:visible, textarea:visible, summary:visible');
    for (const control of await controls.all()) {
      const box = await control.boundingBox();
      const name = await control.getAttribute('aria-label') || await control.textContent() || await control.getAttribute('name') || control.toString();
      expect(box?.width, `${name.trim()} width`).toBeGreaterThanOrEqual(44);
      expect(box?.height, `${name.trim()} height`).toBeGreaterThanOrEqual(44);
    }
  };

  // Closed-flow state: the CTA, the Advanced toggle, and the Power summary.
  await assertTargets();

  await panel.getByTestId('start-led-check').click();
  const bench = panel.getByTestId('wiring-bench-test');
  await bench.getByRole('button', { name: 'I can see the LED strips' }).click();
  await expect(bench.getByRole('button', { name: /^Yes — / })).toBeEnabled();
  await assertTargets();

  await openAdvanced(page);
  await panel.getByRole('button', { name: 'Find my LED wire' }).click();
  await expect(panel.getByRole('region', { name: 'Find my LED wire' }).getByRole('combobox')).toBeVisible();
  await panel.getByTestId('wire-power-section').locator('summary').click();
  await expect(panel.getByLabel('Power supply amps')).toBeVisible();
  await assertTargets();
});

test('Test & Install mirrors the Wire GPIO groups as a read-only summary', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'wire' });
  const summary = page.getByTestId('test-install-plan-summary');

  await expect(summary).toBeVisible();
  await expect(summary.getByText('GPIO 16')).toBeVisible();
  await expect(summary.getByText('first → last')).toBeVisible();
  await expect(summary.locator('[data-testid="test-install-strip-row"]')).toHaveCount(2);
  await expect(summary).toContainText('Outer circle');
  await expect(summary).toContainText('27 LEDs');
  await expect(summary.locator('select, input, [draggable="true"]')).toHaveCount(0);
  await expect(summary.getByRole('button')).toHaveCount(0);
});

test('Test & Install keeps normal wiring controls out of its reduced surface', async ({ page }) => {
  await gotoWire(page);

  await expect(page.getByTestId('start-led-check')).toBeVisible();
  await expect(page.getByTestId('advanced-installation-tools')).toHaveJSProperty('open', false);
  await expect(page.getByTestId('wiring-output-lane')).toHaveCount(0);
  await expect(page.getByText('Data wire mapping')).toHaveCount(0);
  await expect(page.getByText('Board pins', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Output A board pin')).toHaveCount(0);
  await expect(page.getByLabel('Output A GPIO')).toHaveCount(0);
});

test('incomplete Test & Install plans return to the canonical Wire editor', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'wire' });
  const project = await saveProject(page);
  project.layout.wiring.outputs[0].runIds = [];
  await page.evaluate(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(project));
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByText('Finish the setup in Wire')).toBeVisible();
  await page.getByRole('button', { name: 'Edit in Wire' }).click();
  await expect(page.getByTestId('layout-mode-draw')).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/mode=draw/);
});

test('assigning a second GPIO in Wire updates the read-only summary and hardware pin conflicts', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'wire' });
  await expect(page.getByTestId('test-install-plan-summary').locator('.la-gpio-group')).toHaveCount(1);

  // The second data wire is born in Wire: assigning a strip to an unused GPIO
  // creates the output.
  await switchMode(page, 'draw');
  const inner = await expandDrawStrip(page, 'Inner circle');
  await inner.getByLabel('GPIO output').selectOption('17');
  await switchMode(page, 'wire');
  const summary = page.getByTestId('test-install-plan-summary');
  await expect(summary.locator('.la-gpio-group')).toHaveCount(2);
  await expect(summary.getByText('GPIO 17')).toBeVisible();
  await expect(page.getByLabel('Output A GPIO')).toHaveCount(0);

  await openAdvanced(page);
  const hardware = page.getByTestId('wire-power-section');
  await hardware.locator('summary').click();
  const encoderA = page.getByLabel('Encoder A pin');
  await expect(encoderA.locator('option[value="17"]')).toHaveAttribute('disabled', '');
  await encoderA.selectOption('10');
  await expect(encoderA).toHaveValue('10');
});

test('changing logical sections never changes the derived physical data-wire count', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'draw' });
  const outer = await expandDrawStrip(page, 'Outer circle');
  await outer.getByRole('spinbutton', { name: 'Strip LED count', exact: true }).fill('26');
  await outer.getByRole('spinbutton', { name: 'Strip LED count', exact: true }).blur();
  await outer.getByRole('button', { name: 'Reverse data direction of Outer circle' }).click();
  await switchMode(page, 'wire');
  await expect(page.getByTestId('test-install-plan-summary').locator('.la-gpio-group')).toHaveCount(1);
  await expect(planMeta(page)).toContainText('43 LEDs');
  await switchMode(page, 'draw');
  const inner = await expandDrawStrip(page, 'Inner circle');
  await inner.getByLabel('GPIO output').selectOption('17');
  await switchMode(page, 'wire');
  await expect(page.getByTestId('test-install-plan-summary').locator('.la-gpio-group')).toHaveCount(2);
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
  await openAdvanced(page);
  await page.getByRole('button', { name: 'Find my LED wire' }).click();
  const finder = page.getByRole('region', { name: 'Find my LED wire' });
  await expect(finder.getByText('Choose the color you see on the real LEDs.')).toBeVisible();
  await finder.getByRole('button', { name: /Blue GPIO 17/ }).click();
  await expect(page.getByTestId('test-install-plan-summary').getByText('GPIO 17')).toBeVisible();
  await expect(finder).toContainText('uses GPIO 17');
});

test('Test & Install never scrolls horizontally at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoWire(page);
  const panel = page.getByTestId('layout-wire-panel');
  await expect(panel).toBeAttached();
  const step = panel.getByTestId('commissioning-step');
  const summary = panel.getByTestId('test-install-plan-summary');
  await openAdvanced(page);
  const advanced = panel.getByTestId('advanced-installation-tools');
  const power = panel.getByTestId('wire-power-section');
  await power.locator('summary').click();
  await expect(panel.getByLabel('Power supply amps')).toBeVisible();
  // Let the disclosure chevron's 160ms rotation settle — mid-transition its
  // diagonal transiently widens scrollWidth by ~1px.
  await page.waitForTimeout(250);
  const overflows = [
    { selector: 'Wire panel', ...(await panel.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'Plan summary', ...(await summary.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'Primary flow', ...(await step.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'Power', ...(await power.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'Advanced tools', ...(await advanced.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
  ];
  for (const item of overflows) expect(item.scrollWidth, item.selector).toBeLessThanOrEqual(item.clientWidth);
});

test('card hardware keeps power collapsed, persists its inputs, and raises over-budget warnings', async ({ page }) => {
  await gotoWire(page);
  await openAdvanced(page);
  const power = page.getByTestId('wire-power-section');
  await power.locator('summary').click();
  // Defaults: 5 A supply × 0.8 safety = 4 A budget; 44 LEDs × 12 mA = 0.53 A.
  await expect(power.locator('.lww-power-headroom')).toHaveText('Headroom 3.5 A');
  await expect(page.locator('.lww-power-warning')).toHaveCount(0);

  await page.getByLabel('Power supply amps').fill('0.5');
  const warning = page.locator('.lww-power-warning');
  await expect(warning).toHaveText('Needs 0.5 A at full white — your supply is 0.5 A.');
  await expect(warning).toHaveAttribute('role', 'alert');
  await expect(power.locator('.lww-power-headroom')).toHaveClass(/is-over/);
  await expect(power.locator('.lww-power-headroom')).toHaveText('Over by 0.1 A');

  await page.getByLabel('Milliamps per LED').fill('60');
  await expect(warning).toHaveText('Needs 2.6 A at full white — your supply is 0.5 A.');

  // Both inputs persist through the project autosave.
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  await expect(page.locator('.lww-power-warning')).toHaveText('Needs 2.6 A at full white — your supply is 0.5 A.');
  await openAdvanced(page);
  await power.locator('summary').click();
  await expect(page.getByLabel('Power supply amps')).toHaveValue('0.5');
  await expect(page.getByLabel('Milliamps per LED')).toHaveValue('60');
});

test('unverified wiring exposes no lock or install controls and deterministic reserved runs consume addresses', async ({ page }) => {
  await gotoWire(page);
  // Nothing to lock, nothing to send: the install control only exists once
  // the check is fully verified, and locking is automatic.
  await expect(page.getByTestId('layout-send-to-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toHaveCount(0);
  await openCustomMapping(page);
  await page.getByRole('button', { name: 'Add skipped LEDs' }).click();
  await page.getByRole('button', { name: 'Add skipped LEDs' }).click();
  await expect(planMeta(page)).toContainText('46 LEDs');
  const project = await saveProject(page);
  const ids = project.layout.wiring.runs.map((run: any) => run.id);
  expect(ids).toContain('reserved-1');
  expect(ids).toContain('reserved-2');
});

test('Wire owns physical data direction alongside the drawn path direction', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'draw' });
  const outer = await expandDrawStrip(page, 'Outer circle');
  const toggle = outer.getByRole('button', { name: 'Reverse data direction of Outer circle' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  let project = await saveProject(page);
  expect(project.layout.wiring.runs.find((run: any) => run.source?.stripId === 'default-outer-circle').physicalDirection).toBe('source-reverse');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  project = await saveProject(page);
  expect(project.layout.wiring.runs.find((run: any) => run.source?.stripId === 'default-outer-circle').physicalDirection).toBe('source-forward');

  // The wiring toggle is distinct from the drawn-path flip.
  await expect(outer.getByRole('button', { name: 'Flip path direction' })).toHaveAttribute('title', 'Flip the drawing path so pixel 0 swaps ends');
});

test('Draw keeps first-LED positioning in the canvas picker only', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'draw' });
  const outer = await expandDrawStrip(page, 'Outer circle');
  await expect(outer.getByText('First LED', { exact: true })).toHaveCount(0);
  await expect(outer.getByRole('button', { name: /Move first LED/ })).toHaveCount(0);
  await expect(outer.getByRole('button', { name: 'Set first LED' })).toBeVisible();
});

test('bench boundary controls redistribute a fixed physical total and explain the blue-to-red markers', async ({ page }) => {
  await installFrameCard(page);
  await gotoWire(page);
  await startLedCheck(page);
  const bench = page.getByTestId('wiring-bench-test');
  await bench.getByRole('button', { name: 'I can see the LED strips' }).click();
  // The blue-first / red-last convention is explained inline on the output step.
  await expect(bench).toContainText('The first LED should be blue and the last LED red');
  const outputPrimary = bench.getByRole('button', { name: /Yes — I see Wire/ });
  await expect(outputPrimary).toBeEnabled();
  await bench.getByRole('button', { name: 'Something’s wrong' }).click();
  await expect(bench.getByTestId('active-output-count')).toHaveText('44 LEDs');
  const frameCountBeforeOutputChange = await page.evaluate(() => (window as any).__wiringFrames.length);
  await bench.getByRole('button', { name: /Remove one LED from Wire/ }).click();
  await expect(bench.getByTestId('active-output-count')).toHaveText('43 LEDs');
  await expect(planMeta(page)).toContainText('43 LEDs');
  await expect.poll(() => page.evaluate(() => (window as any).__wiringFrames.length)).toBeGreaterThan(frameCountBeforeOutputChange);
  await expect.poll(() => page.evaluate(() => {
    const frame = (window as any).__wiringFrames.at(-1);
    return `${frame?.[42]}:${frame?.[43]}`;
  })).toBe('1A0000:000000');
  const shortenedFrame = await page.evaluate(() => (window as any).__wiringFrames.at(-1));
  expect(shortenedFrame[0]).toBe('00001A');
  expect(shortenedFrame[42]).toBe('1A0000');
  expect(shortenedFrame[43]).toBe('000000');
  await bench.getByRole('button', { name: /Add one LED to Wire/ }).click();
  await expect(bench.getByTestId('active-output-count')).toHaveText('44 LEDs');
  await expect(planMeta(page)).toContainText('44 LEDs');
  await outputPrimary.click();
  // First run step: the run-level nudges live in the same recovery panel.
  await expect(bench.getByRole('button', { name: 'Yes — blue at the start, red at the end' })).toBeVisible();
  await bench.getByRole('button', { name: 'Something’s wrong' }).click();
  await expect(bench.getByRole('button', { name: 'Add one LED to Outer circle' })).toBeVisible();
  await expect(bench.getByTestId('active-run-count')).toHaveText('27 LEDs');
  const corrected = await saveProject(page);
  expect(corrected.layout.strips.map((strip: any) => strip.pixelCount)).toEqual([27, 17]);
  await expect(planMeta(page)).toContainText('44 LEDs');
});

test('leaving Wire stops the active physical test and its hidden frame loop', async ({ page }) => {
  const controls = await installFrameCard(page);
  await gotoWire(page);
  await startLedCheck(page);
  const bench = page.getByTestId('wiring-bench-test');
  await bench.getByRole('button', { name: 'I can see the LED strips' }).click();
  await expect(bench.getByRole('button', { name: /Yes — I see Wire/ })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => (window as any).__wiringFrames.length)).toBeGreaterThan(0);

  await page.getByTestId('layout-mode-draw').click();
  await expect(page.getByTestId('wiring-bench-test')).toHaveCount(0);
  await expect.poll(() => controls.filter(body => body.cancelStream === true).length).toBe(1);
  const framesAfterUnmount = await page.evaluate(() => (window as any).__wiringFrames.length);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as any).__wiringFrames.length)).toBe(framesAfterUnmount);
  expect(controls.filter(body => body.cancelStream === true)).toHaveLength(1);
});

test('saved card position stays compatible without exposing card-position or auto-route UI', async ({ page }) => {
  await gotoWire(page);
  await seedFourRunClosedFixture(page);

  await expect(page.getByTestId('controller-anchor')).toHaveCount(0);
  await expect(page.getByTestId('draw-auto-route')).toHaveCount(0);
  await expect(page.getByTestId('auto-wire-preview')).toHaveCount(0);

  await switchMode(page, 'draw');
  await expect(page.getByTestId('controller-anchor')).toHaveCount(0);
  await expect(page.getByTestId('draw-auto-route')).toHaveCount(0);
  await expect(page.getByTestId('auto-wire-preview')).toHaveCount(0);

  expect((await saveProject(page)).layout.wiring.controllerAnchor).toEqual({ x: 320, y: 200 });
});

test('closed-path seam and physical DATA IN are editable independently until fixed, then refuse movement', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoWire(page);
  await seedFourRunClosedFixture(page);
  await switchMode(page, 'draw');
  await expandDrawStrip(page, 'Outer circle');
  await switchMode(page, 'wire');
  await openCustomMapping(page);
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

test('guided chase verifies every fact, chains into the color quiz, and auto-locks into install', async ({ page }) => {
  await installFrameCard(page);
  await gotoWire(page);
  await startLedCheck(page);
  const bench = page.getByTestId('wiring-bench-test');
  await bench.getByRole('button', { name: 'I can see the LED strips' }).click();

  const outputPrimary = bench.getByRole('button', { name: /Yes — I see Wire/ });
  await expect(outputPrimary).toBeEnabled();
  await outputPrimary.click();
  for (let run = 0; run < 2; run += 1) {
    const confirmRunButton = bench.getByRole('button', { name: 'Yes — blue at the start, red at the end' });
    await expect(confirmRunButton).toBeEnabled();
    if (run === 0) {
      await expect.poll(() => page.evaluate(() => {
        const frame = (window as any).__wiringFrames.at(-1);
        return `${frame?.[0]}:${frame?.[26]}`;
      })).toBe('00001A:1A0000');
      const beforeCorrectionFrames = await page.evaluate(() => (window as any).__wiringFrames.length);
      await bench.getByRole('button', { name: 'Something’s wrong' }).click();
      await bench.getByRole('button', { name: 'Flip the direction' }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__wiringFrames.length)).toBeGreaterThan(beforeCorrectionFrames);
      await expect.poll(() => page.evaluate(() => {
        const frame = (window as any).__wiringFrames.at(-1);
        return `${frame?.[0]}:${frame?.[26]}`;
      })).toBe('00001A:1A0000');
      await expect(confirmRunButton).toBeEnabled();
    }
    await confirmRunButton.click();
  }
  await expect(bench.getByRole('button', { name: 'Finish' })).toBeEnabled();
  await bench.getByRole('button', { name: 'Finish' }).click();

  // The color quiz presents itself as the very next question — one flow, no
  // second start button.
  await expect(page.getByTestId('wiring-bench-test')).toHaveCount(0);
  const colorCheck = page.getByRole('region', { name: 'LED color order' });
  await expect(colorCheck.getByRole('button', { name: 'Check colors' })).toHaveCount(0);
  await expect(colorCheck.getByText('Red test is live.')).toBeVisible();
  await colorCheck.getByRole('button', { name: 'Red', exact: true }).click();

  // Fully verified: the wiring auto-locks and install is the one CTA.
  await expect(page.getByText('Checked ✓ — install it on the card.')).toBeVisible();
  await expect(page.getByTestId('layout-send-to-card')).toBeEnabled();
  const correctedProject = await saveProject(page);
  expect(correctedProject.layout.wiring.locked).toBe(true);
  expect(correctedProject.layout.wiring.runs.find((run: any) => run.type === 'strip').physicalDirection).toBe('source-reverse');
  expect(correctedProject.layout.wiring.runs.every((run: any) => run.verified)).toBe(true);

  const frames = await page.evaluate(() => (window as any).__wiringFrames);
  expect(frames.length).toBeGreaterThanOrEqual(3);
  for (const frame of frames) {
    expect(frame).toHaveLength(44);
    expect(frame.flatMap((pixel: string) => pixel.match(/../g)!.map(value => parseInt(value, 16))).every((channel: number) => channel <= 26)).toBe(true);
  }

  // The assembly map now lives inside Advanced, next to the unlock affordance.
  await openAdvanced(page);
  await expect(page.getByTestId('unlock-wiring')).toBeVisible();
  await page.getByRole('button', { name: 'Open assembly map' }).click();
  const assembly = page.getByTestId('wiring-assembly-map');
  await expect(assembly.getByRole('heading', { name: 'Wiring installation plan' })).toBeVisible();
  await expect(assembly).not.toContainText(/Controller at/i);
  await expect(assembly).toContainText(/GPIO 16/);
  await expect(assembly).toContainText(/LED 0/);
  await expect(assembly).toContainText('End LED → start LED');
  await expect(assembly).toContainText(/Verified/);
  await expect(assembly.getByRole('button', { name: 'Print assembly map' })).toBeVisible();
});

test('failed chase stays on the same step, cancels without false verification, and deferring exits to the CTA', async ({ page }) => {
  const controls = await installFrameCard(page);
  await gotoWire(page);
  await page.evaluate(() => { (window as any).__wiringFail = true; });
  await startLedCheck(page);
  const bench = page.getByTestId('wiring-bench-test');
  await bench.getByRole('button', { name: 'I can see the LED strips' }).click();
  await expect(bench).toContainText('Do you see Wire A lit up?');
  await expect(bench.getByText('The lights didn’t reach the card')).toBeVisible();
  await expect(bench.getByRole('button', { name: /Yes — I see Wire/ })).toBeDisabled();
  await expect(page.getByTestId('layout-send-to-card')).toHaveCount(0);
  expect(controls.some(body => body.cancelStream === true)).toBe(true);

  await page.evaluate(() => { (window as any).__wiringFail = false; });
  await bench.getByRole('button', { name: 'Try again' }).click();
  await expect(bench).toContainText('Do you see Wire A lit up?');
  await expect(bench.getByRole('button', { name: /Yes — I see Wire/ })).toBeEnabled();

  // Cancelling never marks anything verified and exits the check flow back to
  // the single CTA (there is no internal shell to land on any more).
  await bench.getByRole('button', { name: 'Do this later' }).click();
  await expect(page.getByTestId('wiring-bench-test')).toHaveCount(0);
  await expect(page.getByTestId('start-led-check')).toBeVisible();
  const project = await saveProject(page);
  expect(project.layout.wiring.verified).toBe(false);
  expect(project.layout.wiring.runs.every((run: any) => run.verified === false)).toBe(true);
});

test('the primary flow states its card requirement inline and clears it when the card link connects', async ({ page }) => {
  await gotoWire(page);
  const banner = page.locator('.lw-card-banner.is-inline');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('This check lights the real LEDs — use Connect Lightweaver in the footer first.');
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
