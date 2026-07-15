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

async function deliverBridgeResult(page, overrides: Record<string, unknown> = {}) {
  await page.evaluate(extra => {
    const targetTabId = sessionStorage.getItem('lightweaver.bridge.origin-tab.v1');
    const message = {
      version: 1,
      type: 'bridge-result',
      deliveryId: 'AQEBAQEBAQEBAQEB',
      targetTabId,
      operation: 'install-current-release',
      status: 'awaiting-card-acknowledgement',
      code: 'flash-verified',
      cardId: 'lw-441bf681feb0',
      firmwareVersion: '1.2.3',
      buildId: 'a'.repeat(40),
      target: 'lightweaver-controller-esp32s3',
      verification: 'flash-verified',
      physicalOutput: 'unconfirmed',
      ...extra,
    };
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'lightweaver.bridge.result.v1',
      newValue: JSON.stringify(message),
    }));
  }, overrides);
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

test('desktop Bridge launch persists the project, launches once, then shows a truthful signed-installer gap', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
    (window as any).__lwBridgeUrls = [];
    (window as any).__LW_BRIDGE_NAVIGATE_FOR_TEST__ = (url: string) => (window as any).__lwBridgeUrls.push(url);
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'launch-native-bridge');
  await page.getByRole('button', { name: 'Open Lightweaver Bridge' }).click();
  await expect(actionRegion(page)).toContainText('Waiting for Lightweaver Bridge');
  await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem('lw_autosave_v3')))).toBe(true);
  const urls = await page.evaluate(() => (window as any).__lwBridgeUrls);
  expect(urls).toHaveLength(1);
  expect(urls[0]).toMatch(/^lightweaver:\/\/run\?operation=install-current-release&nonce=[A-Za-z0-9_-]{43}&version=1$/);
  await page.waitForTimeout(4100);
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'install-native-bridge');
  await expect(actionRegion(page)).toContainText(/may not be installed/i);
  await expect(actionRegion(page)).toContainText(/signed installer is not yet available/i);
  await expect(actionRegion(page).getByRole('link')).toHaveCount(0);
});

test('mobile handoff stays passive', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux armv8l' });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'handoff-supported-device');
  await expect(actionRegion(page).locator('.card-connection-actions').getByRole('button')).toHaveCount(0);
});

test('missing native Bridge does not expose an unsigned download', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, { type: 'bridge-lost', reason: 'native-bridge-missing' });
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'install-native-bridge');
  await expect(actionRegion(page)).toContainText(/signed installer is not yet available/i);
  await expect(actionRegion(page).getByRole('link')).toHaveCount(0);
});

test('originating tab resumes once, verifies exact card build, and requires human-visible warm white', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
    (window as any).__LW_BRIDGE_NAVIGATE_FOR_TEST__ = () => {};
    (window as any).__lightChecks = 0;
    (window as any).__LW_RECOVER_LIGHTS_FOR_TEST__ = async () => {
      (window as any).__lightChecks += 1;
      return { ok: true, accepted: true };
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();
  await page.getByRole('button', { name: 'Open Lightweaver Bridge' }).click();

  await deliverBridgeResult(page);
  await expect(page.getByRole('heading', { name: 'Firmware installed — verify the card' })).toBeVisible();
  await page.waitForTimeout(4100);
  await expect(page.getByRole('heading', { name: 'Firmware installed — verify the card' })).toBeVisible();

  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    card: { id: 'lw-222222222222', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
  });
  await expect(page.getByRole('dialog')).toContainText(/expected lw-441bf681feb0, but lw-222222222222 answered/i);

  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    card: { id: 'lw-441bf681feb0', firmwareVersion: '1.2.2', buildId: 'a'.repeat(40) },
  });
  await expect(page.getByRole('dialog')).toContainText(/expected firmware 1.2.3/i);

  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    card: { id: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'b'.repeat(40) },
  });
  await expect(page.getByRole('dialog')).toContainText(/build does not match/i);

  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    card: { id: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
  });
  await page.getByRole('button', { name: 'Run light check' }).click();
  await expect(page.getByText('Are the lights warm white?')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__lightChecks)).toBe(1);

  await deliverBridgeResult(page);
  await expect.poll(() => page.evaluate(() => (window as any).__lightChecks)).toBe(1);
  await page.getByRole('button', { name: 'Yes, they are warm white' }).click();
  await expect(page.getByRole('heading', { name: 'Lightweaver is ready' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('visible warm-white lights are confirmed');
});

test('a negative physical check offers real recovery and reconnect actions', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
    (window as any).__LW_BRIDGE_NAVIGATE_FOR_TEST__ = () => {};
    (window as any).__LW_RECOVER_LIGHTS_FOR_TEST__ = async () => ({ ok: true, accepted: true });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();
  await page.getByRole('button', { name: 'Open Lightweaver Bridge' }).click();
  await deliverBridgeResult(page);
  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    card: { id: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
  });
  await page.getByRole('button', { name: 'Run light check' }).click();
  await page.getByRole('button', { name: 'No', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recover current release' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
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

test('safe recovery without browser USB offers the real Bridge recovery path', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, { type: 'bridge-lost', reason: 'recovery-unconfirmed' });

  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'needs-safe-recovery');
  await expect(page.getByRole('button', { name: 'Open Lightweaver Bridge' })).toBeVisible();
  await expect(actionRegion(page)).toContainText(/keep the card powered/i);
});

test('old firmware without browser USB offers the real Bridge update path', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await dispatchCardLinkEvent(page, { type: 'bridge-lost', reason: 'firmware-too-old' });

  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'needs-card-update');
  await expect(actionRegion(page)).toContainText(/Bridge installs the current release/i);
  await expect(page.getByRole('button', { name: 'Open Lightweaver Bridge' })).toBeVisible();
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
