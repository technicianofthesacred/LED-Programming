import { test, expect } from '@playwright/test';
import { createDefaultProject, migrateProject } from '../src/lib/projectModel.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';
import { prepareCardStoragePayload } from '../src/lib/cardStoragePayload.js';
import { CARD_PATTERN_BANK } from '../src/lib/cardPatternBank.js';

function makePlaylistProject({ count = 19, oversized = false } = {}) {
  const project = createDefaultProject();
  project.id = oversized ? 'oversized-playlist-export' : 'nineteen-look-playlist-export';
  project.name = oversized ? 'Oversized playlist export' : 'Nineteen look playlist export';
  const patterns = CARD_PATTERN_BANK.slice(0, count);
  project.devices.standaloneController.playlist = patterns.map((pattern, order) => ({
    id: pattern.id,
    label: oversized ? `${pattern.label} ${'oversized-label-'.repeat(24)}` : pattern.label,
    type: 'pattern',
    patternId: pattern.id,
    enabled: true,
    order,
  }));
  project.devices.standaloneController.controls.encoder.patternCycleIds = patterns.map(pattern => pattern.id);
  return project;
}

function preparedForProject(input) {
  const project = migrateProject(input);
  return prepareCardStoragePayload(buildCardRuntimePackageFromProject({
    projectId: project.id,
    projectName: project.name,
    strips: project.layout.strips,
    patchBoard: project.layout.patchBoard,
    standaloneController: project.devices.standaloneController,
  }));
}

async function gotoPlaylist(page, project) {
  await page.addInitScript((savedProject) => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(savedProject));
  }, project);
  await page.goto('/#screen=playlist', { waitUntil: 'domcontentloaded' });
}

test('Playlist copy and download equal the canonical compact 19-look payload', async ({ page }) => {
  const project = makePlaylistProject();
  const expected = preparedForProject(project);
  expect(expected.bytes).toBeLessThanOrEqual(3968);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => { (window as any).__copiedPlaylistConfig = text; },
      },
    });
  });
  await gotoPlaylist(page, project);

  await page.getByRole('button', { name: /Copy chip config/ }).click();
  const copied = await page.evaluate(() => (window as any).__copiedPlaylistConfig || '');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloaded = Buffer.concat(chunks).toString('utf8');

  expect(copied).toBe(expected.json);
  expect(downloaded).toBe(expected.json);
  expect(copied).not.toContain('\n');
});

test('Playlist overflow blocks clipboard, blob, and download side effects with exact feedback', async ({ page }) => {
  const project = makePlaylistProject({ count: 32, oversized: true });
  let capacityError: any = null;
  try {
    preparedForProject(project);
  } catch (error) {
    capacityError = error;
  }
  expect(capacityError?.reason).toBe('config-too-large');
  await page.addInitScript(() => {
    (window as any).__playlistExportEffects = { clipboard: 0, objectUrl: 0, anchorClick: 0 };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => { (window as any).__playlistExportEffects.clipboard += 1; },
      },
    });
    URL.createObjectURL = () => {
      (window as any).__playlistExportEffects.objectUrl += 1;
      return 'blob:unexpected';
    };
    HTMLAnchorElement.prototype.click = function click() {
      (window as any).__playlistExportEffects.anchorClick += 1;
    };
  });
  await gotoPlaylist(page, project);

  await page.getByRole('button', { name: /Copy chip config/ }).click();
  await expect(page.getByTestId('playlist-card-status')).toBeVisible();
  expect(await page.getByTestId('playlist-card-status').evaluate(node => node.childNodes[0]?.textContent)).toBe(capacityError.message);
  expect(await page.evaluate(() => (window as any).__playlistExportEffects)).toEqual({
    clipboard: 0,
    objectUrl: 0,
    anchorClick: 0,
  });

  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(page.getByTestId('playlist-card-status')).toBeVisible();
  expect(await page.getByTestId('playlist-card-status').evaluate(node => node.childNodes[0]?.textContent)).toBe(capacityError.message);
  expect(await page.evaluate(() => (window as any).__playlistExportEffects)).toEqual({
    clipboard: 0,
    objectUrl: 0,
    anchorClick: 0,
  });
});

test('Playlist marks a row physical only after the paired card acknowledges the latest intent', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  let releaseControl: (() => void) | null = null;
  await page.addInitScript(() => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-playlist-test' }));
  });
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-playlist-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/control', async route => {
    const request = JSON.parse(route.request().postData() || '{}');
    await new Promise<void>(resolve => { releaseControl = resolve; });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        cardId: 'lw-playlist-test',
        patternId: request.patternId,
        revision: request.revision,
      }),
    });
  });
  await gotoPlaylist(page, project);

  const firstRow = page.locator('.pl-row').first();
  await firstRow.getByRole('button', { name: 'Live' }).click();
  await expect(page.getByTestId('playlist-physical-preview-status')).toHaveText('Sending to Lightweaver');
  await expect(firstRow).not.toHaveClass(/\bis-live\b/);
  await expect.poll(() => Boolean(releaseControl)).toBe(true);
  releaseControl?.();
  await expect(page.getByTestId('playlist-physical-preview-status')).toHaveText('Playing on Lightweaver');
  await expect(firstRow).toHaveClass(/\bis-live\b/);
});

test('Playlist transport timeout keeps its prior live row and offers a bounded retry', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  await page.addInitScript(() => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-playlist-test' }));
  });
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-playlist-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/control', route => route.abort('timedout'));
  await gotoPlaylist(page, project);

  await page.locator('.pl-row').first().getByRole('button', { name: 'Live' }).click();
  const alert = page.getByTestId('playlist-card-status');
  await expect(alert).toContainText('The card did not answer in time. Reconnect if needed, then retry the physical preview.');
  await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
});

test('Playlist unconfirmed physical output routes Recover lights to reset live', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  let controlCount = 0;
  await page.addInitScript(() => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-playlist-output-test' }));
  });
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-playlist-output-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/zones', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, zones: [] }),
  }));
  await page.route('**/api/control', route => {
    controlCount += 1;
    const request = JSON.parse(route.request().postData() || '{}');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(controlCount === 1
        ? { ok: true, cardId: 'lw-playlist-output-test' }
        : { ok: true, cardId: 'lw-playlist-output-test', patternId: request.patternId }),
    });
  });
  await gotoPlaylist(page, project);

  await page.locator('.pl-row').first().getByRole('button', { name: 'Live' }).click();
  const alert = page.getByTestId('playlist-card-status');
  await expect(alert).toContainText('The preview reached the card, but the lights did not confirm physical output.');
  await alert.getByRole('button', { name: 'Recover lights' }).click();

  await expect.poll(() => controlCount).toBe(2);
  await expect(alert).toHaveCount(0);
});
