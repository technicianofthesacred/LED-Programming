import { test, expect } from '@playwright/test';

async function gotoLayout(page: any) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
}

// The Wire commissioning flow shows one step at a time; the StepRail
// (role=group "Steps") is the navigation affordance.
async function openWireStep(page: any, railLabel: string, target: (panel: any) => any) {
  await page.getByRole('group', { name: 'Steps' }).getByRole('button', { name: railLabel }).click();
  await expect(target(page)).toBeVisible();
}

test('pending drawing survives a mode visit until explicitly cancelled', async ({ page }) => {
  await gotoLayout(page);
  await page.getByTitle('Draw a new LED strip path on the artwork.').click();
  const svg = page.locator('.lw-viewport svg');
  const box = await svg.boundingBox();
  if (!box) throw new Error('canvas unavailable');
  await page.mouse.click(box.x + 30, box.y + 30);
  await page.mouse.click(box.x + 80, box.y + 60);
  await page.getByTestId('layout-mode-size').click();
  await page.getByTestId('layout-mode-draw').click();
  await page.getByTitle('Draw a new LED strip path on the artwork.').click();
  await expect(page.locator('.la-draw-hint')).toContainText('2 points');
  await page.getByRole('button', { name: /Cancel \(Esc\)/ }).click();
  await expect(page.locator('.la-draw-hint')).toHaveCount(0);
});

test('manual counts and reset are independently undoable', async ({ page }) => {
  await gotoLayout(page);
  await page.getByTestId('layout-mode-size').click();
  const count = page.getByTestId('layout-size-strip-row').first().getByRole('spinbutton');
  const original = await count.inputValue();
  await count.fill('77');
  await count.blur();
  await page.getByTitle('Reset to the computed count').click();
  await page.getByTitle(/Undo/).click();
  await expect(count).toHaveValue('77');
  await page.getByTitle(/Undo/).click();
  await expect(count).toHaveValue(original);
  await page.getByTitle(/Redo/).click();
  await expect(count).toHaveValue('77');
});

test('multi-character count edit creates one undo entry', async ({ page }) => {
  await gotoLayout(page);
  await page.getByTestId('layout-mode-size').click();
  const count = page.getByTestId('layout-size-strip-row').first().getByRole('spinbutton');
  const original = await count.inputValue();

  await count.click();
  await page.keyboard.type('123');
  await count.blur();

  await expect(count).toHaveValue('123');
  await expect(page.getByTitle(/Undo/)).toHaveAttribute('title', /1 step/);
  await page.getByTitle(/Undo/).click();
  await expect(count).toHaveValue(original);
  await expect(page.getByTitle(/Undo/)).toBeDisabled();
});

test('Escape restores a count edit without adding history', async ({ page }) => {
  await gotoLayout(page);
  await page.getByTestId('layout-mode-size').click();
  const count = page.getByTestId('layout-size-strip-row').first().getByRole('spinbutton');
  const original = await count.inputValue();

  await count.click();
  await page.keyboard.type('999');
  await page.keyboard.press('Escape');

  await expect(count).toHaveValue(original);
  await expect(page.getByTitle(/Undo/)).toBeDisabled();
});

test('Finish path is touch-visible and the completed pending path survives mode visits', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoLayout(page);
  await page.getByTitle('Draw a new LED strip path on the artwork.').click();
  const svg = page.locator('.lw-viewport svg');
  const box = await svg.boundingBox();
  if (!box) throw new Error('canvas unavailable');
  await page.mouse.click(box.x + 70, box.y + 70);
  await page.mouse.click(box.x + 140, box.y + 110);

  const finish = page.getByRole('button', { name: 'Finish path' });
  await expect(finish).toBeVisible();
  await finish.click();
  await expect(page.getByText('Name your new strip')).toBeVisible();

  await page.getByTestId('layout-mode-size').click();
  await page.getByTestId('layout-mode-wire').click();
  await page.getByTestId('layout-mode-draw').click();
  await expect(page.getByText('Name your new strip')).toBeVisible();
});

test('artwork vector paths support named keyboard selection, additive selection, and Delete', async ({ page }) => {
  await gotoLayout(page);
  await page.setInputFiles('input[accept=".svg"]', {
    name: 'keyboard-vectors.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200">
        <g id="routes" data-name="Routes">
          <path id="upper" d="M 20 40 H 280" fill="none" stroke="#fff"/>
          <path id="lower" d="M 20 140 H 280" fill="none" stroke="#fff"/>
        </g>
      </svg>`),
  });

  const vectors = page.locator('path[data-vector-path-id]');
  await expect(vectors).toHaveCount(2);
  await expect(vectors.first()).toHaveAttribute('role', 'button');
  await expect(vectors.first()).toHaveAttribute('tabindex', '0');
  await expect(vectors.first()).toHaveAccessibleName(/Select artwork vector Routes/);

  await vectors.first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('1 path selected')).toBeVisible();

  await vectors.nth(1).focus();
  await page.keyboard.press('Shift+Enter');
  await expect(page.getByText('2 paths selected')).toBeVisible();

  await page.keyboard.press('Delete');
  await expect(vectors).toHaveCount(0);
});

test('selected path measurement is cached across unrelated rerenders', async ({ page }) => {
  await page.addInitScript(() => {
    const original = SVGPathElement.prototype.getTotalLength;
    (window as any).__selectedPathMeasurements = 0;
    SVGPathElement.prototype.getTotalLength = function getTotalLength() {
      if (this.getAttribute('d') === 'M 20 100 H 280') (window as any).__selectedPathMeasurements += 1;
      return original.call(this);
    };
  });
  await gotoLayout(page);
  await page.setInputFiles('input[accept=".svg"]', {
    name: 'measured-vector.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><path id="route" d="M 20 100 H 280" fill="none" stroke="#fff"/></svg>'),
  });
  const vector = page.locator('path[data-vector-path-id]').first();
  await vector.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('1 path selected')).toBeVisible();
  const measured = await page.evaluate(() => (window as any).__selectedPathMeasurements);
  expect(measured).toBeGreaterThan(0);

  await page.getByTitle('Toggle LED dots').click();
  await expect.poll(() => page.evaluate(() => (window as any).__selectedPathMeasurements)).toBe(measured);
});

test('reduced motion disables the selected path marching animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await gotoLayout(page);
  await page.setInputFiles('input[accept=".svg"]', {
    name: 'reduced-motion-vector.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><path id="route" d="M 20 100 H 280" fill="none" stroke="#fff"/></svg>'),
  });
  const vector = page.locator('path[data-vector-path-id]').first();
  await vector.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.lw-selected-path-march')).toHaveCSS('animation-name', 'none');
});

test('coarse targets keep primary Layout and wire controls at least 44 pixels', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await gotoLayout(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  for (const control of [
    page.getByTitle('Import an SVG to map LED strips'),
    page.getByTitle('Draw a new LED strip path on the artwork.'),
  ]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  await page.getByTestId('layout-mode-wire').click();
  await openWireStep(page, 'Wires', panel => panel.getByRole('group', { name: 'How many wires leave the card?' }));
  let box = await page.getByRole('group', { name: 'How many wires leave the card?' }).getByRole('button').first().boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await openWireStep(page, 'Match', panel => panel.getByRole('button', { name: /Outer circle IN port/ }));
  box = await page.getByRole('button', { name: /Outer circle IN port/ }).boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await openWireStep(page, 'Install', panel => panel.getByTestId('layout-send-to-card'));
  box = await page.getByTestId('layout-send-to-card').boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await context.close();
});

test('mobile Layout keeps a useful canvas and presents the inspector as a bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoLayout(page);
  const canvas = page.locator('.lw-viewport');
  const sheet = page.locator('.la .side');
  await expect(canvas).toBeVisible();
  await expect(sheet).toHaveCSS('position', 'absolute');
  const collapse = page.getByRole('button', { name: 'Collapse inspector' });
  await expect(collapse).toBeVisible();
  const collapseBox = await collapse.boundingBox();
  expect(collapseBox?.height).toBeGreaterThanOrEqual(44);
  const compactSheetBox = await sheet.boundingBox();
  expect(compactSheetBox?.height).toBeLessThanOrEqual(240);
  await collapse.click();
  await expect(page.getByRole('button', { name: 'Expand inspector' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand inspector' })).toHaveAttribute('aria-expanded', 'false');
  const canvasBox = await canvas.boundingBox();
  const sheetBox = await sheet.boundingBox();
  if (!canvasBox || !sheetBox) throw new Error('mobile canvas or inspector unavailable');
  const nonOverlappedCanvasHeight = Math.min(canvasBox.y + canvasBox.height, sheetBox.y) - canvasBox.y;
  expect(nonOverlappedCanvasHeight).toBeGreaterThan(300);
  await page.getByRole('button', { name: 'Expand inspector' }).click();
  await expect(page.getByRole('button', { name: 'Collapse inspector' })).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('layout-mode-wire').click();
  const wireSheetBox = await sheet.boundingBox();
  expect(wireSheetBox?.height).toBeGreaterThanOrEqual(300);
  expect(wireSheetBox?.height).toBeLessThanOrEqual(480);
});

test('mode toolbar only presents tools that apply while keeping secondary groups named', async ({ page }) => {
  await gotoLayout(page);
  const toolbar = page.locator('.la .toolbar');
  await expect(toolbar.getByRole('group', { name: 'Project' })).toBeVisible();
  await expect(toolbar.getByRole('group', { name: 'View' })).toBeVisible();
  await expect(page.getByTitle('Import an SVG to map LED strips')).toBeVisible();
  await expect(page.getByTitle('Draw a new LED strip path on the artwork.')).toBeVisible();
  await expect(page.getByTitle('Split one physical strip where the wire jumps to a new spot.')).toHaveCount(0);
  await expect(page.getByTitle('Join two strips into one continuous run.')).toHaveCount(0);

  await page.getByTestId('layout-mode-size').click();
  await expect(page.getByTitle('Import an SVG to map LED strips')).toHaveCount(0);
  await expect(page.getByTitle('Draw a new LED strip path on the artwork.')).toHaveCount(0);

  await page.getByTestId('layout-mode-wire').click();
  await expect(page.getByTitle('Split one physical strip where the wire jumps to a new spot.')).toBeVisible();
  await expect(page.getByTitle('Join two strips into one continuous run.')).toBeVisible();
  await expect(page.getByTitle('Import an SVG to map LED strips')).toHaveCount(0);
  await expect(page.getByTitle('Draw a new LED strip path on the artwork.')).toHaveCount(0);
});

test('focusable SVG strip supports Select, arrow nudge, and Delete', async ({ page }) => {
  await gotoLayout(page);
  // A fresh layout opens on the starter shape picker with no strips yet —
  // create one so a strip path exists to drive with the keyboard.
  const picker = page.getByTestId('layout-primitive-picker');
  await picker.getByRole('button', { name: 'Circle', exact: true }).click();
  await picker.getByRole('button', { name: 'Create circle' }).click();
  const strip = page.locator('path[data-strip-path]').first();
  await strip.focus();
  await page.keyboard.press('Enter');
  const parent = strip.locator('..');
  const before = await parent.getAttribute('transform');
  await page.keyboard.press('ArrowRight');
  await expect(parent).not.toHaveAttribute('transform', before || '');
  const count = await page.locator('path[data-strip-path]').count();
  await page.keyboard.press('Delete');
  await expect(page.locator('path[data-strip-path]')).toHaveCount(count - 1);
});

test('wire scaffold is concise and recovery actions stay hidden without a mixed-content failure', async ({ page }) => {
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  const guide = page.getByRole('region', { name: 'Wire setup guide' });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText('Match each run to its real data wire, then prove it on the LEDs.');
  await expect(page.getByRole('button', { name: 'Copy payload' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open installer' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});
