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
    const link = getSharedCardLink();
    const priorBootId = link.getState().validatedBootId;
    link.dispatch(linkEvent);
    // A trusted-card fixture represents the two matching full status reads
    // required after a miss or lifecycle transition. A changed boot remains
    // at its first envelope so restart/revalidation behavior stays observable.
    if (linkEvent.type === 'card-verified' && linkEvent.readiness?.bootId
      && (!priorBootId || priorBootId === linkEvent.readiness.bootId)) link.dispatch(linkEvent);
  }, event);
}

function readyStatus(cardId: string, overrides = {}) {
  return {
    app: 'Lightweaver', provisioningContractVersion: 1,
    cardId, firmwareVersion: '1.4.0', buildId: 'a'.repeat(40),
    bootId: 'boot-quality-1', runtimePhase: 'ready', knownGoodProject: true,
    commandReady: true, outputReady: true,
    ...overrides,
  };
}

function finalStationStatus(cardId: string, overrides = {}) {
  return readyStatus(cardId, {
    wifi: {
      transport: 'station', transition: 'station', transitionPending: false,
      stationIp: '192.168.18.90', ip: '192.168.18.90', handoffGeneration: 7,
    },
    ...overrides,
  });
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
    (window as any).__openedWindows = [];
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      (window as any).__openedUrls.push(String(url || ''));
      (window as any).__openedWindows.push({ url: String(url || ''), target, features });
      return { closed: false, postMessage() {}, close() {}, focus() {} } as Window;
    }) as typeof window.open;
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
}

function actionRegion(page) {
  return page.locator('.card-connection-action');
}

async function activeCommissioning(page) {
  return page.evaluate(() => {
    const registry = JSON.parse(localStorage.getItem('lw_card_commissioning_registry_v2') || '{"flows":{}}');
    const flowId = sessionStorage.getItem('lw_card_commissioning_active_v2') || '';
    return registry.flows?.[flowId]?.flow || null;
  });
}

async function deliverBridgeResult(page, overrides: Record<string, unknown> = {}) {
  // The launch click persists the project (library record + lifecycle record +
  // commissioning registry) BEFORE the pending-launch record is written, so on
  // slow runners the key may not exist the instant the click resolves. Wait for
  // it instead of sampling once — the launch is already in flight.
  await page.waitForFunction(
    () => Object.keys(localStorage).some(key => key.startsWith('lightweaver.bridge.pending.v1.')),
    undefined,
    { timeout: 8000 },
  );
  await page.evaluate(extra => {
    return (async () => {
      const pendingKey = Object.keys(localStorage).find(key => key.startsWith('lightweaver.bridge.pending.v1.'));
      if (!pendingKey) throw new Error('No pending Bridge launch');
      const pending = JSON.parse(localStorage.getItem(pendingKey) || '{}');
      const values = {
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
      const receipt = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
      const params = new URLSearchParams([
        ['status', String(values.status)], ['code', String(values.code)],
        ['cardId', String(values.cardId)], ['firmwareVersion', String(values.firmwareVersion)],
        ['buildId', String(values.buildId)], ['target', String(values.target)],
        ['verification', String(values.verification)], ['physicalOutput', String(values.physicalOutput)],
        ['nonce', pending.nonce], ['receipt', receipt], ['version', '1'],
      ]);
      const { consumeBridgeCallback } = await import('/src/lib/bridgeProtocol.js');
      const { createBridgeResultChannel } = await import('/src/lib/bridgeLaunch.js');
      const result = await consumeBridgeCallback(`https://led.mandalacodes.com/#bridge-result?${params.toString()}`, {
        currentOrigin: 'https://led.mandalacodes.com',
        history: { replaceState() {} },
      });
      const producer = createBridgeResultChannel();
      try { await producer.publish(result); }
      finally { producer.close(); }
    })();
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
    card: { id: 'lw-quality', name: 'Gallery card', pixelCount: 440, firmwareVersion: '1.4.0', buildId: 'a'.repeat(40) },
    readiness: readyStatus('lw-quality'),
  });
  await expect(announcement).toHaveText('Connected');
  await expect(announcement).not.toContainText(/Gallery card|440 pixels|firmware/i);
});

test('normalizes a bare local card name before validation and storage', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('lw_chip_card_host', '192.168.4.1'));
  await page.getByTestId('card-link-status').click();
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
    card: { id: 'lw-quality', name: 'Gallery card', pixelCount: 440, firmwareVersion: '1.4.0', buildId: 'a'.repeat(40) },
    readiness: readyStatus('lw-quality'),
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
  await expect(escape).toHaveAttribute('target', 'lightweaver-studio');

  // Serve the canonical installer origin from a hermetic stub so the
  // navigation commits regardless of external network availability — the
  // assertion is about WHERE the escape goes, not the live site.
  await context.route('https://led.mandalacodes.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Lightweaver installer</title>',
  }));
  const opened = context.waitForEvent('page');
  await escape.click();
  const installer = await opened;
  await expect.poll(() => installer.url()).toBe('https://led.mandalacodes.com/#screen=flash&mode=install');
  await installer.close();
});

test('desktop Bridge launch persists the project and commissioning flow without inferring failure from elapsed time', async ({ page, context }) => {
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
  await expect.poll(async () => (await activeCommissioning(page))?.stage).toBe('install-safely');
  const urls = await page.evaluate(() => (window as any).__lwBridgeUrls);
  expect(urls).toHaveLength(1);
  expect(urls[0]).toMatch(/^lightweaver:\/\/run\?operation=install-current-release&nonce=[A-Za-z0-9_-]{43}&version=1$/);
  await page.waitForTimeout(4100);
  await expect(actionRegion(page)).toHaveAttribute('data-action-id', 'launch-native-bridge');
  await expect(actionRegion(page)).toContainText('Waiting for Lightweaver Bridge');

  const peer = await context.newPage();
  await peer.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  const writeRace = target => target.evaluate(async () => {
    const { beginCardCommissioning, writeCardCommissioning } = await import('/src/lib/cardCommissioningFlow.js');
    const suffix = window.name || (window.name = crypto.randomUUID().replaceAll('-', '').slice(0, 16));
    const flowId = `flow-race-${suffix}`;
    const flow = (await import('/src/lib/cardCommissioningFlow.js')).readCardCommissioning({ flowId }) || beginCardCommissioning({
      source: 'web-serial', operation: 'install-current-release', projectRevision: 1,
      flowId,
      projectRecord: { id: `record-${suffix}`, updatedAt: Date.now(), project: { version: 3, id: `project-${suffix}`, name: 'Race', layout: { strips: [], patchBoard: null, wiring: null }, devices: { standaloneController: {} } } },
    });
    return writeCardCommissioning(flow, { locks: null });
  });
  for (let iteration = 0; iteration < 10; iteration += 1) {
    await Promise.all([writeRace(page), writeRace(peer)]);
  }
  const raceFlows = await page.evaluate(() => {
    const registry = JSON.parse(localStorage.getItem('lw_card_commissioning_registry_v2') || '{"flows":{}}');
    return Object.keys(registry.flows).filter(id => id.startsWith('flow-race-'));
  });
  expect(raceFlows).toHaveLength(2);
  for (const mode of ['canonical', 'staged']) {
    const flowId = await page.evaluate(async completionMode => {
      const api = await import('/src/lib/cardCommissioningFlow.js');
      const id = `flow-real-stale-${completionMode}`;
      const projectRecord = { id: `record-${completionMode}`, updatedAt: Date.now(), project: { version: 3, id: `project-${completionMode}`, name: 'Stale', layout: { strips: [], patchBoard: null, wiring: null }, devices: { standaloneController: {} } } };
      let flow = api.beginCardCommissioning({ source: 'web-serial', operation: 'install-current-release', projectRevision: 1, flowId: id, projectRecord });
      flow = api.completeCardInstall(flow, { cardId: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) });
      flow = api.acknowledgeCommissionedCard(flow, { id: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) }).flow;
      await api.writeCardCommissioning(flow, { locks: null });
      return id;
    }, mode);
    const stale = await peer.evaluate(async id => {
      const { readCardCommissioning } = await import('/src/lib/cardCommissioningFlow.js');
      return readCardCommissioning({ flowId: id });
    }, flowId);
    await page.evaluate(async ({ id, completionMode }) => {
      const api = await import('/src/lib/cardCommissioningFlow.js');
      const current = api.readCardCommissioning({ flowId: id });
      let completed;
      if (completionMode === 'canonical') {
        const evidence = api.adaptCardRestorationReadback({ method: 'GET', endpoint: '/api/firmware-info', response: { cardId: current.expectedCard.id, firmwareVersion: current.expectedCard.firmwareVersion, buildId: current.expectedCard.buildId, projectRevision: current.project.revision, projectFingerprint: current.project.fingerprint, productionJobDigest: '' } });
        completed = api.markCardProjectRestored(current, evidence);
      } else {
        const wiring = await import('/src/lib/cardWiringSafety.js');
        const status = wiring.normalizeCardWiringStatus({ ok: true, state: 'staged', activationId: 'candidate-real-stale', outputs: [] });
        const candidate = await wiring.getCardWiringStatus({ transport: 'bridge', bridgeRequestImpl: async () => ({ ok: true, state: 'staged', activationId: 'candidate-real-stale', outputs: [], cardId: current.expectedCard.id, firmwareVersion: current.expectedCard.firmwareVersion, buildId: current.expectedCard.buildId, projectRevision: current.project.revision, projectFingerprint: current.project.fingerprint }) });
        completed = api.stageCardProjectForPhysicalCheck(current, api.bindCardWiringActivationEvidence(status, candidate));
      }
      await api.writeCardCommissioning(completed, { locks: null });
    }, { id: flowId, completionMode: mode });
    const staleResult = await peer.evaluate(async staleFlow => {
      const { claimCardRestoration } = await import('/src/lib/cardCommissioningFlow.js');
      return claimCardRestoration(staleFlow, { locks: null });
    }, stale);
    expect(staleResult).toEqual({ ok: false, reason: 'stale-flow' });
  }
  await peer.close();
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

test('Bridge return does not call a successful POST independent restoration proof', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
    (window as any).__LW_BRIDGE_NAVIGATE_FOR_TEST__ = () => {};
    (window as any).__commissioningPushes = [];
    (window as any).__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__ = async (runtimePackage: unknown, options: unknown) => {
      (window as any).__commissioningPushes.push({ runtimePackage, options });
      return { ok: true, saved: true };
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();
  await page.getByRole('button', { name: 'Open Lightweaver Bridge' }).click();

  await deliverBridgeResult(page);
  await expect(page.getByRole('heading', { name: 'Set up card' })).toBeVisible();
  for (const label of ['Connect card', 'Install safely', 'Set up card', 'Check lights']) {
    await expect(page.getByRole('listitem').filter({ hasText: label })).toBeVisible();
  }
  await page.waitForTimeout(4100);
  await expect(page.getByRole('heading', { name: 'Set up card' })).toBeVisible();
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-XXXX', exact: true }).click();

  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    card: { id: 'lw-222222222222', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
    readiness: readyStatus('lw-222222222222', { firmwareVersion: '1.2.3' }),
  });
  await expect(page.getByRole('dialog')).toContainText(/expected lw-441bf681feb0, but lw-222222222222 answered/i);

  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    card: { id: 'lw-441bf681feb0', firmwareVersion: '1.2.2', buildId: 'a'.repeat(40) },
    readiness: readyStatus('lw-441bf681feb0', { firmwareVersion: '1.2.2' }),
  });
  await expect(page.getByRole('dialog')).toContainText(/expected firmware 1.2.3/i);

  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
    card: { id: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'b'.repeat(40) },
    readiness: readyStatus('lw-441bf681feb0', { firmwareVersion: '1.2.3', buildId: 'b'.repeat(40) }),
  });
  await expect(page.getByRole('dialog')).toContainText(/build does not match/i);

  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'direct', host: 'lightweaver.local',
    card: { id: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
    readiness: finalStationStatus('lw-441bf681feb0', { firmwareVersion: '1.2.3' }),
  });
  await expect(page.getByRole('button', { name: 'Restore saved project' })).toBeVisible();
  await page.route('**/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(finalStationStatus('lw-441bf681feb0', { firmwareVersion: '1.2.3' })),
  }));
  await page.getByRole('button', { name: 'Restore saved project' }).click();
  await expect(page.getByRole('heading', { name: 'Set up card' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__commissioningPushes.length)).toBe(1);
  await expect(page.getByRole('alert')).toContainText(/independent.*(?:read-back|firmware and project evidence)|not marked.*restored/i);
  const pushedIdentity = await page.evaluate(() => {
    const config = (window as any).__commissioningPushes[0].runtimePackage.config;
    return {
      projectRevision: config.projectRevision,
      projectFingerprint: config.projectFingerprint,
      productionJobId: config.productionJobId,
      productionJobDigest: config.productionJobDigest,
    };
  });
  const active = await activeCommissioning(page);
  expect(pushedIdentity).toEqual({
    projectRevision: active?.project?.revision,
    projectFingerprint: active?.project?.fingerprint,
    productionJobId: undefined,
    productionJobDigest: undefined,
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('lw_card_identity_v1', JSON.stringify({
    version: 1, id: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40),
  })));
  await page.getByTestId('card-link-status').click();
  await expect.poll(() => page.evaluate(() => (window as any).__commissioningPushes.length)).toBe(0);
  await expect(page.getByRole('heading', { name: 'Set up card' })).toBeVisible();
  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'direct', host: 'lightweaver.local',
    card: { id: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
    readiness: finalStationStatus('lw-441bf681feb0', { firmwareVersion: '1.2.3' }),
  });
  await page.evaluate(() => {
    (window as any).__LW_READ_COMMISSIONING_EVIDENCE_FOR_TEST__ = async () => {
      const registry = JSON.parse(localStorage.getItem('lw_card_commissioning_registry_v2') || '{"flows":{}}');
      const flowId = sessionStorage.getItem('lw_card_commissioning_active_v2') || '';
      const flow = registry.flows?.[flowId]?.flow;
      return { cardId: flow.expectedCard.id, firmwareVersion: flow.expectedCard.firmwareVersion, buildId: flow.expectedCard.buildId, projectRevision: flow.project.revision, projectFingerprint: flow.project.fingerprint, productionJobDigest: flow.project.productionJobDigest };
    };
  });
  await page.getByRole('button', { name: 'Restore saved project' }).click();
  await expect(page.getByRole('heading', { name: 'Check lights' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__commissioningPushes.length)).toBe(0);
});

test('a staged GPIO restoration stops at the Check lights handoff without legacy full-white output', async ({ page }) => {
  await page.route('http://lightweaver.local/api/wiring/status', async route => {
    const flow = await activeCommissioning(page);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      app: 'Lightweaver', ok: true, state: 'staged', activationId: 'candidate-safe-7', outputs: [{ pin: 18, pixels: 44 }],
      cardId: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40),
      projectRevision: flow?.project?.revision, projectFingerprint: flow?.project?.fingerprint,
      wiringRevision: 2, wiringDigest: 'd'.repeat(64), maxMilliamps: 1500,
    }) });
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
    (window as any).__LW_BRIDGE_NAVIGATE_FOR_TEST__ = () => {};
    (window as any).__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__ = async () => {
      const { normalizeCardWiringStatus } = await import('/src/lib/cardWiringSafety.js');
      return normalizeCardWiringStatus({
        state: 'staged',
        activationId: 'candidate-safe-7',
        currentOutputs: [{ pin: 18, pixels: 44 }],
      });
    };
    (window as any).__LW_READ_COMMISSIONING_EVIDENCE_FOR_TEST__ = async () => {
      throw new Error('The fresh card returned an invalid project fingerprint');
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connect Lightweaver' }).click();
  await page.getByRole('button', { name: 'Blank or not responding' }).click();
  await page.getByRole('button', { name: 'Open Lightweaver Bridge' }).click();
  await deliverBridgeResult(page);
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-XXXX', exact: true }).click();
  await dispatchCardLinkEvent(page, {
    type: 'card-verified', via: 'direct', host: 'lightweaver.local',
    card: { id: 'lw-441bf681feb0', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
    readiness: finalStationStatus('lw-441bf681feb0', { firmwareVersion: '1.2.3' }),
  });
  await page.route('**/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(finalStationStatus('lw-441bf681feb0', { firmwareVersion: '1.2.3' })),
  }));
  await page.getByRole('button', { name: 'Restore saved project' }).click();
  await expect(page.getByRole('heading', { name: 'Check lights' })).toBeVisible();
  await expect(page.getByText(/staged on this exact card/i)).toBeVisible();
  await expect(page.getByText(/test its GPIO wiring before making it permanent/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Run light check|warm white/i })).toHaveCount(0);
  await expect.poll(async () => (await activeCommissioning(page))?.project?.pendingActivationId).toBe('candidate-safe-7');
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
  await expect.poll(() => page.evaluate(() => (window as any).__openedWindows[0])).toMatchObject({
    target: 'lightweaver-card-bridge',
  });
  expect(await page.evaluate(() => (window as any).__openedWindows[0]?.features || '')).not.toContain('noopener');
});
