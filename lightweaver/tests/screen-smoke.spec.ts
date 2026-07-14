import { test, expect } from '@playwright/test';

// The Rail (src/v3/app.jsx) now also has a "Show" screen (the live LED
// preview screen) alongside the original six.
const SCREENS = ['Patterns', 'Playlist', 'Layout', 'Show', 'Settings', 'Flash', 'Installer'];

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

async function installCardPopupMock(page, cardId = 'lw-test-card', host = 'lightweaver.local', dropPingResponses = false) {
  await page.addInitScript(({ id, cardHost, dropPings }) => {
    (window as any).__cardPopupCalls = [];
    const originalOpen = window.open.bind(window);
    window.open = ((url?: string | URL, name?: string) => {
      const popup = originalOpen('about:blank', name);
      (window as any).__cardPopupCalls.push({ url: String(url || ''), name });
      if (!popup) return popup;
      Object.defineProperty(popup, 'postMessage', {
        configurable: true,
        value(message: any, targetOrigin: string) {
          if (dropPings && message.type === 'ping') return;
          queueMicrotask(() => {
            window.dispatchEvent(new MessageEvent('message', {
              origin: targetOrigin,
              source: popup,
              data: {
                app: 'LightweaverCardBridge',
                id: message.id,
                ok: true,
                version: 1,
                response: message.type === 'firmware-info'
                  ? {
                      cardId: id,
                      cardName: 'Gallery card',
                      firmwareVersion: '1.4.0',
                      buildId: 'test-build',
                      outputs: [{ gpio: 16, count: 44 }],
                    }
                  : { ok: true },
              },
            }));
          });
        },
      });
      queueMicrotask(() => {
        window.dispatchEvent(new MessageEvent('message', {
          origin: `http://${cardHost}`,
          source: popup,
          data: {
            app: 'LightweaverCardBridge',
            type: 'ready',
            host: cardHost,
            version: 1,
          },
        }));
      });
      return popup;
    }) as typeof window.open;
  }, { id: cardId, cardHost: host, dropPings: dropPingResponses });
}

async function dispatchCardLinkEvents(page, events: Record<string, unknown>[]) {
  await page.evaluate(async linkEvents => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    for (const event of linkEvents) getSharedCardLink().dispatch(event);
  }, events);
}

test('every primary screen exposes the Lightweaver connection control', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  for (const label of SCREENS) {
    await page.locator('.rail-item', { hasText: label }).click();
    await expect(page.getByRole('button', { name: 'Connect Lightweaver' })).toBeVisible();
  }
});

test('connection center starts with the two physical card choices', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'My card already lights up' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Blank or not responding' })).toBeVisible();
});

test('an unreachable previously paired card opens directly on reconnect', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1,
      id: 'lw-remembered-card',
      name: 'Remembered gallery card',
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-link-status')).toContainText('Not connected');

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  await expect(dialog.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'My card already lights up' })).toHaveCount(0);
  await expect(dialog).not.toContainText('lw-remembered-card');
});

test('opening while connecting renders the busy flow action directly', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Connect Lightweaver' })).toBeVisible();
  await dispatchCardLinkEvents(page, [{ type: 'connecting', via: 'bridge', host: 'lightweaver.local' }]);

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  await expect(dialog).toContainText('Studio is reconnecting to your Lightweaver now.');
  await expect(dialog.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'My card already lights up' })).toHaveCount(0);
});

test('opening after a blocked popup renders the retry action directly', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-link-status')).toBeVisible();
  await dispatchCardLinkEvents(page, [{ type: 'bridge-lost', reason: 'popup-blocked', host: 'lightweaver.local' }]);
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Needs attention/);
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'My card already lights up' })).toHaveCount(0);
});

test('opening with old firmware renders installation recovery directly', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
  });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Connect Lightweaver' })).toBeVisible();
  await dispatchCardLinkEvents(page, [{ type: 'bridge-lost', reason: 'firmware-too-old', host: 'lightweaver.local' }]);
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Needs attention/);
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await expect(page.getByRole('button', { name: 'Start installation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'My card already lights up' })).toHaveCount(0);
});

test('opening while the card is recovering renders the busy recovery action directly', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Connect Lightweaver' })).toBeVisible();
  await dispatchCardLinkEvents(page, [
    {
      type: 'card-verified',
      via: 'bridge',
      host: 'lightweaver.local',
      card: { id: 'lw-recovering-card', name: 'Gallery card' },
    },
    { type: 'bridge-ping-missed', host: 'lightweaver.local' },
    { type: 'bridge-ping-missed', host: 'lightweaver.local' },
  ]);
  await expect(page.getByTestId('card-link-status')).toContainText('Recovering');
  await page.getByTestId('card-link-status').click();
  await expect(page.getByRole('button', { name: 'Connecting…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'My card already lights up' })).toHaveCount(0);
});

test('working setup card shows AP steps before continuing through the setup host', async ({ page }) => {
  await installCardPopupMock(page, 'lw-setup-card', '192.168.4.1');
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_chip_card_host', '192.168.4.1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'My card already lights up' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  await expect(dialog).toContainText('Lightweaver-XXXX');
  await expect(dialog).toContainText(/finish setup/i);
  await expect.poll(() => page.evaluate(() => (window as any).__cardPopupCalls.length)).toBe(0);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__cardPopupCalls[0]?.url || '')).toContain('192.168.4.1');
});

test('working-card choice opens the card popup path', async ({ page }) => {
  await installCardPopupMock(page);
  let allowDirect = false;
  const directRequests: string[] = [];
  await page.route('http://lightweaver.local/api/status', async route => {
    directRequests.push(route.request().url());
    if (!allowDirect) return route.abort();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cardId: 'lw-direct-card', cardName: 'Direct card', led: { pixels: 44 } }),
    });
  });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  allowDirect = true;
  await page.getByRole('button', { name: 'My card already lights up' }).click();
  await expect.poll(() => directRequests.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__cardPopupCalls.length)).toBe(0);
  await expect(page.getByRole('button', { name: /Direct card.*Connected/i })).toBeVisible();
});

test('background direct discovery stays unpaired until the explicit working-card choice', async ({ page }) => {
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-passive-card', cardName: 'Passive card', led: { pixels: 44 } }),
  }));
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_card_identity_v1'))).toBeNull();
  await expect(page.getByTestId('card-link-status')).not.toHaveAccessibleName(/Connected/);

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'My card already lights up' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null')?.id)).toBe('lw-passive-card');
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Connected/);
});

test('direct wrong-card adoption is explicit and reverifies before Connected', async ({ page }) => {
  let firmwareChecks = 0;
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-direct-found', cardName: 'Found direct card' }),
  }));
  await page.route('http://lightweaver.local/api/firmware-info', route => {
    firmwareChecks += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cardId: 'lw-direct-found', cardName: 'Found direct card', firmwareVersion: '1.4.0' }),
    });
  });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1,
      id: 'lw-direct-expected',
      name: 'Expected direct card',
      hostname: 'lightweaver',
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Needs attention/);
  await page.getByTestId('card-link-status').click();
  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  await expect(dialog).toContainText('Found direct card');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null')?.id)).toBe('lw-direct-expected');

  await dialog.getByRole('button', { name: 'Use this card instead' }).click();
  await expect.poll(() => firmwareChecks).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null')?.id)).toBe('lw-direct-found');
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Connected/);
});

test('blank-card choice reaches Flash install when Web Serial is supported', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
  });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();
  await expect(page).toHaveURL(/#screen=flash&mode=install$/);
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toBeVisible();
});

test('connection details reject public hosts and resync before reopening', async ({ page }) => {
  await installCardPopupMock(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByText('Connection details', { exact: true }).click();
  const host = page.getByLabel('Card hostname');
  await host.fill('example.com');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('local Lightweaver hostname');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_chip_card_host'))).not.toBe('example.com');
  await expect.poll(() => page.evaluate(() => (window as any).__cardPopupCalls.length)).toBe(0);

  await page.getByRole('button', { name: 'Close connection center' }).click();
  await page.evaluate(() => {
    localStorage.setItem('lw_chip_card_host', '192.168.4.1');
    window.dispatchEvent(new CustomEvent('lightweaver-card-host-changed'));
  });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByText('Connection details', { exact: true }).click();
  await expect(page.getByLabel('Card hostname')).toHaveValue('192.168.4.1');
});

test('status control announces state and dialog expansion', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  const status = page.getByTestId('card-link-status');
  await expect(status).toHaveAccessibleName(/Not connected/);
  await expect(status).toHaveAttribute('aria-expanded', 'false');
  await expect(status).toHaveAttribute('aria-controls', 'card-connection-center');
  await status.click();
  await expect(status).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(status).toHaveAttribute('aria-expanded', 'false');

  await dispatchCardLinkEvents(page, [{ type: 'connecting', via: 'bridge', host: 'lightweaver.local' }]);
  await expect(status).toHaveAccessibleName(/Connecting/);
  await dispatchCardLinkEvents(page, [{ type: 'bridge-lost', reason: 'popup-blocked', host: 'lightweaver.local' }]);
  await expect(status).toHaveAccessibleName(/Needs attention/);
});

for (const width of [641, 768, 900]) {
  test(`connected footer remains usable without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('card-link-status')).toBeVisible();
    await dispatchCardLinkEvents(page, [{
      type: 'card-verified',
      via: 'bridge',
      host: 'lightweaver.local',
      card: {
        id: 'lw-responsive-card',
        name: 'Responsive gallery card',
        pixelCount: 440,
        gpioSummary: 'GPIO 16 · 220, GPIO 17 · 220',
        firmwareVersion: '1.4.0',
        buildId: 'responsive-build',
      },
    }]);
    await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Connected/);
    await expect(page.locator('.card-status-summary')).not.toContainText('Responsive gallery card');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

test('blank-card choice explains the supported-device handoff when install is unsupported', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toContainText(/Chrome or Edge|supported computer/i);
});

test('Escape closes the connection center and restores focus', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  const trigger = page.getByRole('button', { name: 'Connect Lightweaver' });
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.locator('.topbar').click({ position: { x: 300, y: 20 } });
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toHaveCount(0);
  await expect(trigger).not.toBeFocused();
});

test('wrong-card recovery only adopts after the explicit secondary action', async ({ page }) => {
  await installCardPopupMock(page, 'lw-found-card');
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1,
      id: 'lw-expected-card',
      name: 'Expected card',
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.evaluate(async () => {
    const { connectCardLink } = await import('/src/lib/cardLink.js');
    connectCardLink('lightweaver.local');
  });
  await expect(page.getByRole('button', { name: 'Use this card instead' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null')?.id)).toBe('lw-expected-card');
  await page.getByRole('button', { name: 'Use this card instead' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null')?.id)).toBe('lw-found-card');
});

test('mobile connection sheet fits without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  const metrics = await dialog.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
    };
  });
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(390);
  expect(metrics.bottom).toBeLessThanOrEqual(844);
  expect(metrics.pageScrollWidth).toBe(metrics.pageClientWidth);

  const interactiveTargets = [
    dialog.getByRole('button', { name: 'Close connection center' }),
    dialog.getByRole('button', { name: 'My card already lights up' }),
    dialog.getByRole('button', { name: 'Blank or not responding' }),
    dialog.getByText('Connection details', { exact: true }),
  ];
  for (const target of interactiveTargets) {
    expect((await target.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await dialog.getByText('Connection details', { exact: true }).click();
  expect((await dialog.getByLabel('Card hostname').boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect((await dialog.getByRole('button', { name: 'Save', exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
});

test('layout opens with the default two-circle hardware layout', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('default-circle-layout-panel')).toBeVisible();
  await expect(page.locator('.la-strip-row')).toHaveCount(2);
  await expect(page.locator('path[data-strip-path]')).toHaveCount(2);
  await expect(page.locator('.la-strip-row', { hasText: 'Outer circle' })).toContainText('27');
  await expect(page.locator('.la-strip-row', { hasText: 'Inner circle' })).toContainText('17');
  await expect(page.getByText('Default two-circle hardware')).toBeVisible();
});

test('settings screen prioritizes card setup and keeps raw config advanced', async ({ page }) => {
  await page.goto('/#screen=settings', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  // The old dedicated "Ready to save to card" / "Card setup" / "Studio
  // project" copy and the .lw-chip-* card-summary classes no longer exist —
  // Settings (src/v3/lw-settings.jsx) is a full mockup-style options page
  // now, not a card-save-first wizard. "Card connection" is the section that
  // carries the same job (getting a setup written to the card).
  await expect(page.getByText('Card connection')).toBeVisible();
  await expect(page.getByTestId('settings-ring-summary')).toBeVisible();
  await expect(page.getByTestId('output-routing-summary')).toContainText('2 outputs');
  await expect(page.locator('.set-output-row')).toHaveCount(2);
  // Output names default to "Output 1"/"Output 2" (src/lib/standaloneController.js);
  // they're no longer auto-named after hardware sections like "Outer circle".
  await expect(page.locator('.set-output-row').nth(0)).toContainText('GPIO');
  await expect(page.locator('.set-output-row').nth(0).locator('.set-outfield').first().locator('input')).toHaveValue('16');
  await expect(page.locator('.set-output-row').nth(1).locator('.set-outfield').first().locator('input')).toHaveValue('17');

  await page.getByRole('button', { name: 'Single output' }).click();
  await expect(page.getByTestId('output-routing-summary')).toContainText('1 output');
  await expect(page.locator('.set-output-row')).toHaveCount(1);

  // "Designer config" JSON is hidden by default and revealed with its own
  // Show/Hide JSON button — the old always-visible "Advanced" click target
  // and .lw-chip-settings-json class are gone.
  await expect(page.locator('.set-json')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show JSON' }).click();
  await expect(page.locator('.set-json')).toBeVisible();
});

test('number keys do not navigate away from LED count fields', async ({ page }) => {
  await page.goto('/#screen=settings', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await page.keyboard.press(key);
    await expect(page).toHaveURL(/#screen=settings$/);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  }
});

test('there is no command-palette panel navigation — actions are direct buttons', async ({ page }) => {
  // The Ctrl+K command palette (search-driven "Go to:" panel navigation)
  // this test used to guard against being reintroduced no longer exists at
  // all — there's no Ctrl+K listener anywhere in src/ today, and "New
  // project" is a plain TopBar button (src/v3/app.jsx), not a palette
  // command. Keep the regression coverage for both halves of that claim.
  await page.goto('/#screen=settings', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('heading', { name: 'Settings', level: 1 }).click();
  await page.keyboard.press('Control+K');
  await expect(page.getByPlaceholder('Type a command...')).toHaveCount(0);
  await expect(page.getByText(/^Go to:/)).toHaveCount(0);

  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
});

test('settings text and number boxes accept direct typing', async ({ page }) => {
  await page.goto('/#screen=settings', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Row labels (.set-k) are sibling text next to their control, not
  // associated <label>s, so most fields aren't reachable via getByLabel —
  // use the stable .set-row wrapper class plus its label text instead.
  const cardAddress = page.locator('.set-row', { hasText: 'Card address' }).locator('input');
  await cardAddress.fill('192.168.4.1');
  await expect(cardAddress).toHaveValue('192.168.4.1');

  const totalLeds = page.locator('.set-row', { hasText: 'Total LEDs' }).locator('input');
  await totalLeds.fill('123');
  await expect(totalLeds).toHaveValue('123');

  const sectionLeds = page.locator('.set-seccount').first().locator('input');
  await sectionLeds.fill('61');
  await expect(sectionLeds).toHaveValue('61');

  // "Output 1 name" does carry a real aria-label.
  const outputName = page.getByLabel('Output 1 name');
  await outputName.fill('Front halo');
  await expect(outputName).toHaveValue('Front halo');

  const firstOutput = page.locator('.set-output-row').first();
  const gpioInput = firstOutput.locator('.set-outfield', { hasText: 'GPIO' }).locator('input');
  await gpioInput.fill('18');
  await expect(gpioInput).toHaveValue('18');

  const outputLedInput = firstOutput.locator('.set-outfield', { hasText: 'pixels' }).locator('input');
  await outputLedInput.fill('123');
  await expect(outputLedInput).toHaveValue('123');
});

test('flash screen is reachable for public chip setup', async ({ page }) => {
  await page.goto('/#screen=flash', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByText('Technician diagnostics', { exact: true }).click();
  await expect(page.getByText('Bootloader mode')).toBeVisible();
  await expect(page.getByText('Lightweaver firmware', { exact: true })).toBeVisible();
  await expect(page.getByText('Fetch latest WLED')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Flash firmware' })).toBeVisible();
});

test('installer screen gives a worker the full chip setup checklist', async ({ page }) => {
  await page.goto('/#screen=installer', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Worker install' })).toBeVisible();
  await expect(page.getByText('Use Chrome or Edge on a laptop')).toBeVisible();
  await expect(page.locator('.inst-wire', { hasText: 'Dial A' })).toContainText('GPIO 4');
  await expect(page.locator('.inst-wire', { hasText: 'Dial press' })).toContainText('GPIO 6');
  await expect(page.locator('.inst-wire', { hasText: 'Shared ground' })).toBeVisible();
  // "Flash chip" is now a `go()`-callback button (client-side view switch),
  // not an <a href="#screen=flash">, so verify the click actually navigates
  // instead of checking a static href.
  await page.getByRole('button', { name: 'Flash chip' }).click();
  await expect(page).toHaveURL(/#screen=flash$/);
});

test('connection center uses the stored card host and verifies the popup card', async ({ page }) => {
  await installCardPopupMock(page, 'lw-ap-card', '192.168.4.1');
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_chip_card_host', '192.168.4.1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'My card already lights up' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect.poll(() => page.evaluate(() => (window as any).__cardPopupCalls[0]?.url || '')).toContain('192.168.4.1');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_chip_card_host'))).toBe('192.168.4.1');
  await expect(page.getByRole('button', { name: /Gallery card.*Connected/i })).toBeVisible();
});

test('patterns target selector wraps without overflow and the footer stays single-line', async ({ page }) => {
  // The old hand-rolled ".lw-target-grid" (vertical-scroll, name+LED-count
  // inputs per target) and ".lw-statusbar" (custom nowrap/overflow-hidden
  // bar) are both gone. Their replacements — ".chips" (plain `flex-wrap:
  // wrap` row of buttons, src/v3/v3-screens.css) and ".status-bar" (a fixed
  // 32px-tall flex row, src/v3/v3-styles.css) — get the same "many items /
  // don't break the page" guarantee from ordinary CSS instead of bespoke
  // scroll-container logic, so there's no name/LED-count input pair per
  // target to clone anymore. This test now proves the same two outcomes
  // (many targets don't blow out the viewport; the footer stays one line)
  // against the real structure.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  const chipsRow = page.locator('.chips[aria-label="Target sections"]');
  await chipsRow.evaluate(el => {
    const existing = Array.from(el.querySelectorAll('.chip'));
    const source = existing[existing.length - 1] || existing[0];
    if (!source) return;
    for (let index = existing.length; index < 10; index += 1) {
      const clone = source.cloneNode(true) as HTMLElement;
      clone.setAttribute('data-testid', `section-target-test-${index + 1}`);
      clone.textContent = `Ring ${index + 1}`;
      el.appendChild(clone);
    }
  });

  const chipMetrics = await chipsRow.evaluate(el => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
    chipTops: Array.from(el.querySelectorAll('.chip'), chip =>
      Math.round(chip.getBoundingClientRect().top),
    ),
  }));
  // flex-wrap keeps the row from ever growing wider than its container...
  expect(chipMetrics.scrollWidth).toBeLessThanOrEqual(chipMetrics.clientWidth + 1);
  // ...by wrapping onto more than one row once there are enough chips.
  expect(new Set(chipMetrics.chipTops).size).toBeGreaterThan(1);
  // ...and none of that pushes the page itself into horizontal scroll.
  const pageOverflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  expect(pageOverflow.scrollW).toBeLessThanOrEqual(pageOverflow.clientW);

  // `.status-bar` is `display: flex; align-items: center` (src/v3/v3-styles.css),
  // so its children — a button, spans, and a 1px divider of differing
  // natural heights — legitimately have different `top`s while still being
  // vertically centered on one row. Compare centers, not tops, to check
  // they're all on the same line without wrapping.
  const statusMetrics = await page.locator('.status-bar').evaluate(el => ({
    height: el.getBoundingClientRect().height,
    childCenters: Array.from(el.children, child => {
      const r = child.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    }),
  }));
  expect(statusMetrics.height).toBeLessThanOrEqual(32);
  const centers = statusMetrics.childCenters;
  const spread = Math.max(...centers) - Math.min(...centers);
  expect(spread).toBeLessThanOrEqual(1);
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`main screens load without overflow or console errors on ${viewport.name}`, async ({ page }) => {
    // Hermetic: answer ambient card-status polling with a benign empty body so
    // a real card on the LAN (or its CORS rejection of the dev origin, or an
    // aborted load) can't leak console errors into the assertion below.
    const benign = route => route.fulfill({
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      contentType: 'application/json',
      body: '{}',
    });
    await page.route('http://lightweaver.local/**', benign);
    await page.route('http://192.168.4.1/**', benign);

    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    for (const label of SCREENS) {
      await page.locator('.rail-item', { hasText: label }).click();
      await expect(page.locator('.app')).toBeVisible();
      await expect.poll(async () => page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }))).toEqual({ scrollW: viewport.width, clientW: viewport.width });
    }

    expect(consoleErrors).toEqual([]);
  });
}
