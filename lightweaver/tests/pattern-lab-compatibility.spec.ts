import { test, expect, type Route } from '@playwright/test';

const AUTOSAVE_KEY = 'lw_autosave_v3';
let cardMutationRequests: string[];

const SECTION_RECIPE = {
  version: 1,
  id: 'section-source',
  name: 'Section source',
  base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
  palette: ['#120703', '#ff9d45'],
  macros: { color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5, energy: 0.5 },
  evolution: { enabled: true, character: 'slow-bloom', durationSeconds: 600, change: 0.35 },
  seed: 17,
  layers: [],
  targets: [{ kind: 'section', id: 'outer-ring' }],
  requirements: [],
  provenance: [],
  estimates: { pixelCount: 1, operationsPerFrame: 1, stateBytes: 1, framebufferBytes: 3 },
};

const BLACK_RECIPE = {
  ...SECTION_RECIPE,
  id: 'black-frame-source',
  name: 'Black frame source',
  base: { kind: 'lightweaver-pattern', patternId: 'gradient', params: {} },
  palette: ['#000000', '#000000'],
  targets: [{ kind: 'whole-piece', id: 'all' }],
};

test.beforeEach(async ({ page }) => {
  cardMutationRequests = [];
  const blockCard = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'GET') cardMutationRequests.push(`${request.method()} ${request.url()}`);
    await route.abort();
  };
  await page.route('http://lightweaver.local/**', blockCard);
  await page.route('http://192.168.4.1/**', blockCard);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
});

test('exposes card compatibility and clock-linked diagnostics without mutating the source recipe', async ({ page }) => {
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).not.toBeNull();
  const projectBefore = await page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY);
  await page.getByLabel('Base pattern').selectOption('aurora');

  const tools = page.getByTestId('pattern-lab-runtime-tools');
  await expect(tools).toBeVisible();
  await expect(tools).not.toHaveAttribute('open', '');
  const toolsSummary = tools.locator(':scope > summary');
  await expect(toolsSummary).toHaveText(/Card compatibility & diagnostics/);
  expect(await toolsSummary.evaluate(element => Number.parseFloat(getComputedStyle(element).height))).toBeGreaterThanOrEqual(44);
  await toolsSummary.click();

  const compatibility = page.getByTestId('pattern-lab-export');
  await expect(compatibility).toBeVisible();
  const outcomes = tools.getByLabel('Card compatibility outcomes');
  for (const label of ['Live on card', 'Bake to card', 'Simplify for card', 'Studio only']) {
    await expect(outcomes.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(outcomes.locator('[aria-current="true"]')).toHaveText('Live on card');
  await expect(compatibility.locator('[data-classification]')).toHaveAttribute(
    'data-classification',
    /^(live-on-card|bake-to-card|simplify-for-card|studio-only)$/,
  );
  await expect(compatibility.getByLabel('Card compatibility budgets')).toContainText('Pixels');
  await expect(compatibility.getByLabel('Card compatibility budgets')).toContainText('Frames / second');
  await expect(compatibility.getByLabel('Card compatibility budgets')).toContainText('State memory');
  await expect(compatibility.getByLabel('Card compatibility budgets')).toContainText('Framebuffer');

  const diagnostics = page.getByTestId('pattern-lab-diagnostics');
  await diagnostics.locator(':scope > summary').click();
  await expect(diagnostics.getByRole('heading', { name: 'Why is this dark?' })).toBeVisible();
  await expect(diagnostics).toContainText(/No known mask|brightness is at zero|active mask removes/);

  const time = page.getByLabel('Preview time');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(diagnostics.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await diagnostics.getByRole('button', { name: 'Pause', exact: true }).click();
  const pausedTime = Number(await time.inputValue());
  await page.waitForTimeout(150);
  expect(Number(await time.inputValue())).toBeCloseTo(pausedTime, 2);

  const frameBefore = Number(await diagnostics.locator('.plab-diagnostic-playback strong').textContent());
  const preciseTimeBefore = Number(await tools.getAttribute('data-preview-time'));
  await diagnostics.getByRole('button', { name: 'Step one frame' }).click();
  await expect.poll(async () => Number(await diagnostics.locator('.plab-diagnostic-playback strong').textContent()))
    .toBe(frameBefore + 1);
  expect(Number(await tools.getAttribute('data-preview-time'))).toBeGreaterThan(preciseTimeBefore);

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'section-source.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(SECTION_RECIPE)),
  });
  await expect(tools).toHaveAttribute('data-source-recipe-id', 'section-source');
  await expect(tools).toHaveAttribute('data-draft-recipe-id', 'section-source');
  const sourceSnapshot = await tools.getAttribute('data-source-recipe-snapshot');
  await expect(compatibility.locator('[data-classification]')).toHaveAttribute('data-classification', 'simplify-for-card');
  await expect(compatibility.getByLabel('Card compatibility budgets')).not.toContainText('Operations / frameUnknown');
  await expect(diagnostics).toContainText('outside the active or supported target');
  await tools.getByRole('button', { name: 'Create simplified variant' }).click();
  await expect(tools).toHaveAttribute('data-source-recipe-id', 'section-source');
  await expect(tools).toHaveAttribute('data-source-recipe-snapshot', sourceSnapshot || '');
  await expect(tools).toHaveAttribute('data-draft-recipe-id', 'section-source-simplified');
  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText('Section source — Card variant');
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).toBe(projectBefore);
  expect(cardMutationRequests).toEqual([]);
});

test('keeps the advanced tools usable in the phone controls drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Pattern controls', exact: true }).click();
  await page.getByLabel('Base pattern').selectOption('aurora');

  const tools = page.getByTestId('pattern-lab-runtime-tools');
  await tools.locator(':scope > summary').click();
  await expect(page.getByTestId('pattern-lab-export')).toBeVisible();
  const step = page.getByTestId('pattern-lab-diagnostics').getByRole('button', { name: 'Step one frame' });
  await page.getByTestId('pattern-lab-diagnostics').locator(':scope > summary').click();
  expect(await step.evaluate(element => Number.parseFloat(getComputedStyle(element).height))).toBeGreaterThanOrEqual(44);

  const drawer = page.getByLabel('Pattern Lab controls');
  const overflow = await drawer.evaluate(element => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('fails closed when a draft layer has no authoritative runtime estimates', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByTestId('pattern-lab-layers').locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Add layer' }).click();
  await page.getByTestId('pattern-lab-runtime-tools').locator(':scope > summary').click();

  const compatibility = page.getByTestId('pattern-lab-export');
  await expect(compatibility.locator('[data-classification]')).toHaveAttribute('data-classification', 'studio-only');
  await expect(compatibility.getByLabel('Card compatibility budgets')).toContainText('Pixels');
  await expect(compatibility.getByLabel('Card compatibility budgets')).toContainText('Operations / frameUnknown');
  await expect(compatibility.getByLabel('Card compatibility budgets')).toContainText('State memoryUnknown');
  await expect(compatibility).toContainText('has no concrete generator');
  await expect(page.getByTestId('pattern-lab-diagnostics')).toHaveCount(0);
});

test('explains when every visible strip has zero brightness', async ({ page }) => {
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).not.toBeNull();
  await page.evaluate(key => {
    const project = JSON.parse(localStorage.getItem(key) || '{}');
    project.layout.strips = project.layout.strips.map((strip: Record<string, unknown>) => ({
      ...strip,
      brightness: 0,
    }));
    localStorage.setItem(key, JSON.stringify(project));
  }, AUTOSAVE_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByTestId('pattern-lab-runtime-tools').locator(':scope > summary').click();
  const diagnostics = page.getByTestId('pattern-lab-diagnostics');
  await diagnostics.locator(':scope > summary').click();

  await expect(diagnostics).toContainText('Every visible strip has zero brightness.');
  await expect(diagnostics).not.toContainText('No known mask, brightness, gamma, power, output, or target issue was detected.');
});

test('explains an observed all-black preview frame without inventing invalid output', async ({ page }) => {
  await page.getByLabel('Import recipe').setInputFiles({
    name: 'black-frame-source.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(BLACK_RECIPE)),
  });
  await expect(page.getByTestId('pattern-lab-mapped-preview')).toHaveAttribute('data-worker-state', 'frame');
  await page.getByTestId('pattern-lab-runtime-tools').locator(':scope > summary').click();
  const diagnostics = page.getByTestId('pattern-lab-diagnostics');
  await diagnostics.locator(':scope > summary').click();

  await expect(diagnostics).toContainText('Every sampled pixel in the last preview frame is black.');
  await expect(diagnostics).not.toContainText('The generator returned an invalid or non-finite color.');
  await expect(diagnostics).not.toContainText('No known mask, brightness, gamma, power, output, or target issue was detected.');
});

test('downloads xLights, MADRIX, and Art-Net setup files from verified physical wiring', async ({ page }) => {
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).not.toBeNull();
  await page.evaluate(key => {
    const project = JSON.parse(localStorage.getItem(key) || '{}');
    project.name = 'Export & Sculpture';
    project.layout.wiring = {
      ...project.layout.wiring,
      locked: true,
      verified: true,
      migrationWarnings: [],
      runs: project.layout.wiring.runs.map((run: Record<string, unknown>) => ({ ...run, verified: true })),
    };
    localStorage.setItem(key, JSON.stringify(project));
  }, AUTOSAVE_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByTestId('pattern-lab-runtime-tools').locator(':scope > summary').click();

  const downloads = [
    ['Export xLights model', '.xmodel', [
      /<custommodel .*name="Export &amp; Sculpture".*CustomStrings="1" NodeStart1="1" Controller="[^"]+"/,
      /<ControllerConnection Port="1" Protocol="ws2811"\/>/,
    ]],
    ['Export MADRIX fixture CSV', '.madrix-fixtures.csv', [/^Product,Display Name,Fixture ID/m]],
    ['Export Art-Net setup notes', '.artnet-setup.txt', [/^# Lightweaver Art-Net Setup/m]],
  ] as const;
  for (const [label, suffix, contentChecks] of downloads) {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: label, exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(new RegExp(`${suffix.replaceAll('.', '\\.')}$`));
    const stream = await download.createReadStream();
    let body = '';
    for await (const chunk of stream) body += chunk.toString();
    for (const content of contentChecks) expect(body).toMatch(content);
  }
  await expect(page.getByTestId('pattern-lab-layout-export-status')).toContainText('Exported Art-Net setup notes');
});

test('starts and safely cancels a real baked card export', async ({ page }) => {
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).not.toBeNull();
  await page.evaluate(key => {
    const project = JSON.parse(localStorage.getItem(key) || '{}');
    project.layout.wiring = {
      ...project.layout.wiring,
      locked: true,
      verified: true,
      migrationWarnings: [],
      runs: project.layout.wiring.runs.map((run: Record<string, unknown>) => ({ ...run, verified: true })),
    };
    localStorage.setItem(key, JSON.stringify(project));
  }, AUTOSAVE_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('generator:particles');
  await page.getByTestId('pattern-lab-runtime-tools').locator(':scope > summary').click();

  const cardExport = page.getByTestId('pattern-lab-export');
  await expect(cardExport.locator('[data-classification]')).toHaveAttribute('data-classification', 'bake-to-card');
  await cardExport.getByRole('button', { name: 'Bake to card' }).click();
  await cardExport.getByRole('button', { name: 'Cancel bake' }).click();
  await expect(page.getByTestId('pattern-lab-bake-status')).toContainText('Bake canceled');
});
