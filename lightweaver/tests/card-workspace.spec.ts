import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

async function dispatchCardLink(page, events) {
  await page.evaluate(async (nextEvents) => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    for (const event of nextEvents) {
      const priorBootId = link.getState().validatedBootId;
      link.dispatch(event);
      // UI fixtures that establish a trusted card represent the stable pair of
      // full status observations required after any background miss/lifecycle.
      // A changed boot is intentionally left at its first envelope so restart
      // UI remains under revalidation.
      if (event.type === 'card-verified' && event.readiness?.bootId
        && (!priorBootId || priorBootId === event.readiness.bootId)) link.dispatch(event);
    }
  }, events);
}

function readyStatus(cardId: string, overrides = {}) {
  return {
    app: 'Lightweaver', provisioningContractVersion: 1,
    cardId, firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
    bootId: 'boot-1', runtimePhase: 'ready', knownGoodProject: true,
    commandReady: true, outputReady: true,
    ...overrides,
  };
}

async function seedCommissioningFlow(page, progress: 'wifi' | 'load-project' | 'test' | 'test-installed') {
  await page.evaluate(async requestedProgress => {
    const api = await import('/src/lib/cardCommissioningFlow.js');
    const startedAt = Date.now();
    const projectRecord = {
      id: 'card-workspace-project',
      updatedAt: 100,
      project: {
        version: 3,
        id: 'gallery-project',
        name: 'Gallery project',
        layout: { strips: [{ id: 'strip-1', pixelCount: 44 }], wiring: null, patchBoard: null },
        devices: { standaloneController: {} },
      },
    };
    const installed = {
      operation: 'install-current-release',
      cardId: 'lw-aabbccddeeff',
      firmwareVersion: '1.2.3',
      buildId: 'a'.repeat(40),
    };
    let flow = api.completeCardInstall(api.beginCardCommissioning({
      source: 'web-serial',
      operation: installed.operation,
      strategy: 'clean-recovery',
      projectRecord,
      projectRevision: 7,
      flowId: `flow-card-${requestedProgress}-123456789`,
      now: startedAt,
    }), installed, { now: startedAt + 1 });
    if (requestedProgress === 'load-project' || requestedProgress === 'test' || requestedProgress === 'test-installed') {
      flow = api.acknowledgeCommissionedCard(flow, {
        id: installed.cardId,
        firmwareVersion: installed.firmwareVersion,
        buildId: installed.buildId,
      }, { now: startedAt + 2 }).flow;
    }
    if (requestedProgress === 'test' || requestedProgress === 'test-installed') {
      flow = {
        ...flow,
        stage: 'check-lights',
        updatedAt: startedAt + 3,
        project: requestedProgress === 'test'
          ? { ...flow.project, pendingActivationId: 'test-activation-7' }
          : { ...flow.project, restoredAt: startedAt + 3, restoredFingerprint: flow.project.fingerprint },
      };
    }
    await api.writeCardCommissioning(flow, { locks: null });
  }, progress);
}

async function connectCommissioningCard(page) {
  const status = readyStatus('lw-aabbccddeeff', { firmwareVersion: '1.2.3' });
  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(status),
  }));
  await page.evaluate((freshStatus) => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1, id: freshStatus.cardId,
      firmwareVersion: freshStatus.firmwareVersion, buildId: freshStatus.buildId,
    }));
  }, status);
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    expectedCard: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    readiness: status,
  }]);
}

test('wide desktop footer keeps card identity, telemetry, and test controls in separate regions', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-link-status')).toBeVisible();
  await dispatchCardLink(page, [{
    type: 'card-verified',
    via: 'bridge',
    host: 'lightweaver.local',
    card: {
      id: 'lw-aabbccddeeff',
      name: 'Lightweaver Gallery Installation Controller',
      pixelCount: 44,
      gpioSummary: 'GPIO 16 · 44',
      firmwareVersion: '1.0.0',
      buildId: 'gallery-release-build-with-a-long-identity',
    },
    readiness: readyStatus('lw-aabbccddeeff', {
      buildId: 'gallery-release-build-with-a-long-identity',
    }),
  }]);
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Connected/);
  await expect(page.locator('.card-status-summary')).toBeVisible();

  const regions = await page.locator('.status-bar').evaluate(node => {
    const rect = selector => node.querySelector(selector)?.getBoundingClientRect();
    return {
      card: rect('.sb-card'),
      facts: rect('.sb-facts'),
      test: rect('.sb-teststrip'),
      control: rect('.card-status-control'),
      copy: rect('.card-status-copy'),
      name: rect('.card-status-name'),
      state: rect('.card-status-state'),
      summary: rect('.card-status-summary'),
    };
  });
  expect(regions.card.right).toBeLessThanOrEqual(regions.facts.left);
  expect(regions.facts.right).toBeLessThanOrEqual(regions.test.left);
  expect(regions.control.right).toBeLessThanOrEqual(regions.card.right);
  expect(regions.name.right).toBeLessThanOrEqual(regions.state.left);
  expect(regions.state.right).toBeLessThanOrEqual(regions.summary.left);
  expect(regions.copy.right).toBeLessThanOrEqual(regions.summary.left);
});

test('Card overview persists WiFi progress, gates the setup address, and resumes after reload', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__commissioningOpens = [];
    (window as any).__commissioningFetches = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/status')) (window as any).__commissioningFetches.push(url);
      return originalFetch(input, init);
    }) as typeof window.fetch;
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      (window as any).__commissioningOpens.push({ url: String(url || ''), target, features });
      return { closed: false, postMessage() {}, focus() {}, location: { href: String(url || '') } } as unknown as Window;
    }) as typeof window.open;
  });
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi');
  await page.reload({ waitUntil: 'domcontentloaded' });

  const steps = page.getByTestId('card-setup-steps').locator('li');
  await expect(steps.nth(0)).toHaveAttribute('data-step-state', 'complete');
  await expect(steps.nth(1)).toHaveAttribute('data-step-state', 'complete');
  await expect(steps.nth(2)).toHaveAttribute('data-step-state', 'current');
  await expect(steps.nth(3)).toHaveAttribute('data-step-state', 'upcoming');
  await expect(steps.nth(4)).toHaveAttribute('data-step-state', 'upcoming');

  await page.getByRole('button', { name: 'Continue WiFi setup', exact: true }).click();
  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.getByRole('button', { name: 'I’ve joined Lightweaver-XXXX', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-XXXX', exact: true }).click();
  const setupButton = page.getByRole('button', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i });
  await expect(setupButton).toBeVisible();
  await setupButton.click();
  await expect.poll(() => page.evaluate(() => (window as any).__commissioningOpens.at(-1))).toMatchObject({
    target: 'lightweaver-card-bridge',
  });
  expect(await page.evaluate(() => (window as any).__commissioningOpens.at(-1)?.features || '')).not.toContain('noopener');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i })).toBeVisible();
});

test('commissioning reconnect preserves the verified host instead of falling back to the setup AP', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
  });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi');
  const reconnectHost = await page.evaluate(async () => {
    const mainSource = await (await fetch('/src/main.jsx')).text();
    const domUrl = mainSource.match(/["']([^"']*react-dom_client[^"']*)["']/)?.[1];
    const panelSource = await (await fetch('/src/components/card/CardCommissioningPanel.jsx')).text();
    const reactUrl = panelSource.match(/["']([^"']*\/deps\/react\.js[^"']*)["']/)?.[1];
    if (!domUrl || !reactUrl) throw new Error('could not resolve React module URLs');
    const [{ CardCommissioningPanel }, { ProjectProvider }, reactModule, domModule] = await Promise.all([
      import('/src/components/card/CardCommissioningPanel.jsx'),
      import('/src/state/ProjectContext.jsx'),
      import(reactUrl),
      import(domUrl),
    ]);
    const React = reactModule.default ?? reactModule;
    const createRoot = domModule.createRoot ?? domModule.default?.createRoot;
    const host = document.createElement('div');
    document.body.appendChild(host);
    let received = '';
    const root = createRoot(host);
    root.render(React.createElement(ProjectProvider, null,
      React.createElement(CardCommissioningPanel, {
        result: null,
        link: { state: 'disconnected', host: '192.168.18.90', transport: 'bridge' },
        onReconnect: value => { received = value; },
      }),
    ));
    await new Promise(resolve => setTimeout(resolve, 100));
    const button = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Reconnect installed card');
    if (!button) throw new Error('commissioning reconnect action not rendered');
    button.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    root.unmount();
    host.remove();
    return received;
  });
  expect(reconnectHost).toBe('192.168.18.90');
});

test('reality-driven detection replaces the dead 192.168.4.1 link with the restore path once the card rejoins the LAN', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi');
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Continue WiFi setup', exact: true }).click();
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-XXXX', exact: true }).click();

  // While the card is still on its setup AP (unreachable on the LAN — the
  // beforeEach aborts every card host) the dead-AP fallback link is the only
  // setup affordance and the restore path is not yet offered.
  const setupLink = page.getByRole('button', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i });
  await expect(setupLink).toBeVisible();
  await expect(page.getByText(/Waiting for the card to rejoin your network/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toHaveCount(0);

  // The card leaves its AP and rejoins home WiFi: it now answers /api/status in
  // station transport with its exact identity. The background detection poll must
  // observe this and auto-advance — no manual "Reconnect installed card" click.
  await page.route('**/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ...readyStatus('lw-aabbccddeeff', { firmwareVersion: '1.2.3' }),
      wifi: {
        transport: 'station', transition: 'station', transitionPending: false,
        stationIp: '192.168.18.70', ip: '192.168.18.70', handoffGeneration: 7,
      },
    }),
  }));

  // The dead 192.168.4.1 link is gone and the verified restore path is reachable
  // without any manual reconnect.
  await expect(setupLink).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeVisible({ timeout: 10_000 });
});

test('a wrong card answering on the LAN never auto-advances setup past the identity gate', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi');
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Continue WiFi setup', exact: true }).click();
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-XXXX', exact: true }).click();

  // A different card (mismatched identity) answers /api/status in station
  // transport. The safety gate must reject it: the detection poll keeps waiting
  // and never offers the restore path.
  await page.route('**/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ...readyStatus('lw-ffffffffffff', { firmwareVersion: '9.9.9', buildId: 'f'.repeat(40) }),
      wifi: {
        transport: 'station', transition: 'station', transitionPending: false,
        stationIp: '192.168.18.71', ip: '192.168.18.71', handoffGeneration: 7,
      },
    }),
  }));

  await expect(page.getByText(/Waiting for the card to rejoin your network/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i })).toBeVisible();
  // Give the poll several cycles; the mismatched card must never unlock restore.
  await page.waitForTimeout(3_000);
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toHaveCount(0);
});

test('retained pre-install card identity cannot bypass the explicit WiFi handoff', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await dispatchCardLink(page, [{
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    acknowledgedAt: '2026-01-01T00:00:00.000Z',
    card: { id: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
    readiness: readyStatus('lw-aabbccddeeff', {
      firmwareVersion: '1.2.3',
      wifi: {
        transport: 'station', transition: 'station', transitionPending: false,
        stationIp: '192.168.18.90', ip: '192.168.18.90', handoffGeneration: 7,
      },
    }),
  }]);
  await seedCommissioningFlow(page, 'wifi');

  await page.getByRole('button', { name: 'Continue WiFi setup', exact: true }).click();
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-XXXX', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reconnect installed card', exact: true })).toBeVisible();

  await dispatchCardLink(page, [{
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    acknowledgedAt: new Date(Date.now() + 5_000).toISOString(),
    card: { id: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
    readiness: readyStatus('lw-aabbccddeeff', {
      firmwareVersion: '1.2.3',
      wifi: {
        transport: 'station', transition: 'station', transitionPending: false,
        stationIp: '192.168.18.90', ip: '192.168.18.90', handoffGeneration: 7,
      },
    }),
  }]);
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeVisible();
});

test('Card overview keeps Load project and Test as resumable commissioning steps', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'load-project');
  await page.reload({ waitUntil: 'domcontentloaded' });

  let steps = page.getByTestId('card-setup-steps').locator('li');
  await expect(steps.nth(2)).toHaveAttribute('data-step-state', 'complete');
  await expect(steps.nth(3)).toHaveAttribute('data-step-state', 'current');
  await expect(steps.nth(4)).toHaveAttribute('data-step-state', 'upcoming');
  await page.getByRole('button', { name: 'Save project to card', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeVisible();

  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'test');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await connectCommissioningCard(page);
  steps = page.getByTestId('card-setup-steps').locator('li');
  await expect(steps.nth(3)).toHaveAttribute('data-step-state', 'complete');
  await expect(steps.nth(4)).toHaveAttribute('data-step-state', 'current');
  await page.evaluate(() => {
    (window as any).__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'testing', activationId });
    (window as any).__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'known-good', activationId });
    (window as any).__LW_ROLLBACK_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'known-good', activationId });
  });
  await page.getByRole('button', { name: 'Test lights', exact: true }).click();
  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await page.getByRole('button', { name: 'Start 90-second light test', exact: true }).click();
  await expect(page.getByText(/blue first pixel and red final pixel/i)).toBeVisible();
  await page.getByRole('button', { name: 'Yes, every output is correct', exact: true }).click();
  await expect(page.getByText('Light check complete', { exact: true })).toBeVisible();
  const done = page.getByRole('button', { name: 'Done', exact: true });
  await expect(done).toBeVisible();
  await done.click();
  await expect(page).toHaveURL(/#screen=card&section=overview$/);

  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'test');
  await connectCommissioningCard(page);
  await page.getByRole('button', { name: 'Test lights', exact: true }).click();
  await page.getByRole('button', { name: 'Start 90-second light test', exact: true }).click();
  await page.getByRole('button', { name: 'No, restore working setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up card', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeVisible();
});

test('installed check-lights progress runs a bounded marker test and restores the working look on rejection', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'test-installed');
  await connectCommissioningCard(page);
  await page.evaluate(() => {
    (window as any).__commissioningMarkerStarts = [];
    (window as any).__commissioningMarkerStops = 0;
    (window as any).__LW_START_COMMISSIONING_MARKERS_FOR_TEST__ = async (frame: string[]) => {
      (window as any).__commissioningMarkerStarts.push(frame);
      return { stop: async () => { (window as any).__commissioningMarkerStops += 1; } };
    };
  });

  await page.getByRole('button', { name: 'Test lights', exact: true }).click();
  await page.getByRole('button', { name: 'Start bounded marker test', exact: true }).click();
  await expect(page.getByText(/blue first pixel and red final pixel/i)).toBeVisible();
  const markers = await page.evaluate(() => (window as any).__commissioningMarkerStarts[0]);
  expect(markers[0]).toBe('00001A');
  expect(markers.at(-1)).toBe('1A0000');
  await page.getByRole('button', { name: 'No, restore working look', exact: true }).click();
  await expect(page.getByText(/working look is restored/i)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__commissioningMarkerStops)).toBe(1);
  await expect(page.getByRole('button', { name: 'Start bounded marker test', exact: true })).toBeVisible();
});

test('light-check hardware mutations stay locked after loss until two stable exact status envelopes', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'test');
  await connectCommissioningCard(page);
  await page.evaluate(() => {
    (window as any).__lightMutationCalls = { activate: 0, confirm: 0, rollback: 0 };
    (window as any).__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => {
      (window as any).__lightMutationCalls.activate += 1;
      return { state: 'testing', activationId };
    };
    (window as any).__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => {
      (window as any).__lightMutationCalls.confirm += 1;
      return { state: 'known-good', activationId };
    };
    (window as any).__LW_ROLLBACK_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => {
      (window as any).__lightMutationCalls.rollback += 1;
      return { state: 'known-good', activationId };
    };
  });
  await page.getByRole('button', { name: 'Test lights', exact: true }).click();

  await dispatchCardLink(page, [{ type: 'direct-ping-missed', host: 'lightweaver.local' }]);
  const start = page.getByRole('button', { name: 'Start 90-second light test', exact: true });
  await expect(start).toBeDisabled();
  await start.evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => page.evaluate(() => (window as any).__lightMutationCalls.activate)).toBe(0);

  const stable = readyStatus('lw-aabbccddeeff', { firmwareVersion: '1.2.3' });
  const recovery = {
    type: 'direct-ping-ok', host: 'lightweaver.local', readiness: stable,
    card: { id: stable.cardId, firmwareVersion: stable.firmwareVersion, buildId: stable.buildId },
    expectedCard: { id: stable.cardId, firmwareVersion: stable.firmwareVersion, buildId: stable.buildId },
  };
  await dispatchCardLink(page, [recovery, recovery]);
  await expect(start).toBeEnabled();
  await start.click();
  await expect.poll(() => page.evaluate(() => (window as any).__lightMutationCalls.activate)).toBe(1);

  await dispatchCardLink(page, [{ type: 'direct-ping-missed', host: 'lightweaver.local' }]);
  const confirm = page.getByRole('button', { name: 'Yes, every output is correct', exact: true });
  const rollback = page.getByRole('button', { name: 'No, restore working setup', exact: true });
  await expect(confirm).toBeDisabled();
  await expect(rollback).toBeDisabled();
  await confirm.evaluate((button: HTMLButtonElement) => button.click());
  await rollback.evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => page.evaluate(() => (window as any).__lightMutationCalls)).toEqual({
    activate: 1, confirm: 0, rollback: 0,
  });
});

test('Card replaces the setup rail destinations and exposes ordinary section navigation', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Card', exact: true }).click();

  await expect(page).toHaveURL(/#screen=card&section=overview$/);
  const sections = page.getByRole('navigation', { name: 'Card sections' });
  await expect(sections).toBeVisible();
  for (const label of ['Install or update', 'Card settings', 'Advanced & Support']) {
    await expect(sections.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  // Batch production (formerly Workshop setup) is not a section tab.
  await expect(sections.getByRole('button', { name: 'Workshop setup', exact: true })).toHaveCount(0);
  await expect(sections.getByRole('button', { name: 'Batch production', exact: true })).toHaveCount(0);
  for (const label of ['Flash', 'Installer', 'Production setup', 'Settings']) {
    await expect(page.locator('.rail').getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
  await expect(sections.getByRole('menu')).toHaveCount(0);
  await expect(sections.locator('[role="menuitem"]')).toHaveCount(0);
  await expect(sections.locator('[aria-haspopup]')).toHaveCount(0);
});

test('Card section navigation wraps without page overflow on a 390px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });

  const sections = page.getByRole('navigation', { name: 'Card sections' });
  const dimensions = await sections.evaluate(node => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

  for (const label of ['Card', 'Install or update', 'Card settings', 'Advanced & Support', 'Preferences']) {
    const button = sections.getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible();
    await expect(button).toBeInViewport();
  }

  const pageWidth = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.viewportWidth);
});

test('disconnected Card overview shows the ordered setup path and Connect as primary', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();
  await dispatchCardLink(page, [{ type: 'bridge-lost', reason: 'never-connected', host: 'lightweaver.local' }]);
  await expect(page.getByTestId('card-detected-state')).toContainText(/not detected|not connected/i);
  const steps = page.getByTestId('card-setup-steps').locator('li');
  await expect(steps).toHaveCount(5);
  await expect(steps.locator('.card-setup-label')).toHaveText(['Connect', 'Install firmware', 'WiFi', 'Save to card', 'Test lights']);
  await expect(page.getByRole('button', { name: 'Connect card', exact: true })).toHaveClass(/primary/);

  const batch = page.getByTestId('card-batch-link');
  await expect(batch).toContainText('Making many cards?');
  await expect(batch.getByRole('button', { name: 'Batch production', exact: true })).toBeVisible();
});

test('direct discovery never auto-adopts; only the explicit pair action persists identity', async ({ page }) => {
  const status = readyStatus('lw-explicit-pair');
  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(status),
  }));
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(status),
  }));
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Found — pair/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_card_identity_v1'))).toBeNull();

  await page.getByTestId('card-link-status').click();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null')?.id)).toBe('lw-explicit-pair');
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Connected/);
});

test('connect actions prefer onOpenConnectionCenter and fall back to onConnectCard when absent', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();

  const calls = await page.evaluate(async () => {
    // Resolve the app's own React instance through the Vite module graph so
    // the direct render shares the running React copy.
    const mainSource = await (await fetch('/src/main.jsx')).text();
    const domUrl = mainSource.match(/["']([^"']*react-dom_client[^"']*)["']/)?.[1];
    const cardSource = await (await fetch('/src/v3/lw-card.jsx')).text();
    const reactUrl = cardSource.match(/["']([^"']*\/deps\/react\.js[^"']*)["']/)?.[1];
    if (!domUrl || !reactUrl) throw new Error('could not resolve React module URLs');
    const [{ CardScreen }, reactModule, domModule] = await Promise.all([
      import('/src/v3/lw-card.jsx'),
      import(reactUrl),
      import(domUrl),
    ]);
    const React = reactModule.default ?? reactModule;
    const createRoot = domModule.createRoot ?? domModule.default?.createRoot;
    if (typeof createRoot !== 'function') throw new Error('could not resolve createRoot');

    const result = { overviewCenter: 0, overviewProbe: 0, recoveryCenter: 0, fallbackProbe: 0 };
    const disconnectedLink = { state: 'disconnected', reason: 'card-unreachable', activity: 'idle' };
    const renderOnce = async props => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      root.render(React.createElement(CardScreen, props));
      await new Promise(resolve => setTimeout(resolve, 50));
      const button = [...host.querySelectorAll('button')].find(node => node.textContent.trim() === 'Reconnect card');
      if (!button) throw new Error('Reconnect card action not rendered');
      button.click();
      root.unmount();
      host.remove();
    };

    // Overview connect action with the connection center provided.
    await renderOnce({
      connected: false,
      cardHost: 'lightweaver.local',
      cardLink: disconnectedLink,
      onConnectCard: () => { result.overviewProbe += 1; },
      onOpenConnectionCenter: () => { result.overviewCenter += 1; },
      onOpenSection: () => {},
      route: { section: 'overview', supportTool: '' },
    });
    // Recovery support connect action with the connection center provided.
    await renderOnce({
      connected: false,
      cardHost: 'lightweaver.local',
      cardLink: disconnectedLink,
      onConnectCard: () => {},
      onOpenConnectionCenter: () => { result.recoveryCenter += 1; },
      onOpenSection: () => {},
      route: { section: 'support', supportTool: 'recovery' },
    });
    // Prop absent (current app.jsx wiring): must fall back to onConnectCard.
    await renderOnce({
      connected: false,
      cardHost: 'lightweaver.local',
      cardLink: disconnectedLink,
      onConnectCard: () => { result.fallbackProbe += 1; },
      onOpenSection: () => {},
      route: { section: 'overview', supportTool: '' },
    });
    return result;
  });

  expect(calls.overviewCenter).toBe(1);
  expect(calls.overviewProbe).toBe(0);
  expect(calls.recoveryCenter).toBe(1);
  expect(calls.fallbackProbe).toBe(1);
});

test('connected Card overview identifies the card and makes Save to card primary', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();
  await dispatchCardLink(page, [{
    type: 'card-verified', via: 'bridge',
    card: { id: 'lw-gallery-card', name: 'Gallery card' },
    readiness: readyStatus('lw-gallery-card'),
  }]);

  await expect(page.getByTestId('card-detected-state')).toContainText('Gallery card');
  await expect(page.getByTestId('card-detected-state')).toContainText(/connected/i);
  await expect(page.getByTestId('card-detected-state')).not.toContainText(/has not changed|nothing changed/i);
  await expect(page.getByRole('button', { name: 'Save to card', exact: true })).toHaveClass(/primary/);
  await expect(page.getByRole('button', { name: 'Verify in workshop', exact: true })).toHaveCount(0);
});

test('Card overview distinguishes checking, blank, and ready evidence', async ({ page }) => {
  let status: any = {
    app: 'Lightweaver', cardId: 'lw-overview-state',
    firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
  };
  await page.addInitScript(identity => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify(identity));
  }, {
    version: 1, id: 'lw-overview-state', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
  });
  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(status),
  }));
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: 'lw-overview-state', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    expectedCard: { id: 'lw-overview-state', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    readiness: status,
  }]);
  await expect(page.getByTestId('card-detected-state')).toContainText('Checking card');

  status = readyStatus('lw-overview-state', {
    runtimePhase: 'factory', knownGoodProject: false, commandReady: false,
  });
  await expect(page.getByTestId('card-detected-state')).toContainText('Blank — load a project');

  status = readyStatus('lw-overview-state');
  await expect(page.getByTestId('card-detected-state')).toContainText('ready for light check');
});

test('ready overview offers Batch production as a low-emphasis link, not a setup step', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();
  await dispatchCardLink(page, [{
    type: 'card-verified', via: 'bridge',
    card: { id: 'lw-gallery-card', name: 'Gallery card' },
    readiness: readyStatus('lw-gallery-card'),
  }]);
  await expect(page.getByRole('button', { name: 'Save to card', exact: true })).toHaveClass(/primary/);
  await expect(page.getByRole('button', { name: 'Verify in workshop', exact: true })).toHaveCount(0);

  await expect(page.getByTestId('card-setup-steps')).not.toContainText('Batch production');
  const batch = page.getByTestId('card-batch-link').getByRole('button', { name: 'Batch production', exact: true });
  await expect(batch).toHaveClass(/link-btn/);
  await expect(batch).not.toHaveClass(/primary/);

  await batch.click();
  await expect(page).toHaveURL(/#screen=card&section=workshop$/);
  await expect(page.getByRole('heading', { name: 'Batch production', level: 1 })).toBeVisible();
  await expect(page.getByText('Manufacturing mode', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Card', exact: true }).click();
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();
});

for (const cardState of [
  {
    name: 'connecting',
    events: [{ type: 'connecting', via: 'bridge', host: 'lightweaver.local' }],
    copy: /looking for the card/i,
    action: 'Connecting…',
  },
  {
    name: 'stopped responding',
    events: [
      { type: 'card-verified', via: 'bridge', host: 'lightweaver.local', card: { id: 'lw-gallery', name: 'Gallery card' }, readiness: readyStatus('lw-gallery') },
      { type: 'bridge-ping-missed', host: 'lightweaver.local' },
      { type: 'bridge-ping-missed', host: 'lightweaver.local' },
    ],
    copy: /card stopped responding/i,
    action: 'Card stopped responding',
  },
  {
    name: 'revalidating after restart',
    events: [
      { type: 'card-verified', via: 'direct', host: 'lightweaver.local', card: { id: 'lw-gallery', name: 'Gallery card' }, readiness: readyStatus('lw-gallery') },
      { type: 'card-verified', via: 'direct', host: 'lightweaver.local', card: { id: 'lw-gallery', name: 'Gallery card' }, readiness: readyStatus('lw-gallery', { bootId: 'boot-2' }) },
    ],
    copy: /card restarted.*verifying/i,
    action: 'Card restarted — verifying',
  },
  {
    name: 'wrong card',
    events: [{ type: 'direct-status', connected: true, host: 'lightweaver.local', card: { id: 'lw-other' }, expectedCard: { id: 'lw-gallery' } }],
    copy: /different Lightweaver card/i,
    action: 'Connect expected card',
  },
  {
    name: 'old firmware',
    events: [{ type: 'bridge-lost', reason: 'firmware-too-old', host: 'lightweaver.local' }],
    copy: /firmware needs an update/i,
    action: 'Update card',
  },
  {
    name: 'unreachable card',
    events: [{ type: 'direct-status', connected: false, reason: 'card-unreachable', host: 'lightweaver.local' }],
    copy: /No card found on this network/i,
    action: 'Reconnect card',
  },
  {
    name: 'failed operation',
    events: [{ type: 'operation-failed' }],
    copy: /last card operation failed/i,
    action: 'Reconnect card',
  },
  {
    name: 'recovering operation',
    events: [{ type: 'operation-recovering' }],
    copy: /recovering the last card operation/i,
    action: 'Recovery in progress…',
  },
]) {
  test(`Card overview preserves the ${cardState.name} state and recovery action`, async ({ page }) => {
    await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();
    if (cardState.name === 'revalidating after restart') {
      await page.route('**/api/status', () => new Promise(() => {}));
    }
    await dispatchCardLink(page, cardState.events);

    await expect(page.getByTestId('card-detected-state')).toContainText(cardState.copy);
    await expect(page.getByTestId('card-detected-state')).not.toContainText('A Lightweaver card is not connected');
    await expect(page.getByRole('button', { name: cardState.action, exact: true })).toBeVisible();
  });
}

test('top-bar Preferences opens the canonical Card preferences section', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();

  await expect(page).toHaveURL(/#screen=card&section=preferences$/);
  await expect(page.getByRole('heading', { name: 'Preferences', level: 1 })).toBeFocused();
  await expect(page.getByText('Project', { exact: true })).toBeVisible();
});

for (const legacy of [
  { hash: '#screen=flash&mode=install', section: 'Install or update', heading: 'Install Lightweaver' },
  { hash: '#screen=flash', section: 'Advanced & Support', heading: 'Manual firmware tools' },
  { hash: '#screen=installer', section: 'Advanced & Support', heading: 'Worker install' },
  // Batch production is not a section tab, so no tab is highlighted for it.
  { hash: '#screen=production&job=moon-batch-7', section: null, heading: 'Batch production' },
  { hash: '#screen=settings', section: 'Preferences', heading: 'Preferences' },
]) {
  test(`legacy ${legacy.hash} stays intact and opens ${legacy.section || legacy.heading}`, async ({ page }) => {
    await page.goto(`/${legacy.hash}`, { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(new RegExp(`${legacy.hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await expect(page.locator('.rail-item.active')).toHaveAccessibleName('Card');
    const sections = page.getByRole('navigation', { name: 'Card sections' });
    if (legacy.section) {
      await expect(sections.getByRole('button', { name: legacy.section, exact: true })).toHaveAttribute('aria-current', 'page');
    } else {
      await expect(sections.locator('[aria-current="page"]')).toHaveCount(0);
    }
    await expect(page.getByRole('heading', { name: legacy.heading, exact: true }).first()).toBeVisible();
  });
}

test('new section navigation emits canonical Card hashes and moves focus to the section heading', async ({ page }) => {
  await page.goto('/#screen=flash', { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation', { name: 'Card sections' }).getByRole('button', { name: 'Card settings' }).click();

  await expect(page).toHaveURL(/#screen=card&section=settings$/);
  const heading = page.getByRole('heading', { name: 'Card settings', level: 1 });
  await expect(heading).toBeFocused();
  expect(await heading.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  expect(await heading.evaluate(element => Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
  await expect(page.getByText('Card connection', { exact: true })).toBeVisible();
});

test('embedded install uses the Card heading as the only h1', async ({ page }) => {
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Install or update', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Install Lightweaver', level: 2 })).toBeVisible();
});

test('embedded unsupported install uses the Card heading as the only h1', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Install or update', level: 1 })).toBeVisible();
  await expect(page.locator('.install-handoff').getByRole('heading', { level: 2 })).toBeVisible();
});

test('legacy technician path uses the Card heading as the only h1', async ({ page }) => {
  await page.goto('/#screen=flash', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Advanced & Support', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Manual firmware tools', level: 2 })).toBeVisible();
});

test('legacy installer guide path uses the Card heading as the only h1', async ({ page }) => {
  await page.goto('/#screen=installer', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Advanced & Support', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Worker install', level: 2 })).toBeVisible();
});

test('embedded workshop uses the Card heading as the only h1', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
  });
  await page.goto('/#screen=card&section=workshop', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Batch production', level: 1 })).toBeVisible();
  await expect(page.getByText('Manufacturing mode', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to Card', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Card sections' }).locator('[aria-current="page"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('.prod-shell')).toHaveJSProperty('tagName', 'SECTION');
});

test('embedded unsupported workshop does not add a nested main landmark', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.goto('/#screen=card&section=workshop', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('.prod-handoff')).toHaveJSProperty('tagName', 'SECTION');
});

test('Advanced & Support exposes its tools without a collapsed disclosure', async ({ page }) => {
  await page.goto('/#screen=card&section=support', { waitUntil: 'domcontentloaded' });

  for (const label of ['Technician firmware & logs', 'GPIO & install guide', 'Designer JSON', 'Recovery', 'Batch production']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.locator('details')).toHaveCount(0);
  await page.getByRole('button', { name: 'Technician firmware & logs' }).click();
  await expect(page.getByRole('heading', { name: 'Manual firmware tools' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Flash firmware' })).toBeVisible();
});

test('Advanced & Support Batch production tile navigates to the batch surface', async ({ page }) => {
  await page.goto('/#screen=card&section=support', { waitUntil: 'domcontentloaded' });

  const tile = page.locator('.card-support-grid').getByRole('button', { name: 'Batch production', exact: true });
  await expect(tile).toBeVisible();
  // It navigates rather than toggling a local support tool.
  expect(await tile.getAttribute('aria-pressed')).toBeNull();
  await tile.click();
  await expect(page).toHaveURL(/#screen=card&section=workshop$/);
  await expect(page.getByRole('heading', { name: 'Batch production', level: 1 })).toBeVisible();
});

test('an active firmware install keeps rail navigation locked to install', async ({ page }) => {
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: true } })));
  await page.getByRole('navigation', { name: 'Card sections' }).getByRole('button', { name: 'Card settings' }).click();
  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();

  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.locator('.rail-item.active')).toHaveAccessibleName('Card');
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
});

test('an active firmware install rejects direct hash mutation without changing visible content', async ({ page }) => {
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: true } }));
    window.location.hash = 'screen=card&section=support';
  });

  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Advanced & Support' })).toHaveCount(0);
});

test('an active firmware install rejects browser Back without changing visible content', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();
  // Section clicks replace history, so push a real Back entry by mutating the
  // hash directly — the same way an external link or bookmark would.
  await page.evaluate(() => { window.location.hash = 'screen=card&section=install'; });
  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: true } })));
  await page.goBack();

  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toHaveCount(0);
});

test('the browser deployment check verifies the served signed release and never overstates it', async ({ page }) => {
  await page.goto('/#screen=card&section=support', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Deployment check' }).click();

  const panel = page.getByTestId('deployment-check-panel');
  await expect(panel).toBeVisible();
  // Runs on demand only — opening the tool performs no check by itself.
  await expect(page.getByTestId('deployment-check-results')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Run deployment check' }).click();
  const results = page.getByTestId('deployment-check-results');
  await expect(results).toBeVisible();

  // The dev server serves the real signed release set from public/, so the
  // cryptographic release verification passes with the release identity...
  const releaseRow = results.locator('li').filter({ hasText: 'Signed firmware release' });
  await expect(releaseRow).toHaveAttribute('data-check-ok', 'true', { timeout: 15000 });
  await expect(results.locator('.deploy-check-summary')).toContainText(/Firmware v\d+\.\d+\.\d+/);

  // ...while cache policies genuinely differ from production here, and the
  // panel must say FAILED rather than claim an unverified success.
  const cacheRow = results.locator('li').filter({ hasText: 'cache policies' });
  await expect(cacheRow).toHaveAttribute('data-check-ok', 'false');
  await expect(results.getByText(/Deployment checks FAILED/)).toBeVisible();

  // The honest boundary stays visible: the independent audit is check:prod.
  await expect(panel.getByText(/check:prod/)).toBeVisible();
});


test('a worker typing the bare domain reaches Batch production from the rail and finds the published job', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const workshop = page.locator('.rail').getByRole('button', { name: 'Workshop — Batch production' });
  await expect(workshop).toBeVisible();
  await workshop.click();
  await expect(page.getByRole('heading', { name: 'Batch production', level: 1 })).toBeVisible();

  // The published same-origin job is discoverable by its printed code alone.
  await page.getByLabel('Job code').fill('bench-fixture-44');
  await page.getByRole('button', { name: 'Find job' }).click();
  await expect(page.getByText('Bench fixture · 44 LEDs')).toBeVisible();
  await expect(page.getByText(/Verified production job/i)).toBeVisible();
});

test('HTTPS Studio keeps a blank replacement card config-only across an ambiguous WiFi handoff', async ({ page }) => {
  // Serve the real Vite app at its production HTTPS origin. This keeps the
  // browser security boundary realistic while all card traffic remains the
  // postMessage-only local bridge exercised below.
  await page.route('https://led.mandalacodes.com/**', async route => {
    const requested = new URL(route.request().url());
    const upstream = await page.request.fetch(`http://localhost:9997${requested.pathname}${requested.search}`);
    await route.fulfill({ response: upstream });
  });
  await page.goto('https://led.mandalacodes.com/#screen=card&section=overview', {
    waitUntil: 'domcontentloaded',
  });

  const result = await page.evaluate(async () => {
    const bridge = await import('/src/lib/cardBridge.js');
    const handoff = await import('/src/lib/cardWifiHandoff.js');
    const cardLink = await import('/src/lib/cardLink.js');
    const commissioning = await import('/src/lib/cardCommissioningFlow.js');

    const priorCard = {
      version: 1,
      id: 'lw-aaaaaaaaaaaa',
      firmwareVersion: '1.0.0',
      buildId: 'a'.repeat(40),
    };
    localStorage.setItem('lw_card_identity_v1', JSON.stringify(priorCard));
    localStorage.removeItem('lw_chip_card_host');

    const expectedCard = {
      id: 'lw-bbbbbbbbbbbb',
      firmwareVersion: '2.0.0',
      buildId: 'b'.repeat(40),
    };
    const stationHost = '192.168.18.91';
    const bootId = 'boot-replacement-b';
    const generation = 12;
    const flowId = 'flow-browser-wifi-123456789';
    const replacementFlowId = 'flow-browser-wifi-987654321';
    const messageTypes: string[] = [];
    let configured = false;
    let activeHost = '192.168.4.1';
    const projectRevision = 23;
    const projectRecord = {
      id: 'browser-blank-project-record',
      updatedAt: 100,
      project: {
        version: 3,
        id: 'browser-blank-project',
        name: 'Browser blank project',
        layout: { strips: [{ id: 'strip-1', pixelCount: 44 }], wiring: null, patchBoard: null },
        devices: { standaloneController: {} },
      },
    };
    const startedAt = Date.now();
    let commissioningFlow = commissioning.completeCardInstall(commissioning.beginCardCommissioning({
      source: 'web-serial', operation: 'install-current-release', strategy: 'clean-recovery',
      projectRecord, projectRevision, flowId, now: startedAt,
    }), {
      operation: 'install-current-release', cardId: expectedCard.id,
      firmwareVersion: expectedCard.firmwareVersion, buildId: expectedCard.buildId,
    }, { now: startedAt + 1 });
    commissioningFlow = commissioning.confirmCardSetupNetworkJoined(commissioningFlow, { now: startedAt + 2 });
    await commissioning.writeCardCommissioning(commissioningFlow, { locks: null });
    const projectFingerprint = commissioningFlow.project.fingerprint;
    let status = {
      app: 'Lightweaver',
      provisioningContractVersion: 1,
      cardId: expectedCard.id,
      firmwareVersion: expectedCard.firmwareVersion,
      buildId: expectedCard.buildId,
      bootId,
      runtimePhase: 'ready',
      knownGoodProject: true,
      commandReady: true,
      outputReady: true,
      wifi: {
        transport: 'station',
        transition: 'handoff-ready',
        transitionPending: true,
        apActive: true,
        stationIp: stationHost,
        ip: stationHost,
        handoffGeneration: generation,
      },
    };

    const emit = (data: Record<string, unknown>, host = activeHost) => {
      const event = new Event('message');
      Object.defineProperties(event, {
        data: { value: data },
        origin: { value: `http://${host}` },
        source: { value: fakeCardTab },
      });
      window.dispatchEvent(event);
    };
    const emitReady = () => emit({
      app: 'LightweaverCardBridge', type: 'ready', version: 2, host: activeHost,
    });

    const fakeCardTab = {
      closed: false,
      focus() {},
      postMessage(message: Record<string, unknown>) {
        const type = String(message.type || '');
        messageTypes.push(type);
        if (type === 'wifi-handoff-ack') {
          // The card applies the ack, but the reply is lost. A same-tab reload
          // creates a new bridge lifecycle before the request times out.
          status = {
            ...status,
            runtimePhase: 'factory',
            knownGoodProject: false,
            commandReady: false,
            outputReady: false,
            wifi: {
              transport: 'station',
              transition: 'station',
              transitionPending: false,
              apActive: false,
              stationIp: stationHost,
              ip: stationHost,
              handoffGeneration: generation,
            },
          };
          setTimeout(emitReady, 25);
          return;
        }
        if (type === 'config') {
          configured = true;
          status = {
            ...status,
            runtimePhase: 'ready', knownGoodProject: true,
            commandReady: true, outputReady: true,
          };
        }
        const response = type === 'firmware-info'
          ? {
            app: 'Lightweaver',
            cardId: expectedCard.id,
            firmwareVersion: expectedCard.firmwareVersion,
            buildId: expectedCard.buildId,
            ...(configured ? { projectRevision, projectFingerprint } : {}),
          }
          : type === 'status'
            ? status
            : { ok: true, saved: type === 'config' };
        setTimeout(() => emit({
          app: 'LightweaverCardBridge', version: 2, id: message.id,
          ok: true, response,
        }), 0);
      },
      location: {
        set href(value: string) {
          activeHost = new URL(value).hostname;
        },
      },
    } as unknown as Window;
    window.open = ((url?: string | URL) => {
      if (url) activeHost = new URL(String(url)).hostname;
      if (activeHost === stationHost) setTimeout(emitReady, 0);
      return fakeCardTab;
    }) as typeof window.open;

    const opened = bridge.openLocalCardPage('192.168.4.1');
    if (!opened.ok) throw new Error(`could not open setup card: ${opened.reason}`);
    const apStatus = await bridge.sendCardBridgeRequest('status', {}, { host: '192.168.4.1' });
    const correlation = handoff.acceptWifiHandoff({
      status: apStatus,
      expectedCard,
      expectedBootId: bootId,
      lastGeneration: generation - 1,
    });
    if (!correlation) throw new Error('setup AP did not produce a correlation');

    const retargeted = bridge.retargetCardBridge(stationHost, correlation, { flowId });
    if (!retargeted.ok) throw new Error(`could not retarget card: ${retargeted.reason}`);
    const hostBeforeFinal = localStorage.getItem('lw_chip_card_host');
    emitReady();

    const deadline = Date.now() + 7000;
    while (Date.now() < deadline && !cardLink.getCardLinkState().handoffStationVerified) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const linkAfterFinal = cardLink.getCardLinkState();
    const bridgeAfterFinal = bridge.getCardBridgeState();
    (window as any).__blankProductionPath = { messageTypes, flowId, replacementFlowId, correlation };

    return {
      protocol: location.protocol,
      hostBeforeFinal,
      persistedHost: localStorage.getItem('lw_chip_card_host'),
      priorIdentity: JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null'),
      linkAfterFinal,
      bridgeAfterFinal,
      ackCount: messageTypes.filter(type => type === 'wifi-handoff-ack').length,
      statusCount: messageTypes.filter(type => type === 'status').length,
    };
  });

  expect(result.protocol).toBe('https:');
  expect(result.hostBeforeFinal).toBe('192.168.4.1');
  expect(result.persistedHost).toBe('192.168.18.91');
  expect(result.priorIdentity.id).toBe('lw-aaaaaaaaaaaa');
  expect(result.ackCount).toBe(1);
  expect(result.statusCount).toBeLessThanOrEqual(8);
  expect(result.linkAfterFinal).toMatchObject({
    state: 'connected-bridge',
    handoffFlowId: 'flow-browser-wifi-123456789',
    handoffStationVerified: true,
    handoffAckSent: true,
    cardBlank: true,
  });
  expect(result.bridgeAfterFinal).toMatchObject({
    stationIdentityVerified: true,
    runtimeCommandReady: false,
    initialConfigAuthority: true,
    handoffFlowId: 'flow-browser-wifi-123456789',
  });
  await page.getByRole('button', { name: 'Continue WiFi setup', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const bridge = await import('/src/lib/cardBridge.js');
    const link = await import('/src/lib/cardLink.js');
    return {
      bridge: bridge.getCardBridgeState(),
      link: link.getCardLinkState(),
    };
  })).toMatchObject({
    bridge: { initialConfigAuthority: true, handoffFlowId: 'flow-browser-wifi-123456789' },
    link: { handoffStationVerified: true, cardBlank: true },
  });
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeEnabled();
  const beforeWizardPush = await page.evaluate(() => (window as any).__blankProductionPath.messageTypes.length);
  await page.getByRole('button', { name: 'Restore saved project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check lights', exact: true })).toBeVisible();
  const productionPath = await page.evaluate(async (start) => {
    const bridge = await import('/src/lib/cardBridge.js');
    const cardLink = await import('/src/lib/cardLink.js');
    const fixture = (window as any).__blankProductionPath;
    const types = fixture.messageTypes.slice(start);
    const recoveryCleared = sessionStorage.getItem('lw_wifi_handoff_recovery_v1') == null;
    const replacementCorrelation = {
      ...fixture.correlation,
      handoffGeneration: fixture.correlation.handoffGeneration + 1,
    };
    const replacement = bridge.retargetCardBridge(fixture.correlation.host, replacementCorrelation, {
      flowId: fixture.replacementFlowId,
    });
    const replacementState = cardLink.getCardLinkState();
    const stateBeforeStaleEnvelope = replacementState;
    cardLink.getSharedCardLink().dispatch({
      type: 'wifi-handoff-status', host: fixture.correlation.host,
      correlation: fixture.correlation, flowId: fixture.flowId,
      bridgeLifecycle: bridge.getCardBridgeState().lifecycle, readiness: {},
    });
    return {
      types,
      recoveryCleared,
      replacement,
      replacementState,
      staleEnvelopeIgnored: cardLink.getCardLinkState() === stateBeforeStaleEnvelope,
    };
  }, beforeWizardPush);
  expect(productionPath.types.filter(type => type === 'config')).toHaveLength(1);
  expect(productionPath.types).not.toContain('wiring-candidate');
  const configIndex = productionPath.types.indexOf('config');
  expect(configIndex).toBeGreaterThanOrEqual(0);
  expect(productionPath.types.slice(0, configIndex)).not.toContain('firmware-info');
  expect(productionPath.types.slice(configIndex + 1)).toContain('firmware-info');
  expect(productionPath.recoveryCleared).toBe(true);
  expect(productionPath.replacement).toMatchObject({ ok: true, state: 'retargeted' });
  expect(productionPath.replacementState).toMatchObject({
    handoffFlowId: 'flow-browser-wifi-987654321',
    handoffEnvelopeCount: 0,
    handoffAckAttempted: false,
    handoffStationVerified: false,
  });
  expect(productionPath.staleEnvelopeIgnored).toBe(true);
});

test('HTTPS Studio reload proves an ambiguous initial config without replaying either mutation', async ({ page }) => {
  await page.addInitScript(() => {
    const stationHost = '192.168.18.92';
    const expectedCard = {
      id: 'lw-cccccccccccc',
      firmwareVersion: '2.1.0',
      buildId: 'c'.repeat(40),
    };
    const appendType = (type: string) => {
      const prior = JSON.parse(sessionStorage.getItem('__reload_bridge_types') || '[]');
      prior.push(type);
      sessionStorage.setItem('__reload_bridge_types', JSON.stringify(prior));
    };
    const emit = (source: Window, data: Record<string, unknown>) => {
      const event = new Event('message');
      Object.defineProperties(event, {
        data: { value: data },
        origin: { value: `http://${stationHost}` },
        source: { value: source },
      });
      window.dispatchEvent(event);
    };
    const tab = {
      closed: false,
      focus() {},
      postMessage(message: Record<string, unknown>) {
        const type = String(message.type || '');
        appendType(type);
        if (type === 'config') {
          sessionStorage.setItem('__reload_configured', '1');
          if (sessionStorage.getItem('__reload_drop_config_response') === '1') {
            sessionStorage.setItem('__reload_drop_config_response', '0');
            return;
          }
        }
        const configured = sessionStorage.getItem('__reload_configured') === '1';
        const reportedCardId = sessionStorage.getItem('__reload_report_prior_card') === '1'
          ? 'lw-aaaaaaaaaaaa'
          : expectedCard.id;
        const response = type === 'firmware-info'
          ? {
            app: 'Lightweaver', cardId: reportedCardId,
            firmwareVersion: expectedCard.firmwareVersion, buildId: expectedCard.buildId,
            ...(configured ? {
              projectRevision: Number(sessionStorage.getItem('__reload_revision')),
              projectFingerprint: sessionStorage.getItem('__reload_fingerprint'),
            } : {}),
          }
          : type === 'status'
            ? {
              app: 'Lightweaver', provisioningContractVersion: 1,
              cardId: reportedCardId, firmwareVersion: expectedCard.firmwareVersion,
              buildId: expectedCard.buildId, bootId: 'boot-reload-blank',
              runtimePhase: configured ? 'ready' : 'factory',
              knownGoodProject: configured, commandReady: configured, outputReady: configured,
              wifi: {
                transport: 'station', transition: 'station', transitionPending: false,
                apActive: false, stationIp: stationHost, ip: stationHost,
                handoffGeneration: 21,
              },
            }
            : { ok: true, saved: type === 'config' };
        setTimeout(() => emit(tab as unknown as Window, {
          app: 'LightweaverCardBridge', version: 2, id: message.id,
          ok: true, response,
        }), 0);
      },
      location: { set href(_value: string) {} },
    };
    window.open = ((_url?: string | URL) => {
      setTimeout(() => emit(tab as unknown as Window, {
        app: 'LightweaverCardBridge', type: 'ready', version: 2, host: stationHost,
      }), 0);
      return tab as unknown as Window;
    }) as typeof window.open;
  });
  await page.route('https://led.mandalacodes.com/**', async route => {
    const requested = new URL(route.request().url());
    const upstream = await page.request.fetch(`http://localhost:9997${requested.pathname}${requested.search}`);
    await route.fulfill({ response: upstream });
  });
  await page.goto('https://led.mandalacodes.com/#screen=card&section=install', {
    waitUntil: 'domcontentloaded',
  });

  const seeded = await page.evaluate(async () => {
    const commissioning = await import('/src/lib/cardCommissioningFlow.js');
    const handoff = await import('/src/lib/cardWifiHandoff.js');
    const connection = await import('/src/lib/cardConnection.js');
    const expectedCard = {
      id: 'lw-cccccccccccc', firmwareVersion: '2.1.0', buildId: 'c'.repeat(40),
    };
    const flowId = 'flow-reload-wifi-123456789';
    const now = Date.now();
    const projectRecord = {
      id: 'reload-blank-project-record', updatedAt: now,
      project: {
        version: 3, id: 'reload-blank-project', name: 'Reload blank project',
        layout: { strips: [{ id: 'strip-1', pixelCount: 36 }], wiring: null, patchBoard: null },
        devices: { standaloneController: {} },
      },
    };
    let flow = commissioning.completeCardInstall(commissioning.beginCardCommissioning({
      source: 'web-serial', operation: 'install-current-release', strategy: 'clean-recovery',
      projectRecord, projectRevision: 31, flowId, now,
    }), {
      operation: 'install-current-release', cardId: expectedCard.id,
      firmwareVersion: expectedCard.firmwareVersion, buildId: expectedCard.buildId,
    }, { now: now + 1 });
    flow = commissioning.confirmCardSetupNetworkJoined(flow, { now: now + 2 });
    flow = commissioning.acknowledgeCommissionedCard(flow, expectedCard, { now: now + 3 }).flow;
    await commissioning.writeCardCommissioning(flow, { locks: null });
    const correlation = {
      host: '192.168.18.92', expectedCardId: expectedCard.id,
      expectedFirmwareVersion: expectedCard.firmwareVersion,
      expectedBuildId: expectedCard.buildId, expectedBootId: 'boot-reload-blank',
      handoffGeneration: 21,
    };
    connection.writeStoredCardHost(correlation.host);
    handoff.writeWifiHandoffRecovery({ correlation, flowId, ackAttempted: true });
    sessionStorage.setItem('__reload_revision', String(flow.project.revision));
    sessionStorage.setItem('__reload_fingerprint', flow.project.fingerprint);
    sessionStorage.setItem('__reload_bridge_types', '[]');
    sessionStorage.setItem('__reload_drop_config_response', '1');
    return { flowId, correlation };
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(async () => {
    const bridge = await import('/src/lib/cardBridge.js');
    const link = await import('/src/lib/cardLink.js');
    return { bridge: bridge.getCardBridgeState(), link: link.getCardLinkState() };
  })).toMatchObject({
    bridge: {
      initialConfigAuthority: true,
      handoffFlowId: seeded.flowId,
      handoffReloadRecovery: false,
      handoffReloadEnvelopeCount: 2,
    },
    link: {
      handoffFlowId: seeded.flowId,
      handoffStationVerified: true,
      handoffAckAttempted: true,
      cardBlank: true,
    },
  });
  const afterReload = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__reload_bridge_types') || '[]'));
  expect(afterReload.filter((type: string) => type === 'wifi-handoff-ack')).toHaveLength(0);
  expect(afterReload.filter((type: string) => type === 'status').length).toBeGreaterThanOrEqual(2);

  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeEnabled();
  const beforePush = afterReload.length;
  await page.getByRole('button', { name: 'Restore saved project', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const types = JSON.parse(sessionStorage.getItem('__reload_bridge_types') || '[]');
    const recovery = JSON.parse(sessionStorage.getItem('lw_wifi_handoff_recovery_v1') || 'null');
    return {
      configCount: types.filter((type: string) => type === 'config').length,
      configAttempted: recovery?.configAttempted,
    };
  })).toEqual({ configCount: 1, configAttempted: true });

  // The card applied config but its response was lost. A real Studio reload
  // may only reacquire the named popup and prove the outcome through status;
  // it must never post config or the WiFi acknowledgement a second time.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(async () => {
    const bridge = await import('/src/lib/cardBridge.js');
    const link = await import('/src/lib/cardLink.js');
    return { bridge: bridge.getCardBridgeState(), link: link.getCardLinkState() };
  })).toMatchObject({
    bridge: { runtimeCommandReady: true, initialConfigAuthority: false },
    link: { handoffStationVerified: true, cardBlank: false },
  });
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Restore saved project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check lights', exact: true })).toBeVisible();
  const pushed = await page.evaluate((start) => ({
    types: JSON.parse(sessionStorage.getItem('__reload_bridge_types') || '[]').slice(start),
    recovery: sessionStorage.getItem('lw_wifi_handoff_recovery_v1'),
  }), beforePush);
  expect(pushed.types.filter((type: string) => type === 'config')).toHaveLength(1);
  expect(pushed.types).not.toContain('wifi-handoff-ack');
  expect(pushed.types).not.toContain('wiring-candidate');
  expect(pushed.types.indexOf('config')).toBeLessThan(pushed.types.indexOf('firmware-info'));
  expect(pushed.recovery).toBeNull();

  const identityHandoff = await page.evaluate(async (host) => {
    const bridge = await import('/src/lib/cardBridge.js');
    const persisted = JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null');
    const handoffFlowId = bridge.getCardBridgeState().handoffFlowId;
    const accepted = await bridge.verifyCardBridgeIdentity(host);
    sessionStorage.setItem('__reload_report_prior_card', '1');
    let priorReason = '';
    try { await bridge.verifyCardBridgeIdentity(host); }
    catch (error) { priorReason = (error as { reason?: string })?.reason || ''; }
    return { persisted, handoffFlowId, accepted, priorReason };
  }, seeded.correlation.host);
  expect(identityHandoff.persisted.id).toBe('lw-cccccccccccc');
  expect(identityHandoff.handoffFlowId).toBe('');
  expect(identityHandoff.accepted.id).toBe('lw-cccccccccccc');
  expect(identityHandoff.priorReason).toBe('wrong-card');
});
