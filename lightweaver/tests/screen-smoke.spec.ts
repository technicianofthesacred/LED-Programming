import { test, expect } from '@playwright/test';

// Every primary Studio destination must retain the shared shell controls.
const SCREENS = ['Patterns', 'Pattern Lab', 'Playlist', 'Layout', 'Show', 'Card'];

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
                      buildId: 'a'.repeat(40),
                      outputs: [{ gpio: 16, count: 44 }],
                    }
                  : message.type === 'status' || message.type === 'ping'
                    ? {
                        app: 'Lightweaver', provisioningContractVersion: 1,
                        cardId: id, cardName: 'Gallery card', firmwareVersion: '1.4.0',
                        buildId: 'a'.repeat(40), bootId: 'boot-popup-test', runtimePhase: 'ready',
                        knownGoodProject: true, commandReady: true, outputReady: true,
                        led: { pixels: 44 },
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
    const link = getSharedCardLink();
    for (const event of linkEvents) {
      const priorBootId = link.getState().validatedBootId;
      link.dispatch(event);
      if (event.type === 'card-verified' && event.readiness?.bootId
        && (!priorBootId || priorBootId === event.readiness.bootId)) link.dispatch(event);
    }
  }, events);
}

function readyStatus(cardId: string, overrides = {}) {
  return {
    app: 'Lightweaver', provisioningContractVersion: 1,
    cardId, firmwareVersion: '1.4.0', buildId: 'a'.repeat(40),
    bootId: 'boot-screen-1', runtimePhase: 'ready', knownGoodProject: true,
    commandReady: true, outputReady: true,
    ...overrides,
  };
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

test('an unreachable previously paired card opens directly on retry guidance', async ({ page }) => {
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
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
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
  await expect(dialog.getByRole('heading', { name: 'Connecting to the Lightweaver card' })).toBeVisible();
  await expect(dialog).toContainText('Keep the card powered and leave its page open while Studio checks it.');
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

test('opening with old firmware renders the card update directly', async ({ page }) => {
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
  await expect(page.getByRole('heading', { name: 'Update this Lightweaver card' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update card' })).toBeVisible();
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
      via: 'direct',
      host: 'lightweaver.local',
      card: { id: 'lw-recovering-card', name: 'Gallery card', firmwareVersion: '1.4.0', buildId: 'a'.repeat(40) },
      readiness: readyStatus('lw-recovering-card'),
    },
    { type: 'operation-recovering' },
  ]);
  await expect(page.getByTestId('card-link-status')).toContainText('Recovering');
  await page.getByTestId('card-link-status').click();
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
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
      body: JSON.stringify({
        ...readyStatus('lw-direct-card', { bootId: 'boot-direct-card' }),
        cardName: 'Direct card', led: { pixels: 44 }, source: 'internal-flash',
        wiringRevision: 4, wiringDigest: 'deadbeef',
      }),
    });
  });
  await page.route('http://lightweaver.local/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      cardId: 'lw-direct-card', cardName: 'Direct card',
      firmwareVersion: '1.4.0', buildId: 'a'.repeat(40),
    }),
  }));
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  allowDirect = true;
  await page.getByRole('button', { name: 'My card already lights up' }).click();
  await expect.poll(() => directRequests.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__cardPopupCalls.length)).toBe(0);
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toContainText('Pair this Lightweaver card');
  await page.getByRole('dialog', { name: 'Connect Lightweaver' }).getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('button', { name: /Direct card.*Connected/i })).toBeVisible();
});

test('background direct discovery stays unpaired until an explicit one-tap pair', async ({ page }) => {
  const passiveCard = {
    ...readyStatus('lw-passive-card', { bootId: 'boot-passive-card' }),
    cardName: 'Passive card', led: { pixels: 44 }, source: 'internal-flash',
    wiringRevision: 4, wiringDigest: 'deadbeef',
  };
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(passiveCard),
  }));
  await page.route('http://lightweaver.local/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(passiveCard),
  }));
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_card_identity_v1'))).toBeNull();
  // A reachable-but-unpaired card is actionable, never green "Connected".
  await expect(page.getByTestId('card-link-status')).not.toHaveAccessibleName(/Connected/);
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Found . pair/);

  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  await expect(dialog).toContainText('Pair this Lightweaver card');
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null')?.id)).toBe('lw-passive-card');
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Connected/);
});

test('direct wrong-card adoption is explicit and reverifies before Connected', async ({ page }) => {
  let firmwareChecks = 0;
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ...readyStatus('lw-direct-found', { bootId: 'boot-direct-found' }),
      cardName: 'Found direct card', source: 'internal-flash',
      wiringRevision: 4, wiringDigest: 'deadbeef',
    }),
  }));
  await page.route('http://lightweaver.local/api/firmware-info', route => {
    firmwareChecks += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cardId: 'lw-direct-found', cardName: 'Found direct card',
        firmwareVersion: '1.4.0', buildId: 'a'.repeat(40),
      }),
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

  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Wrong card/);
  await page.getByTestId('card-link-status').click();
  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  await expect(dialog).toContainText('Found direct card');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null')?.id)).toBe('lw-direct-expected');

  await dialog.getByRole('button', { name: 'Use this card instead' }).click();
  await expect.poll(() => firmwareChecks).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null')?.id)).toBe('lw-direct-found');
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Connected/);
});

test('a paired card reporting a factory status surfaces "Needs project", not green', async ({ page }) => {
  // The card is paired (identity persisted) and reachable — so the write guard
  // would pass — but it answers with a factory/blank status. The footer must
  // say "Needs project" and route the user to install, never plain "Connected".
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      app: 'Lightweaver', provisioningContractVersion: 1,
      cardId: 'lw-blank-card', cardName: 'Blank card', firmwareVersion: '1.4.0',
      buildId: 'a'.repeat(40), bootId: 'boot-blank', runtimePhase: 'factory',
      knownGoodProject: false, commandReady: false, outputReady: false,
      mode: 'factory-flash', source: 'defaults', wiringRevision: 0, wiringDigest: '',
    }),
  }));
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1, id: 'lw-blank-card', name: 'Blank card', hostname: 'lightweaver',
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const status = page.getByTestId('card-link-status');
  await expect(status).toHaveAccessibleName(/Needs project/);
  await expect(status).not.toHaveAccessibleName(/· Connected/);

  await status.click();
  const dialog = page.getByRole('dialog', { name: 'Connect Lightweaver' });
  await expect(dialog).toContainText('Blank — load a project');
  await expect(dialog.getByRole('button', { name: 'Install your project' })).toBeVisible();
});

test('card status control distinguishes checking, blank, and command-ready states', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  const card = { id: 'lw-status-card', name: 'Status card' };
  await page.unroute('http://lightweaver.local/**');
  await page.route('http://lightweaver.local/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: card.id, cardName: card.name }),
  }));
  await page.evaluate(pairedCard => {
    localStorage.clear();
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1,
      ...pairedCard,
      hostname: 'lightweaver',
    }));
    localStorage.setItem('lw_chip_card_host', 'lightweaver.local');
  }, card);
  await page.reload({ waitUntil: 'domcontentloaded' });

  const status = page.getByTestId('card-link-status');
  await expect(status).toHaveAccessibleName(/Checking card/);
  await expect(status).not.toHaveClass(/is-connected/);

  await dispatchCardLinkEvents(page, [{
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local', card,
    blank: true,
    readiness: {
      app: 'Lightweaver', provisioningContractVersion: 1,
      cardId: card.id, firmwareVersion: '1.4.0', buildId: 'a'.repeat(40),
      bootId: 'boot-factory', runtimePhase: 'factory', knownGoodProject: false,
      commandReady: false, outputReady: false,
    },
  }]);
  await expect(status).toHaveAccessibleName(/Needs project/);
  await expect(status).not.toHaveClass(/is-connected/);

  const readyEvent = {
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local', card,
    blank: false,
    readiness: readyStatus(card.id, { bootId: 'boot-ready' }),
  };
  await dispatchCardLinkEvents(page, [readyEvent, readyEvent]);
  await expect(status).toHaveAccessibleName(/Status card.*Connected/);
  await expect(status).toHaveClass(/is-connected/);
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
      readiness: readyStatus('lw-responsive-card', { buildId: 'responsive-build' }),
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

test('layout opens with the primitive-first starter', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  const picker = page.getByTestId('layout-primitive-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Line', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByRole('button', { name: 'Circle', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Square', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Free draw', exact: true })).toBeVisible();
  await expect(page.locator('.la-strip-row')).toHaveCount(0);
  await expect(page.locator('path[data-strip-path]')).toHaveCount(0);
  await expect(page.getByText('Default two-circle hardware')).toHaveCount(0);
});

test('settings screen prioritizes card setup and keeps raw config advanced', async ({ page }) => {
  await page.goto('/#screen=card&section=settings', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  // The old dedicated "Ready to save to card" / "Card setup" / "Studio
  // project" copy and the .lw-chip-* card-summary classes no longer exist —
  // Settings (src/v3/lw-settings.jsx) is a full mockup-style options page
  // now, not a card-save-first wizard. "Card connection" is the section that
  // carries the same job (getting a setup written to the card).
  await expect(page.getByText('Card connection')).toBeVisible();
  await expect(page.getByTestId('settings-ring-summary')).toBeVisible();

  // Card settings is now a READ-ONLY summary of the Layout/Wire result: it
  // shows totals plus per-output GPIO/pixels as text, offers Edit in Layout,
  // and exposes no routing inputs or re-routing actions (Layout owns
  // structure and routing for every layout type).
  const routingSummary = page.getByTestId('output-routing-summary');
  await expect(routingSummary).toContainText(/\d+ LEDs · \d+ sections/);
  await expect(routingSummary).toContainText(/\d+ outputs? · \d+ LEDs routed/);
  await expect(page.locator('[data-testid="output-summary-row"] input')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Single output' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Split by sections' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit in Layout' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit in Layout' }).click();
  await expect(page).toHaveURL(/screen=layout&mode=wire/);
  await page.goto('/#screen=card&section=settings', { waitUntil: 'domcontentloaded' });

  // "Designer config" JSON is hidden by default and revealed with its own
  // Show/Hide JSON button — the old always-visible "Advanced" click target
  // and .lw-chip-settings-json class are gone.
  await page.getByRole('navigation', { name: 'Card sections' }).getByRole('button', { name: 'Advanced & Support' }).click();
  await page.getByRole('button', { name: 'Designer JSON' }).click();
  await expect(page.locator('.set-json')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show JSON' }).click();
  await expect(page.locator('.set-json')).toBeVisible();
});

test('settings rows stack readable labels above controls at 390px without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // `#screen=settings` is the legacy PREFERENCES alias (no Card connection
  // section there) — the Card address row lives in Card settings.
  await page.goto('/#screen=card&section=settings', { waitUntil: 'domcontentloaded' });

  const row = page.locator('.set-row', { hasText: "The card's name on your WiFi" }).first();
  await expect(row).toBeVisible();

  const metrics = await row.evaluate((element) => {
    const label = element.querySelector('.set-k');
    const helper = element.querySelector('.hh');
    const value = element.querySelector('.set-v');
    const control = element.querySelector('input');
    if (!label || !helper || !value || !control) throw new Error('Expected a complete Settings row');

    const rowRect = element.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const helperRect = helper.getBoundingClientRect();
    const valueRect = value.getBoundingClientRect();
    const controlRect = control.getBoundingClientRect();
    return {
      row: { left: rowRect.left, right: rowRect.right },
      label: { left: labelRect.left, right: labelRect.right, bottom: labelRect.bottom },
      helper: { width: helperRect.width, height: helperRect.height, lineHeight: parseFloat(getComputedStyle(helper).lineHeight) },
      value: { left: valueRect.left, top: valueRect.top },
      control: { left: controlRect.left, right: controlRect.right },
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
    };
  });

  expect(metrics.value.top).toBeGreaterThanOrEqual(metrics.label.bottom);
  expect(metrics.value.left).toBeCloseTo(metrics.label.left, 0);
  expect(metrics.helper.width).toBeGreaterThanOrEqual((metrics.row.right - metrics.row.left) * 0.9);
  expect(metrics.helper.height).toBeLessThanOrEqual(metrics.helper.lineHeight * 2.1);
  expect(metrics.control.left).toBeGreaterThanOrEqual(metrics.row.left);
  expect(metrics.control.right).toBeLessThanOrEqual(metrics.row.right);
  expect(metrics.pageScrollWidth).toBe(metrics.pageClientWidth);

  await page.setViewportSize({ width: 1280, height: 900 });
  const desktopMetrics = await row.evaluate((element) => {
    const labelRect = element.querySelector('.set-k')?.getBoundingClientRect();
    const valueRect = element.querySelector('.set-v')?.getBoundingClientRect();
    if (!labelRect || !valueRect) throw new Error('Expected Settings label and value columns');
    return {
      labelRight: labelRect.right,
      valueLeft: valueRect.left,
      labelTop: labelRect.top,
      labelBottom: labelRect.bottom,
      valueTop: valueRect.top,
      valueBottom: valueRect.bottom,
    };
  });
  expect(desktopMetrics.valueLeft).toBeGreaterThan(desktopMetrics.labelRight);
  expect(desktopMetrics.valueTop).toBeLessThan(desktopMetrics.labelBottom);
  expect(desktopMetrics.labelTop).toBeLessThan(desktopMetrics.valueBottom);
});

test('number keys do not navigate away from LED count fields', async ({ page }) => {
  await page.goto('/#screen=settings', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Preferences', level: 1 })).toBeVisible();
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await page.keyboard.press(key);
    await expect(page).toHaveURL(/#screen=settings$/);
    await expect(page.getByRole('heading', { name: 'Preferences', level: 1 })).toBeVisible();
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

  await page.getByRole('heading', { name: 'Preferences', level: 1 }).click();
  await page.keyboard.press('Control+K');
  await expect(page.getByPlaceholder('Type a command...')).toHaveCount(0);
  await expect(page.getByText(/^Go to:/)).toHaveCount(0);

  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
});

test('settings text and number boxes accept direct typing', async ({ page }) => {
  await page.goto('/#screen=card&section=settings', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Row labels (.set-k) are sibling text next to their control, not
  // associated <label>s, so most fields aren't reachable via getByLabel —
  // use the stable .set-row wrapper class plus its label text instead.
  const cardAddress = page.locator('.set-row', { hasText: 'Card address' }).locator('input');
  await cardAddress.fill('192.168.4.1');
  await expect(cardAddress).toHaveValue('192.168.4.1');

  // Layout structure and output routing are READ-ONLY here now (Layout/Wire
  // owns them) — Card settings must not expose editable inputs for them.
  await expect(page.locator('.set-row', { hasText: 'Total LEDs' }).locator('input')).toHaveCount(0);
  await expect(page.locator('.set-seccount input')).toHaveCount(0);
  await expect(page.locator('.set-output-row input')).toHaveCount(0);

  // Preferences fields still accept direct typing.
  await page.goto('/#screen=card&section=preferences', { waitUntil: 'domcontentloaded' });
  const projectNameInput = page.locator('.set-row', { hasText: 'Project name' }).locator('input');
  await projectNameInput.fill('Typed Piece');
  await expect(projectNameInput).toHaveValue('Typed Piece');

  const bpmInput = page.locator('.set-row', { hasText: 'Default BPM' }).locator('input');
  await bpmInput.fill('96');
  await expect(bpmInput).toHaveValue('96');
});

test('flash screen is reachable for public chip setup', async ({ page }) => {
  await page.goto('/#screen=flash', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByText('Technician diagnostics', { exact: true })).toBeVisible();
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
  await expect(page).toHaveURL(/#screen=card&section=install$/);
});

test('connection center opens the stored setup host without silently pairing its popup card', async ({ page }) => {
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
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toContainText('Finish card setup');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_card_identity_v1'))).toBeNull();
  await expect(page.getByTestId('card-link-status')).not.toHaveAccessibleName(/Connected/);
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
    // Hermetic for the same reason: the webfont CDNs are third-party network
    // dependencies (blocked in offline/proxied environments); serve empty CSS
    // so their availability can't leak resource errors or fallback-font
    // metrics into this assertion. App-code errors still fail the test.
    const emptyCss = route => route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    await page.route('https://api.fontshare.com/**', emptyCss);
    await page.route('https://cdn.fontshare.com/**', emptyCss);
    await page.route('https://fonts.googleapis.com/**', emptyCss);
    await page.route('https://fonts.gstatic.com/**', emptyCss);

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
