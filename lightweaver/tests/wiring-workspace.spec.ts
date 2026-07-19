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

// ── Step rail helpers ────────────────────────────────────────────────────────
// Wire is exactly two steps now: Check (light the real LEDs + color order) and
// Install (lock, preflight, push). Everything before that — wire count, order,
// direction, routing — lives in Draw. The StepRail (role=group "Steps") is the
// navigation affordance; done steps append a checkmark, so name matching stays
// on the label substring.
const rail = (page: any) => page.getByRole('group', { name: 'Steps' });

async function openStep(page: any, label: 'Check' | 'Install') {
  await rail(page).getByRole('button', { name: label }).click();
  await expect(page.getByTestId('commissioning-step')).toBeVisible();
}

async function railStepStates(page: any) {
  return rail(page).getByRole('button').evaluateAll((elements: Element[]) => elements.map(element => {
    const cls = [...element.classList].find(name => /^lwui-rail-(done|current|todo|optional)$/.test(name));
    return cls ? cls.replace('lwui-rail-', '') : null;
  }));
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
// open). It is reachable from either step.
async function openAdvanced(page: any) {
  const toggle = page.getByTestId('advanced-wiring-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

// The LEDs stat tile is the always-visible pixel total.
const pixelsTile = (page: any) => page.locator('.lwui-tile').filter({ hasText: 'LEDs' }).locator('.lwui-tile-value');

async function saveProject(page: any) {
  await page.waitForTimeout(600);
  const pending = page.waitForEvent('download');
  await page.locator('.la .toolbar').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await pending;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lw-wire-save-')), 'project.json');
  await download.saveAs(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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
  await openAdvanced(page);
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
  await expect(page.getByRole('button', { name: 'Add skipped LEDs' })).toHaveCount(0);
  await openAdvanced(page);
  await expect(page.getByTestId('wiring-output-lane')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Output A' })).toBeVisible();
  await expect(page.getByTestId('wiring-run-row')).toHaveCount(2);
  await expect(page.locator('.lw-wiring-run-index')).toHaveCount(0);
  await expect(page.getByLabel('Output A GPIO')).toHaveValue('16');
  await expect(page.getByText('Compiler preflight')).toHaveCount(0);
  await expect(page.getByText('Edit LED range')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add skipped LEDs' })).toBeVisible();

  await openStep(page, 'Install');
  await expect(page.getByText('One thing left before install')).toBeVisible();
  await expect(page.getByText('Run the LED check on the real strips.', { exact: true })).toBeVisible();
});

test('Wire presents exactly two commissioning steps with Check before Install', async ({ page }) => {
  await gotoWire(page);
  const steps = rail(page).getByRole('button');
  await expect(steps).toHaveCount(2);
  // Only the selected step's card renders; state pills are gone in favor of
  // rail segment states.
  await expect(page.getByTestId('commissioning-step')).toHaveCount(1);
  expect(await railStepStates(page)).toEqual(['current', 'todo']);
  const labels = await steps.allTextContents();
  expect(labels.map(label => label.replace(' ✓', ''))).toEqual(['Check', 'Install']);
  // The flow lands on the physical check step.
  await expect(page.getByTestId('commissioning-step')).toHaveAttribute('data-step-state', 'current');
  await expect(page.getByTestId('commissioning-step')).toHaveAttribute('aria-label', 'Light them up and check');
  await expect(page.getByTestId('wiring-bench-test')).toBeVisible();
});

test('Wire owns neither wire count nor ordering nor routing and keeps expert tools behind Advanced wiring', async ({ page }) => {
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

  await expect(page.getByTestId('advanced-wiring-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Split a strip mid-wire' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Paint the route by clicking strips' })).toHaveCount(0);
  await openAdvanced(page);
  await expect(page.getByRole('button', { name: 'Split a strip mid-wire' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Paint the route by clicking strips' })).toBeVisible();
});

test('physical LED check requires the visibility acknowledgement before the chase starts', async ({ page }) => {
  await installFrameCard(page);
  await gotoWire(page);
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

test('review separates install from export and names the card connection state', async ({ page }) => {
  await gotoWire(page);
  await openStep(page, 'Install');
  const step = page.getByTestId('commissioning-step');
  await expect(step.getByRole('button', { name: /Save to card/ })).toContainText('Card not connected');
  await expect(step.getByRole('button', { name: 'Download WLED map' })).toHaveClass(/btn-ghost/);
  // The install summary reads from the always-visible stat tiles; the old
  // color-order spec row ("GRB") stays out of primary copy.
  await expect(page.locator('.lwui-tile-label').filter({ hasText: /^Strips$/ })).toBeVisible();
  await expect(page.locator('.lwui-tile-label').filter({ hasText: /^LEDs$/ })).toBeVisible();
  await expect(page.getByText('Configured color order')).toHaveCount(0);
});

test('narrow inspector uses container-aware stacked controls without clipping', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await gotoWire(page);
  const panel = page.getByTestId('layout-wire-panel');
  await panel.evaluate(element => { (element as HTMLElement).style.width = '300px'; });
  await openAdvanced(page);
  const row = panel.getByTestId('wiring-run-row').first();
  await expect(row).toBeVisible();
  await expect(row).toHaveCSS('grid-template-columns', /.+/);
  for (const target of [panel, panel.getByTestId('commissioning-step'), row]) {
    const size = await target.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth);
  }
  await expect(panel.getByRole('button', { name: 'Remove Outer circle' })).toContainText('Remove');
  const controls = panel.locator([
    '[data-testid="wiring-output-lane"] header button',
    '[data-testid="wiring-run-row"] button',
  ].join(', '));
  for (const control of await controls.all()) {
    if (!await control.isVisible()) continue;
    const box = await control.boundingBox();
    expect(box?.width, await control.getAttribute('aria-label') || 'control width').toBeGreaterThanOrEqual(44);
    expect(box?.height, await control.getAttribute('aria-label') || 'control height').toBeGreaterThanOrEqual(44);
  }
});

test('Delete requests guarded removal instead of immediately deleting an LED strip', async ({ page }) => {
  await gotoWire(page);
  await openAdvanced(page);
  const rows = page.getByTestId('wiring-run-row');
  const row = rows.first();
  await row.focus();
  await page.keyboard.press('Delete');
  await expect(rows).toHaveCount(2);
  await expect(row.getByRole('button', { name: 'Confirm remove Outer circle' })).toBeVisible();
});

test('legacy wire-count review is confirmed in Draw and clears the Wire warnings', async ({ page }) => {
  await seedDefaultCircles(page, { needsReview: true, mode: 'wire' });
  // Wire: the Check step carries a one-line pointer to Draw…
  const warning = page.getByText('This older project needs its wire count confirmed in Draw first.');
  await expect(warning).toBeVisible();
  // …and Install is blocked with a Draw pointer that has no in-panel action.
  await openStep(page, 'Install');
  const blocker = page.getByText('Confirm the wire count in Draw.');
  await expect(blocker).toBeVisible();
  await expect(page.getByTestId('commissioning-step').locator('.lwui-card-footer button')).toHaveCount(0);

  // Draw: the legacy banner confirms the derived GPIO assignments.
  await switchMode(page, 'draw');
  const banner = page.getByTestId('legacy-gpio-confirm');
  await expect(banner).toContainText("Older project — confirm each strip's GPIO looks right.");
  await banner.getByRole('button', { name: 'Looks right' }).click();
  await expect(banner).toHaveCount(0);

  // Back in Wire, both the inline warning and the install blocker are gone.
  await switchMode(page, 'wire');
  await expect(warning).toHaveCount(0);
  await openStep(page, 'Install');
  await expect(page.getByText('Confirm the wire count in Draw.')).toHaveCount(0);
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
  // The machine color-order token stays out of primary copy (change 11):
  // before the check opens the head shows plain language only.
  await expect(check.getByText('Colors not checked yet')).toBeVisible();
  await expect(check.getByTestId('strip-color-order')).toHaveCount(0);
  // Both live inside the Check step; the color quiz follows the guided check.
  expect(await bench.evaluate((benchElement, checkElement) => Boolean(
    benchElement.compareDocumentPosition(checkElement as Node) & Node.DOCUMENT_POSITION_FOLLOWING
  ), await check.elementHandle())).toBe(true);

  await check.getByRole('button', { name: 'Check colors' }).click();
  await expect(check.getByTestId('strip-color-order')).toHaveText('RGB');
  await expect(check.getByText('The whole strip just lit up. Tap the color you actually see.')).toBeVisible();
  await expect.poll(() => testRequests.some(request => request.patternId === 'test-red')).toBe(true);
  await check.getByRole('button', { name: 'Send Green test' }).click();
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

  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  expect(await railStepStates(page)).toEqual(['current', 'todo']);
  const check = page.getByRole('region', { name: 'LED color order' });
  await check.getByRole('button', { name: 'Check colors' }).click();
  // The matching quiz answer is the confirmation: the card is showing red.
  const redAnswer = check.getByRole('button', { name: 'Red', exact: true });
  await expect(redAnswer).toBeEnabled();
  await expect(check.getByText('Red test is live.')).toBeVisible();
  await redAnswer.click();
  await expect.poll(() => railStepStates(page)).toEqual(['done', 'current']);
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toBeEnabled();

  const confirmedProject = await saveProject(page);
  expect(confirmedProject.devices.standaloneController.led).toMatchObject({
    colorOrder: 'RGB',
    colorOrderConfirmed: true,
    confirmedColorOrder: 'RGB',
  });
  await page.evaluate(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(confirmedProject));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  await expect.poll(() => railStepStates(page)).toEqual(['done', 'current']);

  await openStep(page, 'Check');
  const persistedCheck = page.getByRole('region', { name: 'LED color order' });
  await persistedCheck.getByRole('button', { name: 'Check colors' }).click();
  await persistedCheck.getByRole('button', { name: 'Try next order' }).click();
  await expect(persistedCheck.getByTestId('strip-color-order')).toHaveText('GRB');
  await expect.poll(() => railStepStates(page)).toEqual(['current', 'todo']);
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
  await expect(check.getByRole('button', { name: 'Check colors' })).toBeEnabled();
  // With no successful live test, answering the matching color must NOT
  // confirm the order — it replays the test instead.
  await check.getByRole('button', { name: 'Red', exact: true }).click();
  expect((await saveProject(page)).devices.standaloneController.led.colorOrderConfirmed).not.toBe(true);

  cardReachable = true;
  await check.getByRole('button', { name: 'Check colors' }).click();
  await expect(check.getByText('Red test is live.')).toBeVisible();
  await check.getByRole('button', { name: 'Red', exact: true }).click();
  await expect(check.getByText('RGB color order confirmed.')).toBeVisible();
  expect((await saveProject(page)).devices.standaloneController.led).toMatchObject({
    colorOrderConfirmed: true,
    confirmedColorOrder: 'RGB',
  });
});

test('the step rail navigates between steps and names the current one', async ({ page }) => {
  await gotoWire(page);
  await expect(rail(page).getByRole('button', { name: 'Check' })).toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('commissioning-step')).toHaveAttribute('aria-label', 'Light them up and check');
  await openStep(page, 'Install');
  await expect(rail(page).getByRole('button', { name: 'Install' })).toHaveAttribute('aria-current', 'step');
  await expect(rail(page).getByRole('button', { name: 'Check' })).not.toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('commissioning-step')).toHaveAttribute('aria-label', 'Lock it in and install');
  await openStep(page, 'Check');
  await expect(page.getByTestId('commissioning-step')).toHaveAttribute('aria-label', 'Light them up and check');
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

  const colorCheck = panel.getByRole('region', { name: 'LED color order' });
  await colorCheck.getByRole('button', { name: 'Check colors' }).click();
  const bench = panel.getByTestId('wiring-bench-test');
  await bench.getByRole('button', { name: 'I can see the LED strips' }).click();
  await expect(bench.getByRole('button', { name: /^Yes — / })).toBeEnabled();
  await assertTargets();

  await openAdvanced(page);
  await panel.getByRole('button', { name: 'Find my LED wire' }).click();
  await expect(panel.getByRole('region', { name: 'Find my LED wire' }).getByRole('combobox')).toBeVisible();
  await panel.getByTestId('wiring-run-row').first().locator('.lw-wiring-run-name').click();
  await expect(panel.getByRole('spinbutton', { name: 'Start LED' })).toBeVisible();
  await assertTargets();

  await openStep(page, 'Install');
  await assertTargets();
});

test('assigning a second GPIO in Draw creates a second output and board pins reject conflicts', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'wire' });
  // Board pins and expert mapping stay behind the collapsed Advanced drawer.
  await expect(page.getByText('Expert mapping')).toHaveCount(0);
  await expect(page.getByText('Board pins')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add skipped LEDs' })).toHaveCount(0);
  await openAdvanced(page);
  await expect(page.getByTestId('wiring-output-lane')).toHaveCount(1);

  // The second data wire is born in Draw: assigning a strip to an unused GPIO
  // creates the output.
  await switchMode(page, 'draw');
  const inner = await expandDrawStrip(page, 'Inner circle');
  await inner.getByLabel('GPIO output').selectOption('17');
  await switchMode(page, 'wire');
  await openAdvanced(page);
  await expect(page.getByTestId('wiring-output-lane')).toHaveCount(2);

  const gpioA = page.getByLabel('Output A GPIO');
  const gpioB = page.getByLabel('Output B GPIO');
  await expect(gpioB).toHaveValue('17');
  await expect(gpioB.locator('option[value="16"]')).toBeDisabled();
  await gpioA.selectOption('38');
  await expect(gpioA).toHaveValue('38');
  await expect(page.getByText('Board pins')).toBeVisible();
  await expect(page.getByText('Expert mapping')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add skipped LEDs' })).toBeVisible();
  const encoderA = page.getByLabel('Encoder A pin');
  await expect(encoderA.locator('option[value="38"]')).toHaveAttribute('disabled', '');
  await encoderA.selectOption('10');
  await expect(encoderA).toHaveValue('10');
});

test('entire output lanes drag with their GPIO, support keyboard reorder, and Draw reassignment collapses empty lanes', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'draw' });
  const inner = await expandDrawStrip(page, 'Inner circle');
  await inner.getByLabel('GPIO output').selectOption('17');
  await switchMode(page, 'wire');
  await openAdvanced(page);
  const lanes = page.getByTestId('wiring-output-lane');
  await expect(lanes).toHaveCount(2);
  await expect(lanes.nth(0).getByRole('button', { name: /Remove Output/ })).toBeDisabled();
  const firstLaneId = await lanes.nth(0).getAttribute('data-output-id');
  const handle = lanes.nth(0).getByRole('button', { name: 'Drag Output A' });
  const target = lanes.nth(1);
  await handle.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  if (!to) throw new Error('output lanes unavailable');
  await handle.dragTo(target, { targetPosition: { x: 20, y: Math.max(1, to.height - 2) } });
  await expect(lanes.nth(1)).toHaveAttribute('data-output-id', firstLaneId!);
  await expect(lanes.nth(1).getByLabel('Output B GPIO')).toHaveValue('16');
  await lanes.nth(1).getByRole('button', { name: 'Drag Output B' }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(lanes.nth(0)).toHaveAttribute('data-output-id', firstLaneId!);

  // Reassigning the lone strip back to GPIO 16 in Draw removes the emptied
  // output — the derived wire count follows the assignments.
  await switchMode(page, 'draw');
  const innerAgain = await expandDrawStrip(page, 'Inner circle');
  await innerAgain.getByLabel('GPIO output').selectOption('16');
  await switchMode(page, 'wire');
  await openAdvanced(page);
  await expect(lanes).toHaveCount(1);
});

test('changing logical sections never changes the derived physical data-wire count', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'wire' });
  await openAdvanced(page);
  const outputs = page.getByTestId('wiring-output-lane');
  await expect(outputs).toHaveCount(1);
  const firstRun = page.getByTestId('wiring-run-row').first();
  await firstRun.getByRole('button', { name: 'Remove one LED from Outer circle' }).click();
  await expect(outputs).toHaveCount(1);
  await firstRun.getByRole('button', { name: 'Flip' }).click();
  await expect(outputs).toHaveCount(1);
  await switchMode(page, 'draw');
  const inner = await expandDrawStrip(page, 'Inner circle');
  await inner.getByLabel('GPIO output').selectOption('17');
  await switchMode(page, 'wire');
  await openAdvanced(page);
  await expect(outputs).toHaveCount(2);
  await page.getByTestId('wiring-run-row').first().getByRole('button', { name: 'Add one LED to Outer circle' }).click();
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
  await openAdvanced(page);
  await page.getByRole('button', { name: 'Find my LED wire' }).click();
  const finder = page.getByRole('region', { name: 'Find my LED wire' });
  await expect(finder.getByText('Choose the color you see on the real LEDs.')).toBeVisible();
  await finder.getByRole('button', { name: /Blue GPIO 17/ }).click();
  await expect(page.getByLabel('Output A GPIO')).toHaveValue('17');
  await expect(finder).toContainText('uses GPIO 17');
});

test('Wire panel never scrolls horizontally at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoWire(page);
  const panel = page.getByTestId('layout-wire-panel');
  await expect(panel).toBeAttached();
  const step = panel.getByTestId('commissioning-step');
  const colorOrder = panel.getByRole('region', { name: 'LED color order' });
  await expect(colorOrder).toBeVisible();
  await openAdvanced(page);
  await expect(panel.getByTestId('wiring-run-row').first()).toBeVisible();
  // Let the disclosure chevron's 160ms rotation settle — mid-transition its
  // diagonal transiently widens scrollWidth by ~1px.
  await page.waitForTimeout(250);
  const overflows = [
    { selector: 'Wire panel', ...(await panel.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'Check step', ...(await step.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'LED color order', ...(await colorOrder.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
    { selector: 'Advanced wiring', ...(await panel.getByTestId('advanced-wiring').evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))) },
  ];
  for (const item of overflows) expect(item.scrollWidth, item.selector).toBeLessThanOrEqual(item.clientWidth);
});

test('inline strip count controls resize the real project without selecting the row', async ({ page }) => {
  await gotoWire(page);
  await openAdvanced(page);
  const row = page.getByTestId('wiring-run-row').first();
  await expect(row).toHaveAttribute('aria-selected', 'false');
  await row.getByRole('button', { name: 'Remove one LED from Outer circle' }).click();
  await expect(row.getByTestId('inline-run-count')).toHaveText('26');
  await expect(pixelsTile(page)).toHaveText('43');
  await expect(row).toHaveAttribute('aria-selected', 'false');
  await row.getByRole('button', { name: 'Add one LED to Outer circle' }).click();
  await expect(row.getByTestId('inline-run-count')).toHaveText('27');
  await expect(pixelsTile(page)).toHaveText('44');
});

test('run selection stays synchronized with the artwork canvas', async ({ page }) => {
  await gotoWire(page);
  await openAdvanced(page);
  const row = page.getByTestId('wiring-run-row').first();
  await row.locator('.lw-wiring-run-name').click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-wiring-run].is-selected')).toHaveCount(1);
});

test('Draw strip selection carries into the Wire canvas and run list', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'draw' });
  await expandDrawStrip(page, 'Outer circle');
  await switchMode(page, 'wire');
  await expect(page.locator('[data-wiring-run].is-selected')).toHaveCount(1);
  await openAdvanced(page);
  const selected = page.getByTestId('wiring-run-row').filter({ hasText: 'Outer circle' }).first();
  await expect(selected).toHaveAttribute('aria-selected', 'true');
});

test('accessible ports connect by tap and keyboard alternatives reorder runs', async ({ page }) => {
  await gotoWire(page);
  await openAdvanced(page);
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
  await openStep(page, 'Install');
  await expect(page.getByTestId('layout-send-to-card')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toHaveCount(0);
  await openAdvanced(page);
  await page.getByRole('button', { name: 'Add skipped LEDs' }).click();
  await page.getByRole('button', { name: 'Add skipped LEDs' }).click();
  await expect(page.getByTestId('wiring-run-row').getByText('Reserved · unlit')).toHaveCount(2);
  await expect(pixelsTile(page)).toHaveText('46');
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
  await seedDefaultCircles(page, { mode: 'draw' });
  const inner = await expandDrawStrip(page, 'Inner circle');
  await inner.getByLabel('GPIO output').selectOption('17');
  await switchMode(page, 'wire');
  await openAdvanced(page);
  await expect(page.getByTestId('wiring-output-lane')).toHaveCount(2);
  const run = page.getByTestId('wiring-output-lane').nth(0).getByTestId('wiring-run-row').first();
  const runId = await run.getAttribute('data-run-id');
  const handle = run.getByRole('button', { name: /Drag/ });
  const laneB = page.getByTestId('wiring-output-lane').nth(1).getByRole('heading', { name: 'Output B' });
  await handle.scrollIntoViewIfNeeded();
  await handle.dragTo(laneB);
  await expect(page.getByTestId('wiring-output-lane').nth(1)).not.toHaveCSS('background-color', 'rgb(77, 45, 25)');
  await expect(page.getByTestId('wiring-output-lane').nth(1).getByTestId('wiring-run-row')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).__captures)).toBeGreaterThan(0);
  const project = await saveProject(page);
  const refs = project.layout.wiring.outputs.flatMap((output: any) => output.runIds);
  expect(refs.filter((id: string) => id === runId)).toHaveLength(1);
  expect(project.layout.wiring.outputs[1].runIds).toContain(runId);
  const moved = page.getByTestId('wiring-output-lane').nth(1).locator(`[data-run-id="${runId}"]`);
  await expect(moved).toHaveAttribute('aria-selected', 'false');
});

test('Draw wiring-direction toggle flips physicalDirection and honors a fixed policy', async ({ page }) => {
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

  // The wiring toggle is distinct from the path flip and refuses fixed runs.
  await expect(outer.getByRole('button', { name: 'Flip path direction' })).toHaveAttribute('title', 'Flip the drawing path so pixel 0 swaps ends');
  await switchMode(page, 'wire');
  await openAdvanced(page);
  await page.getByTestId('wiring-run-row').filter({ hasText: 'Outer circle' }).first().locator('.lw-wiring-run-name').click();
  await page.getByLabel('Direction policy').selectOption('fixed');
  await switchMode(page, 'draw');
  const outerAgain = await expandDrawStrip(page, 'Outer circle');
  await expect(outerAgain.getByRole('button', { name: 'Reverse data direction of Outer circle' })).toBeDisabled();
});

test('Draw first-LED nudge moves the seam on closed strips', async ({ page }) => {
  await seedDefaultCircles(page, { mode: 'draw' });
  const outer = await expandDrawStrip(page, 'Outer circle');
  const position = outer.getByTestId('order-seam-position');
  await expect(position).toHaveText('1');
  await outer.getByRole('button', { name: 'Move first LED of Outer circle forward one' }).click();
  await expect(position).toHaveText('2');
  // Clamped at the run start: nudging back below LED 1 stays put.
  await outer.getByRole('button', { name: 'Move first LED of Outer circle back one' }).click();
  await outer.getByRole('button', { name: 'Move first LED of Outer circle back one' }).click();
  await expect(position).toHaveText('1');
  await outer.getByRole('button', { name: 'Move first LED of Outer circle forward one' }).click();
  const project = await saveProject(page);
  expect(project.layout.wiring.runs.find((run: any) => run.source?.stripId === 'default-outer-circle').seamLed).toBe(1);
});

test('bench boundary controls redistribute a fixed physical total and explain the blue-to-red markers', async ({ page }) => {
  await installFrameCard(page);
  await gotoWire(page);
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
  await expect(pixelsTile(page)).toHaveText('43');
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
  await expect(pixelsTile(page)).toHaveText('44');
  await outputPrimary.click();
  // First run step: the run-level nudges live in the same recovery panel.
  await expect(bench.getByRole('button', { name: 'Yes — blue at the start, red at the end' })).toBeVisible();
  await bench.getByRole('button', { name: 'Something’s wrong' }).click();
  await expect(bench.getByRole('button', { name: 'Add one LED to Outer circle' })).toBeVisible();
  await expect(bench.getByTestId('active-run-count')).toHaveText('27 LEDs');
  await openAdvanced(page);
  await expect(page.getByTestId('wiring-run-row').nth(0).getByTestId('inline-run-count')).toHaveText('27');
  await expect(page.getByTestId('wiring-run-row').nth(1).getByTestId('inline-run-count')).toHaveText('17');
  await expect(pixelsTile(page)).toHaveText('44');
});

test('leaving Wire stops the active physical test and its hidden frame loop', async ({ page }) => {
  const controls = await installFrameCard(page);
  await gotoWire(page);
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

test('pointer cord drag from run DATA OUT to DATA IN creates one zero-address cable jump', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await gotoWire(page);
  await openAdvanced(page);
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
  await expect(pixelsTile(page)).toHaveText('44');
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
  await page.getByLabel('Direction policy').selectOption('fixed');
  await expect(page.getByTestId('wiring-run-row').first().getByRole('button', { name: 'Flip' })).toBeDisabled();
  const row = page.getByTestId('wiring-run-row').first();
  await row.getByRole('button', { name: /OUT port/ }).click();
  await row.getByRole('button', { name: /IN port/ }).click();
  const ids = await page.getByTestId('wiring-run-row').evaluateAll(rows => rows.map(row => row.getAttribute('data-run-id')));
  expect(new Set(ids).size).toBe(ids.length);
  await expect(page.getByText(/cycle|duplicate|branch/i)).toHaveCount(0);
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
  const row = page.getByTestId('wiring-run-row').first();
  await row.locator('.lw-wiring-run-name').click();
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
  await openAdvanced(page);
  const stripRows = page.getByTestId('wiring-run-row').filter({ has: page.getByRole('button', { name: 'Flip' }) });
  await stripRows.nth(0).getByRole('button', { name: /OUT port/ }).click();
  await stripRows.nth(1).getByRole('button', { name: /IN port/ }).click();
  await page.getByRole('button', { name: 'Add skipped LEDs' }).click();
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
    if (run === 0) {
      await expect(bench).toContainText('Cable jump');
      const cableButton = bench.getByRole('button', { name: 'Yes — the cable is connected' });
      await expect(cableButton).toBeEnabled();
      await cableButton.click();
    }
  }
  await expect(bench).toContainText('Reserved LEDs');
  const inactiveButton = bench.getByRole('button', { name: 'Yes — they stay dark' });
  await expect(inactiveButton).toBeEnabled();
  await inactiveButton.click();
  await expect(bench.getByRole('button', { name: 'Finish' })).toBeEnabled();
  await bench.getByRole('button', { name: 'Finish' }).click();
  await expect(bench.getByText('All checked. Review and lock the wiring before installation.')).toBeVisible();
  // Install stays blocked until the color order is confirmed too.
  expect(await railStepStates(page)).toEqual(['current', 'todo']);
  const colorCheck = page.getByRole('region', { name: 'LED color order' });
  await colorCheck.getByRole('button', { name: 'Check colors' }).click();
  await expect(colorCheck.getByText('Red test is live.')).toBeVisible();
  await colorCheck.getByRole('button', { name: 'Red', exact: true }).click();
  await expect(page.getByTestId('commissioning-step')).toHaveAttribute('aria-label', 'Lock it in and install');
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
  await expect(assembly.getByRole('heading', { name: 'Wiring installation plan' })).toBeVisible();
  await expect(assembly).not.toContainText(/Controller at/i);
  await expect(assembly).toContainText(/GPIO 16/);
  await expect(assembly).toContainText(/LED 0/);
  await expect(assembly).toContainText('End LED → start LED');
  await expect(assembly).toContainText(/Verified/);
  await expect(assembly.getByRole('button', { name: 'Print assembly map' })).toBeVisible();
});

test('failed chase stays on the same step, cancels without false verification, and restarting requires a fresh acknowledgement', async ({ page }) => {
  const controls = await installFrameCard(page);
  await gotoWire(page);
  await page.evaluate(() => { (window as any).__wiringFail = true; });
  const bench = page.getByTestId('wiring-bench-test');
  await bench.getByRole('button', { name: 'I can see the LED strips' }).click();
  await expect(bench).toContainText('Do you see Wire A lit up?');
  await expect(bench.getByText('The lights didn’t reach the card')).toBeVisible();
  await expect(bench.getByRole('button', { name: /Yes — I see Wire/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Lock wiring' })).toHaveCount(0);
  expect(controls.some(body => body.cancelStream === true)).toBe(true);

  await page.evaluate(() => { (window as any).__wiringFail = false; });
  await bench.getByRole('button', { name: 'Try again' }).click();
  await expect(bench).toContainText('Do you see Wire A lit up?');
  await expect(bench.getByRole('button', { name: /Yes — I see Wire/ })).toBeEnabled();

  // Cancelling never marks anything verified and forces the next attempt back
  // through the visibility acknowledgement screen.
  await bench.getByRole('button', { name: 'Do this later' }).click();
  await expect(bench.getByRole('button', { name: 'I can see the LED strips' })).toBeVisible();
  const project = await saveProject(page);
  expect(project.layout.wiring.verified).toBe(false);
  expect(project.layout.wiring.runs.every((run: any) => run.verified === false)).toBe(true);
});

test('the check step states its card requirement inline and clears it when the card link connects', async ({ page }) => {
  await gotoWire(page);
  const banner = page.locator('.lw-card-banner.is-inline');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('This step lights the real LEDs — use Connect Lightweaver in the footer first.');
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
