import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Phase 2 step 9 (docs/layout-redesign-plan.md) — the Wire-mode finish line:
// Send to card + Export ledmap.json. Reuses the `mockLocalCard` route pattern
// from workflow.spec.ts. The default project boots the two-circle hardware
// layout (strips already present), so Wire mode has a chain + a real config to
// push and export without importing an SVG.

async function mockLocalCard(page: any, options: any = {}) {
  const card = {
    savedConfig: null as any,
    candidateConfig: null as any,
    attemptedConfigs: [] as any[],
    operations: [] as string[],
    activationId: 'card-issued-layout-1',
    testing: false,
  };
  await page.route('http://lightweaver.local/**', async (route: any) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/status') {
      await route.fulfill({ json: { ok: true, led: { pixels: 44 }, wifi: { ip: 'lightweaver.local' } } });
      return;
    }
    if (pathname === '/api/firmware-info') {
      await route.fulfill({
        json: {
          ok: true,
          pixels: 44,
          outputs: options.currentOutputs || [{ id: 'out1', pin: 16, pixels: 44 }],
        },
      });
      return;
    }
    if (pathname === '/api/config') {
      card.operations.push('config');
      card.attemptedConfigs.push(JSON.parse(request.postData() || '{}'));
      if (options.delayConfig) await new Promise(resolve => setTimeout(resolve, options.delayConfig));
      if (options.failConfig) {
        await route.fulfill({ status: 500, json: { ok: false, error: 'boom' } });
        return;
      }
      card.savedConfig = JSON.parse(request.postData() || '{}');
      await route.fulfill({ json: { ok: true, requiresReboot: false } });
      return;
    }
    if (pathname === '/api/wiring/candidate') {
      card.operations.push('candidate');
      card.candidateConfig = JSON.parse(request.postData() || '{}').candidate;
      await route.fulfill({ json: {
        ok: true,
        state: 'staged',
        activationId: card.activationId,
        currentOutputs: card.candidateConfig?.led?.outputs || [],
      } });
      return;
    }
    if (pathname === '/api/wiring/activate') {
      card.operations.push('activate');
      card.testing = true;
      if (options.ambiguousActivate && !options.activationDropped) {
        options.activationDropped = true;
        await route.abort('connectionrefused');
        return;
      }
      await route.fulfill({ json: { ok: true, state: 'testing', activationId: card.activationId, remainingProbationMs: 90000 } });
      return;
    }
    if (pathname === '/api/wiring/status') {
      card.operations.push('status');
      await route.fulfill({ json: {
        ok: true,
        state: card.testing ? 'testing' : 'staged',
        activationId: card.activationId,
        remainingProbationMs: card.testing ? 84000 : 0,
        currentOutputs: card.candidateConfig?.led?.outputs || [],
      } });
      return;
    }
    if (pathname === '/api/wiring/rollback') {
      card.operations.push('rollback');
      card.testing = false;
      await route.fulfill({ json: { ok: true, state: 'rolled-back', activationId: card.activationId } });
      return;
    }
    if (pathname === '/api/wiring/confirm') {
      card.operations.push('confirm');
      card.testing = false;
      card.savedConfig = card.candidateConfig;
      await route.fulfill({ json: { ok: true, state: 'known-good', activationId: card.activationId } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  return card;
}

async function gotoWire(page: any, { verified = false, transformProject = null as null | ((project: any) => void) } = {}) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  await expect(page.getByTestId('layout-send-to-card')).toBeVisible();
  if (!verified) return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-send-ready-'));
  const pending = page.waitForEvent('download');
  await page.getByTitle('Save project file').click();
  const download = await pending;
  const source = path.join(tmp, 'source.json');
  await download.saveAs(source);
  const project = JSON.parse(fs.readFileSync(source, 'utf8'));
  project.layout.wiring.verified = true;
  project.layout.wiring.locked = true;
  project.layout.wiring.runs.forEach((run: any) => { run.verified = true; });
  transformProject?.(project);
  const ready = path.join(tmp, 'ready.json');
  fs.writeFileSync(ready, JSON.stringify(project));
  await page.addInitScript(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(project));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-send-to-card')).toBeEnabled();
}

test('Send to card stays disabled for default unverified wiring and makes no request', async ({ page }) => {
  const card = await mockLocalCard(page);
  await gotoWire(page);

  const send = page.getByTestId('layout-send-to-card');
  await expect(send).toBeDisabled();
  await expect(send).toContainText('Install on card');
  await expect(send.locator('.la-card-push-dot')).toHaveCount(1);
  await expect(page.getByTestId('layout-export-ledmap')).toHaveText('Download WLED map');
  await expect(page.getByTestId('layout-export-ledmap')).toHaveAttribute('title', 'File only — does not change the card');
  expect(card.operations).toEqual([]);
});

test('a successful push is pending until acknowledgement and records the exact installed revision', async ({ page }) => {
  const options = { delayConfig: 350 };
  const card = await mockLocalCard(page, options);
  await gotoWire(page, { verified: true });

  await page.getByTestId('layout-send-to-card').click();
  await expect(page.getByTestId('layout-send-to-card')).toBeDisabled();
  await expect(page.getByTestId('layout-send-to-card')).toContainText(/Installing/);

  const banner = page.locator('.la-card-push-banner');
  await expect(banner).toBeVisible({ timeout: 5000 });
  await expect(banner).toHaveClass(/is-ok/);
  await expect(banner).toContainText(/Installed revision \d+ on card/);
  await expect(banner).toContainText(/zone/i);
  expect(card.operations).toContain('config');
  expect(card.savedConfig).not.toBeNull();
});

test('candidate test locks conflicting saves, recovers an ambiguous activation, and rollback resolves with Retry', async ({ page }) => {
  const options = { ambiguousActivate: true, activationDropped: false };
  const card = await mockLocalCard(page, options);
  await gotoWire(page, {
    verified: true,
    transformProject(project: any) {
      const outer = project.layout.strips.find((strip: any) => strip.name === 'Outer circle');
      const outerRun = project.layout.wiring.runs.find((run: any) => run.source?.stripId === outer.id);
      outer.pixelCount = 26;
      outer.pixels = outer.pixels.slice(0, 26).map((pixel: any, index: number) => ({ ...pixel, index }));
      outerRun.source.to = 25;
      outerRun.seamLed = Math.min(Number(outerRun.seamLed) || 25, 25);
      project.layout.wiring.outputs[0].pin = 38;
    },
  });

  await page.getByTestId('layout-send-to-card').click();
  await expect(page.getByRole('region', { name: 'Wiring safety check' })).toBeVisible();
  await expect(page.getByTestId('layout-send-to-card')).toBeDisabled();
  expect(card.candidateConfig.led.pixels).toBe(43);
  expect(card.candidateConfig.led.outputs).toEqual([
    expect.objectContaining({ pin: 38, pixels: 43 }),
  ]);

  await page.getByRole('button', { name: 'Start 90-second test' }).click();
  await expect(page.getByText('Do you see the expected lights?')).toBeVisible();
  expect(card.operations).toContain('status');
  await expect(page.getByTestId('layout-send-to-card')).toBeDisabled();

  await page.getByRole('button', { name: 'No, restore working setup' }).click();
  const banner = page.locator('.la-card-push-banner');
  await expect(banner).toHaveClass(/is-err/);
  await expect(banner).toContainText('Restored the last working setup');
  await expect(banner.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(page.getByTestId('layout-send-to-card')).toBeEnabled();
  expect(card.operations).toContain('rollback');
});

test('a failed push retains the acknowledged installed revision and Retry installs successfully', async ({ page }) => {
  const options = { failConfig: false };
  const card = await mockLocalCard(page, options);
  await gotoWire(page, { verified: true });

  await page.getByTestId('layout-send-to-card').click();
  const banner = page.locator('.la-card-push-banner');
  await expect(banner).toHaveClass(/is-ok/);
  const installed = (await banner.textContent())?.match(/Installed revision (\d+)/)?.[1];
  expect(installed).toBeTruthy();

  options.failConfig = true;
  await page.getByTestId('layout-send-to-card').click();
  await expect(banner).toBeVisible({ timeout: 5000 });
  await expect(banner).toHaveClass(/is-err/);
  await expect(banner).toContainText(`Installed revision ${installed} remains on the card.`);
  await expect(banner.getByRole('button', { name: 'Retry' })).toBeVisible();

  const failedPayload = card.attemptedConfigs.at(-1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'New project' }).click();
  options.failConfig = false;
  await banner.getByRole('button', { name: 'Retry' }).click();
  await expect(banner).toHaveClass(/is-ok/);
  await expect(banner).toContainText(`Installed revision ${installed} on card`);
  expect(card.attemptedConfigs.at(-1)).toEqual(failedPayload);
});

test('Download WLED map exports a valid { n, map } file', async ({ page }) => {
  await mockLocalCard(page);
  await gotoWire(page);

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('layout-export-ledmap').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('ledmap.json');

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  expect(typeof json.n).toBe('number');
  expect(json.n).toBeGreaterThan(0);
  expect(Array.isArray(json.map)).toBe(true);
  expect(json.map.length).toBe(json.n);
  expect(json.map[0]).toHaveLength(2);
});

// Mixed-content fail (browser blocks HTTP push from an HTTPS designer) surfaces
// the read-only JSON fallback textarea. Not reproducible here: Playwright serves
// the app over plain HTTP, so `canPushDirectlyToCard('http:')` is always true
// and the mixed-content branch never triggers. Skipped until an HTTPS harness
// exists.
test.skip('mixed-content push shows the JSON fallback textarea', async () => {});
