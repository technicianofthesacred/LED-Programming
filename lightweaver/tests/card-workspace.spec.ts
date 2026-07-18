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

async function seedCommissioningFlow(page, progress: 'wifi' | 'load-project' | 'test') {
  await page.evaluate(async requestedProgress => {
    const api = await import('/src/lib/cardCommissioningFlow.js');
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
      now: 10,
    }), installed, { now: 20 });
    if (requestedProgress === 'load-project' || requestedProgress === 'test') {
      flow = api.acknowledgeCommissionedCard(flow, {
        id: installed.cardId,
        firmwareVersion: installed.firmwareVersion,
        buildId: installed.buildId,
      }, { now: 30 }).flow;
    }
    if (requestedProgress === 'test') {
      flow = {
        ...flow,
        stage: 'check-lights',
        updatedAt: 40,
        project: { ...flow.project, pendingActivationId: 'test-activation-7' },
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

test('Card overview keeps Load project and Test as resumable commissioning steps', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'load-project');
  await page.reload({ waitUntil: 'domcontentloaded' });

  let steps = page.getByTestId('card-setup-steps').locator('li');
  await expect(steps.nth(2)).toHaveAttribute('data-step-state', 'complete');
  await expect(steps.nth(3)).toHaveAttribute('data-step-state', 'current');
  await expect(steps.nth(4)).toHaveAttribute('data-step-state', 'upcoming');
  await page.getByRole('button', { name: 'Load saved project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeVisible();

  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'test');
  await page.reload({ waitUntil: 'domcontentloaded' });
  steps = page.getByTestId('card-setup-steps').locator('li');
  await expect(steps.nth(3)).toHaveAttribute('data-step-state', 'complete');
  await expect(steps.nth(4)).toHaveAttribute('data-step-state', 'current');
  await page.getByRole('button', { name: 'Test lights', exact: true }).click();
  await expect(page).toHaveURL(/#screen=card&section=workshop$/);
});

test('Card replaces the setup rail destinations and exposes ordinary section navigation', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Card', exact: true }).click();

  await expect(page).toHaveURL(/#screen=card&section=overview$/);
  const sections = page.getByRole('navigation', { name: 'Card sections' });
  await expect(sections).toBeVisible();
  for (const label of ['Install or update', 'Card settings', 'Workshop setup', 'Advanced & Support']) {
    await expect(sections.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
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

  for (const label of ['Card', 'Install or update', 'Card settings', 'Workshop setup', 'Advanced & Support', 'Preferences']) {
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
  await expect(steps.locator('.card-setup-label')).toHaveText(['Connect', 'Install', 'WiFi', 'Load project', 'Test']);
  await expect(page.getByRole('button', { name: 'Connect card', exact: true })).toHaveClass(/primary/);
});

test('connected Card overview identifies the card and makes Load changes primary', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'Load changes', exact: true })).toHaveClass(/primary/);
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
  { hash: '#screen=production&job=moon-batch-7', section: 'Workshop setup', heading: 'Workshop setup' },
  { hash: '#screen=settings', section: 'Preferences', heading: 'Preferences' },
]) {
  test(`legacy ${legacy.hash} stays intact and opens ${legacy.section}`, async ({ page }) => {
    await page.goto(`/${legacy.hash}`, { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(new RegExp(`${legacy.hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await expect(page.locator('.rail-item.active')).toHaveAccessibleName('Card');
    await expect(page.getByRole('navigation', { name: 'Card sections' }).getByRole('button', { name: legacy.section, exact: true })).toHaveAttribute('aria-current', 'page');
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
  await expect(page.getByRole('heading', { name: 'Workshop setup', level: 1 })).toBeVisible();
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

  for (const label of ['Technician firmware & logs', 'GPIO & install guide', 'Designer JSON', 'Recovery']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.locator('details')).toHaveCount(0);
  await page.getByRole('button', { name: 'Technician firmware & logs' }).click();
  await expect(page.getByRole('heading', { name: 'Manual firmware tools' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Flash firmware' })).toBeVisible();
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
  await page.getByRole('navigation', { name: 'Card sections' }).getByRole('button', { name: 'Install or update' }).click();
  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: true } })));
  await page.goBack();

  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toHaveCount(0);
});
