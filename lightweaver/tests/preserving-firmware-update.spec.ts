import { test, expect } from '@playwright/test';

const CARD_ID = 'lw-b0fe81f61b44';
const OLD_BUILD = '1'.repeat(40);
const TARGET_BUILD = '2'.repeat(40);
const HEAD = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);

async function openPreservingFixture(page: any, mode: 'wifi' | 'usb', outcome = 'progress', capabilityShape = 'current') {
  if (outcome === 'reload-disconnected' || outcome === 'in-place-disconnect') {
    const exactRestartedStatus = {
      app: 'Lightweaver', provisioningContractVersion: 1,
      cardId: CARD_ID, bootId: 'boot-new', projectHead: HEAD, projectFingerprint: FINGERPRINT,
      projectId: 'recovered-project', projectRevision: 7,
      firmwareVersion: '1.2.0', buildId: TARGET_BUILD, buildNumber: 1300,
      runtimePhase: 'ready', knownGoodProject: true, commandReady: true,
      outputReady: true, playbackReady: true,
    };
    await page.route('http://lightweaver.local/api/status', route => route.fulfill({ json: exactRestartedStatus }));
    await page.route('http://lightweaver.local/api/update/status', route => route.fulfill({ json: { phase: 'idle' } }));
  }
  await page.addInitScript(({ mode, outcome, capabilityShape, cardId, oldBuild, targetBuild, head, fingerprint }) => {
    localStorage.clear();
    sessionStorage.clear();
    const imageBytes = new Uint8Array([0xe9, 1, 2]);
    const recovering = outcome === 'reload-valid';
    const disconnectedRecovery = outcome === 'reload-disconnected';
    (window as any).__LW_PRESERVING_UPDATE_FIXTURE__ = {
      ...(disconnectedRecovery ? {} : {
      ...(mode === 'usb' ? { mode } : {}),
      card: { id: cardId, cardId, firmwareVersion: recovering ? '1.2.0' : '1.1.1', buildId: recovering ? targetBuild : oldBuild, buildNumber: recovering ? 1300 : 1198 },
      readiness: {
        cardId, bootId: recovering ? 'boot-new' : 'boot-old', projectHead: head, projectFingerprint: fingerprint,
        firmwareVersion: recovering ? '1.2.0' : '1.1.1', buildId: recovering ? targetBuild : oldBuild,
        firmwareUpdate: { phase: recovering ? 'valid' : 'idle', rollbackReason: '' },
        ...(capabilityShape === 'current'
          ? { capabilities: { firmwareUpdate: { version: 1, network: mode === 'wifi', softwareGrant: mode === 'wifi' } } }
          : capabilityShape === 'network-physical'
            ? { capabilities: { firmwareUpdate: { version: 1, network: mode === 'wifi' } } }
          : { firmwareUpdate: { version: 1, network: mode === 'wifi' } }),
      },
      }),
    };
    if (recovering || disconnectedRecovery) sessionStorage.setItem('lw_firmware_update_session_v1', JSON.stringify({
      version: 1, cardId, previousBootId: 'boot-old', expectedProjectHead: head,
      expectedProjectFingerprint: fingerprint, targetFirmwareVersion: '1.2.0',
      targetBuildId: targetBuild, targetBuildNumber: 1300, ticketSha256: '4'.repeat(64),
      phase: disconnectedRecovery ? 'valid' : 'restarting', acknowledgedBytes: 3,
    }));
    (window as any).__LW_LOAD_UPDATE_RELEASE_FOR_TEST__ = async () => ({
      manifest: { target: 'esp32-s3-n16r8', firmwareVersion: '1.2.0', buildId: targetBuild, buildNumber: 1300 },
      ticket: {
        schemaVersion: 1, target: 'esp32-s3-n16r8', firmwareVersion: '1.2.0', buildId: targetBuild, buildNumber: 1300,
        image: { size: 3, sha256: '0'.repeat(64) },
        partition: { layout: 'default_16MB.csv', tableSha256: '3'.repeat(64), app0Offset: 0x10000, app1Offset: 0x650000, slotSize: 0x640000 },
        compatibility: { minimumBootstrapBuild: 1198 }, preservation: { dataPartitionsIncluded: false },
      },
      ticketBytes: new Uint8Array([1]), ticketSha256: '4'.repeat(64), ticketSignature: new Uint8Array(64), imageBytes,
    });
    (window as any).__LW_UPDATE_READ_STATUS_CALLS__ = 0;
    (window as any).__LW_PRESERVING_RECONNECT_TIMEOUT_MS__ = outcome === 'reload-disconnected' ? 800 : 75;
    (window as any).__LW_RUN_PRESERVING_USB_BOOTSTRAP_FOR_TEST__ = async ({ onProgress }: any) => {
      onProgress({ phase: 'updating', progress: 1 });
      onProgress({ phase: 'verifying', progress: 1 });
      if (outcome === 'usb-verifying') await new Promise(() => {});
      return { ok: true };
    };
    (window as any).__LW_CREATE_FIRMWARE_UPDATER_FOR_TEST__ = ({ onProgress }: any) => {
      const saveExactSession = (phase: string) => sessionStorage.setItem('lw_firmware_update_session_v1', JSON.stringify({
        version: 1, cardId, previousBootId: 'boot-old', expectedProjectHead: head,
        expectedProjectFingerprint: fingerprint, targetFirmwareVersion: '1.2.0',
        targetBuildId: targetBuild, targetBuildNumber: 1300, ticketSha256: '4'.repeat(64),
        phase, acknowledgedBytes: phase === 'preflight' ? 0 : 3,
      }));
      return ({
      preflight: async () => {
        if (outcome === 'http-400') throw Object.assign(new Error('owner binding is incomplete'), {
          status: 400, code: 'owner binding is incomplete',
        });
        saveExactSession('preflight');
        onProgress({ phase: 'preflight', acknowledgedBytes: 0, totalBytes: 3 });
      },
      begin: async () => {
        saveExactSession('sending');
        onProgress({ phase: 'sending', acknowledgedBytes: 0, totalBytes: 3 });
        if (outcome === 'pause-sending') await new Promise(() => {});
      },
      send: async () => { onProgress({ phase: 'sending', acknowledgedBytes: 3, totalBytes: 3 }); },
      commit: async () => {
        saveExactSession('restarting');
        if (outcome === 'in-place-disconnect') (window as any).__LW_PRESERVING_UPDATE_FIXTURE__ = null;
        onProgress({ phase: 'restarting', acknowledgedBytes: 3, totalBytes: 3 });
      },
      readStatus: async () => {
        (window as any).__LW_UPDATE_READ_STATUS_CALLS__ += 1;
        const status = outcome === 'rollback'
          ? { phase: 'rolled-back', restoredBuildNumber: 1198, rollbackReason: 'boot-health-failed' }
          : { phase: 'pending-reboot', receivedBytes: 3 };
        onProgress(status);
        return status;
      },
      });
    };
  }, { mode, outcome, capabilityShape, cardId: CARD_ID, oldBuild: OLD_BUILD, targetBuild: TARGET_BUILD, head: HEAD, fingerprint: FINGERPRINT });
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', {
    name: capabilityShape === 'legacy' ? 'Install Lightweaver' : 'Update Lightweaver',
  })).toBeVisible({ timeout: 15_000 });
}

test('preserving update: capable card uses Wi-Fi with exact preservation facts and acknowledged phases', async ({ page }) => {
  await openPreservingFixture(page, 'wifi');
  const panel = page.getByTestId('preserving-update-panel');
  await expect(panel.getByRole('button', { name: 'Update over Wi-Fi' })).toBeVisible();
  await expect(panel).toContainText(CARD_ID);
  await expect(panel).toContainText('1.1.1 · Build 1198');
  await expect(panel).toContainText('1.2.0 · Build 1300');
  await expect(panel).toContainText(HEAD);
  await expect(panel).toContainText('Keeps Wi-Fi, project, patterns, wiring, and settings');
  await expect(panel).not.toContainText(/SSID|password|flash address|partition/i);
  await expect(page.getByRole('button', { name: 'Find connected card' })).toHaveCount(0);

  const updateAction = panel.getByRole('button', { name: 'Update over Wi-Fi' });
  const targetBuild = panel.getByText('1.2.0 · Build 1300');
  await expect(updateAction).not.toHaveClass(/btn-lg|primary/);
  await expect(updateAction).toHaveCSS('justify-self', 'end');
  const targetBox = await targetBuild.boundingBox();
  const actionBox = await updateAction.boundingBox();
  expect(targetBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.y).toBeGreaterThan(targetBox!.y + targetBox!.height);
  expect(Math.abs((actionBox!.x + actionBox!.width) - (targetBox!.x + targetBox!.width))).toBeLessThanOrEqual(1);
  await updateAction.click();
  await expect(panel).toContainText('securely binds this signed update to this exact card');
  await expect(panel.getByRole('checkbox', { name: /physically confirmed/i })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Start secure Wi-Fi update' }).click();
  await expect(panel).toContainText('Restarting card');
});

test('preserving update: a legacy top-level capability cannot unlock network firmware update', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'progress', 'legacy');
  await expect(page.getByRole('button', { name: 'Update over Wi-Fi' })).toHaveCount(0);
});

test('preserving update: an older network-capable card retains the one-button bootstrap path', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'progress', 'network-physical');
  const panel = page.getByTestId('preserving-update-panel');
  await panel.getByRole('button', { name: 'Update over Wi-Fi' }).click();
  await expect(panel).toContainText('Briefly press BOOT/control once');
  await expect(panel.getByRole('checkbox', { name: /physically confirmed/i })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Start secure Wi-Fi update' })).toHaveCount(0);
  await panel.getByRole('checkbox', { name: /physically confirmed/i }).check();
  await panel.getByRole('button', { name: 'Start preserving update' }).click();
  await expect(panel).toContainText('Restarting card');
});

test('preserving update: a software-capable card keeps the physical fallback available', async ({ page }) => {
  await openPreservingFixture(page, 'wifi');
  const panel = page.getByTestId('preserving-update-panel');
  await panel.getByRole('button', { name: 'Update over Wi-Fi' }).click();
  await panel.getByRole('button', { name: 'Use card button instead' }).click();
  await expect(panel).toContainText('Briefly press BOOT/control once');
  await expect(panel.getByRole('checkbox', { name: /physically confirmed/i })).toBeVisible();
  await panel.getByRole('button', { name: 'Use secure software authorization' }).click();
  await expect(panel.getByRole('button', { name: 'Start secure Wi-Fi update' })).toBeVisible();
});

test('preserving update: Wi-Fi panel surfaces the card response detail for a rejected request', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'http-400');
  const panel = page.getByTestId('preserving-update-panel');
  await panel.getByRole('button', { name: 'Update over Wi-Fi' }).click();
  await panel.getByRole('button', { name: 'Start secure Wi-Fi update' }).click();
  await expect(panel.getByRole('alert')).toHaveText('owner binding is incomplete');
  await expect(panel.getByRole('alert')).not.toContainText('Card returned HTTP 400');
});

test('preserving update: rollback names the restored build and a redacted reason', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'rollback');
  const panel = page.getByTestId('preserving-update-panel');
  await panel.getByRole('button', { name: 'Update over Wi-Fi' }).click();
  await panel.getByRole('button', { name: 'Start secure Wi-Fi update' }).click();
  await expect(panel).toContainText('Update rolled back');
  await expect(panel).toContainText('restored Build 1198');
  await expect(panel).toContainText('boot-health-failed');
  expect(await page.evaluate(() => (window as any).__LW_UPDATE_READ_STATUS_CALLS__)).toBeGreaterThan(0);
});

test('preserving update: reload resumes redacted state and shows valid only after exact correlation', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'reload-valid');
  const panel = page.getByTestId('preserving-update-panel');
  await expect(panel).toContainText(`Reconnected to Card ${CARD_ID} on firmware 1.2.0 · Build 1300`);
});

test('preserving update: a Wi-Fi reboot self-heals from exact runtime-known-good evidence', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'reload-disconnected');
  const panel = page.getByTestId('preserving-update-panel');
  await expect(panel).toContainText(`Reconnected to Card ${CARD_ID} on firmware 1.2.0 · Build 1300`);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('lw_firmware_update_session_v1'))).toBeNull();
  const recoveredLink = await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const state = getSharedCardLink().getState();
    return {
      cardId: state.readiness?.cardId,
      bootId: state.validatedBootId || state.readiness?.bootId,
      projectHead: state.readiness?.projectHead,
      projectFingerprint: state.readiness?.projectFingerprint,
      firmwareVersion: state.readiness?.firmwareVersion,
      buildId: state.readiness?.buildId,
    };
  });
  expect(recoveredLink).toEqual({
    cardId: CARD_ID,
    bootId: 'boot-new',
    projectHead: HEAD,
    projectFingerprint: FINGERPRINT,
    firmwareVersion: '1.2.0',
    buildId: TARGET_BUILD,
  });
});

test('preserving update: navigation cannot discard an active update lifecycle or reopen controls', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'pause-sending');
  const panel = page.getByTestId('preserving-update-panel');
  await panel.getByRole('button', { name: 'Update over Wi-Fi' }).click();
  await panel.getByRole('button', { name: 'Start secure Wi-Fi update' }).click();
  await expect(panel).toContainText('Sending signed update');

  await page.getByRole('button', { name: 'Layout' }).click();
  await expect(page).toHaveURL(/screen=layout/);
  const footer = page.getByTestId('card-link-status');
  await expect(footer).toHaveAccessibleName(/Updating card/);
  await footer.click();
  await expect(page.getByRole('dialog', { name: /connect lightweaver/i })).toBeVisible();
  await expect(page.getByRole('dialog', { name: /controls/i })).toHaveCount(0);
});

test('preserving update: an in-place disconnect retains the new session and self-heals through the real coordinator', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'in-place-disconnect');
  const panel = page.getByTestId('preserving-update-panel');
  await panel.getByRole('button', { name: 'Update over Wi-Fi' }).click();
  await panel.getByRole('button', { name: 'Start secure Wi-Fi update' }).click();
  await expect(panel).toContainText(`Reconnected to Card ${CARD_ID} on firmware 1.2.0 · Build 1300`);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('lw_firmware_update_session_v1'))).toBeNull();
});

test('preserving update: an already healthy exact card clears stale restart evidence outside the update route', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  const status = await page.evaluate(async ({ cardId, targetBuild }) => {
    const { createDefaultProject, migrateProject } = await import('/src/lib/projectModel.js');
    const { cardProjectFingerprint } = await import('/src/lib/cardProjectResolver.js');
    const project = createDefaultProject();
    project.id = 'stale-session-project';
    project.name = 'Stale session project';
    const migratedProject = migrateProject(project);
    const fingerprint = cardProjectFingerprint(migratedProject);
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('lw_autosave_v3', JSON.stringify(migratedProject));
    localStorage.setItem('lw_autosave_v3_backup', JSON.stringify(migratedProject));
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1, id: cardId, firmwareVersion: '1.1.13', buildId: targetBuild,
    }));
    localStorage.setItem('lw_chip_card_host', 'lightweaver.local');
    sessionStorage.setItem('lw_firmware_update_session_v1', JSON.stringify({
      version: 1, cardId, previousBootId: 'boot-before-update',
      expectedProjectHead: '', expectedProjectFingerprint: fingerprint,
      targetFirmwareVersion: '1.1.13', targetBuildId: targetBuild,
      targetBuildNumber: 1286, ticketSha256: '4'.repeat(64),
      phase: 'pending-reboot', acknowledgedBytes: 3,
    }));
    return {
      app: 'Lightweaver', provisioningContractVersion: 1, cardId,
      bootId: 'boot-after-update', firmwareVersion: '1.1.13', buildId: targetBuild, buildNumber: 1286,
      projectId: project.id, projectRevision: 0, projectHead: '', projectFingerprint: fingerprint,
      runtimePhase: 'ready', knownGoodProject: true, commandReady: true,
      outputReady: true, playbackReady: true, provisionalSetup: false,
      firmwareUpdate: { phase: 'idle' },
    };
  }, { cardId: CARD_ID, targetBuild: TARGET_BUILD });
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({ json: status }));
  await page.route('http://lightweaver.local/api/firmware-info', route => route.fulfill({ json: status }));
  // The query change forces a new document so the app boots from the project
  // and recovery session written above instead of retaining the first mount.
  await page.goto('/?stale-recovery=1#screen=card&section=support', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async freshStatus => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const event = {
      type: 'card-verified', via: 'direct', host: 'lightweaver.local',
      card: { id: freshStatus.cardId, firmwareVersion: freshStatus.firmwareVersion, buildId: freshStatus.buildId },
      expectedCard: { id: freshStatus.cardId, firmwareVersion: freshStatus.firmwareVersion, buildId: freshStatus.buildId },
      readiness: freshStatus,
    };
    getSharedCardLink().dispatch(event);
    getSharedCardLink().dispatch(event);
  }, status);

  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('lw_firmware_update_session_v1'))).toBeNull();
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Connected/);
});

test('preserving update: older card offers one USB bootstrap and separates factory reset', async ({ page }) => {
  await openPreservingFixture(page, 'usb');
  const panel = page.getByTestId('preserving-update-panel');
  await expect(panel.getByRole('button', { name: 'Update once over USB' })).toBeVisible();
  await expect(panel).toContainText('Future updates use Wi-Fi');
  await expect(panel).not.toContainText(/erase all|flash address|choose.*file/i);
  const recovery = page.getByText('Factory reset and reinstall', { exact: true });
  await expect(recovery).toBeVisible();
  await recovery.click();
  await expect(page.getByText(/permanently removes Wi-Fi, projects, patterns, wiring, and settings/i)).toBeVisible();
});

test('preserving update: completed USB send visibly acknowledges readback verification', async ({ page }) => {
  await openPreservingFixture(page, 'usb', 'usb-verifying');
  const panel = page.getByTestId('preserving-update-panel');
  await panel.getByRole('button', { name: 'Update once over USB' }).click();
  await panel.getByRole('checkbox', { name: /physically confirmed/i }).check();
  await panel.getByRole('button', { name: 'Start preserving update' }).click();
  await expect(panel.getByRole('status')).toHaveText('Upload complete · checking the saved update');
  await expect(panel.getByRole('status')).not.toContainText('Sending signed update');
});

test('preserving update: USB reset ends with an actionable bounded reconnect failure', async ({ page }) => {
  await openPreservingFixture(page, 'usb', 'usb-timeout');
  const panel = page.getByTestId('preserving-update-panel');
  await panel.getByRole('button', { name: 'Update once over USB' }).click();
  await panel.getByRole('checkbox', { name: /physically confirmed/i }).check();
  await panel.getByRole('button', { name: 'Start preserving update' }).click();
  await expect(panel.getByRole('alert')).toContainText(/could not verify the restarted card/i);
  await expect(panel).not.toContainText('Restarting card');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('lw_firmware_update_session_v1') || 'null')?.phase)).toBe('restarting');
});
