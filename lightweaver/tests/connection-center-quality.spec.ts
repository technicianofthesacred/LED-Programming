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

async function installOpenSpy(page) {
  await page.addInitScript(() => {
    (window as any).__openedUrls = [];
    (window as any).__cardFetchCalls = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/^http:\/\/(?:lightweaver\.local|192\.168\.4\.1)/.test(url)) {
        (window as any).__cardFetchCalls.push(url);
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
    window.open = ((url?: string | URL) => {
      (window as any).__openedUrls.push(String(url || ''));
      return { closed: false, postMessage() {}, close() {}, focus() {} } as Window;
    }) as typeof window.open;
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
}

function actionRegion(page) {
  return page.locator('.card-connection-action');
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

test('ready-browser-usb opens the fixed local install screen', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();

  await expect(page).toHaveURL(/#screen=flash&mode=install$/);
  await expect(page.url()).not.toMatch(/callback|target|url=/i);
});

test('secure iframe escapes to the fixed canonical installer in a new top-level tab', async ({ page, context }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
  });
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'embedded-studio';
    frame.src = `${location.origin}/#screen=layout`;
    document.body.append(frame);
  });
  const studio = page.frameLocator('#embedded-studio');
  await studio.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await studio.getByRole('button', { name: 'Blank or not responding' }).click();
  const escape = studio.getByRole('link', { name: 'Open secure installer' });
  await expect(escape).toHaveAttribute('href', 'https://led.mandalacodes.com/#screen=flash&mode=install');
  await expect(escape).toHaveAttribute('target', '_blank');

  const opened = context.waitForEvent('page');
  await escape.click();
  const installer = await opened;
  await expect.poll(() => installer.url()).toBe('https://led.mandalacodes.com/#screen=flash&mode=install');
  await installer.close();
});

test('native bridge states and supported-device handoff stay passive', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'launch-native-bridge');
  await expect(actionRegion(page).locator('.card-connection-actions').getByRole('button')).toHaveCount(0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, { type: 'bridge-lost', reason: 'native-bridge-missing' });
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'install-native-bridge');
  await expect(actionRegion(page).locator('.card-connection-actions').getByRole('button')).toHaveCount(0);

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux armv8l' });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'handoff-supported-device');
  await expect(actionRegion(page).locator('.card-connection-actions').getByRole('button')).toHaveCount(0);
});

test('wrong-card and recoverable failures retry the existing connection step', async ({ page }) => {
  await installOpenSpy(page);
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, { type: 'bridge-lost', reason: 'wrong-card' });
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'wrong-card');
  await expect(page.getByRole('button', { name: 'Use this card instead' })).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect expected card' }).click();
  await expect.poll(() => page.evaluate(() => (
    (window as any).__openedUrls.length + (window as any).__cardFetchCalls.length
  ))).toBeGreaterThan(0);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, { type: 'bridge-lost', reason: 'no-answer' });
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'recoverable-failure');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => page.evaluate(() => (
    (window as any).__openedUrls.length + (window as any).__cardFetchCalls.length
  ))).toBeGreaterThan(0);
});

test('card update and safe recovery use install only when browser USB is usable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, { type: 'bridge-lost', reason: 'firmware-too-old' });
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'needs-card-update');
  await page.getByRole('button', { name: 'Update card' }).click();
  await expect(page).toHaveURL(/#screen=flash&mode=install$/);

  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, { type: 'bridge-lost', reason: 'recovery-unconfirmed' });
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'needs-safe-recovery');
  await page.getByRole('button', { name: 'Start safe recovery' }).click();
  await expect(page).toHaveURL(/#screen=flash&mode=install$/);
});

test('safe recovery without browser USB is passive and names the coming Bridge path', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, { type: 'bridge-lost', reason: 'recovery-unconfirmed' });

  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'needs-safe-recovery');
  await expect(actionRegion(page)).toContainText(/Bridge recovery is coming/i);
  await expect(actionRegion(page).locator('.card-connection-actions').getByRole('button')).toHaveCount(0);
});

test('old firmware without browser USB gives passive supported-computer guidance', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, { type: 'bridge-lost', reason: 'firmware-too-old' });

  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'needs-card-update');
  await expect(actionRegion(page)).toContainText(/Bridge update is coming/i);
  await expect(actionRegion(page)).toContainText(/supported computer/i);
  await expect(actionRegion(page).locator('.card-connection-actions').getByRole('button')).toHaveCount(0);
});

test('working setup card restores AP steps and continues through 192.168.4.1', async ({ page }) => {
  await installOpenSpy(page);
  await page.evaluate(() => localStorage.setItem('lw_chip_card_host', '192.168.4.1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'My card already lights up' }).click();

  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'recoverable-failure');
  await expect(actionRegion(page)).toContainText('Lightweaver-XXXX');
  await expect.poll(() => page.evaluate(() => (window as any).__openedUrls.length)).toBe(0);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__openedUrls[0] || '')).toContain('192.168.4.1');
});
