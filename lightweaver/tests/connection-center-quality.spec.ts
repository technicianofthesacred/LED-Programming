import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
});

async function dispatchCardLinkEvent(page, event: Record<string, unknown>) {
  await page.evaluate(async linkEvent => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    getSharedCardLink().dispatch(linkEvent);
  }, event);
}

test('announces asynchronous connection states without repeating card metadata', async ({ page }) => {
  const announcement = page.getByRole('status');

  await dispatchCardLinkEvent(page, { type: 'connecting', via: 'bridge', host: 'lightweaver.local' });
  await expect(announcement).toHaveText('Connecting');

  await dispatchCardLinkEvent(page, { type: 'operation-recovering' });
  await expect(announcement).toHaveText('Recovering');

  await dispatchCardLinkEvent(page, { type: 'operation-failed' });
  await expect(announcement).toHaveText('Needs attention');

  await dispatchCardLinkEvent(page, { type: 'operation-confirmed' });
  await dispatchCardLinkEvent(page, {
    type: 'card-verified',
    via: 'bridge',
    host: 'lightweaver.local',
    card: { id: 'lw-quality', name: 'Gallery card', pixelCount: 440, firmwareVersion: '1.4.0' },
  });
  await expect(announcement).toHaveText('Connected');
  await expect(announcement).not.toContainText(/Gallery card|440 pixels|firmware/i);
});

test('normalizes a bare local card name before validation and storage', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('lw_chip_card_host', '192.168.4.1'));
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByText('Connection details', { exact: true }).click();
  const host = page.getByLabel('Card hostname');

  await host.fill('lightweaver');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(host).toHaveValue('lightweaver.local');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_chip_card_host'))).toBe('lightweaver.local');
  await expect(page.getByRole('alert')).toHaveCount(0);

  await host.fill('example.com');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('local Lightweaver hostname');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_chip_card_host'))).toBe('lightweaver.local');
});

test('renders verified card behavior through the new orchestrator state', async ({ page }) => {
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, {
    type: 'card-verified',
    via: 'bridge',
    host: 'lightweaver.local',
    card: { id: 'lw-quality', name: 'Gallery card', pixelCount: 440, firmwareVersion: '1.4.0' },
  });

  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Gallery card');
  await expect(dialog).toContainText('440');
});
