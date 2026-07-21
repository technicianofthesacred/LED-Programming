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
  restoreThrows = false, restoreDelayMs = 0, linkLossDuringRestore = false, invalidInspection = false, recordThrowsOnce = false, recordDelayMs = 0, linkLossDuringRecord = false,
  candidateEvidenceMismatch = false, physicalIdentityMismatch = false, physicalFirmwareMismatch = false,
  activationFailure = false, activationLifecycleChange = false, rollbackFailure = false, rollbackRebootReads = 0, physicalDeliveryFailure = false, physicalDeliveryFailureOnce = false, physicalDeliveryDelayMs = 0, linkLossDuringPhysical = false,
  connectErrorOnce = '',
  disconnectFailureAt = 0, disconnectDelayMs = 0, secondUsbWrong = false, installThrows = false, reconnectFirmwareMismatch = false,
} = {}) {
  await page.addInitScript(({ firmwareVersion, firmwareBuildId, wrongReconnect, wrongLanCard, wrongBeforeRestore, preflightCurrent, preflightThrowsOnce, preflightMissingOnce, restoreThrows, restoreDelayMs, linkLossDuringRestore, invalidInspection, recordThrowsOnce, recordDelayMs, linkLossDuringRecord, candidateEvidenceMismatch, physicalIdentityMismatch, physicalFirmwareMismatch, activationFailure, activationLifecycleChange, rollbackFailure, rollbackRebootReads, physicalDeliveryFailure, physicalDeliveryFailureOnce, physicalDeliveryDelayMs, linkLossDuringPhysical, connectErrorOnce, disconnectFailureAt, disconnectDelayMs, secondUsbWrong, installThrows, reconnectFirmwareMismatch }) => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
    const evidence = {
      cardId: 'lw-aabbccddeeff', firmwareVersion,
      buildId: firmwareBuildId, projectRevision: 12,
      projectFingerprint: '', productionJobId: 'moon-batch-7', productionJobDigest: '',
    };
    const readyCardLink = () => ({
      state: localStorage.getItem('lw_test_card_link_state') || 'connected-bridge',
      transport: 'bridge', host: '192.168.18.70',
      card: { id: evidence.cardId }, expectedCard: { id: evidence.cardId },
      cardBlank: localStorage.getItem('lw_test_card_blank') === '1',
      validatedBootId: localStorage.getItem('lw_test_boot_id') || 'boot-production-1',
      operationGeneration: Number(localStorage.getItem('lw_test_operation_generation') || 4),
      bridgeLifecycle: Number(localStorage.getItem('lw_test_bridge_lifecycle') || 9),
      readiness: {
        app: 'Lightweaver', cardId: evidence.cardId, firmwareVersion, buildId: firmwareBuildId,
        bootId: localStorage.getItem('lw_test_boot_id') || 'boot-production-1',
        commandReady: localStorage.getItem('lw_test_card_blank') !== '1',
        outputReady: localStorage.getItem('lw_test_card_blank') !== '1',
        runtimePhase: localStorage.getItem('lw_test_card_blank') === '1' ? 'factory' : 'ready',
        knownGoodProject: localStorage.getItem('lw_test_card_blank') !== '1',
      },
    });
    window.__LW_PRODUCTION_DRIVER_FOR_TEST__ = {
      getCardLink: readyCardLink,
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
        try {
          if (disconnectDelayMs) await new Promise(resolve => setTimeout(resolve, disconnectDelayMs));
          if (count === disconnectFailureAt) throw new Error('USB port did not release');
        } finally {
          localStorage.setItem('lw_test_disconnect_settled_count', String(count));
        }
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
        if (linkLossDuringPhysical) {
          localStorage.setItem('lw_test_card_link_state', 'revalidating');
          localStorage.setItem('lw_test_operation_generation', '5');
          return { ok: true, generation };
        }
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
        if (activationLifecycleChange) {
          localStorage.setItem('lw_test_bridge_lifecycle', '10');
          localStorage.setItem('lw_test_operation_generation', '5');
          localStorage.setItem('lw_test_boot_id', 'boot-production-2');
        }
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
        if (restoreDelayMs) await new Promise(resolve => setTimeout(resolve, restoreDelayMs));
        if (linkLossDuringRestore) {
          localStorage.setItem('lw_test_card_link_state', 'revalidating');
          localStorage.setItem('lw_test_operation_generation', '5');
        }
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
          if (linkLossDuringRecord) {
            localStorage.setItem('lw_test_card_link_state', 'revalidating');
            localStorage.setItem('lw_test_operation_generation', '5');
          }
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
  }, { firmwareVersion: signedRelease.firmwareVersion, firmwareBuildId: signedRelease.buildId, wrongReconnect, wrongLanCard, wrongBeforeRestore, preflightCurrent, preflightThrowsOnce, preflightMissingOnce, restoreThrows, restoreDelayMs, linkLossDuringRestore, invalidInspection, recordThrowsOnce, recordDelayMs, linkLossDuringRecord, candidateEvidenceMismatch, physicalIdentityMismatch, physicalFirmwareMismatch, activationFailure, activationLifecycleChange, rollbackFailure, rollbackRebootReads, physicalDeliveryFailure, physicalDeliveryFailureOnce, physicalDeliveryDelayMs, linkLossDuringPhysical, connectErrorOnce, disconnectFailureAt, disconnectDelayMs, secondUsbWrong, installThrows, reconnectFirmwareMismatch });
}

test('production fixture tracks the exact currently signed firmware release', async () => {
  const job = await productionJob();
  expect(job.firmware).toMatchObject({
    target: signedRelease.target,
    version: signedRelease.firmwareVersion,
    buildId: signedRelease.buildId,
  });
});

test('HTTPS production transport performs exact blank config then runtime frame through one card-page bridge', async ({ page }) => {
  const job = await productionJob();
  const testPort = Number(process.env.LIGHTWEAVER_TEST_PORT || 9997);
  await page.route('https://led.mandalacodes.com/**', async route => {
    const requested = new URL(route.request().url());
    if (requested.pathname === '/production-bridge-harness') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Production bridge harness</title>' });
      return;
    }
    const upstream = await page.request.fetch(`http://localhost:${testPort}${requested.pathname}${requested.search}`);
    await route.fulfill({ response: upstream });
  });
  await page.goto('https://led.mandalacodes.com/production-bridge-harness', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async ({ configuration, project, jobId, digest, firmware }) => {
    const bridge = await import('/src/lib/cardBridge.js');
    const handoff = await import('/src/lib/cardWifiHandoff.js');
    const linkModule = await import('/src/lib/cardLink.js');
    const leaseModule = await import('/src/lib/productionCardLease.js');
    const pushClient = await import('/src/lib/cardPushClient.js');

    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-prior-card-a' }));
    const priorIdentity = JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null').id;
    const expectedCardId = 'lw-aabbccddeeff';
    const expectedCard = { id: expectedCardId, firmwareVersion: firmware.version, buildId: firmware.buildId };
    const stationHost = '192.168.18.77';
    const bootId = 'boot-production-bridge-1';
    const flowId = 'flow-production-bridge-123456';
    const generation = 4;
    // The deliberate USB inspection is the only action allowed to replace A
    // with B; no LAN envelope can do this implicitly.
    (await import('/src/lib/cardIdentity.js')).adoptExpectedCardIdentity({ id: expectedCardId });
    const messageTypes = [];
    let activeHost = '192.168.4.1';
    let configured = false;
    let status = {
      app: 'Lightweaver', provisioningContractVersion: 1,
      cardId: expectedCardId, firmwareVersion: firmware.version, buildId: firmware.buildId,
      bootId, runtimePhase: 'ready', knownGoodProject: true, commandReady: true, outputReady: true,
      wifi: { transport: 'station', transition: 'handoff-ready', transitionPending: true, apActive: true, stationIp: stationHost, ip: stationHost, handoffGeneration: generation },
    };
    const emit = (data, host = activeHost) => {
      const event = new Event('message');
      Object.defineProperties(event, { data: { value: data }, origin: { value: `http://${host}` }, source: { value: fakeCardTab } });
      window.dispatchEvent(event);
    };
    const emitReady = () => emit({ app: 'LightweaverCardBridge', type: 'ready', version: 2, host: activeHost });
    const fakeCardTab = {
      closed: false, focus() {},
      postMessage(message) {
        const type = String(message.type || '');
        messageTypes.push(type);
        if (type === 'wifi-handoff-ack') {
          status = { ...status, runtimePhase: 'factory', knownGoodProject: false, commandReady: false, outputReady: false,
            wifi: { transport: 'station', transition: 'station', transitionPending: false, apActive: false, stationIp: stationHost, ip: stationHost, handoffGeneration: generation } };
          setTimeout(emitReady, 25);
        }
        if (type === 'config') {
          configured = true;
          status = { ...status, runtimePhase: 'ready', knownGoodProject: true, commandReady: true, outputReady: true };
        }
        const response = type === 'status' ? status : type === 'firmware-info' ? {
          app: 'Lightweaver', cardId: expectedCardId, firmwareVersion: firmware.version, buildId: firmware.buildId,
          projectRevision: configured ? project.revision : 0,
          projectFingerprint: configured ? project.fingerprint : '',
          productionJobId: configured ? jobId : '', productionJobDigest: configured ? digest : '',
        } : { ok: true, saved: type === 'config' };
        setTimeout(() => emit({ app: 'LightweaverCardBridge', version: 2, id: message.id, ok: true, response }), 0);
      },
      location: { set href(value) { activeHost = new URL(value).hostname; } },
    };
    window.open = ((url) => { if (url) activeHost = new URL(String(url)).hostname; if (activeHost === stationHost) setTimeout(emitReady, 0); return fakeCardTab; });

    const opened = bridge.openLocalCardPage('192.168.4.1');
    if (!opened.ok) throw new Error(opened.reason);
    const apStatus = await bridge.sendCardBridgeRequest('status', {}, { host: '192.168.4.1' });
    const correlation = handoff.acceptWifiHandoff({ status: apStatus, expectedCard, expectedBootId: bootId, lastGeneration: generation - 1 });
    if (!correlation) throw new Error('AP handoff correlation was not accepted');
    const retargeted = bridge.retargetCardBridge(stationHost, correlation, { flowId });
    if (!retargeted.ok) throw new Error(retargeted.reason);
    emitReady();
    const blankDeadline = Date.now() + 7000;
    while (Date.now() < blankDeadline && linkModule.getCardLinkState().cardBlank !== true) await new Promise(resolve => setTimeout(resolve, 25));
    const blankLink = linkModule.getCardLinkState();
    if (blankLink.cardBlank !== true) throw new Error(`blank link not ready: ${JSON.stringify(blankLink)}`);
    const configLease = leaseModule.captureProductionCardLease(blankLink, expectedCardId, { mutation: 'config' });
    await pushClient.pushConfigToCard(configuration, {
      host: configLease.host, commissioningFlowId: configLease.commissioningFlowId,
      reboot: false, allowProjectChange: true, allowLayoutChange: true,
    });
    emitReady();
    const readbackDeadline = Date.now() + 7000;
    while (Date.now() < readbackDeadline && !leaseModule.productionCardAuthority(linkModule.getCardLinkState(), expectedCardId, { mutation: 'readback' }).ok) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const readbackLease = leaseModule.captureProductionCardLease(linkModule.getCardLinkState(), expectedCardId, { mutation: 'readback' });
    const evidence = await pushClient.readCardProjectEvidence({ host: readbackLease.host, transport: 'bridge' });
    if (evidence.productionJobDigest !== digest || evidence.cardId !== expectedCardId) throw new Error('independent project readback did not match');
    leaseModule.assertProductionCardLease(readbackLease, linkModule.getCardLinkState(), { mutation: 'readback' });
    const bridgeAuthorityDeadline = Date.now() + 7000;
    while (Date.now() < bridgeAuthorityDeadline && !bridge.getCardBridgeState().runtimeCommandReady) await new Promise(resolve => setTimeout(resolve, 50));
    leaseModule.assertProductionCardLease(readbackLease, linkModule.getCardLinkState(), { mutation: 'readback' });
    bridge.adoptCommissionedCardBridgeIdentity(configLease.commissioningFlowId);
    const readyDeadline = Date.now() + 12000;
    while (Date.now() < readyDeadline && !leaseModule.productionCardAuthority(linkModule.getCardLinkState(), expectedCardId, { mutation: 'runtime' }).ok) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const runtimeLink = linkModule.getCardLinkState();
    const runtimeAuthority = leaseModule.productionCardAuthority(runtimeLink, expectedCardId, { mutation: 'runtime' });
    if (!runtimeAuthority.ok) throw new Error(`runtime link not ready: ${JSON.stringify(runtimeLink)} bridge=${JSON.stringify(bridge.getCardBridgeState())}`);
    const runtimeLease = leaseModule.captureProductionCardLease(runtimeLink, expectedCardId, { mutation: 'runtime' });
    await bridge.sendCardBridgeRequest('frame', { pixels: ['FFFF00'] }, { host: runtimeLease.host });
    leaseModule.assertProductionCardLease(runtimeLease, linkModule.getCardLinkState(), { mutation: 'runtime' });
    const finalEvidence = await pushClient.readCardProjectEvidence({ host: runtimeLease.host, transport: 'bridge' });
    return {
      blankState: blankLink.cardBlank,
      runtimeState: runtimeLink.state,
      runtimeBlank: runtimeLink.cardBlank,
      evidence: finalEvidence,
      ackCount: messageTypes.filter(type => type === 'wifi-handoff-ack').length,
      configCount: messageTypes.filter(type => type === 'config').length,
      frameCount: messageTypes.filter(type => type === 'frame').length,
      priorIdentity,
      pairedIdentity: JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null').id,
    };
  }, { configuration: job.configuration, project: job.project, jobId: job.jobId, digest: job.digest, firmware: job.firmware });

  expect(result).toMatchObject({
    blankState: true, runtimeState: 'connected-bridge', runtimeBlank: false,
    ackCount: 1, configCount: 1, frameCount: 1,
    priorIdentity: 'lw-prior-card-a', pairedIdentity: 'lw-aabbccddeeff',
    evidence: { cardId: 'lw-aabbccddeeff', projectRevision: job.project.revision, projectFingerprint: job.project.fingerprint, productionJobId: job.jobId, productionJobDigest: job.digest },
  });
});

test('a delayed hotspot status cannot retarget or resurrect recovery after the production run is replaced', async ({ page }) => {
  const testPort = Number(process.env.LIGHTWEAVER_TEST_PORT || 9997);
  await page.route('https://led.mandalacodes.com/**', async route => {
    const requested = new URL(route.request().url());
    const upstream = await page.request.fetch(`http://localhost:${testPort}${requested.pathname}${requested.search}`);
    await route.fulfill({ response: upstream });
  });
  const job = await serveJob(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
    window.__LW_PRODUCTION_DRIVER_FOR_TEST__ = {
      connectCard: async () => ({}), disconnect: async () => true,
      inspectCard: async () => ({ cardId: 'lw-aabbccddeeff', chipName: 'ESP32-S3', flashSize: '16MB' }),
    };
  });
  await page.goto('https://led.mandalacodes.com/#screen=production');
  await page.evaluate(firmware => {
    const stationHost = '192.168.18.77';
    let activeHost = '192.168.4.1';
    const stats = { statusStarted: 0, retargets: 0 };
    window.__LW_DELAYED_HANDOFF_STATS__ = stats;
    const fakeCardTab = {
      closed: false, focus() {},
      postMessage(message) {
        if (message.type !== 'status') return;
        stats.statusStarted += 1;
        const response = {
          app: 'Lightweaver', provisioningContractVersion: 1,
          cardId: 'lw-aabbccddeeff', firmwareVersion: firmware.firmwareVersion, buildId: firmware.buildId,
          bootId: 'boot-delayed-handoff', runtimePhase: 'ready', knownGoodProject: true, commandReady: true, outputReady: true,
          wifi: { transport: 'station', transition: 'handoff-ready', transitionPending: true, apActive: true, stationIp: stationHost, ip: stationHost, handoffGeneration: 3 },
        };
        setTimeout(() => {
          const event = new Event('message');
          Object.defineProperties(event, {
            data: { value: { app: 'LightweaverCardBridge', version: 2, id: message.id, ok: true, response } },
            origin: { value: `http://${activeHost}` }, source: { value: fakeCardTab },
          });
          window.dispatchEvent(event);
        }, 250);
      },
      location: { set href(value) { activeHost = new URL(value).hostname; stats.retargets += 1; } },
    };
    window.open = url => { if (url) activeHost = new URL(String(url)).hostname; return fakeCardTab; };
  }, signedRelease);

  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click({ noWaitAfter: true });
  await expect.poll(() => page.evaluate(() => window.__LW_DELAYED_HANDOFF_STATS__.statusStarted)).toBeGreaterThanOrEqual(1);
  const replacementRunId = await page.evaluate(async digest => {
    const module = await import('/src/lib/productionRun.js');
    const replacement = await module.updateProductionRunAtomically(() => {
      const created = module.createProductionRun({ jobDigest: digest });
      const correlation = {
        runId: created.runId, flowId: created.flowId, jobDigest: created.jobDigest,
        operationId: created.operationId, expectedCardId: created.expectedCardId, generation: created.generation,
      };
      return module.transitionProductionRun(created, 'connect-card', { correlation });
    });
    window.dispatchEvent(new StorageEvent('storage', { key: module.PRODUCTION_RUN_COMMIT_A_KEY }));
    return replacement.runId;
  }, job.digest);

  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__LW_DELAYED_HANDOFF_STATS__.retargets)).toBe(0);
  await expect(page.getByRole('region', { name: 'Safe recovery' })).toHaveCount(0);
  expect(await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun())).toMatchObject({ runId: replacementRunId, state: 'connect-card' });
});

test('install-required production reconnects through the factory AP and exact station handoff after flashing', async ({ page }) => {
  const testPort = Number(process.env.LIGHTWEAVER_TEST_PORT || 9997);
  await page.route('https://led.mandalacodes.com/**', async route => {
    const requested = new URL(route.request().url());
    const upstream = await page.request.fetch(`http://localhost:${testPort}${requested.pathname}${requested.search}`);
    await route.fulfill({ response: upstream });
  });
  const job = await serveJob(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
    const oldReadiness = {
      app: 'Lightweaver', cardId: 'lw-aabbccddeeff', firmwareVersion: '0.9.0', buildId: '0'.repeat(40),
      bootId: 'boot-before-flash', runtimePhase: 'factory', knownGoodProject: false, commandReady: false, outputReady: false,
    };
    const driver = {
      connectCard: async () => ({}), disconnect: async () => true,
      inspectCard: async () => ({ cardId: 'lw-aabbccddeeff', chipName: 'ESP32-S3', flashSize: '16MB' }),
      connectLan: async () => {},
      getCardLink: () => ({
        state: 'connected-bridge', transport: 'bridge', host: '192.168.18.70',
        card: { id: 'lw-aabbccddeeff' }, expectedCard: { id: 'lw-aabbccddeeff' },
        cardBlank: true, validatedBootId: 'boot-before-flash', operationGeneration: 4,
        bridgeLifecycle: 9, readiness: oldReadiness,
      }),
      readEvidence: async () => ({
        app: 'Lightweaver', cardId: 'lw-aabbccddeeff', firmwareVersion: '0.9.0', buildId: '0'.repeat(40),
        projectRevision: 0, projectFingerprint: '', productionJobId: '', productionJobDigest: '',
      }),
      install: async ({ onProgress }) => {
        localStorage.setItem('lw_test_factory_flashed', '1');
        delete driver.connectLan; delete driver.getCardLink; delete driver.readEvidence;
        onProgress(1);
      },
    };
    window.__LW_PRODUCTION_DRIVER_FOR_TEST__ = driver;
  });
  await page.goto('https://led.mandalacodes.com/#screen=production');
  await page.evaluate(async firmware => {
    const expectedCardId = 'lw-aabbccddeeff';
    const stationHost = '192.168.18.77';
    const oldBuild = '0'.repeat(40);
    let activeHost = 'lightweaver.local';
    let acked = false;
    const stats = { openHosts: [], status: 0, ack: 0, firmwareInfo: 0 };
    window.__LW_FLASH_HANDOFF_STATS__ = stats;
    const installed = () => localStorage.getItem('lw_test_factory_flashed') === '1';
    const statusEnvelope = () => {
      if (!installed()) return {
        app: 'Lightweaver', provisioningContractVersion: 1, cardId: expectedCardId,
        firmwareVersion: '0.9.0', buildId: oldBuild, bootId: 'boot-before-flash',
        runtimePhase: 'factory', knownGoodProject: false, commandReady: false, outputReady: false,
        wifi: { transport: 'station', transition: 'station', transitionPending: false, apActive: false, stationIp: stationHost, ip: stationHost, handoffGeneration: 1 },
      };
      return {
        app: 'Lightweaver', provisioningContractVersion: 1, cardId: expectedCardId,
        firmwareVersion: firmware.firmwareVersion, buildId: firmware.buildId, bootId: 'boot-after-flash',
        runtimePhase: acked ? 'factory' : 'ready', knownGoodProject: !acked,
        commandReady: !acked, outputReady: !acked,
        wifi: acked
          ? { transport: 'station', transition: 'station', transitionPending: false, apActive: false, stationIp: stationHost, ip: stationHost, handoffGeneration: 2 }
          : { transport: 'station', transition: 'handoff-ready', transitionPending: true, apActive: true, stationIp: stationHost, ip: stationHost, handoffGeneration: 2 },
      };
    };
    const firmwareInfo = () => ({
      app: 'Lightweaver', cardId: expectedCardId,
      firmwareVersion: installed() ? firmware.firmwareVersion : '0.9.0',
      buildId: installed() ? firmware.buildId : oldBuild,
      outputs: [],
    });
    const emit = (data, host = activeHost) => {
      const event = new Event('message');
      Object.defineProperties(event, { data: { value: data }, origin: { value: `http://${host}` }, source: { value: fakeCardTab } });
      window.dispatchEvent(event);
    };
    const emitReady = () => emit({ app: 'LightweaverCardBridge', type: 'ready', version: 2, host: activeHost });
    const fakeCardTab = {
      closed: false, focus() {},
      postMessage(message) {
        let response = { ok: true };
        if (message.type === 'status') { stats.status += 1; response = statusEnvelope(); }
        else if (message.type === 'firmware-info') { stats.firmwareInfo += 1; response = firmwareInfo(); }
        else if (message.type === 'wifi-handoff-ack') { stats.ack += 1; acked = true; response = { ok: true, handoffGeneration: 2 }; }
        queueMicrotask(() => emit({ app: 'LightweaverCardBridge', version: 2, id: message.id, ok: true, response }));
      },
      location: { set href(value) { activeHost = new URL(value).hostname; if (activeHost === stationHost) setTimeout(emitReady, 0); } },
    };
    window.open = url => {
      if (url) activeHost = new URL(String(url)).hostname;
      stats.openHosts.push(activeHost);
      return fakeCardTab;
    };
  }, signedRelease);

  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await expect(page.getByRole('button', { name: 'Reconnect same USB card' })).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  await page.getByRole('button', { name: 'Install verified firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same card' }).click();
  await expect(page.getByRole('button', { name: 'Load verified artwork' })).toBeVisible({ timeout: 12_000 });

  const result = await page.evaluate(async () => ({
    stats: window.__LW_FLASH_HANDOFF_STATS__,
    flashed: localStorage.getItem('lw_test_factory_flashed'),
    run: (await import('/src/lib/productionRun.js')).readProductionRun(),
  }));
  expect(result.flashed).toBe('1');
  expect(result.stats.openHosts).toContain('192.168.4.1');
  expect(result.stats.ack).toBe(1);
  expect(result.stats.firmwareInfo).toBeGreaterThanOrEqual(2);
  expect(result.run).toMatchObject({ state: 'restore', expectedCardId: 'lw-aabbccddeeff', cardChanged: true });
});

test('HTTPS ProductionScreen commissions a blank card through bridge, human light checks, final reads, and pass', async ({ page }) => {
  const testPort = Number(process.env.LIGHTWEAVER_TEST_PORT || 9997);
  await page.route('https://led.mandalacodes.com/**', async route => {
    const requested = new URL(route.request().url());
    const upstream = await page.request.fetch(`http://localhost:${testPort}${requested.pathname}${requested.search}`);
    await route.fulfill({ response: upstream });
  });
  const job = await serveJob(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
    window.__LW_PRODUCTION_DRIVER_FOR_TEST__ = {
      connectCard: async () => ({}),
      disconnect: async () => true,
      inspectCard: async () => ({ cardId: 'lw-aabbccddeeff', chipName: 'ESP32-S3', flashSize: '16MB' }),
    };
  });
  await page.goto('https://led.mandalacodes.com/#screen=production');

  await page.evaluate(async ({ firmware, project, jobId, digest }) => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-prior-card-a' }));
    const linkModule = await import('/src/lib/cardLink.js');
    const expectedCardId = 'lw-aabbccddeeff';
    const stationHost = '192.168.18.77';
    const bootId = 'boot-production-ui-1';
    const handoffGeneration = 8;
    let activeHost = '192.168.4.1';
    let configured = null;
    let acked = false;
    const stats = {
      apStatus: 0, stationStatusBeforeAck: 0, ack: 0, config: 0,
      firmwareInfo: 0, wiringStatus: 0, frame: 0,
    };
    window.__LW_REAL_PRODUCTION_BRIDGE_STATS__ = stats;

    const statusEnvelope = () => ({
      app: 'Lightweaver', provisioningContractVersion: 1,
      cardId: expectedCardId, firmwareVersion: firmware.version, buildId: firmware.buildId,
      bootId,
      runtimePhase: configured ? 'ready' : acked ? 'factory' : 'ready',
      knownGoodProject: Boolean(configured),
      commandReady: Boolean(configured), outputReady: Boolean(configured),
      wifi: acked
        ? { transport: 'station', transition: 'station', transitionPending: false, apActive: false, stationIp: stationHost, ip: stationHost, handoffGeneration }
        : { transport: 'station', transition: 'handoff-ready', transitionPending: true, apActive: true, stationIp: stationHost, ip: stationHost, handoffGeneration },
    });
    const firmwareInfo = () => ({
      app: 'Lightweaver', cardId: expectedCardId,
      firmwareVersion: firmware.version, buildId: firmware.buildId,
      ...(configured ? {
        projectRevision: project.revision,
        projectFingerprint: project.fingerprint,
        productionJobId: jobId,
        productionJobDigest: digest,
      } : {}),
      outputs: configured?.led?.outputs || [],
    });
    const wiringStatus = () => ({
      app: 'Lightweaver', state: 'known-good', cardId: expectedCardId,
      firmwareVersion: firmware.version, buildId: firmware.buildId,
      projectRevision: project.revision, projectFingerprint: project.fingerprint,
      productionJobId: jobId, productionJobDigest: digest,
      colorOrder: configured?.led?.colorOrder,
      maxMilliamps: configured?.led?.maxMilliamps,
      wiringRevision: configured?.wiringRevision,
      wiringDigest: configured?.wiringDigest,
      outputs: configured?.led?.outputs || [],
    });
    const emit = (data, host = activeHost) => {
      const event = new Event('message');
      Object.defineProperties(event, {
        data: { value: data }, origin: { value: `http://${host}` }, source: { value: fakeCardTab },
      });
      window.dispatchEvent(event);
    };
    const emitReady = () => emit({ app: 'LightweaverCardBridge', type: 'ready', version: 2, host: activeHost });
    const fakeCardTab = {
      closed: false,
      focus() {},
      postMessage(message) {
        const type = String(message.type || '');
        let response = { ok: true };
        if (type === 'status') {
          if (activeHost === stationHost && !acked) stats.stationStatusBeforeAck += 1;
          else if (activeHost !== stationHost) stats.apStatus += 1;
          response = statusEnvelope();
        } else if (type === 'firmware-info') {
          stats.firmwareInfo += 1;
          response = firmwareInfo();
        } else if (type === 'wifi-handoff-ack') {
          stats.ack += 1;
          stats.handoffEnvelopeCountAtAck = linkModule.getCardLinkState().handoffEnvelopeCount;
          acked = true;
          response = { ok: true, handoffGeneration };
        } else if (type === 'config') {
          stats.config += 1;
          configured = structuredClone(message.payload);
          response = { ok: true, saved: true, requiresReboot: false };
        } else if (type === 'wiring-status') {
          stats.wiringStatus += 1;
          response = wiringStatus();
        } else if (type === 'frame') {
          stats.frame += 1;
          response = { ok: true, wsOpen: true };
        } else if (type === 'control') {
          response = { ok: true, wsOpen: true };
        }
        queueMicrotask(() => {
          emit({ app: 'LightweaverCardBridge', version: 2, id: message.id, ok: true, response });
        });
      },
      location: { set href(value) {
        activeHost = new URL(value).hostname;
        if (activeHost === stationHost) setTimeout(emitReady, 0);
      } },
    };
    window.open = url => {
      if (url) activeHost = new URL(String(url)).hostname;
      return fakeCardTab;
    };
  }, { firmware: job.firmware, project: job.project, jobId: job.jobId, digest: job.digest });

  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await expect(page.getByRole('button', { name: 'Load verified artwork' })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByRole('button', { name: /Needs project/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Needs project/ })).not.toHaveClass(/connected/);
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.getByRole('button', { name: 'Verify card read-back' }).click();
  await expect(page.getByText('Test delivered to this exact boundary. Look at the real LEDs — this is not a pass.')).toBeVisible({ timeout: 12_000 });
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await page.getByRole('tab', { name: /Inner ring/ }).click();
  await expect(page.getByText('Test delivered to this exact boundary. Look at the real LEDs — this is not a pass.')).toBeVisible();
  await page.getByRole('button', { name: 'Yes, this boundary is correct' }).click();
  await page.getByRole('button', { name: 'Continue to pass record' }).click();
  await page.getByLabel('Worker initials or ID').fill('AR');
  await page.getByRole('button', { name: 'Save pass record' }).click();
  await expect(page.getByText('Artwork passed')).toBeVisible();

  const result = await page.evaluate(async () => ({
    stats: window.__LW_REAL_PRODUCTION_BRIDGE_STATS__,
    pairedIdentity: JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null')?.id,
    run: (await import('/src/lib/productionRun.js')).readProductionRun(),
    records: (await import('/src/lib/productionRecords.js')).readProductionRecords(),
  }));
  expect(result.stats.stationStatusBeforeAck).toBe(3);
  expect(result.stats.apStatus).toBeGreaterThanOrEqual(1);
  expect(result.stats.handoffEnvelopeCountAtAck).toBe(2);
  expect(result.stats.ack).toBe(1);
  expect(result.stats.config).toBe(1);
  expect(result.stats.frame).toBeGreaterThanOrEqual(1);
  expect(result.stats.firmwareInfo).toBeGreaterThanOrEqual(4);
  expect(result.stats.wiringStatus).toBeGreaterThanOrEqual(2);
  expect(result.pairedIdentity).toBe('lw-aabbccddeeff');
  expect(result.run).toMatchObject({ state: 'complete', expectedCardId: 'lw-aabbccddeeff' });
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ runId: result.run.runId, cardId: 'lw-aabbccddeeff', workerId: 'AR' });
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

test('a stale USB recovery action cannot mutate a replacement production run', async ({ page }) => {
  const job = await serveJob(page);
  await installDriver(page, { invalidInspection: true, disconnectFailureAt: 1, disconnectDelayMs: 200 });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();

  const recovery = page.getByRole('region', { name: 'Safe recovery' });
  const release = recovery.getByRole('button', { name: 'Release USB safely' });
  await expect(release).toBeVisible();
  const staleRunId = await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun().runId);
  await release.click({ noWaitAfter: true });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_test_disconnect_count'))).toBe('2');

  const replacementRunId = await page.evaluate(async digest => {
    const module = await import('/src/lib/productionRun.js');
    const replacement = await module.updateProductionRunAtomically(() => {
      const created = module.createProductionRun({ jobDigest: digest });
      const correlation = {
        runId: created.runId,
        flowId: created.flowId,
        jobDigest: created.jobDigest,
        operationId: created.operationId,
        expectedCardId: created.expectedCardId,
        generation: created.generation,
      };
      return module.transitionProductionRun(created, 'connect-card', { correlation });
    });
    window.dispatchEvent(new StorageEvent('storage', { key: module.PRODUCTION_RUN_COMMIT_A_KEY }));
    return replacement.runId;
  }, job.digest);

  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_test_disconnect_settled_count'))).toBe('2');
  await expect(recovery).toHaveCount(0);
  const storedRun = await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun());
  expect(replacementRunId).not.toBe(staleRunId);
  expect(storedRun).toMatchObject({ runId: replacementRunId, state: 'connect-card', usbReleased: true });
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
  await serveJob(page); await installDriver(page, { preflightCurrent: true, activationLifecycleChange: true });
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

test('card-link lifecycle loss during the one config write cancels advancement and demotes the run', async ({ page }) => {
  await serveJob(page);
  await installDriver(page, { restoreDelayMs: 25, linkLossDuringRestore: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  await page.getByRole('button', { name: 'Install verified firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same card' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();

  await expect(page.getByRole('button', { name: 'Verify card read-back' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toHaveCount(0);
  expect(await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun().state)).toBe('verify-card');
  expect(await page.evaluate(() => localStorage.getItem('lw_test_restore_count'))).toBe('1');
});

test('card-link loss while starting a frame leaves the boundary unconfirmed and cannot reach pass', async ({ page }) => {
  await serveJob(page);
  await installDriver(page, { physicalDeliveryDelayMs: 25, linkLossDuringPhysical: true });
  await page.goto('/#screen=production');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await page.getByRole('button', { name: 'Connect one USB card' }).click();
  await page.getByRole('button', { name: 'Release USB and inspect firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same USB card' }).click();
  await page.getByRole('button', { name: 'Install verified firmware' }).click();
  await page.getByRole('button', { name: 'Reconnect same card' }).click();
  await page.getByRole('button', { name: 'Load verified artwork' }).click();
  await page.evaluate(() => {
    localStorage.setItem('lw_test_card_link_state', 'connected-bridge');
    localStorage.setItem('lw_test_operation_generation', '4');
  });
  await page.getByRole('button', { name: 'Verify card read-back' }).click();

  await expect(page.getByText(/card link changed|did not reach the LEDs/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yes, this boundary is correct' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue to pass record' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('lw_test_physical_frame'))).toBeNull();
});

test('card-link loss during final read-back never writes a production pass', async ({ page }) => {
  await serveJob(page);
  await installDriver(page, { recordDelayMs: 25, linkLossDuringRecord: true });
  await page.goto('/#screen=production');
  await reachPassRecord(page);
  await page.getByLabel('Worker initials or ID').fill('AR');
  await page.getByRole('button', { name: 'Save pass record' }).click();

  await expect(page.getByText(/Pass was not completed.*card link/i)).toBeVisible();
  await expect(page.getByText('Artwork passed')).toHaveCount(0);
  await expect(page.getByText('No completed artwork passes')).toBeVisible();
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
  const entry = page.getByRole('button', { name: 'Card', exact: true });
  await entry.focus();
  await entry.press('Enter');
  await expect(page).toHaveURL(/#screen=card&section=overview/);
  // Batch production is no longer a section tab; it is reached from the
  // low-emphasis overview link.
  const batch = page.getByTestId('card-batch-link').getByRole('button', { name: 'Batch production', exact: true });
  await batch.focus();
  await batch.press('Enter');
  await expect(page).toHaveURL(/#screen=card&section=workshop/);
  await expect(page.getByRole('heading', { name: 'Batch production', level: 1 })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Production setup', level: 2 })).toBeVisible();
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

test('canonical workshop route stays canonical while selecting and clearing a job', async ({ page }) => {
  await serveJob(page); await installDriver(page);
  await page.goto('/#screen=card&section=workshop');
  await page.getByRole('button', { name: /Moon · batch 7/ }).click();
  await expect(page).toHaveURL(/#screen=card&section=workshop&job=moon-batch-7$/);
  await page.getByRole('button', { name: 'Change job' }).click();
  await expect(page).toHaveURL(/#screen=card&section=workshop$/);
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

test('a stale tab cannot append a pass or complete a replacement production run', async ({ page }) => {
  const job = await serveJob(page);
  await installDriver(page, { recordDelayMs: 150 });
  await page.goto('/#screen=production');
  await reachPassRecord(page);
  const originalRunId = await page.evaluate(async () => (await import('/src/lib/productionRun.js')).readProductionRun().runId);
  await page.getByLabel('Worker initials or ID').fill('STALE');
  await page.getByRole('button', { name: 'Save pass record' }).click({ noWaitAfter: true });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_test_record_attempts'))).toBe('1');

  const replacementRunId = await page.evaluate(async digest => {
    const module = await import('/src/lib/productionRun.js');
    const bind = run => ({
      runId: run.runId, flowId: run.flowId, jobDigest: run.jobDigest,
      operationId: run.operationId, expectedCardId: run.expectedCardId,
      generation: run.generation,
    });
    const replacement = await module.updateProductionRunAtomically(() => {
      let run = module.createProductionRun({ jobDigest: digest });
      run = module.transitionProductionRun(run, 'connect-card', { correlation: bind(run) });
      run = module.transitionProductionRun(run, 'inspect', { correlation: bind(run), expectedCardId: 'lw-aabbccddeeff' });
      run = module.transitionProductionRun(run, 'restore', { correlation: bind(run) });
      run = module.transitionProductionRun(run, 'verify-card', { correlation: bind(run) });
      run = module.transitionProductionRun(run, 'check-lights', { correlation: bind(run) });
      return module.transitionProductionRun(run, 'record', { correlation: bind(run) });
    });
    window.dispatchEvent(new StorageEvent('storage', { key: module.PRODUCTION_RUN_COMMIT_A_KEY }));
    return replacement.runId;
  }, job.digest);

  await expect(page.getByRole('alert')).toContainText(/production run changed|Pass was not completed/i);
  const state = await page.evaluate(async () => {
    const runModule = await import('/src/lib/productionRun.js');
    const recordModule = await import('/src/lib/productionRecords.js');
    return { run: runModule.readProductionRun(), records: recordModule.readProductionRecords() };
  });
  expect(replacementRunId).not.toBe(originalRunId);
  expect(state.run).toMatchObject({ runId: replacementRunId, state: 'record' });
  expect(state.records.filter(record => record.runId === originalRunId || record.runId === replacementRunId)).toEqual([]);
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
