import { test, expect } from '@playwright/test';

const CARD_ID = 'lw-b0fe81f61b44';
const OLD_BUILD = '1'.repeat(40);
const TARGET_BUILD = '2'.repeat(40);
const HEAD = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);

async function openPreservingFixture(page: any, mode: 'wifi' | 'usb', outcome = 'progress', capabilityShape = 'current') {
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
    (window as any).__LW_CREATE_FIRMWARE_UPDATER_FOR_TEST__ = ({ onProgress }: any) => ({
      preflight: async () => { onProgress({ phase: 'preflight', acknowledgedBytes: 0, totalBytes: 3 }); },
      begin: async () => { onProgress({ phase: 'sending', acknowledgedBytes: 0, totalBytes: 3 }); },
      send: async () => { onProgress({ phase: 'sending', acknowledgedBytes: 3, totalBytes: 3 }); },
      commit: async () => { onProgress({ phase: 'restarting', acknowledgedBytes: 3, totalBytes: 3 }); },
      readStatus: async () => {
        (window as any).__LW_UPDATE_READ_STATUS_CALLS__ += 1;
        const status = outcome === 'rollback'
          ? { phase: 'rolled-back', restoredBuildNumber: 1198, rollbackReason: 'boot-health-failed' }
          : { phase: 'pending-reboot', receivedBytes: 3 };
        onProgress(status);
        return status;
      },
    });
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

  await panel.getByRole('button', { name: 'Update over Wi-Fi' }).click();
  await expect(panel).toContainText('Press the card control once');
  await panel.getByRole('checkbox', { name: /physically confirmed/i }).check();
  await panel.getByRole('button', { name: 'Start preserving update' }).click();
  await expect(panel).toContainText('Restarting card');
});

test('preserving update: a legacy top-level capability cannot unlock network firmware update', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'progress', 'legacy');
  await expect(page.getByRole('button', { name: 'Update over Wi-Fi' })).toHaveCount(0);
});

test('preserving update: rollback names the restored build and a redacted reason', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'rollback');
  const panel = page.getByTestId('preserving-update-panel');
  await panel.getByRole('button', { name: 'Update over Wi-Fi' }).click();
  await panel.getByRole('checkbox', { name: /physically confirmed/i }).check();
  await panel.getByRole('button', { name: 'Start preserving update' }).click();
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

test('preserving update: a Wi-Fi reboot keeps recovery visible while the card link is disconnected', async ({ page }) => {
  await openPreservingFixture(page, 'wifi', 'reload-disconnected');
  const panel = page.getByTestId('preserving-update-panel');
  await expect(panel).toContainText('InstalledChecking restarted card…');
  await expect(panel).toContainText('Restarting card');
  await expect(panel.getByRole('alert')).toContainText(/could not verify the restarted card/i);
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
