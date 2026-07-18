import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

async function dispatchCardLink(page, events) {
  await page.evaluate(async (nextEvents) => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    for (const event of nextEvents) link.dispatch(event);
  }, events);
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
  await expect(page.getByRole('link', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-XXXX', exact: true }).click();
  await expect(page.getByRole('link', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i })).toBeVisible();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('link', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i })).toBeVisible();
});

test('retained pre-install card identity cannot bypass the explicit WiFi handoff', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await dispatchCardLink(page, [{
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    acknowledgedAt: '2026-01-01T00:00:00.000Z',
    card: { id: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
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
  await page.getByRole('button', { name: 'Test lights', exact: true }).click();
  await page.getByRole('button', { name: 'Start 90-second light test', exact: true }).click();
  await page.getByRole('button', { name: 'No, restore working setup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up card', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeVisible();
});

test('installed check-lights progress runs a bounded marker test and restores the working look on rejection', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'test-installed');
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
  await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    link.dispatch({
      type: 'card-verified',
      via: 'bridge',
      host: link.getState().host || 'lightweaver.local',
      card: { id: 'lw-gallery-card', name: 'Gallery card' },
    });
  });

  await expect(page.getByTestId('card-detected-state')).toContainText('Gallery card');
  await expect(page.getByTestId('card-detected-state')).toContainText(/connected/i);
  await expect(page.getByTestId('card-detected-state')).not.toContainText(/has not changed|nothing changed/i);
  await expect(page.getByRole('button', { name: 'Save to card', exact: true })).toHaveClass(/primary/);
  await expect(page.getByRole('button', { name: 'Verify in workshop', exact: true })).toHaveCount(0);
});

test('ready overview offers Batch production as a low-emphasis link, not a setup step', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();
  await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    link.dispatch({
      type: 'card-verified',
      via: 'bridge',
      host: link.getState().host || 'lightweaver.local',
      card: { id: 'lw-gallery-card', name: 'Gallery card' },
    });
  });
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
    name: 'restarting',
    events: [
      { type: 'card-verified', via: 'bridge', host: 'lightweaver.local', card: { id: 'lw-gallery', name: 'Gallery card' } },
      { type: 'bridge-ping-missed', host: 'lightweaver.local' },
      { type: 'bridge-ping-missed', host: 'lightweaver.local' },
    ],
    copy: /card is restarting/i,
    action: 'Card restarting…',
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
