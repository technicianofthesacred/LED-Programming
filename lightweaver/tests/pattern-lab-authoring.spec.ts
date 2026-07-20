import { test, expect, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const AUTOSAVE_KEY = 'lw_autosave_v3';
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
  await expect(alert.locator('li')).toHaveCount(1);
  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText(nameBefore || 'Aurora');
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');
});

test('keeps the mapped preview first and controls touchable on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Base pattern').selectOption('aurora');

  const previewBox = await page.getByTestId('pattern-lab-mapped-preview').boundingBox();
  const controlsBox = await page.getByLabel('Pattern Lab controls').boundingBox();
  expect(previewBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(previewBox!.y).toBeLessThan(controlsBox!.y);

  const saveHeight = await page.getByRole('button', { name: 'Save private draft' }).evaluate(element => {
    return Number.parseFloat(getComputedStyle(element).height);
  });
  expect(saveHeight).toBeGreaterThanOrEqual(40);
  await expect(page.getByText('Advanced controls')).not.toHaveAttribute('open', '');
});
