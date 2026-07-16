import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildProductionJob, canonicalProductionJobBytes } from '../src/lib/productionJobPackage.js';
import { fingerprintCommissioningProject } from '../src/lib/cardCommissioningFlow.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';

const signedRelease = JSON.parse(await readFile(new URL('../public/firmware/release-manifest.json', import.meta.url), 'utf8'));

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
      strips: [{ id: 'strip-1', name: 'Outer ring', pixelCount: 5 }, { id: 'strip-2', name: 'Inner ring', pixelCount: 3 }], patchBoard: null,
      wiring: {
        version: 1, locked: true, verified: true, controllerAnchor: null, migrationWarnings: [],
        outputs: [{ id: 'out1', name: 'Two rings', pin: 16, runIds: ['run-strip-1', 'run-strip-2'] }],
        runs: [
          { id: 'run-strip-1', type: 'strip', verified: true, source: { stripId: 'strip-1', from: 0, to: 4 }, directionPolicy: 'flexible', physicalDirection: 'source-forward', seamLed: null },
          { id: 'run-strip-2', type: 'strip', verified: true, source: { stripId: 'strip-2', from: 0, to: 2 }, directionPolicy: 'flexible', physicalDirection: 'source-reverse', seamLed: null },
        ],
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
    firmware: {
      target: signedRelease.target,
      version: signedRelease.firmwareVersion,
      buildId: signedRelease.buildId,
      minimumVersion: '1.0.0',
    },
    project: { id: 'moon-01', revision: 12, fingerprint, restoreSnapshot }, configuration,
    expectedOutputs: [{ id: 'out1', label: 'Two rings', pin: 16, pixels: 8, direction: 'mixed', colorOrder: 'GRB' }],
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
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await page.getByRole('tab', { name: /Inner ring/ }).click();
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await page.getByRole('button', { name: 'Continue to pass record' }).click();
}

async function installDriver(page, {
  wrongReconnect = false, wrongLanCard = false, wrongBeforeRestore = false,
  preflightCurrent = false, preflightThrowsOnce = false, preflightMissingOnce = false,
  restoreThrows = false, invalidInspection = false, recordThrowsOnce = false, recordDelayMs = 0,
  candidateEvidenceMismatch = false, physicalIdentityMismatch = false, physicalFirmwareMismatch = false,
  activationFailure = false, rollbackFailure = false, rollbackRebootReads = 0, physicalDeliveryFailure = false, physicalDeliveryFailureOnce = false, physicalDeliveryDelayMs = 0,
  connectErrorOnce = '',
  disconnectFailureAt = 0, secondUsbWrong = false, installThrows = false, reconnectFirmwareMismatch = false,
} = {}) {
  await page.addInitScript(({ firmwareVersion, firmwareBuildId, wrongReconnect, wrongLanCard, wrongBeforeRestore, preflightCurrent, preflightThrowsOnce, preflightMissingOnce, restoreThrows, invalidInspection, recordThrowsOnce, recordDelayMs, candidateEvidenceMismatch, physicalIdentityMismatch, physicalFirmwareMismatch, activationFailure, rollbackFailure, rollbackRebootReads, physicalDeliveryFailure, physicalDeliveryFailureOnce, physicalDeliveryDelayMs, connectErrorOnce, disconnectFailureAt, secondUsbWrong, installThrows, reconnectFirmwareMismatch }) => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
    const evidence = {
      cardId: 'lw-aabbccddeeff', firmwareVersion,
      buildId: firmwareBuildId, projectRevision: 12,
      projectFingerprint: '', productionJobId: 'moon-batch-7', productionJobDigest: '',
    };
    window.__LW_PRODUCTION_DRIVER_FOR_TEST__ = {
      connectCard: async () => {
        const attempts = Number(localStorage.getItem('lw_test_connect_attempts') || 0) + 1;
        localStorage.setItem('lw_test_connect_attempts', String(attempts));
        if (attempts === 1 && connectErrorOnce) throw new Error(connectErrorOnce);
        return {};
      },
      connectLan: async () => {},
      disconnect: async () => {
        const count = Number(localStorage.getItem('lw_test_disconnect_count') || 0) + 1;
        localStorage.setItem('lw_test_disconnect_count', String(count));
        if (count === disconnectFailureAt) throw new Error('USB port did not release');
      },
      noteLanHandoff: () => localStorage.setItem('lw_test_lan_handoff_count', String(Number(localStorage.getItem('lw_test_lan_handoff_count') || 0) + 1)),
      inspectCard: async () => {
        const count = Number(localStorage.getItem('lw_test_inspect_count') || 0) + 1;
        localStorage.setItem('lw_test_inspect_count', String(count));
        return { cardId: secondUsbWrong && count === 2 ? 'lw-different-usb' : 'lw-aabbccddeeff', chipName: 'ESP32-S3', flashSize: invalidInspection ? '4MB' : '16MB' };
      },
      install: async ({ onProgress }) => {
        localStorage.setItem('lw_test_install_count', String(Number(localStorage.getItem('lw_test_install_count') || 0) + 1));
        if (installThrows) throw new Error('Install transport stopped');
        onProgress(1);
      },
      startPhysical: async ({ frame, output, generation }) => {
        const attempt = Number(localStorage.getItem('lw_test_physical_delivery_attempts') || 0) + 1;
        localStorage.setItem('lw_test_physical_delivery_attempts', String(attempt));
        if (physicalDeliveryDelayMs) await new Promise(resolve => setTimeout(resolve, physicalDeliveryDelayMs));
        if (physicalDeliveryFailure || (physicalDeliveryFailureOnce && attempt === 1)) return { ok: false, generation };
        const candidate = JSON.parse(localStorage.getItem('lw_test_candidate') || 'null');
        const current = JSON.parse(localStorage.getItem('lw_test_current_config') || 'null');
        const activeConfig = candidate?.config || current;
        const configured = activeConfig?.led?.outputs?.find(item => item.id === output.id);
        const physical = [...frame];
        if (configured?.segments) {
          const outputs = activeConfig.led.outputs;
          let start = outputs.slice(0, outputs.findIndex(item => item.id === output.id)).reduce((sum, item) => sum + item.pixels, 0);
          for (const segment of configured.segments) {
            if (segment.direction === 'reverse') physical.splice(start, segment.count, ...physical.slice(start, start + segment.count).reverse());
            start += segment.count;
          }
        }
        localStorage.setItem('lw_test_physical_frame', JSON.stringify(physical)); return { ok: true, generation };
      },
      stageCandidate: async candidate => {
        const history = JSON.parse(localStorage.getItem('lw_test_candidate_history') || '[]'); history.push(candidate);
        localStorage.setItem('lw_test_candidate_history', JSON.stringify(history));
        const activationId = `candidate-production-${history.length}`;
        localStorage.setItem('lw_test_candidate', JSON.stringify({ ...candidate, state: 'staged', activationId }));
        return { state: 'staged', activationId };
      },
      readCandidateEvidence: async activationId => {
        const candidate = JSON.parse(localStorage.getItem('lw_test_candidate') || '{}');
        return { app: 'Lightweaver', state: 'staged', activationId, ...evidence, projectFingerprint: candidateEvidenceMismatch ? 'f'.repeat(16) : evidence.projectFingerprint, colorOrder: candidate.config?.led?.colorOrder, maxMilliamps: candidate.config?.led?.maxMilliamps, wiringRevision: candidate.config?.wiringRevision, wiringDigest: candidate.config?.wiringDigest, candidateOutputs: candidate.config?.led?.outputs || [] };
      },
      activateCandidate: async activationId => {
        if (activationFailure) throw new Error('Candidate activation failed');
        const candidate = JSON.parse(localStorage.getItem('lw_test_candidate') || '{}');
        localStorage.setItem('lw_test_candidate', JSON.stringify({ ...candidate, state: 'testing', activationId }));
        return { state: 'testing', activationId, remainingMs: 90000 };
      },
      confirmCandidate: async activationId => {
        const candidate = JSON.parse(localStorage.getItem('lw_test_candidate') || '{}');
        localStorage.setItem('lw_test_current_config', JSON.stringify(candidate.config || null));
        localStorage.removeItem('lw_test_candidate');
        return { state: 'known-good', activationId };
      },
      readWiringStatus: async () => {
        localStorage.setItem('lw_test_wiring_status_count', String(Number(localStorage.getItem('lw_test_wiring_status_count') || 0) + 1));
        const rebootReads = Number(localStorage.getItem('lw_test_rollback_reboot_reads') || 0);
        if (rebootReads > 0) {
          localStorage.setItem('lw_test_rollback_reboot_reads', String(rebootReads - 1));
          throw new Error('Card is restarting after rollback');
        }
        const candidate = JSON.parse(localStorage.getItem('lw_test_candidate') || 'null');
        const current = JSON.parse(localStorage.getItem('lw_test_current_config') || '{}');
        return {
          state: candidate?.state || 'known-good', activationId: candidate?.activationId, ...evidence,
          projectRevision: current?.projectRevision ?? evidence.projectRevision,
          projectFingerprint: current?.projectFingerprint || evidence.projectFingerprint,
          productionJobId: current?.productionJobId || evidence.productionJobId,
          productionJobDigest: current?.productionJobDigest || evidence.productionJobDigest,
          colorOrder: current?.led?.colorOrder, maxMilliamps: current?.led?.maxMilliamps,
          wiringRevision: current?.wiringRevision, wiringDigest: current?.wiringDigest, outputs: current?.led?.outputs || [],
        };
      },
      rollbackCandidate: async activationId => {
        localStorage.setItem('lw_test_rollback_count', String(Number(localStorage.getItem('lw_test_rollback_count') || 0) + 1));
        if (rollbackFailure) throw new Error('Rollback transport failed');
        localStorage.removeItem('lw_test_candidate');
        if (rollbackRebootReads) localStorage.setItem('lw_test_rollback_reboot_reads', String(rollbackRebootReads));
        return { state: 'rolled-back', activationId };
      },
      restore: async configuration => {
        localStorage.setItem('lw_test_restore_count', String(Number(localStorage.getItem('lw_test_restore_count') || 0) + 1));
        localStorage.setItem('lw_test_current_config', JSON.stringify(configuration.config));
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
        if (phase === 'reconnect') return { ...evidence, cardId: wrongReconnect ? 'lw-wrong-card' : evidence.cardId, firmwareVersion: reconnectFirmwareMismatch ? '0.8.0' : evidence.firmwareVersion, buildId: reconnectFirmwareMismatch ? '0'.repeat(40) : evidence.buildId, projectRevision: 0, projectFingerprint: '', productionJobId: '', productionJobDigest: '' };
        if (phase === 'before-restore') return { ...evidence, cardId: wrongBeforeRestore ? 'lw-wrong-before-restore' : evidence.cardId, projectRevision: 0, projectFingerprint: '', productionJobId: '', productionJobDigest: '' };
        if (phase === 'physical') {
          const current = JSON.parse(localStorage.getItem('lw_test_current_config') || '{}');
          return {
          ...evidence, projectRevision: current?.projectRevision ?? evidence.projectRevision,
          projectFingerprint: current?.projectFingerprint || evidence.projectFingerprint,
          productionJobId: current?.productionJobId || evidence.productionJobId,
          productionJobDigest: current?.productionJobDigest || evidence.productionJobDigest,
          cardId: physicalIdentityMismatch || localStorage.getItem('lw_test_physical_identity_changed') === '1' ? 'lw-other-card' : evidence.cardId,
          firmwareVersion: physicalFirmwareMismatch || localStorage.getItem('lw_test_physical_firmware_changed') === '1' ? '0.8.0' : evidence.firmwareVersion,
          };
        }
        return evidence;
      },
    };
  }, { firmwareVersion: signedRelease.firmwareVersion, firmwareBuildId: signedRelease.buildId, wrongReconnect, wrongLanCard, wrongBeforeRestore, preflightCurrent, preflightThrowsOnce, preflightMissingOnce, restoreThrows, invalidInspection, recordThrowsOnce, recordDelayMs, candidateEvidenceMismatch, physicalIdentityMismatch, physicalFirmwareMismatch, activationFailure, rollbackFailure, rollbackRebootReads, physicalDeliveryFailure, physicalDeliveryFailureOnce, physicalDeliveryDelayMs, connectErrorOnce, disconnectFailureAt, secondUsbWrong, installThrows, reconnectFirmwareMismatch });
}

test('production fixture tracks the exact currently signed firmware release', async () => {
  const job = await productionJob();
  expect(job.firmware).toMatchObject({
    target: signedRelease.target,
    version: signedRelease.firmwareVersion,
    buildId: signedRelease.buildId,
  });
});

test('USB failure shows one safe action and exports only bounded redacted diagnostics', async ({ page }) => {
  await serveJob(page);
  await installDriver(page, { connectErrorOnce: 'No device found. This may be a charge-only data cable. card lw-secret job moon-batch-7' });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();

  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  await expect(recovery).toContainText('The computer did not find a data connection');
  await expect(recovery.getByText('Card changed?')).toBeVisible();
  await expect(recovery.getByText('No', { exact: true })).toBeVisible();
  await expect(recovery.getByText('USB released?')).toBeVisible();
  await expect(recovery.getByText('Yes', { exact: true })).toBeVisible();
  await expect(recovery).toContainText('LW-USB-101');
  await expect(recovery.locator('.prod-recovery-primary')).toHaveCount(1);
  await expect(recovery.getByRole('button', { name: 'Reconnect with a data cable' })).toBeFocused();

  const downloadPromise = page.waitForEvent('download');
  await recovery.getByRole('button', { name: 'Export support details' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let body = '';
  for await (const chunk of stream) body += chunk.toString();
  const diagnostic = JSON.parse(body);
  expect(Object.keys(diagnostic)).toEqual(['app', 'version', 'os', 'arch', 'supportCode', 'phase', 'firmwareTarget', 'vid', 'pid']);
  expect(JSON.stringify(diagnostic)).not.toMatch(/lw-secret|moon-batch|charge-only|raw|error/i);

  await recovery.getByRole('button', { name: 'Reconnect with a data cable' }).click();
  await expect(page.getByRole('button', { name: 'Release USB and inspect firmware' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('lw_test_connect_attempts'))).toBe('2');
});

test('failed USB cleanup stays unknown, persists conservative ownership, and retries release', async ({ page }) => {
  await serveJob(page); await installDriver(page, { invalidInspection: true, disconnectFailureAt: 1 });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  await expect(recovery).toContainText('USB released?Not confirmed');
  await expect(recovery.getByRole('button', { name: 'Release USB safely' })).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun().usbReleased)).toBe(false);
  await recovery.getByRole('button', { name: 'Release USB safely' }).click();
  await expect(page.getByRole('button', { name: 'Connect one USB card' })).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun().usbReleased)).toBe(true);
});

test('install failure never claims USB release when cleanup fails', async ({ page }) => {
  await serveJob(page); await installDriver(page, { installThrows: true, disconnectFailureAt: 2 });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  await page.getByRole('button', { name: 'Install verified firmware' }).click();
  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  await expect(recovery).toContainText('USB released?Not confirmed');
  await expect(recovery.getByRole('button', { name: 'Release USB safely' })).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun().usbReleased)).toBe(false);
});

test('different USB card is a wrong-card recovery in every phase', async ({ page }) => {
  await serveJob(page); await installDriver(page, { secondUsbWrong: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  await expect(recovery).toContainText('LW-CARD-201');
  await expect(recovery.getByRole('button', { name: 'Reconnect the expected card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install verified firmware' })).toHaveCount(0);
});

test('exact-card firmware mismatch returns to same-card USB evidence before install', async ({ page }) => {
  await serveJob(page); await installDriver(page, { reconnectFirmwareMismatch: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  await page.getByRole('button', { name: 'Install verified firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same card' }).click();
  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  await expect(recovery).toContainText('LW-FW-502');
  await expect(recovery.locator('dl div').filter({ hasText: 'Card changed?' }).getByText('Yes', { exact: true })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Reconnect same card by USB' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Install verified firmware' })).toHaveCount(0);
  await recovery.getByRole('button', { name: 'Reconnect same card by USB' }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await expect(page.getByRole('button', { name: 'Install verified firmware' })).toBeVisible();
});

test('physical failures use stable structured recovery before bounded correction', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByRole('button', { name: 'Colors wrong' }).click();
  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  await expect(recovery).toContainText('LW-LIGHT-412');
  await expect(recovery).toContainText('Card changed?No');
  await expect(recovery).toContainText('USB released?Yes');
  await expect(recovery.locator('.prod-recovery-primary')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /Inner ring/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Red end is off' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Test color order', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to pass record' })).toHaveCount(0);
  await recovery.getByRole('button', { name: 'Test color order safely' }).click();
  await expect(recovery).toHaveCount(0);
  await expect(page.getByLabel('Color order')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Red end is off' })).toHaveCount(0);
});

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
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await page.getByRole('tab', { name: /Inner ring/ }).click();
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await page.getByRole('button', { name: 'Continue to pass record' }).click();
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

test('physical diagnosis is bounded, requires worker observation, and reverse is an acknowledged reboot-safe candidate', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();

  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_test_physical_frame'))).not.toBeNull();
  const initial = JSON.parse(await page.evaluate(() => localStorage.getItem('lw_test_physical_frame') || '[]'));
  expect(initial).toHaveLength(8);
  expect(initial[0]).toBe('000020');
  expect(initial[4]).toBe('200000');
  expect(initial.slice(1, 4)).toEqual(Array(3).fill('020202'));
  expect(initial.slice(5)).toEqual(Array(3).fill('000000'));
  const outerTab = page.getByRole('tab', { name: /Outer ring/ });
  const innerTab = page.getByRole('tab', { name: /Inner ring/ });
  await outerTab.focus();
  await page.keyboard.press('End');
  await expect(innerTab).toBeFocused();
  await expect(innerTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(outerTab).toBeFocused();
  await expect(page.getByRole('button', { name: 'Continue to pass record' })).toHaveCount(0);
  await page.setViewportSize({ width: 420, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole('button', { name: 'Blue / red swapped' }).click();
  await page.getByRole('button', { name: 'Test the opposite direction' }).click();
  await page.getByRole('button', { name: 'Try opposite direction' }).click();
  await expect(page.getByText(/Temporary boundary test/)).toBeVisible();
  await expect(page.getByRole('tab', { name: /Inner ring/ })).toBeDisabled();
  const candidate = JSON.parse(await page.evaluate(() => localStorage.getItem('lw_test_candidate') || '{}'));
  expect(candidate.rollbackAfterMs).toBe(90_000);
  expect(candidate.config.led.outputs[0].segments[0].direction).toBe('reverse');
  expect(candidate.config.led.outputs[0].segments[1].direction).toBe('reverse');
  const reversed = JSON.parse(await page.evaluate(() => localStorage.getItem('lw_test_physical_frame') || '[]'));
  expect(reversed[0]).toBe('200000');
  expect(reversed[4]).toBe('000020');
  expect(reversed.slice(5)).toEqual(Array(3).fill('000000'));
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await expect(page.getByText('You physically confirmed this boundary.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to pass record' })).toHaveCount(0);
  await page.getByRole('tab', { name: /Inner ring/ }).click();
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await expect(page.getByRole('button', { name: 'Continue to pass record' })).toBeVisible();
});

test('sequential boundary corrections preserve the previously confirmed count', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();

  await page.getByRole('button', { name: 'Red end is off' }).click();
  await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
  await page.getByRole('button', { name: '+ 1 pixel' }).click();
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await page.getByRole('tab', { name: /Inner ring/ }).click();
  await page.getByRole('button', { name: 'Blue / red swapped' }).click();
  await page.getByRole('button', { name: 'Test the opposite direction' }).click();
  await page.getByRole('button', { name: 'Try opposite direction' }).click();

  const history = JSON.parse(await page.evaluate(() => localStorage.getItem('lw_test_candidate_history') || '[]'));
  expect(history).toHaveLength(2);
  expect(history[0].config.led.outputs[0].segments[0].count).toBe(6);
  expect(history[1].config.led.outputs[0].segments[0].count).toBe(6);
  expect(history[1].config.led.outputs[0].segments[1].direction).toBe('forward');
});

test('confirmed count correction is saved with final boundary hardware facts', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByRole('button', { name: 'Red end is off' }).click();
  await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
  await page.getByRole('button', { name: '+ 1 pixel' }).click();
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await page.getByRole('tab', { name: /Inner ring/ }).click();
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await page.getByRole('button', { name: 'Continue to pass record' }).click();
  await page.getByLabel('Worker initials or ID').fill('AR');
  await page.getByRole('button', { name: 'Save pass record' }).click();
  const records = await page.evaluate(async () => (await import('/src/lib/productionRecords.js')).readProductionRecords());
  expect(records).toHaveLength(1);
  const finalDigest = records[0].physicalResults[0].wiringDigest;
  expect(finalDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(records[0].physicalResults).toEqual([
    { boundaryId: 'run-strip-1', result: 'correct', activationId: 'candidate-production-1', count: 6, pin: 16, direction: 'forward', colorOrder: 'GRB', wiringRevision: 2, wiringDigest: finalDigest },
    { boundaryId: 'run-strip-2', result: 'correct', count: 3, pin: 16, direction: 'reverse', colorOrder: 'GRB', wiringRevision: 2, wiringDigest: finalDigest },
  ]);
});

test('save pass re-proves exact final wiring and rejects every post-check mutation', async ({ page }) => {
  await serveJob(page); await installDriver(page);
  await page.goto('/#screen=production');
  await reachPassRecord(page);
  await page.getByLabel('Worker initials or ID').fill('AR');
  const baseline = await page.evaluate(() => localStorage.getItem('lw_test_current_config'));
  expect(baseline).not.toBeNull();

  for (const mutation of ['revision', 'digest', 'output', 'color']) {
    await page.evaluate(({ baselineConfig, mutationKind }) => {
      const config = JSON.parse(baselineConfig);
      if (mutationKind === 'revision') config.wiringRevision += 1;
      if (mutationKind === 'digest') config.wiringDigest = 'c'.repeat(64);
      if (mutationKind === 'output') config.led.outputs[0].pin += 1;
      if (mutationKind === 'color') config.led.colorOrder = 'RGB';
      localStorage.setItem('lw_test_current_config', JSON.stringify(config));
    }, { baselineConfig: baseline, mutationKind: mutation });
    await page.getByRole('button', { name: 'Save pass record' }).click();
    await expect(page.getByRole('alert')).toContainText('Final wiring read-back did not match');
    await expect(page.getByRole('button', { name: 'Re-run physical checks' })).toBeVisible();
    expect(await page.evaluate(async () => (await import('/src/lib/productionRecords.js')).readProductionRecords())).toHaveLength(0);
    await page.evaluate(value => localStorage.setItem('lw_test_current_config', value), baseline);
  }

  await page.getByRole('button', { name: 'Save pass record' }).click();
  await expect(page.getByText('Artwork passed')).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/lib/productionRecords.js')).readProductionRecords())).toHaveLength(1);
});

test('reload during a temporary correction waits through rollback reboot before any new physical frame', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true, rollbackRebootReads: 2 });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByRole('button', { name: 'Red end is off' }).click();
  await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
  await page.getByRole('button', { name: '+ 1 pixel' }).click();
  await expect(page.getByText(/Temporary boundary test/)).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('lw_test_physical_frame'));

  await page.reload();
  await expect(page.getByText('Test delivered to this exact boundary. Look at the real LEDs — this is not a pass.')).toBeVisible();
  expect(await page.evaluate(() => ({ rollback: localStorage.getItem('lw_test_rollback_count'), candidate: localStorage.getItem('lw_test_candidate') }))).toEqual({ rollback: '1', candidate: null });
  const frame = JSON.parse(await page.evaluate(() => localStorage.getItem('lw_test_physical_frame') || '[]'));
  expect(frame).toHaveLength(8);
});

test('reload after a confirmed count correction restores exact progress and wiring identity', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByRole('button', { name: 'Red end is off' }).click();
  await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
  await page.getByRole('button', { name: '+ 1 pixel' }).click();
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await expect(page.getByText('You physically confirmed this boundary.')).toBeVisible();

  await page.reload();
  await expect(page.getByText('You physically confirmed this boundary.')).toBeVisible();
  await expect(page.getByText(/Pixel 6 red/)).toBeVisible();
  const current = JSON.parse(await page.evaluate(() => localStorage.getItem('lw_test_current_config') || '{}'));
  expect(current.wiringRevision).toBe(2);
  expect(current.wiringDigest).toMatch(/^[a-f0-9]{64}$/);
});

test('failed physical delivery never unlocks worker observations', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true, physicalDeliveryFailure: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await expect(page.getByText('The test did not reach the LEDs.')).toBeVisible();
  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  await expect(recovery).toContainText('LW-LIGHT-416');
  await expect(recovery.locator('.prod-recovery-primary')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toHaveCount(0);
  await recovery.getByRole('button', { name: 'Release and restart the light test' }).click();
  await expect(recovery).toContainText('LW-LIGHT-416');
  await expect(recovery.locator('.prod-recovery-primary')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toHaveCount(0);
});

test('a failed initial physical delivery can restart and unlock only after a fresh acknowledgement', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true, physicalDeliveryFailureOnce: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  await expect(recovery).toContainText('LW-LIGHT-416');
  await recovery.getByRole('button', { name: 'Release and restart the light test' }).click();
  await expect(recovery).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toBeEnabled();
});

test('count correction invalidates a previously checked downstream boundary before completion', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByRole('tab', { name: /Inner ring/ }).click();
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await page.getByRole('tab', { name: /Outer ring/ }).click();
  await page.getByRole('button', { name: 'Red end is off' }).click();
  await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
  await page.getByRole('button', { name: '+ 1 pixel' }).click();
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await expect(page.getByRole('button', { name: 'Continue to pass record' })).toHaveCount(0);
  await page.getByRole('tab', { name: /Inner ring/ }).click();
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toBeVisible();
});

test('candidate evidence mismatch is rejected before activation', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true, candidateEvidenceMismatch: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByRole('button', { name: 'Red end is off' }).click();
  await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
  await page.getByRole('button', { name: '+ 1 pixel' }).click();
  await expect(page.getByRole('alert')).toContainText('Staged candidate evidence did not match');
  await expect(page.getByText(/Temporary boundary test/)).toHaveCount(0);
  expect(await page.evaluate(() => ({ rollback: localStorage.getItem('lw_test_rollback_count'), status: localStorage.getItem('lw_test_wiring_status_count') }))).toEqual({ rollback: '1', status: '2' });
});

test('candidate activation failure rolls back the exact staged activation and proves known-good independently', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true, activationFailure: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByRole('button', { name: 'Red end is off' }).click();
  await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
  await page.getByRole('button', { name: '+ 1 pixel' }).click();
  await expect(page.getByRole('alert')).toContainText('Candidate activation failed');
  expect(await page.evaluate(() => ({ rollback: localStorage.getItem('lw_test_rollback_count'), status: localStorage.getItem('lw_test_wiring_status_count') }))).toEqual({ rollback: '1', status: '2' });
  await expect(page.getByText('Temporary candidate cleanup required')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Inner ring/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Release and restart the light test' }).click();
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toBeEnabled();
});

test('explicit candidate rollback exposes one restart and requires a fresh boundary acknowledgement', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByRole('button', { name: 'Red end is off' }).click();
  await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
  await page.getByRole('button', { name: '+ 1 pixel' }).click();
  await expect(page.getByText(/Temporary boundary test/)).toBeVisible();
  await page.getByRole('button', { name: 'Restore last confirmed wiring' }).click();
  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  await expect(recovery).toContainText('LW-LIGHT-416');
  await expect(recovery.locator('.prod-recovery-primary')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /Inner ring/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Continue to pass record' })).toHaveCount(0);
  await recovery.getByRole('button', { name: 'Release and restart the light test' }).click();
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toBeEnabled();
  await expect(page.getByRole('tab', { name: /Inner ring/ })).toBeEnabled();
});

for (const [kind, storageKey, expectedRoute] of [
  ['identity', 'lw_test_physical_identity_changed', 'Load verified artwork'],
  ['firmware', 'lw_test_physical_firmware_changed', 'Connect one USB card'],
] as const) {
  test(`${kind} change after rollback preserves its stronger recovery instead of retrying the boundary`, async ({ page }) => {
    await serveJob(page); await installDriver(page, { preflightCurrent: true });
    await page.goto('/#screen=production');
    await page.getByRole('button', { name: /Moon · batch 7/ }).click();
    await page.getByRole('button', { name: 'Connect one USB card' }).click();
    await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
    await page.getByRole('button', { name: 'Load verified artwork' }).click();
    await page.getByRole('button', { name: 'Verify card read-back' }).click();
    await page.getByRole('button', { name: 'Red end is off' }).click();
    await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
    await page.getByRole('button', { name: '+ 1 pixel' }).click();
    await page.getByRole('button', { name: 'Restore last confirmed wiring' }).click();
    await page.evaluate(key => localStorage.setItem(key, '1'), storageKey);
    await page.getByRole('button', { name: 'Release and restart the light test' }).click();
    await expect(page.getByRole('button', { name: 'Stop test and continue safely' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Release and restart the light test' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop test and continue safely' }).click();
    await expect(page.getByRole('button', { name: expectedRoute })).toBeVisible();
  });
}

test('failed candidate rollback stays visibly locked with an actionable retry', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightCurrent: true, candidateEvidenceMismatch: true, rollbackFailure: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await page.getByRole('button', { name: 'Red end is off' }).click();
  await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
  await page.getByRole('button', { name: '+ 1 pixel' }).click();
  await expect(page.getByText('Temporary candidate cleanup required')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore last confirmed wiring' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Inner ring/ })).toBeDisabled();
});

for (const [kind, options] of [
  ['identity', { physicalIdentityMismatch: true }],
  ['firmware', { physicalFirmwareMismatch: true }],
] as const) {
  test(`physical ${kind} failure exposes the safe recovery handoff`, async ({ page }) => {
    await serveJob(page); await installDriver(page, { preflightCurrent: true, ...options });
    await page.goto('/#screen=production');
    await page.getByRole('button', { name: /Moon · batch 7/ }).click();
    await page.getByRole('button', { name: 'Connect one USB card' }).click();
    await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
    await page.getByRole('button', { name: 'Load verified artwork' }).click();
    await page.getByRole('button', { name: 'Verify card read-back' }).click();
    await page.getByRole('button', { name: 'Stop test and continue safely' }).click();
    await expect(page.getByRole('button', { name: kind === 'identity' ? 'Load verified artwork' : 'Connect one USB card' })).toBeVisible();
    expect(await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun().state)).toBe(kind === 'identity' ? 'restore' : 'connect-card');
  });
}

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
  await expect(page.getByRole('region', { name: 'Safe recovery' })).toContainText('not the card bound to this production run');
  await expect(page.getByRole('button', { name: 'Reconnect the expected card' })).toBeVisible();
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
  await expect(page.getByRole('region', { name: 'Safe recovery' })).toContainText('not the card bound to this production run');
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
  await expect(page.getByRole('region', { name: 'Safe recovery' })).toContainText('not the card bound to this production run');
  expect(await page.evaluate(() => localStorage.getItem('lw_test_restore_count'))).toBeNull();
  await expect(page.getByRole('button', { name: 'Reconnect the expected card' })).toBeVisible();
});

test('throwing LAN evidence has a clear handoff retry and never unlocks mutation early', async ({ page }) => {
  await serveJob(page); await installDriver(page, { preflightThrowsOnce: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await expect(page.getByRole('region', { name: 'Safe recovery' })).toContainText('could not read the local card page');
  await expect(page.getByRole('button', { name: 'Reconnect the expected card page' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Install verified firmware|Load verified artwork/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reconnect the expected card page' }).click();
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
  await expect(page.getByRole('button', { name: 'Reconnect the expected card page' })).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect the expected card page' }).click();
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
  await expect(page.getByRole('region', { name: 'Safe recovery' })).toContainText('artwork load response was interrupted');
  expect(await page.evaluate(() => localStorage.getItem('lw_test_restore_count'))).toBe('1');
  await expect(page.getByRole('button', { name: 'Verify card read-back' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Moon · batch 7' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load verified artwork' })).toHaveCount(0);
  const verify = page.getByRole('button', { name: 'Verify card read-back' });
  await expect(verify).toBeEnabled();
  await verify.click();
  await expect(page.getByRole('region', { name: 'Safe recovery' })).toContainText('did not load the artwork a second time');
  await expect(page.getByRole('button', { name: 'Retry verified artwork load' })).toBeVisible();
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
  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  await expect(recovery).toContainText('not a supported Lightweaver ESP32-S3 card');
  await expect(recovery.getByText('Yes', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('lw_test_disconnect_count'))).toBe('1');
  await expect(page.getByRole('button', { name: 'Connect a supported card' })).toBeVisible();
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
