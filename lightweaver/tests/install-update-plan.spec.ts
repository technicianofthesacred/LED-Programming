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
async function availableBuild(request: any) {
  return (await (await request.get('/firmware/release-manifest.json')).json()).buildNumber as number;
}

test('an older card is told which build it is on and which build it is getting', async ({ page, request }) => {
  const target = await availableBuild(request);
  await openInstall(page, remembered(1));
  const plan = page.getByTestId('install-update-plan');
  await expect(plan).toBeVisible();
  await expect(plan).toContainText('This card is on Build 1.');
  await expect(plan).toContainText(`This updates it to 1.0.0 · Build ${target}.`);
  await expect(plan).toContainText('erases the card');
});

// The case that matters most: reinstalling the build already on the card still
// wipes it, and must never read as an upgrade.
test('reinstalling the same build says so instead of implying an upgrade', async ({ page, request }) => {
  const target = await availableBuild(request);
  await openInstall(page, remembered(target));

  const plan = page.getByTestId('install-update-plan');
  await expect(plan).toContainText(`already on 1.0.0 · Build ${target}`);
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
  const target = await availableBuild(request);
  await openInstall(page, null);
  const plan = page.getByTestId('install-update-plan');
  await expect(plan).toContainText('has not been connected to Studio before');
  await expect(plan).toContainText(`This installs 1.0.0 · Build ${target}.`);
});
