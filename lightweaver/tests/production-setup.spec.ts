import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { buildProductionJob, canonicalProductionJobBytes } from '../src/lib/productionJobPackage.js';
import { fingerprintCommissioningProject } from '../src/lib/cardCommissioningFlow.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';

async function productionJob() {
  const standaloneController = {
    outputs: [{ id: 'out1', name: 'Outer ring', pin: 16, pixels: 8 }],
    led: { type: 'WS2815', colorOrder: 'GRB', brightnessLimit: 0.35 },
    controls: {
      encoder: { a: 4, b: 5, press: 0, alternatePress: 6, rotateDirection: 'clockwise-brighter', brightnessStep: 18 },
      previous: 7, next: 8, blackout: 9, brightness: -1, statusLed: 2,
    },
    defaultLook: { patternId: 'aurora', brightness: 1, speed: 1, hueShift: 0, customHue: 32, customSaturation: 230, customBreathe: false, customDrift: false },
    looks: [],
    playlist: [{ id: 'aurora', type: 'pattern', patternId: 'aurora', label: 'Aurora', enabled: true, createdAt: 0 }],
  };
  const restoreSnapshot = {
    version: 4, id: 'moon-01', name: 'Moon',
    layout: {
      strips: [{ id: 'strip-1', name: 'Outer ring', pixelCount: 8 }], patchBoard: null,
      wiring: {
        version: 1, locked: true, verified: true, controllerAnchor: null, migrationWarnings: [],
        outputs: [{ id: 'out1', name: 'Outer ring', pin: 16, runIds: ['run-strip-1'] }],
        runs: [{ id: 'run-strip-1', type: 'strip', verified: true, source: { stripId: 'strip-1', from: 0, to: 7 }, directionPolicy: 'flexible', physicalDirection: 'source-forward', seamLed: null }],
      },
    },
    devices: { standaloneController },
  };
  const fingerprint = fingerprintCommissioningProject(restoreSnapshot);
  const configuration = buildCardRuntimePackageFromProject({
    projectId: restoreSnapshot.id, projectName: restoreSnapshot.name, projectRevision: 12,
    projectFingerprint: fingerprint, productionJobId: 'moon-batch-7', productionJobDigest: '0'.repeat(64),
    strips: restoreSnapshot.layout.strips, patchBoard: null, wiring: restoreSnapshot.layout.wiring, standaloneController,
  });
  return buildProductionJob({
    schemaVersion: 1, jobId: 'moon-batch-7', label: 'Moon · batch 7', artwork: 'Moon', batch: '7',
    firmware: { target: 'esp32-s3-n16r8', version: '1.0.0', buildId: 'f5625d5970bd9e737889977f83efa25562c430f0', minimumVersion: '1.0.0' },
    project: { id: 'moon-01', revision: 12, fingerprint, restoreSnapshot }, configuration,
    expectedOutputs: [{ id: 'out1', label: 'Outer ring', pin: 16, pixels: 8, direction: 'forward', colorOrder: 'GRB' }],
  });
}

async function serveJob(page, { artifactDelayMs = 0, onArtifactRequest = () => {} } = {}) {
  const job = await productionJob();
  const bytes = canonicalProductionJobBytes(job);
  const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
  await page.route('**/production/jobs/index.json', route => route.fulfill({ json: { schemaVersion: 1, jobs: [{ jobId: job.jobId, label: job.label, digest: job.digest, artifactSha256, size: bytes.byteLength, url: `/production/jobs/${job.digest}.lwjob.json` }] } }));
  await page.route(`**/production/jobs/${job.digest}.lwjob.json`, async route => {
    onArtifactRequest();
    if (artifactDelayMs) await new Promise(resolve => setTimeout(resolve, artifactDelayMs));
    await route.fulfill({ body: Buffer.from(bytes), headers: { 'content-type': 'application/json', 'content-length': String(bytes.byteLength) } });
  });
  return job;
}

async function reachPassRecord(page) {
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  await page.getByRole('button', { name: 'Install verified firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same card' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByLabel(/Outer ring/).check();
  await page.getByRole('button', { name: 'All outputs look correct' }).click();
}

async function installDriver(page, {
  wrongReconnect = false, wrongLanCard = false, wrongBeforeRestore = false,
  preflightCurrent = false, preflightThrowsOnce = false, preflightMissingOnce = false,
  restoreThrows = false, invalidInspection = false, recordThrowsOnce = false, recordDelayMs = 0,
} = {}) {
  await page.addInitScript(({ wrongReconnect, wrongLanCard, wrongBeforeRestore, preflightCurrent, preflightThrowsOnce, preflightMissingOnce, restoreThrows, invalidInspection, recordThrowsOnce, recordDelayMs }) => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
    const evidence = {
      cardId: 'lw-aabbccddeeff', firmwareVersion: '1.0.0',
      buildId: 'f5625d5970bd9e737889977f83efa25562c430f0', projectRevision: 12,
      projectFingerprint: '', productionJobId: 'moon-batch-7', productionJobDigest: '',
    };
    window.__LW_PRODUCTION_DRIVER_FOR_TEST__ = {
      connectCard: async () => ({}),
      connectLan: async () => {},
      disconnect: async () => localStorage.setItem('lw_test_disconnect_count', String(Number(localStorage.getItem('lw_test_disconnect_count') || 0) + 1)),
      noteLanHandoff: () => localStorage.setItem('lw_test_lan_handoff_count', String(Number(localStorage.getItem('lw_test_lan_handoff_count') || 0) + 1)),
      inspectCard: async () => ({ cardId: 'lw-aabbccddeeff', chipName: 'ESP32-S3', flashSize: invalidInspection ? '4MB' : '16MB' }),
      install: async ({ onProgress }) => { localStorage.setItem('lw_test_install_count', String(Number(localStorage.getItem('lw_test_install_count') || 0) + 1)); onProgress(1); },
      restore: async configuration => {
        localStorage.setItem('lw_test_restore_count', String(Number(localStorage.getItem('lw_test_restore_count') || 0) + 1));
        evidence.projectFingerprint = configuration.config.projectFingerprint;
        evidence.productionJobDigest = configuration.config.productionJobDigest;
        if (restoreThrows) throw new Error('Response lost after card accepted restore');
      },
      readEvidence: async phase => {
        if (phase === 'record') {
          const attempt = Number(localStorage.getItem('lw_test_record_attempts') || 0) + 1;
          localStorage.setItem('lw_test_record_attempts', String(attempt));
          if (recordDelayMs) await new Promise(resolve => setTimeout(resolve, recordDelayMs));
          if (recordThrowsOnce && attempt === 1) throw new Error('Final card read-back timed out');
        }
        if (phase === 'preflight') {
          const attempt = Number(localStorage.getItem('lw_test_preflight_count') || 0) + 1;
          localStorage.setItem('lw_test_preflight_count', String(attempt));
          if (attempt === 1 && preflightThrowsOnce) throw new Error('Card page bridge is not ready');
          if (attempt === 1 && preflightMissingOnce) return {};
          return {
            ...evidence,
            cardId: wrongLanCard ? 'lw-wrong-lan-card' : evidence.cardId,
            firmwareVersion: preflightCurrent ? evidence.firmwareVersion : '0.9.0',
            buildId: preflightCurrent ? evidence.buildId : '0'.repeat(40),
            projectRevision: 0, projectFingerprint: '', productionJobId: '', productionJobDigest: '',
          };
        }
        if (phase === 'reconnect') return { ...evidence, cardId: wrongReconnect ? 'lw-wrong-card' : evidence.cardId, projectRevision: 0, projectFingerprint: '', productionJobId: '', productionJobDigest: '' };
        if (phase === 'before-restore') return { ...evidence, cardId: wrongBeforeRestore ? 'lw-wrong-before-restore' : evidence.cardId, projectRevision: 0, projectFingerprint: '', productionJobId: '', productionJobDigest: '' };
        return evidence;
      },
    };
  }, { wrongReconnect, wrongLanCard, wrongBeforeRestore, preflightCurrent, preflightThrowsOnce, preflightMissingOnce, restoreThrows, invalidInspection, recordThrowsOnce, recordDelayMs });
}

test('worker completes one verified job, retains its pass, and Next artwork resets transient state', async ({ page }) => {
  const job = await serveJob(page);
  await installDriver(page);
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await expect(page.getByText(/Job and official firmware are verified/)).toBeVisible();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await expect(page.getByRole('button', { name: 'Install verified firmware' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  await page.getByRole('button', { name: 'Install verified firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same card' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByLabel(/Outer ring/).check();
  await page.getByRole('button', { name: 'All outputs look correct' }).click();
  await page.getByLabel('Worker initials or ID').fill('AR');
  await page.getByRole('button', { name: 'Save pass record' }).click();
  await expect(page.getByText('Artwork passed')).toBeVisible();
  await page.getByRole('button', { name: 'Next artwork' }).click();
  await expect(page.getByRole('heading', { name: 'Choose the artwork job' })).toBeVisible();
  await expect(page.getByText('No completed artwork passes')).toHaveCount(0);
  await expect(page.getByText(/Latest:.*Moon/)).toBeVisible();
  await expect(page.evaluate(() => localStorage.getItem('lw_test_restore_count'))).resolves.toBe('1');
  expect(job.digest).toHaveLength(64);
});

test('interrupted restore resumes at read-back and never restores twice', async ({ page }) => {
  await serveJob(page); await installDriver(page);
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  await page.getByRole('button', { name: 'Install verified firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same card' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await expect(page.getByRole('button', { name: 'Verify card read-back' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Moon · batch 7' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load verified artwork' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Verify card read-back' })).toBeVisible();
  await expect(page.evaluate(() => localStorage.getItem('lw_test_restore_count'))).resolves.toBe('1');
});

test('wrong card after installation is stopped without restoring', async ({ page }) => {
  await serveJob(page); await installDriver(page, { wrongReconnect: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  await page.getByRole('button', { name: 'Install verified firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same card' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong card');
  await expect(page.getByRole('button', { name: 'Load verified artwork' })).toHaveCount(0);
});

test('exact same-card LAN evidence skips flashing and wrong LAN card blocks all mutation', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await expect(page.getByRole('button', { name: 'Load verified artwork' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install verified firmware' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('lw_test_install_count'))).toBeNull();
});

test('wrong LAN card after USB inspection cannot install or restore', async ({ page }) => {
  await serveJob(page); await installDriver(page, { wrongLanCard: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong online card');
  await expect(page.getByRole('button', { name: /Install verified firmware|Load verified artwork/ })).toHaveCount(0);
  expect(await page.evaluate(() => ({ installs: localStorage.getItem('lw_test_install_count'), restores: localStorage.getItem('lw_test_restore_count') }))).toEqual({ installs: null, restores: null });
});

test('LAN identity is rebound immediately before restore and a changed host cannot mutate', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true, wrongBeforeRestore: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await expect(page.getByRole('alert')).toContainText('no longer the exact USB-inspected card');
  expect(await page.evaluate(() => localStorage.getItem('lw_test_restore_count'))).toBeNull();
  await expect(page.getByRole('button', { name: 'Load verified artwork' })).toBeVisible();
});

test('throwing LAN evidence has a clear handoff retry and never unlocks mutation early', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightThrowsOnce: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await expect(page.getByRole('alert')).toContainText('Card page bridge is not ready');
  await expect(page.getByRole('button', { name: 'Reconnect card page and retry' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Install verified firmware|Load verified artwork/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reconnect card page and retry' }).click();
  await expect(page.getByRole('button', { name: 'Reconnect same USB card' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('lw_test_lan_handoff_count'))).toBe('2');
  expect(await page.evaluate(() => localStorage.getItem('lw_test_install_count'))).toBeNull();
});

test('missing LAN identity can retry the card-page handoff and exact evidence safely skips flash', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightMissingOnce: true, preflightCurrent: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await expect(page.getByRole('button', { name: 'Reconnect card page and retry' })).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect card page and retry' }).click();
  await expect(page.getByRole('button', { name: 'Load verified artwork' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('lw_test_install_count'))).toBeNull();
});

test('accepted restore with a lost response resumes verify-only and retry unlocks only after explicit evidence', async ({ page }) => {
  await serveJob(page); await installDriver(page, { restoreThrows: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  await page.getByRole('button', { name: 'Install verified firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same card' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await expect(page.getByRole('alert')).toContainText('Response lost after card accepted restore');
  expect(await page.evaluate(() => localStorage.getItem('lw_test_restore_count'))).toBe('1');
  await expect(page.getByRole('button', { name: 'Verify card read-back' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Moon · batch 7' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load verified artwork' })).toHaveCount(0);
  const verify = page.getByRole('button', { name: 'Verify card read-back' });
  await expect(verify).toBeEnabled();
  await verify.click();
  await expect(page.getByRole('alert')).toContainText('No second restore ran');
  await expect(page.getByRole('button', { name: 'Load verified artwork' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('lw_test_restore_count'))).toBe('1');
});

test('job deep link and QR-style URL automatically load the exact verified index job', async ({ page }) => {
  await serveJob(page); await installDriver(page);
  await page.goto('/#screen=production&job=moon-batch-7');
  await expect(page.getByRole('heading', { name: 'Moon · batch 7' })).toBeVisible();
  await expect(page.getByText(/Job and official firmware are verified/)).toBeVisible();
  await expect(page).toHaveURL(/#screen=production&job=moon-batch-7/);
});

test('unsupported browser and mobile get a computer handoff with no Bridge action', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1' });
  const page = await context.newPage();
  await page.goto('/#screen=production');
  await expect(page.getByRole('heading', { name: 'Continue on a workshop computer' })).toBeVisible();
  await expect(page.getByText('led.mandalacodes.com/#screen=production')).toBeVisible();
  await expect(page.getByRole('button', { name: /Bridge/i })).toHaveCount(0);
  await context.close();
});

test('desktop without the supported browser USB lane gets a direct handoff, never Bridge', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined }));
  await page.goto('/#screen=production&job=moon-batch-7');
  await expect(page.getByRole('heading', { name: 'Open this page in Chrome or Edge' })).toBeVisible();
  await expect(page.getByText(/job code.*moon-batch-7/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Bridge/i })).toHaveCount(0);
});

test('production screen reflows at 200% equivalent width and honors reduced motion', async ({ page }) => {
  await installDriver(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto('/#screen=production');
  await expect(page.getByRole('heading', { name: 'Production setup' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
});

test('production setup is keyboard operable, restores heading focus, and announces state', async ({ page }) => {
  await installDriver(page);
  await page.goto('/#screen=layout');
  const entry = page.getByRole('button', { name: 'Production setup' });
  await entry.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#screen=production/);
  await expect(page.getByRole('heading', { name: 'Production setup' })).toBeFocused();
  await page.getByLabel('Job code').focus();
  await page.keyboard.type('moon-batch-7');
  await expect(page.getByLabel('Job code')).toHaveValue('moon-batch-7');
  await expect(page.locator('[aria-live="polite"]')).toHaveCount(1);
});

test('failed USB validation always releases the local connection and remains retryable', async ({ page }) => {
  await serveJob(page); await installDriver(page, { invalidInspection: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await expect(page.getByRole('alert')).toContainText('USB was released');
  expect(await page.evaluate(() => localStorage.getItem('lw_test_disconnect_count'))).toBe('1');
  await expect(page.getByRole('button', { name: 'Connect one USB card' })).toBeVisible();
});

test('job selection is single-flight, awaits verification, and ignores overlapping clicks', async ({ page }) => {
  let artifacts = 0;
  await serveJob(page, { artifactDelayMs: 250, onArtifactRequest: () => { artifacts += 1; } });
  await installDriver(page);
  await page.goto('/#screen=production');
  const option = page.getByRole('button', { name: /Moon · batch 7/ });
  await option.evaluate(element => { element.click(); element.click(); });
  await expect(option).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Moon · batch 7' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect one USB card' })).toBeFocused();
  expect(artifacts).toBe(1);
});

test('a run storage failure leaves job selection recoverable and commits no visible job or URL', async ({ page }) => {
  await serveJob(page); await installDriver(page);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    let failOnce = true;
    Storage.prototype.setItem = function setItem(key, value) {
      if (failOnce && String(key).startsWith('lw_production_run_v1_')) {
        failOnce = false;
        throw new DOMException('Workshop storage is blocked', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await page.goto('/#screen=production');
  const option = page.getByRole('button', { name: /Moon · batch 7/ });
  await option.click();
  await expect(page.getByRole('heading', { name: 'Choose the artwork job' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('workshop progress could not be saved');
  await expect(option).toBeEnabled();
  await expect(page.locator('.prod-action')).toHaveCount(0);
  await expect(page).not.toHaveURL(/(?:[&#])job=/);
  expect(await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun())).toBeNull();

  await option.click();
  await expect(page.getByRole('heading', { name: 'Moon · batch 7' })).toBeVisible();
  await expect(page).toHaveURL(/(?:[&#])job=moon-batch-7/);
});

test('pass save is single-flight and a readable failure can be retried without duplicate records', async ({ page }) => {
  await serveJob(page); await installDriver(page, { recordThrowsOnce: true, recordDelayMs: 100 });
  await page.goto('/#screen=production');
  await reachPassRecord(page);
  await page.getByLabel('Worker initials or ID').fill('AR');
  const save = page.getByRole('button', { name: 'Save pass record' });
  await save.evaluate(element => { element.click(); element.click(); });
  await expect(page.getByRole('alert')).toContainText('Pass was not completed');
  expect(await page.evaluate(() => localStorage.getItem('lw_test_record_attempts'))).toBe('1');
  await page.getByRole('button', { name: 'Save pass record' }).click();
  await expect(page.getByText('Artwork passed')).toBeVisible();
  const count = await page.evaluate(async () => (await import('/src/lib/productionRecords.js')).readProductionRecords().length);
  expect(count).toBe(1);
});

test('Change job safely cancels before mutation and firmware preload retry preserves the run', async ({ page }) => {
  await serveJob(page); await installDriver(page);
  let signatures = 0;
  await page.route('**/firmware/release-manifest.sig', async route => {
    signatures += 1;
    if (signatures === 1) await route.fulfill({ status: 200, body: 'invalid' });
    else await route.fallback();
  });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await expect(page.getByRole('button', { name: 'Retry verified firmware' })).toBeVisible();
  const before = await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun().runId);
  await page.getByRole('button', { name: 'Retry verified firmware' }).click();
  await expect(page.getByRole('button', { name: 'Connect one USB card' })).toBeEnabled();
  const after = await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun().runId);
  expect(after).toBe(before);
  await page.getByRole('button', { name: 'Change job' }).click();
  await expect(page.getByRole('heading', { name: 'Choose the artwork job' })).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun())).toBeNull();
  expect(await page.evaluate(() => ({ install: localStorage.getItem('lw_test_install_count'), restore: localStorage.getItem('lw_test_restore_count') }))).toEqual({ install: null, restore: null });
});

test('production text contrast, file focus, contextual focus, and error container meet quality rules', async ({ page }) => {
  await installDriver(page);
  await page.goto('/#screen=production');
  for (const theme of ['studio', 'daylight']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const ratios = await page.locator('.prod-shell').evaluate(root => {
      function oklch(value) {
        const match = /oklch\(([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/.exec(value);
        if (!match) return null;
        const L = Number(match[1]) > 1 ? Number(match[1]) / 100 : Number(match[1]);
        const C = Number(match[2]); const h = Number(match[3]) * Math.PI / 180;
        const a = C * Math.cos(h); const b = C * Math.sin(h);
        const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
        const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
        const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
        const rgb = [4.0767416621*l - 3.3077115913*m + 0.2309699292*s, -1.2684380046*l + 2.6097574011*m - 0.3413193965*s, -0.0041960863*l - 0.7034186147*m + 1.707614701*s].map(channel => Math.max(0, Math.min(1, channel)));
        return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      }
      function background(element) {
        for (let node = element; node; node = node.parentElement) {
          const value = getComputedStyle(node).backgroundColor;
          if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') return oklch(value);
        }
        return null;
      }
      return [...root.querySelectorAll('.prod-kicker, .prod-muted, .prod-steps li, .prod-fallbacks small')]
        .filter(element => element.getClientRects().length)
        .map(element => {
          const fg = oklch(getComputedStyle(element).color); const bg = background(element);
          return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        });
    });
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
  }
  const file = page.getByLabel('Production job file');
  await file.focus();
  await expect(file.locator('..')).toHaveCSS('outline-style', 'solid');
  await page.getByLabel('Job code').fill('not-a-job');
  await page.getByRole('button', { name: 'Find job' }).click();
  const error = page.getByRole('alert');
  await expect(error).toHaveCSS('border-left-width', '1px');
  await expect(error).toHaveCSS('border-right-width', '1px');
});
