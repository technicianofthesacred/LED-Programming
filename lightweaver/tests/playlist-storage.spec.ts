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

async function waitForUiCommit(page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function mockConnectedPlaylistCard(page, project, cardId = 'lw-playlist-install') {
  const runtime = preparedForProject(project).config;
  await page.addInitScript((identity) => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: identity }));
  }, cardId);
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId, firmwareVersion: '1.0.0', outputs: runtime.led.outputs }),
  }));
  await page.route('**/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, cardId, firmwareVersion: '1.0.0', led: { pixels: runtime.led.pixels } }),
  }));
  await page.route('**/api/zones', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, zones: runtime.zones }),
  }));
}

test('Playlist resolves a duplicate encoder press without pausing card setup', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  project.devices.standaloneController.controls.encoder.press = 6;
  await gotoPlaylist(page, project);

  await expect(page.locator('.pm')).toBeVisible();
  await expect(page.getByTestId('screen-error-fallback')).toHaveCount(0);
  await expect(page.getByTestId('playlist-hardware-warning')).toHaveCount(0);

  await expect(page.locator('.pl-row')).toHaveCount(2);
  await page.locator('.pl-row').first().getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.locator('.pl-row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Load playlist to card' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Copy chip config/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
});

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

test('Playlist install stays pending, fails with Retry, then remains confirmed until the next edit', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  await mockConnectedPlaylistCard(page, project);
  let configAttempt = 0;
  let releaseFailure: (() => void) | null = null;
  await page.route('**/api/config', async route => {
    configAttempt += 1;
    if (configAttempt === 1) {
      await new Promise<void>(resolve => { releaseFailure = resolve; });
      await route.fulfill({ status: 503, body: 'not ready' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await gotoPlaylist(page, project);

  const install = page.getByRole('button', { name: 'Load playlist to card' });
  await expect(install).toBeEnabled();
  await install.click();
  await expect(page.getByTestId('playlist-card-status')).toContainText('Installing playlist on card…');
  await expect.poll(() => Boolean(releaseFailure)).toBe(true);
  releaseFailure?.();

  const failure = page.getByTestId('playlist-card-status');
  await expect(failure).toHaveAttribute('role', 'alert');
  await expect(failure.getByRole('button', { name: 'Retry' })).toBeVisible();
  await failure.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('playlist-card-status')).toContainText('Playlist installed on card.');
  await expect(page.getByTestId('playlist-card-status')).toBeVisible();

  await page.locator('.pl-row').first().getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByTestId('playlist-card-status')).toHaveCount(0);
});

test('Playlist ignores a stale install success after the playlist is edited', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  await mockConnectedPlaylistCard(page, project, 'lw-playlist-stale-install-success');
  let releaseInstall: (() => void) | null = null;
  await page.route('**/api/config', async route => {
    await new Promise<void>(resolve => { releaseInstall = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await gotoPlaylist(page, project);

  await page.getByRole('button', { name: 'Load playlist to card' }).click();
  await expect.poll(() => Boolean(releaseInstall)).toBe(true);
  await page.locator('.pl-row').first().getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByTestId('playlist-card-status')).toHaveCount(0);

  const installResponse = page.waitForResponse(response => response.url().endsWith('/api/config'));
  releaseInstall?.();
  await installResponse;
  await waitForUiCommit(page);
  await expect(page.getByTestId('playlist-card-status')).toHaveCount(0);
  await expect(page.locator('.pl-row')).toHaveCount(3);
});

test('Playlist ignores a stale install failure after a newer live preview succeeds', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  await mockConnectedPlaylistCard(page, project, 'lw-playlist-stale-install-failure');
  let releaseInstall: (() => void) | null = null;
  await page.route('**/api/config', async route => {
    await new Promise<void>(resolve => { releaseInstall = resolve; });
    await route.fulfill({ status: 503, body: 'stale install failed' });
  });
  await page.route('**/api/control', route => {
    const request = JSON.parse(route.request().postData() || '{}');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        cardId: 'lw-playlist-stale-install-failure',
        patternId: request.patternId,
        revision: request.revision,
      }),
    });
  });
  await gotoPlaylist(page, project);

  await page.getByRole('button', { name: 'Load playlist to card' }).click();
  await expect.poll(() => Boolean(releaseInstall)).toBe(true);
  const firstRow = page.locator('.pl-row').first();
  await firstRow.getByRole('button', { name: 'Live' }).click();
  await expect(firstRow).toHaveClass(/\bis-live\b/);

  const installResponse = page.waitForResponse(response => response.url().endsWith('/api/config'));
  releaseInstall?.();
  await installResponse;
  await waitForUiCommit(page);
  await expect(page.getByTestId('playlist-card-status')).toHaveCount(0);
  await expect(firstRow).toHaveClass(/\bis-live\b/);
});

test('Playlist Reset live failure remains visible and retries the same bounded action', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  await mockConnectedPlaylistCard(page, project, 'lw-playlist-reset');
  let controlAttempts = 0;
  await page.route('**/api/control', route => {
    controlAttempts += 1;
    return route.abort('timedout');
  });
  await gotoPlaylist(page, project);

  await page.getByRole('button', { name: 'Reset live' }).click();
  const failure = page.getByTestId('playlist-card-status');
  await expect(failure).toContainText('The card did not answer in time.');
  await expect(failure.getByRole('button', { name: 'Retry' })).toBeVisible();
  await failure.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => controlAttempts).toBeGreaterThanOrEqual(2);
  await expect(failure).toBeVisible();
});

test('Playlist ignores a stale reset success after a newer live preview succeeds', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  await mockConnectedPlaylistCard(page, project, 'lw-playlist-stale-reset-success');
  let controlAttempt = 0;
  let releaseReset: (() => void) | null = null;
  await page.route('**/api/control', async route => {
    controlAttempt += 1;
    const request = JSON.parse(route.request().postData() || '{}');
    if (controlAttempt === 2) await new Promise<void>(resolve => { releaseReset = resolve; });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        cardId: 'lw-playlist-stale-reset-success',
        patternId: request.patternId,
        revision: request.revision,
      }),
    });
  });
  await gotoPlaylist(page, project);

  const rows = page.locator('.pl-row');
  await rows.first().getByRole('button', { name: 'Live' }).click();
  await expect(rows.first()).toHaveClass(/\bis-live\b/);
  await page.getByRole('button', { name: 'Reset live' }).click();
  await expect.poll(() => Boolean(releaseReset)).toBe(true);
  await rows.nth(1).getByRole('button', { name: 'Live' }).click();
  await expect(rows.nth(1)).toHaveClass(/\bis-live\b/);

  const resetResponse = page.waitForResponse(response => response.url().endsWith('/api/control'));
  releaseReset?.();
  await resetResponse;
  await waitForUiCommit(page);
  await expect(rows.nth(1)).toHaveClass(/\bis-live\b/);
  await expect(page.getByTestId('playlist-card-status')).toHaveCount(0);
});

test('Playlist ignores a stale reset failure after the playlist is edited', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  await mockConnectedPlaylistCard(page, project, 'lw-playlist-stale-reset-failure');
  let releaseReset: (() => void) | null = null;
  await page.route('**/api/control', async route => {
    await new Promise<void>(resolve => { releaseReset = resolve; });
    await route.abort('timedout');
  });
  await gotoPlaylist(page, project);

  await page.getByRole('button', { name: 'Reset live' }).click();
  await expect.poll(() => Boolean(releaseReset)).toBe(true);
  await page.locator('.pl-row').first().getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByTestId('playlist-card-status')).toHaveCount(0);

  const resetFailure = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/control'));
  releaseReset?.();
  await resetFailure;
  await waitForUiCommit(page);
  await expect(page.getByTestId('playlist-card-status')).toHaveCount(0);
  await expect(page.locator('.pl-row')).toHaveCount(3);
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

test('Playlist keeps the failure visible while dedicated light recovery runs and confirms success', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  let releaseRecovery: (() => void) | null = null;
  let recoveryCount = 0;
  await page.addInitScript(() => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-playlist-output-test' }));
  });
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-playlist-output-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/control', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, cardId: 'lw-playlist-output-test' }),
  }));
  await page.route('**/api/wiring/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, state: 'known-good', currentOutputs: [] }),
  }));
  await page.route('**/api/recover-lights', async route => {
    recoveryCount += 1;
    if (recoveryCount === 1) await new Promise<void>(resolve => { releaseRecovery = resolve; });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        accepted: true,
        diagnostics: { nonBlackPixels: 44, brightnessByte: 180 },
      }),
    });
  });
  await page.route('**/api/reboot', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));
  await gotoPlaylist(page, project);

  await page.locator('.pl-row').first().getByRole('button', { name: 'Live' }).click();
  const alert = page.getByTestId('playlist-card-status');
  await expect(alert).toContainText('The preview reached the card, but the lights did not confirm physical output.');
  const recoverButton = alert.getByRole('button', { name: 'Recover lights' });
  await recoverButton.click();

  await expect.poll(() => Boolean(releaseRecovery)).toBe(true);
  await expect(alert).toContainText('The preview reached the card, but the lights did not confirm physical output.');
  await expect(recoverButton).toBeDisabled();
  releaseRecovery?.();

  await expect.poll(() => recoveryCount).toBe(2);
  await expect(page.getByTestId('playlist-card-status')).toContainText('Recovery frame sent. Confirm warm white is visible on the physical lights.');
  await expect(page.getByTestId('playlist-card-status')).toHaveAttribute('role', 'status');
});

test('Playlist reports a bounded failure when dedicated light recovery is rejected', async ({ page }) => {
  const project = makePlaylistProject({ count: 2 });
  await page.addInitScript(() => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-playlist-output-test' }));
  });
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-playlist-output-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/control', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, cardId: 'lw-playlist-output-test' }),
  }));
  await page.route('**/api/wiring/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, state: 'known-good', currentOutputs: [] }),
  }));
  await page.route('**/api/recover-lights', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: false, accepted: false, privateReason: '<script>unsafe</script>' }),
  }));
  await gotoPlaylist(page, project);

  await page.locator('.pl-row').first().getByRole('button', { name: 'Live' }).click();
  const alert = page.getByTestId('playlist-card-status');
  await alert.getByRole('button', { name: 'Recover lights' }).click();

  await expect(alert).toContainText('Light recovery did not complete. The physical preview could not be confirmed. Check the card connection and try again.');
  await expect(alert).not.toContainText('unsafe');
});
