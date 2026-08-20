import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testPort as port } from './testPort.mjs';

const TEST_CARD_ID = 'lw-layout-tests';
const TEST_BUILD_ID = 'a'.repeat(40);

// Project export runs through the ONE download implementation
// (src/lib/projectTransfer.js), which prefers the File System Access save
// picker. Headless Chromium can never show that dialog, so stub it out (as
// tests/show-screen.spec.ts does) so the export falls back to the anchor
// download that `page.waitForEvent('download')` observes.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { (window as any).showSaveFilePicker = undefined; });
});

// Test & Install finish line: one card installation path. Reuses the
// `mockLocalCard` route pattern
// from workflow.spec.ts. The default project boots the two-circle hardware
// layout (strips already present), so Wire mode has a chain + a real config to
// push without importing an SVG.

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
      const outputs = card.savedConfig?.led?.outputs || options.currentOutputs || [{ id: 'out1', pin: 16, pixels: 44 }];
      await route.fulfill({ json: {
        app: 'Lightweaver',
        ok: true,
        cardId: TEST_CARD_ID,
        firmwareVersion: '1.0.0',
        buildId: TEST_BUILD_ID,
        runtimePhase: 'ready',
        knownGoodProject: true,
        commandReady: true,
        outputReady: true,
        playbackReady: true,
        projectId: card.savedConfig?.piece?.id || '',
        projectRevision: card.savedConfig?.projectRevision ?? 0,
        projectFingerprint: card.savedConfig?.projectFingerprint ?? '',
        led: card.savedConfig?.led || {
          pixels: 44,
          maxMilliamps: 1500,
          colorOrder: 'RGB',
          outputGammaEnabled: false,
          outputGammaValue: 2.2,
          calibration: { red: 1, green: 1, blue: 1 },
        },
        outputs: outputs.map((output: any) => ({
          ...output,
          segments: output.segments || [{ id: `${output.id || 'out1'}-full`, count: output.pixels, direction: output.direction || 'forward' }],
        })),
        wifi: { ip: 'lightweaver.local' },
      } });
      return;
    }
    if (pathname === '/api/firmware-info') {
      await route.fulfill({
        json: {
          ok: true,
          app: 'Lightweaver',
          cardId: TEST_CARD_ID,
          firmwareVersion: '1.0.0',
          buildId: TEST_BUILD_ID,
          pixels: 44,
          outputs: options.currentOutputs || [{ id: 'out1', pin: 16, pixels: 44 }],
          projectRevision: card.savedConfig?.projectRevision ?? 0,
          projectFingerprint: card.savedConfig?.projectFingerprint ?? '',
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
      const hasCandidate = Boolean(card.candidateConfig);
      const candidateState = hasCandidate
        ? (card.testing ? 'awaiting-confirmation' : 'staged')
        : 'none';
      const state = hasCandidate
        ? (card.testing ? 'testing' : 'staged')
        : 'known-good';
      const identity = hasCandidate ? card.candidateConfig : card.savedConfig;
      await route.fulfill({ json: {
        ok: true,
        state,
        candidateState,
        hasCandidate,
        cardId: TEST_CARD_ID,
        firmwareVersion: '1.0.0',
        buildId: TEST_BUILD_ID,
        ...(hasCandidate ? { activationId: card.activationId } : {}),
        projectRevision: identity?.projectRevision ?? 0,
        projectFingerprint: identity?.projectFingerprint ?? '',
        productionJobId: identity?.productionJobId ?? '',
        productionJobDigest: identity?.productionJobDigest ?? '',
        wiringRevision: identity?.wiringRevision ?? 0,
        wiringDigest: identity?.wiringDigest ?? '',
        ledType: identity?.led?.type || 'WS2812B',
        colorOrder: identity?.led?.colorOrder || 'RGB',
        maxMilliamps: identity?.led?.maxMilliamps ?? 1500,
        nextStep: hasCandidate
          ? (card.testing ? 'confirm-or-rollback' : 'activate')
          : 'stage-candidate',
        remainingProbationMs: card.testing ? 84000 : 0,
        currentOutputs: (card.savedConfig?.led?.outputs || options.currentOutputs || [{ id: 'out1', pin: 16, pixels: 44 }]),
        ...(hasCandidate ? { candidateOutputs: card.candidateConfig?.led?.outputs || [] } : {}),
      } });
      return;
    }
    if (pathname === '/api/wiring/rollback') {
      card.operations.push('rollback');
      card.testing = false;
      card.candidateConfig = null;
      await route.fulfill({ json: { ok: true, state: 'rolled-back', activationId: card.activationId } });
      return;
    }
    if (pathname === '/api/wiring/confirm') {
      card.operations.push('confirm');
      card.testing = false;
      card.savedConfig = card.candidateConfig;
      card.candidateConfig = null;
      await route.fulfill({ json: { ok: true, state: 'known-good', activationId: card.activationId } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  return card;
}

async function gotoWire(page: any, { verified = false, transformProject = null as null | ((project: any) => void), url = '/#screen=layout&mode=wire' } = {}) {
  await page.addInitScript(cardId => {
    localStorage.clear();
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: cardId }));
  }, TEST_CARD_ID);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  if (!verified) {
    // Unverified wiring exposes no install control — only the LED-check CTA.
    await expect(page.getByTestId('start-led-check')).toBeVisible();
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-send-ready-'));
  await page.waitForTimeout(600);
  const pending = page.waitForEvent('download');
  await page.locator('.la .toolbar').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await pending;
  const source = path.join(tmp, 'source.json');
  await download.saveAs(source);
  const project = JSON.parse(fs.readFileSync(source, 'utf8'));
  project.layout.wiring.verified = true;
  project.layout.wiring.locked = true;
  project.layout.wiring.runs.forEach((run: any) => { run.verified = true; });
  const led = project.devices.standaloneController.led;
  led.colorOrder = led.colorOrder || 'RGB';
  led.colorOrderConfirmed = true;
  led.confirmedColorOrder = led.colorOrder;
  transformProject?.(project);
  const ready = path.join(tmp, 'ready.json');
  fs.writeFileSync(ready, JSON.stringify(project));
  await page.addInitScript(value => localStorage.setItem('lw_autosave_v3', value), JSON.stringify(project));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  // The seeded project is fully verified, so the primary flow area settles on
  // the install control. Wait for the enabled state instead of sampling early.
  await expect(page.getByText('Checked ✓ — install it on the card.')).toBeVisible();
  await expect(page.getByTestId('layout-send-to-card')).toBeEnabled();
}

async function proxyStudioOverHttps(page: any) {
  await page.route('https://led.mandalacodes.com/**', async (route: any) => {
    const requested = new URL(route.request().url());
    const localUrl = `http://localhost:${port}${requested.pathname}${requested.search}`;
    const response = await route.fetch({ url: localUrl });
    await route.fulfill({ response });
  });
  await page.addInitScript(() => {
    (window as any).__copiedPayload = '';
    (window as any).__openedInstaller = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value: string) {
          (window as any).__copiedPayload = value;
          return Promise.resolve();
        },
      },
    });
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      (window as any).__openedInstaller = { url: String(url), target, features };
      return null;
    }) as typeof window.open;
  });
}

test('unverified wiring exposes no install control and makes no request', async ({ page }) => {
  const card = await mockLocalCard(page);
  await gotoWire(page);

  // The install surface only exists after the LED check verifies the wiring.
  // No install control or alternate export path is available yet.
  await expect(page.getByTestId('layout-send-to-card')).toHaveCount(0);
  await expect(page.getByTestId('advanced-installation-tools')).toHaveJSProperty('open', false);
  await expect(page.getByTestId('layout-export-ledmap')).toHaveCount(0);
  await expect(page.getByTestId('start-led-check')).toBeVisible();
  expect(card.operations).toEqual([]);
});

test('a successful push is pending until acknowledgement and records the exact installed revision', async ({ page }) => {
  const options = { delayConfig: 350 };
  const card = await mockLocalCard(page, options);
  await gotoWire(page, { verified: true });

  await page.getByTestId('layout-send-to-card').click();
  await expect(page.getByTestId('layout-send-to-card')).toBeDisabled();
  await expect(page.getByTestId('layout-send-to-card')).toContainText(/Sending/);

  const banner = page.locator('.la-card-push-banner');
  await expect(banner).toBeVisible({ timeout: 10000 });
  await expect(banner).toHaveClass(/is-ok/);
  await expect(banner).toContainText(/Installed revision \d+ on card/);
  await expect(banner).toContainText(/zone/i);
  await expect.poll(() => page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('lw_project_lifecycle_v1') || '{}').installation))).toBe(true);
  await expect(page.getByTestId('workspace-notice')).toHaveCount(0);
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
      project.layout.wiring.outputs[0].pin = 17;
    },
  });

  await page.getByTestId('layout-send-to-card').click();
  await expect(page.getByRole('region', { name: 'Wiring safety check' })).toBeVisible();
  await expect(page.getByTestId('layout-send-to-card')).toBeDisabled();
  expect(card.candidateConfig.led.pixels).toBe(43);
  expect(card.candidateConfig.led.outputs).toEqual([
    expect.objectContaining({ pin: 17, pixels: 43 }),
  ]);

  await page.getByRole('button', { name: 'Start light test' }).click();
  await expect(page.getByText('Do you see the expected lights?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'The lights look correct', exact: true })).toBeVisible();
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
  await expect(banner).toBeVisible({ timeout: 10000 });
  await expect(banner).toHaveClass(/is-err/);
  await expect(banner).toContainText(`Confirmed revision ${installed} remains on the card.`);
  await expect(banner.getByRole('button', { name: 'Retry' })).toBeVisible();

  const failedPayload = card.attemptedConfigs.at(-1);
  options.failConfig = false;
  await banner.getByRole('button', { name: 'Retry' }).click();
  await expect(banner).toHaveClass(/is-ok/);
  await expect(banner).toContainText(`Installed revision ${installed} on card`);
  expect(card.attemptedConfigs.at(-1)).toEqual(failedPayload);
});

test('mixed-content recovery copies JSON, opens the installer, and retries the same bounded attempt', async ({ page }) => {
  await proxyStudioOverHttps(page);
  await gotoWire(page, {
    verified: true,
    url: 'https://led.mandalacodes.com/#screen=layout&mode=wire',
  });

  await page.getByTestId('layout-send-to-card').click();
  const recovery = page.getByRole('group', { name: 'Mixed-content recovery' });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Copy payload' })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Open installer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();

  await recovery.getByRole('button', { name: 'Copy payload' }).click();
  const firstPayload = await page.evaluate(() => (window as any).__copiedPayload);
  expect(() => JSON.parse(firstPayload)).not.toThrow();

  await recovery.getByRole('button', { name: 'Open installer' }).click();
  const opened = await page.evaluate(() => (window as any).__openedInstaller);
  expect(opened.target).toBe('lightweaver-card-bridge');
  const handoff = new URL(opened.url);
  expect(handoff.origin).toBe('http://lightweaver.local');
  expect(new URLSearchParams(handoff.hash.slice(1)).get('lwconfig')).toBeTruthy();
  expect(new URLSearchParams(handoff.hash.slice(1)).get('reboot')).toBe('1');

  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(recovery).toBeVisible();
  await page.evaluate(() => { (window as any).__copiedPayload = ''; });
  await recovery.getByRole('button', { name: 'Copy payload' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__copiedPayload)).toBe(firstPayload);
});
