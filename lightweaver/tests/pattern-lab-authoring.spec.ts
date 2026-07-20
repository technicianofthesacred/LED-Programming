import { test, expect, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const AUTOSAVE_KEY = 'lw_autosave_v3';
const PREVIEW_SOURCE = await readFile(fileURLToPath(new URL('../src/v3/PatternPreview.jsx', import.meta.url)), 'utf8');
const LAB_PREVIEW_SOURCE = await readFile(fileURLToPath(new URL('../src/pattern-lab/PatternLabPreview.jsx', import.meta.url)), 'utf8');
let cardMutationRequests: string[];

async function projectBytes(page) {
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).not.toBeNull();
  return page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY);
}

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

test('creates, compares, and reopens a long private pattern without changing the project', async ({ page }) => {
  const projectBefore = await projectBytes(page);

  await expect(page.getByText('No source selected')).toBeVisible();
  await page.getByLabel('Base pattern').selectOption('aurora');
  await expect(page.getByTestId('pattern-lab-mapped-preview').locator('canvas')).toBeVisible();
  await expect(page.getByText('Mapped to current artwork')).toBeVisible();

  await page.getByRole('slider', { name: 'Color', exact: true }).fill('72');
  await expect(page.getByLabel('Color value')).toHaveText('72%');
  await expect(page.getByText('Advanced controls')).not.toHaveAttribute('open', '');

  await page.getByRole('checkbox', { name: /Long Evolution/ }).check();
  await page.getByLabel('Evolution character').selectOption('tidal');
  await page.getByLabel('Duration (minutes)').fill('10');
  await page.getByLabel('Change amount').fill('48');

  await page.getByRole('button', { name: 'Beginning' }).click();
  await expect(page.getByLabel('Preview time')).toHaveValue('0');
  await page.getByRole('button', { name: 'Middle' }).click();
  await expect(page.getByLabel('Preview time')).toHaveValue('300');
  await expect(page.getByTestId('pattern-lab-time')).toHaveText('5:00 / 10:00');
  await page.getByRole('button', { name: 'End' }).click();
  await expect(page.getByLabel('Preview time')).toHaveValue('600');

  const seedBefore = await page.getByTestId('pattern-lab-seed').textContent();
  await page.getByRole('button', { name: 'Variation 3' }).click();
  await expect(page.getByTestId('pattern-lab-seed')).not.toHaveText(seedBefore || '');

  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Draft', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect(page.getByTestId('pattern-lab-save-status')).toContainText('Saved privately');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Open Aurora/ }).click();
  await expect(page.getByLabel('Evolution character')).toHaveValue('tidal');
  await expect(page.getByLabel('Duration (minutes)')).toHaveValue('10');
  await expect(page.getByRole('slider', { name: 'Color', exact: true })).toHaveValue('72');

  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).toBe(projectBefore);
  expect(cardMutationRequests).toEqual([]);
});

test('Play advances one bounded journey clock and Pause preserves it', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByRole('checkbox', { name: /Long Evolution/ }).check();
  await page.getByLabel('Duration (minutes)').fill('5');
  await page.getByRole('button', { name: 'Middle' }).click();
  const before = Number(await page.getByLabel('Preview time').inputValue());
  const canvasBefore = await page.getByTestId('pattern-lab-mapped-preview').locator('canvas').evaluate(canvas => canvas.toDataURL());

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Preview time').inputValue())).toBeGreaterThan(before + 0.2);
  await expect(page.getByTestId('pattern-lab-time')).not.toHaveText('2:30 / 5:00');
  const canvasAfter = await page.getByTestId('pattern-lab-mapped-preview').locator('canvas').evaluate(canvas => canvas.toDataURL());
  expect(canvasAfter).not.toBe(canvasBefore);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = Number(await page.getByLabel('Preview time').inputValue());
  await page.waitForTimeout(350);
  expect(Number(await page.getByLabel('Preview time').inputValue())).toBeCloseTo(paused, 3);

  await page.getByRole('button', { name: 'End' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Preview time').inputValue())).toBeLessThan(5);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});

test('selected recipe owns strips that entered the Lab with inherited pattern overrides', async ({ page }) => {
  await projectBytes(page);
  await page.evaluate(key => {
    const project = JSON.parse(localStorage.getItem(key)!);
    project.layout.strips = project.layout.strips.map(strip => ({ ...strip, patternId: 'fire' }));
    localStorage.setItem(key, JSON.stringify(project));
  }, AUTOSAVE_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });

  const signature = async () => {
    await page.waitForTimeout(650);
    return page.getByTestId('pattern-lab-mapped-preview').locator('canvas').evaluate(canvas => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (let index = 0; index < data.length; index += 97) hash = Math.imul(hash ^ data[index], 16777619);
      return hash >>> 0;
    });
  };

  await page.getByLabel('Base pattern').selectOption('fire');
  const fireSignature = await signature();
  await page.getByLabel('Base pattern').selectOption('gradient');
  const gradientSignature = await signature();
  expect(gradientSignature).not.toBe(fireSignature);
});

test('exports canonical recipes and rejects invalid imports without mutating the draft', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByRole('slider', { name: 'Movement', exact: true }).fill('64');
  const nameBefore = await page.getByTestId('pattern-lab-draft-name').textContent();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recipe' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.lwrecipe\.json$/);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadedPath!, 'utf8'));
  expect(exported.version).toBe(1);
  expect(exported.base.patternId).toBe('aurora');
  expect(exported.macros.movement).toBe(0.64);

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'broken.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 99, id: 'bad', name: 'Wrong recipe' })),
  });
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Could not import recipe');
  expect(await alert.locator('li').count()).toBeLessThanOrEqual(4);
  await expect(alert).toContainText('$.version');
  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText(nameBefore || 'Aurora');
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'invalid-fields.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      ...exported,
      base: { ...exported.base, patternId: 'not-a-built-in' },
      evolution: { ...exported.evolution, character: 'unknown-character' },
      layers: Array.from({ length: 4 }, (_, index) => ({ id: `layer-${index}` })),
      targets: Array.from({ length: 80 }, (_, index) => ({ id: `target-${index}` })),
    })),
  });
  await expect(alert.locator('li')).toHaveCount(4);
  await expect(alert).toContainText('$.base.patternId');
  await expect(alert).toContainText('$.evolution.character');
  await expect(alert).toContainText('$.layers');
  await expect(alert).toContainText('$.targets');
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'null-layer.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...exported, layers: [null] })),
  });
  await expect(alert.locator('li')).toHaveCount(1);
  await expect(alert).toContainText('$.layers[0]');
  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText(nameBefore || 'Aurora');
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'malformed-layer.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      ...exported,
      layers: [{ id: '', name: 42, blendMode: 'overlay', opacity: 2 }],
    })),
  });
  await expect(alert.locator('li')).toHaveCount(4);
  await expect(alert).toContainText('$.layers[0].id');
  await expect(alert).toContainText('$.layers[0].name');
  await expect(alert).toContainText('$.layers[0].blendMode');
  await expect(alert).toContainText('$.layers[0].opacity');
  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText(nameBefore || 'Aurora');
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'too-large.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(300 * 1024, 32),
  });
  await expect(alert).toContainText('file: must be smaller');
  await expect(alert.locator('li')).toHaveCount(1);
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');
});

test('uses an accessible lower controls drawer on a phone while keeping preview first', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const trigger = page.getByRole('button', { name: 'Pattern controls', exact: true });
  const preview = page.locator('.plab-preview');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(preview).toHaveAttribute('inert', '');
  await page.getByLabel('Base pattern').selectOption('aurora');
  await expect(page.getByTestId('pattern-lab-variation-preview')).toHaveCount(4);
  await page.getByRole('button', { name: 'Close pattern controls' }).click();

  const previewBox = await page.getByTestId('pattern-lab-mapped-preview').boundingBox();
  expect(previewBox).not.toBeNull();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Pattern Lab controls')).toHaveAttribute('aria-hidden', 'true');
  await expect(preview).not.toHaveAttribute('inert', '');
  await expect(page.getByTestId('pattern-lab-variation-preview')).toHaveCount(0);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Pattern Lab controls')).not.toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByLabel('Pattern Lab controls')).toHaveAttribute('role', 'dialog');

  const backdropBox = await page.getByRole('button', { name: 'Dismiss pattern controls' }).boundingBox();
  expect(backdropBox).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  const drawerBox = await page.getByLabel('Pattern Lab controls').boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox?.x).toBe(0);
  expect(drawerBox?.width).toBe(390);
  expect(Math.round((drawerBox?.y || 0) + (drawerBox?.height || 0))).toBe(844);

  const saveHeight = await page.getByRole('button', { name: 'Save private draft' }).evaluate(element => {
    return Number.parseFloat(getComputedStyle(element).height);
  });
  expect(saveHeight).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: 'Close pattern controls' }).click();
  const playHeight = await page.getByRole('button', { name: 'Play', exact: true }).evaluate(element => {
    return Number.parseFloat(getComputedStyle(element).height);
  });
  expect(playHeight).toBeGreaterThanOrEqual(44);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Advanced controls')).not.toHaveAttribute('open', '');
});

test('renders four mapped seed previews and does not mutate the draft until one is selected', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  const variants = page.getByTestId('pattern-lab-variants');
  await expect(variants.getByTestId('pattern-lab-variation-preview')).toHaveCount(4);
  await expect(variants.locator('canvas')).toHaveCount(4);
  const mainCanvas = page.getByTestId('pattern-lab-mapped-preview').locator('canvas');
  await page.waitForTimeout(350);
  const mainBefore = await mainCanvas.evaluate(canvas => canvas.toDataURL());
  await expect.poll(async () => {
    const signatures = await variants.locator('canvas').evaluateAll(canvases => canvases.map(canvas => canvas.toDataURL()));
    return new Set(signatures).size;
  }).toBe(4);
  const seedBefore = await page.getByTestId('pattern-lab-seed').textContent();
  const optionsBefore = await variants.locator('[data-seed]').evaluateAll(elements => elements.map(element => element.getAttribute('data-seed')));

  await page.getByRole('button', { name: 'New variation' }).click();
  const optionsAfter = await variants.locator('[data-seed]').evaluateAll(elements => elements.map(element => element.getAttribute('data-seed')));
  expect(optionsAfter).not.toEqual(optionsBefore);
  await expect(page.getByTestId('pattern-lab-seed')).toHaveText(seedBefore || '1');

  await page.getByRole('button', { name: 'Select variation 2' }).click();
  await expect(page.getByTestId('pattern-lab-seed')).not.toHaveText(seedBefore || '1');
  await expect.poll(() => mainCanvas.evaluate(canvas => canvas.toDataURL())).not.toBe(mainBefore);
  await page.getByRole('checkbox', { name: 'Lock seed choices' }).check();
  await expect(page.getByRole('button', { name: 'New variation' })).toBeDisabled();
});

test('shows storage read and write failures without claiming a private save', async ({ page }) => {
  await page.addInitScript(() => {
    const originalGet = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (String(key).startsWith('lw_pattern_lab_drafts')) throw new DOMException('Private reads blocked', 'SecurityError');
      return originalGet.call(this, key);
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/Private draft storage.*unavailable/i)).toBeVisible();
});

test('does not announce success when a private draft write fails', async ({ page }) => {
  await page.addInitScript(() => {
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith('lw_pattern_lab_drafts')) throw new DOMException('Private write blocked', 'QuotaExceededError');
      return originalSet.call(this, key, value);
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect(page.getByTestId('pattern-lab-save-status')).toContainText('Private write blocked');
  await expect(page.getByTestId('pattern-lab-save-status')).not.toContainText('Saved privately');
});

test('Advanced and optional Layers are collapsed safely', async ({ page }) => {
  await expect(page.locator('details.plab-advanced')).toHaveCount(0);
  const inertAdvanced = page.getByText('Advanced controls');
  await expect(inertAdvanced).toHaveAttribute('aria-disabled', 'true');

  await page.getByLabel('Base pattern').selectOption('aurora');
  const advanced = page.locator('details.plab-advanced').filter({ hasText: 'Advanced controls' });
  await expect(advanced).not.toHaveAttribute('open', '');
  expect(await advanced.locator('summary').evaluate(element => Number.parseFloat(getComputedStyle(element).height))).toBeGreaterThanOrEqual(44);
  const layers = page.getByTestId('pattern-lab-layers');
  await expect(layers).toBeVisible();
  await expect(layers).not.toHaveAttribute('open', '');
});

test('PatternPreview exposes a controlled renderer clock without a per-pixel wrapper', () => {
  expect(PREVIEW_SOURCE).toContain('controlledTime = null');
  expect(PREVIEW_SOURCE).toContain('renderTime');
  expect(LAB_PREVIEW_SOURCE).not.toContain('return (...args)');
  expect(LAB_PREVIEW_SOURCE).not.toContain('const shifted = [...args]');
});
