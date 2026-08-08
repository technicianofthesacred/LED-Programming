import { test, expect, type Page } from '@playwright/test';

// Setup is where the owner is ASKED to set the piece up. Hardware settings sat
// beside it appearing to ask three of the same questions — colour order, card
// address, and installing on the card.
//
// Only one of the three turned out to be a true duplicate. The other two are
// the same words doing a different job, and deleting them was tried and
// withdrawn because it removed working capability:
//
//   Colour order — the picker pushes an order to the card and refuses to claim
//     success until the card reports it back. Setup asks the question; this
//     tries the answer. Guard: screen-smoke "reports success only after exact
//     state readback".
//   Card address — Setup puts the card on the WiFi; this is where Studio LOOKS
//     for it afterwards, including by raw IP when the name will not resolve.
//     Guard: card-workspace "reachable recovering factory card uses URL IP".
//   Install on card — a true duplicate. Setup installs the piece; this page
//     only sends what this page can change, and now says so.
//
// This spec pins the distinction so the deletion is not attempted a third time.

const HARDWARE_ROUTE = '/#screen=card&section=settings';

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

async function openHardware(page: Page) {
  await page.goto(HARDWARE_ROUTE, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-address-summary')).toBeVisible({ timeout: 20_000 });
}

test('every control here says which job it is doing, so it does not read as a second Setup', async ({ page }) => {
  await openHardware(page);

  // The controls stay — each is also a recovery or calibration path. What
  // changed is that each now says so, instead of silently repeating a
  // question Setup already asked.
  await expect(page.locator('.set-row', { hasText: 'Install on card' }).locator('.hh'))
    .toContainText('First-time setup lives in Setup');
});

test('the card address stays editable, because it is also the recovery path', async ({ page }) => {
  await openHardware(page);

  const address = page.getByTestId('card-address-summary').locator('input');
  await expect(address).toBeVisible();
  // Typing a raw IP is how an owner reaches a card whose name will not resolve.
  await address.fill('192.168.4.1');
  await expect(address).toHaveValue('192.168.4.1');
  // The hint has to say which job this is, or it reads as a second setup.
  await expect(page.locator('.set-row', { hasText: 'Card address' }).locator('.hh'))
    .toContainText('where Studio looks for it');
});

test('the colour-order picker stays, because trying an order is not asking for it', async ({ page }) => {
  await openHardware(page);

  const picker = page.getByTestId('color-order-summary');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'GRB', exact: true })).toBeVisible();
  await expect(page.locator('.set-row', { hasText: 'Color order' }).locator('.hh'))
    .toContainText('try an order on the strip');
});

test('the colour-order test deep link from the card still lands here', async ({ page }) => {
  await page.goto(`${HARDWARE_ROUTE}&tool=color-order`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('color-order-summary')).toBeVisible({ timeout: 20_000 });
});
