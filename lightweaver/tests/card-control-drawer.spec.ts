import { expect, test, type Page } from '@playwright/test';

const CARD_ID = 'lw-drawer-card';

async function verifyCard(page: Page) {
  await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const event = {
      type: 'card-verified', via: 'direct', host: 'lightweaver.local',
      card: { id: 'lw-drawer-card', name: 'Gallery Lightweaver', firmwareVersion: '1.1.1', buildId: 'a'.repeat(40) },
      expectedCard: { id: 'lw-drawer-card', firmwareVersion: '1.1.1', buildId: 'a'.repeat(40) },
      readiness: {
        app: 'Lightweaver', provisioningContractVersion: 1, cardId: 'lw-drawer-card',
        firmwareVersion: '1.1.1', buildId: 'a'.repeat(40), bootId: 'drawer-boot',
        runtimePhase: 'ready', knownGoodProject: true, commandReady: true, outputReady: true,
      },
    };
    const link = getSharedCardLink();
    link.dispatch(event);
    link.dispatch(event);
  });
}

test('a connected footer opens customer card controls without a popup', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let controlBody: Record<string, unknown> | null = null;
  await page.route('http://lightweaver.local/api/zones', route => route.fulfill({ json: {
    zones: [{ id: 'all', label: 'Whole piece', patternId: 'custom-color', brightness: 0.7, speed: 1, hueShift: 0, customHue: 32, customSaturation: 230, customBreathe: false, customDrift: false, driftHueMin: 17, driftHueMax: 203, blackout: false }],
  } }));
  await page.route('http://lightweaver.local/api/patterns', route => route.fulfill({ json: {
    currentId: 'custom-color', currentIndex: 0,
    patterns: [{ id: 'custom-color', label: 'Custom color', mode: 'procedural', zones: [], controls: { customColor: true, breathe: false, drift: true } }, { id: 'ocean', label: 'Ocean combination', mode: 'combo', zones: [] }],
  } }));
  await page.route('http://lightweaver.local/api/firmware-info', route => route.fulfill({ json: { cardId: CARD_ID, firmwareVersion: '1.1.1' } }));
  await page.route('http://lightweaver.local/api/control', async route => {
    controlBody = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ json: { ok: true, cardId: CARD_ID, ...controlBody } });
  });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-drawer-card' }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await verifyCard(page);

  const footer = page.getByTestId('card-link-status');
  await expect(footer).toHaveAccessibleName(/Gallery Lightweaver.*Connected/);
  await footer.click();
  const drawer = page.getByRole('dialog', { name: 'Gallery Lightweaver controls' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(drawer.getByRole('button', { name: 'Blackout' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(drawer.locator('select[aria-label="Pattern"]')).toHaveValue('custom-color');
  const blackout = drawer.getByRole('button', { name: 'Blackout' });
  await expect(blackout).toHaveAttribute('aria-pressed', 'false');
  await drawer.getByRole('button', { name: 'Close card controls' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(blackout).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(footer).toBeFocused();
  await footer.click();
  await expect(drawer).toBeVisible();

  await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    getSharedCardLink().dispatch({ type: 'operation-failed' });
  });
  await expect(footer).toHaveAccessibleName(/Needs attention/);
  await expect(drawer.getByRole('slider', { name: 'Brightness' })).toBeDisabled();
  await drawer.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toBeVisible();
  await page.getByRole('button', { name: 'Close connection center' }).click();
  await footer.click();
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toBeVisible();
  await page.getByRole('button', { name: 'Close connection center' }).click();
  await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    getSharedCardLink().dispatch({ type: 'operation-confirmed' });
  });
  await footer.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Warm palette' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Cool palette' })).toBeVisible();
  await expect(drawer.getByRole('checkbox', { name: 'Breathe' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Rainbow palette' }).click();
  await expect.poll(() => controlBody?.drift).toBe(true);
  expect(controlBody).toMatchObject({ driftMin: 0, driftMax: 255 });
  await expect(drawer.getByText(/Wi-?Fi|Firmware|Factory reset|Reboot/i)).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Next pattern' }).click();
  await expect.poll(() => controlBody?.patternId).toBe('ocean');
  await expect(drawer.locator('select[aria-label="Pattern"]')).toHaveValue('ocean');
  await drawer.getByRole('button', { name: 'Advanced editing' }).click();
  await expect(page).toHaveURL(/\?editLook=ocean#screen=card&section=overview$/);
});
