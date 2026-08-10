import { test, expect } from '@playwright/test';

// The install screen used to state only the firmware it was about to write. This
// covers the sentence that answers the question an owner is actually asking:
// what is on this card now, and which way does installing move it.
const CARD_ID = 'lw-plan-test';

async function openInstall(page: any, identity: object | null) {
  await page.addInitScript((card) => {
    localStorage.clear();
    if (card) localStorage.setItem('lw_card_identity_v1', JSON.stringify(card));
  }, identity);
  await page.goto('/#screen=flash&mode=install', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible({ timeout: 15_000 });
}

function remembered(buildNumber: number, buildId = 'b'.repeat(40)) {
  return {
    version: 1,
    id: CARD_ID,
    name: 'Plan test card',
    hostname: '',
    address: '',
    firmwareVersion: '1.0.0',
    buildId,
    buildNumber,
    acknowledgedAt: '2026-08-07T00:00:00.000Z',
  };
}

// The manifest the site serves is the target; the number in it is whatever the
// last signed release published, so the test reads it rather than hard-coding.
// Read OUT of the page: addInitScript re-runs on every navigation and clears
// storage, so the seeded identity has to be right before the first load.
async function availableRelease(request: any) {
  const manifest = await (await request.get('/firmware/release-manifest.json')).json();
  return {
    buildNumber: manifest.buildNumber as number,
    firmwareVersion: manifest.firmwareVersion as string,
  };
}

test('an older card is told which build it is on and which build it is getting', async ({ page, request }) => {
  const target = await availableRelease(request);
  await openInstall(page, remembered(1));
  const plan = page.getByTestId('install-update-plan');
  await expect(plan).toBeVisible();
  await expect(plan).toContainText('This card is on Build 1.');
  await expect(plan).toContainText(`This updates it to ${target.firmwareVersion} · Build ${target.buildNumber}.`);
  await expect(plan).toContainText('erases the card');
});

// The case that matters most: reinstalling the build already on the card still
// wipes it, and must never read as an upgrade.
test('reinstalling the same build says so instead of implying an upgrade', async ({ page, request }) => {
  const target = await availableRelease(request);
  await openInstall(page, remembered(target.buildNumber));

  const plan = page.getByTestId('install-update-plan');
  await expect(plan).toContainText(`already on ${target.firmwareVersion} · Build ${target.buildNumber}`);
  await expect(plan).not.toContainText('updates it to');
  await expect(plan).toContainText('erases the card');
});

test('a card running newer firmware is warned it is going backwards', async ({ page }) => {
  await openInstall(page, remembered(999999));
  const plan = page.getByTestId('install-update-plan');
  await expect(plan).toContainText('which is NEWER');
  await expect(plan).toContainText('backwards');
  await expect(plan).toHaveClass(/is-downgrade/);
});

// Never let the target read as the answer to "what is on it".
test('a card this browser has never met is reported as unknown', async ({ page, request }) => {
  const target = await availableRelease(request);
  await openInstall(page, null);
  const plan = page.getByTestId('install-update-plan');
  await expect(plan).toContainText('has not been connected to Studio before');
  await expect(plan).toContainText(`This installs ${target.firmwareVersion} · Build ${target.buildNumber}.`);
});

test('USB discovery names the exact card and separates last-verified installed firmware from the current release', async ({ page, request }) => {
  const manifest = await (await request.get('/firmware/release-manifest.json')).json();
  await page.addInitScript(({ card }) => {
    localStorage.clear();
    localStorage.setItem('lw_card_identity_v1', JSON.stringify(card));
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
    (window as any).__LW_FIND_INSTALL_CARD_FOR_TEST__ = async () => ({
      connection: {
        loader: {},
        transport: { disconnect: async () => true },
      },
      hardware: {
        cardId: card.id,
        chipName: 'ESP32-S3',
        chipDescription: 'ESP32-S3',
        flashSize: '16MB',
        flashBytes: 16 * 1024 * 1024,
      },
    });
  }, { card: remembered(1198, 'a'.repeat(40)) });
  await page.goto('/#screen=flash&mode=install', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Find connected card' }).click();

  const identity = page.getByTestId('install-card-identity');
  await expect(identity).toContainText(CARD_ID);
  await expect(identity).toContainText('ESP32-S3 · 16 MB');
  await expect(identity).toContainText('Installed firmware');
  await expect(identity).toContainText('v1.0.0 · Build 1198 (last verified for this exact card)');
  await expect(identity).toContainText('Current firmware');
  await expect(identity).toContainText(`v${manifest.firmwareVersion} · Build ${manifest.buildNumber}`);
});

test('LAN connection explains and releases an active USB inspection before any status probe', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    (window as any).__usbInspectionDisconnects = 0;
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
    (window as any).__LW_FIND_INSTALL_CARD_FOR_TEST__ = async () => ({
      connection: {
        loader: {},
        transport: {
          disconnect: async () => {
            (window as any).__usbInspectionDisconnects += 1;
            return true;
          },
        },
      },
      hardware: {
        cardId: 'lw-b0fe81f61b44', chipName: 'ESP32-S3', chipDescription: 'ESP32-S3',
        flashSize: '16MB', flashBytes: 16 * 1024 * 1024,
      },
    });
  });
  let statusProbes = 0;
  await page.route('http://lightweaver.local/api/status', route => {
    statusProbes += 1;
    return route.abort();
  });
  await page.goto('/#screen=flash&mode=install', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Find connected card' }).click();
  await expect(page.getByTestId('install-card-identity')).toContainText('lw-b0fe81f61b44');
  statusProbes = 0;

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  await expect(dialog.getByRole('heading', { name: 'Card is in USB install mode' })).toBeVisible();
  await expect(dialog).toContainText('Its Wi-Fi is temporarily off.');
  await expect(dialog).toContainText('This does not mean its firmware is out of date.');
  await expect(dialog.getByRole('button', { name: 'Continue firmware update' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Restart card for Wi-Fi connection' })).toBeVisible();
  await expect(dialog.locator('.card-condition-choices')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Blank or not responding' })).toHaveCount(0);
  await expect(dialog).not.toContainText('Studio could not reach the card directly');
  expect(statusProbes).toBe(0);

  await dialog.getByRole('button', { name: 'Restart card for Wi-Fi connection' }).click();
  await expect(dialog).toContainText('Card restarted. Its Wi-Fi may take a moment.');
  await expect.poll(() => page.evaluate(() => (window as any).__usbInspectionDisconnects)).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Connect this card' })).toBeVisible();
  await expect(page.getByTestId('install-card-identity')).toHaveCount(0);
  expect(statusProbes).toBe(0);
});
