import { test, expect } from '@playwright/test';
import { testPort } from './testPort.mjs';

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

async function renderProjectSwitchCardHarness(page, mode: 'offline' | 'duplicate' | 'cloud' | 'cloud-late' | 'cloud-stale' | 'changed' | 'browser-fresh' | 'browser-deleted' | 'association' | 'association-failure' | 'post-read-failure') {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (scenario) => {
    const mainSource = await (await fetch('/src/main.jsx')).text();
    const domUrl = mainSource.match(/["']([^"']*react-dom_client[^"']*)["']/)?.[1];
    const cardSource = await (await fetch('/src/v3/lw-card.jsx')).text();
    const reactUrl = cardSource.match(/["']([^"']*\/deps\/react\.js[^"']*)["']/)?.[1];
    if (!domUrl || !reactUrl) throw new Error('could not resolve React module URLs');
    const [{ CardScreen }, { createDefaultProject }, resolver, reactModule, domModule] = await Promise.all([
      import('/src/v3/lw-card.jsx'),
      import('/src/lib/projectModel.js'),
      import('/src/lib/cardProjectResolver.js'),
      import(reactUrl),
      import(domUrl),
    ]);
    const React = reactModule.default ?? reactModule;
    const createRoot = domModule.createRoot ?? domModule.default?.createRoot;
    if (typeof createRoot !== 'function') throw new Error('could not resolve createRoot');
    const cloudScenario = scenario === 'cloud' || scenario === 'cloud-late' || scenario === 'cloud-stale';

    const current = createDefaultProject();
    current.id = 'current-work-in-progress';
    current.name = 'Work in progress';
    current.layout.starterPending = false;
    const installed = createDefaultProject();
    installed.id = cloudScenario ? 'cloud-installed-project' : 'browser-installed-project';
    installed.name = cloudScenario ? 'Cloud installed project' : 'Browser installed project';
    installed.layout.starterPending = false;
    const fingerprint = resolver.cardProjectFingerprint(installed);
    const status = {
      app: 'Lightweaver', provisioningContractVersion: 1,
      cardId: 'lw-project-switch-harness', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
      bootId: 'boot-harness', runtimePhase: 'ready', knownGoodProject: true,
      commandReady: true, outputReady: true,
      // The firmware reports the installed project on /api/status as well as
      // /api/firmware-info. Studio binds pattern authorization to the status
      // value, because that is the payload the Patterns screen can see.
      projectId: installed.id,
    };
    const evidence = {
      ...status,
      projectId: installed.id,
      projectRevision: 23,
      projectFingerprint: fingerprint,
      piece: { id: installed.id, name: installed.name },
    };
    let releasePostReplaceRead;
    let releaseInitialEvidence;
    let initialEvidenceHeld = false;
    let shouldHoldInitialEvidence = scenario === 'cloud-late';
    const calls = { save: 0, replace: 0, open: 0, association: 0, associationMarker: null, openOptions: null };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'http://lightweaver.local/api/status') {
        if (scenario === 'post-read-failure' && calls.replace > 0) {
          return new Response(JSON.stringify({
            ...status,
            runtimePhase: 'recovery',
            knownGoodProject: false,
            commandReady: false,
            outputReady: false,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (scenario === 'association' && calls.replace > 0) {
          return new Promise(resolve => {
            releasePostReplaceRead = () => resolve(new Response(JSON.stringify(status), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }));
          });
        }
        return new Response(JSON.stringify(status), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === 'http://lightweaver.local/api/firmware-info') {
        if (shouldHoldInitialEvidence) {
          shouldHoldInitialEvidence = false;
          initialEvidenceHeld = true;
          return new Promise(resolve => {
            releaseInitialEvidence = () => resolve(new Response(JSON.stringify(evidence), {
              status: 200, headers: { 'Content-Type': 'application/json' },
            }));
          });
        }
        return new Response(JSON.stringify(evidence), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(input, init);
    };

    let releaseSave;
    const savedSnapshot = {
      project: current,
      marker: { generation: 7, revision: 4 },
      remoteId: cloudScenario ? 'remote-current' : '',
    };
    const saveBeforeCardProjectSwitch = () => {
      calls.save += 1;
      if (scenario === 'offline') return Promise.resolve({ ok: false, reason: 'offline' });
      if (scenario === 'duplicate') {
        return new Promise(resolve => { releaseSave = () => resolve({ ok: true, destination: 'browser', snapshot: savedSnapshot }); });
      }
      return Promise.resolve({
        ok: true,
        destination: cloudScenario ? 'cloud' : 'browser',
        snapshot: savedSnapshot,
      });
    };
    const openMatchingCardProject = async (_remoteId, _evidence, options) => {
      calls.open += 1;
      calls.openOptions = {
        expectedRevision: options?.expectedRevision,
        currentProjectSaved: options?.currentProjectSaved,
        beforeMutation: typeof options?.beforeMutation,
      };
      await options?.beforeMutation?.();
      if (scenario === 'cloud-stale') {
        calls.replace += 1;
        return { ok: false, reason: 'stale-session', replacementCommitted: true };
      }
      return { ok: true };
    };
    const host = document.createElement('div');
    host.dataset.testid = `project-switch-${scenario}`;
    document.body.appendChild(host);
    const root = createRoot(host);
    const cardLink = {
      state: 'connected-direct', transport: 'direct', host: 'lightweaver.local',
      card: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
      expectedCard: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
      readiness: status, validatedBootId: status.bootId,
      operationGeneration: 0, revalidationGeneration: 0,
    };
    const cloudRecord = {
      id: 'remote-installed', revision: 23, embeddedProjectId: installed.id,
      title: installed.name, document: installed,
    };
    const cardProps = {
      connected: true,
      cardHost: 'lightweaver.local',
      cardLink,
      onConnectCard: () => {},
      onOpenSection: () => {},
      replaceProject: async () => {
        calls.replace += 1;
        return { ok: true, marker: { generation: 8, revision: 0 } };
      },
      currentProject: current,
      projectGeneration: 7,
      activeCloudProjects: cloudScenario && scenario !== 'cloud-late' ? [cloudRecord] : [],
      browserProjects: cloudScenario || scenario === 'browser-fresh' ? [] : [{ id: 'browser-installed', project: installed }],
      readBrowserProjects: () => cloudScenario || (scenario === 'browser-deleted' && calls.save > 0)
        ? []
        : [{ id: 'browser-installed', project: installed }],
      readCloudProject: async () => cloudRecord,
      openMatchingCardProject,
      saveBeforeCardProjectSwitch,
      isProjectSwitchSnapshotCurrent: () => scenario !== 'changed',
      onMatchedProjectLoaded: input => {
        calls.association += 1;
        calls.associationMarker = input?.expectedMarker || null;
        return scenario === 'association-failure'
          ? { ok: false, reason: 'association-handoff-failed' }
          : { ok: true };
      },
      route: { section: 'overview', supportTool: '' },
    };
    root.render(React.createElement(CardScreen, cardProps));
    (window as any).__projectSwitchHarness = {
      calls,
      releaseSave: () => releaseSave?.(),
      releasePostReplaceRead: () => releasePostReplaceRead?.(),
      initialEvidenceHeld: () => initialEvidenceHeld,
      releaseInitialEvidence: () => releaseInitialEvidence?.(),
      releaseCloudCandidates: () => root.render(React.createElement(CardScreen, {
        ...cardProps,
        activeCloudProjects: [cloudRecord],
      })),
      host,
    };
  }, mode);

  const region = page.locator(`[data-testid="project-switch-${mode}"]`).getByRole('region', { name: 'Matching card project' });
  if (mode === 'cloud-late') {
    await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.initialEvidenceHeld())).toBe(true);
    await page.evaluate(() => (window as any).__projectSwitchHarness.releaseCloudCandidates());
    await page.evaluate(() => (window as any).__projectSwitchHarness.releaseInitialEvidence());
  }
  await expect(region.getByRole('button', { name: /^Load / })).toBeVisible();
  return region;
}

async function seedCommissioningFlow(
  page,
  progress: 'wifi' | 'load-project' | 'test' | 'test-installed' | 'test-legacy',
  // What Studio observed on the USB serial port as the card rebooted after the
  // flash. Omitted = no observation recorded (the pre-detection behaviour).
  postFlashNetwork: { state: string; stationIp?: string } | null = null,
  // How long ago the flow was stamped. The setup-hotspot wait is measured from
  // that stamp, so ageing the flow is how a test reaches the later phases of it
  // without sitting through a real minute.
  ageMs = 0,
) {
  await page.evaluate(async ([requestedProgress, observedNetwork, age]: any) => {
    const api = await import('/src/lib/cardCommissioningFlow.js');
    const startedAt = Date.now() - Number(age || 0);
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
    }), observedNetwork ? { ...installed, postFlashNetwork: observedNetwork } : installed, { now: startedAt + 1 });
    if (requestedProgress === 'load-project' || requestedProgress === 'test' || requestedProgress === 'test-installed' || requestedProgress === 'test-legacy') {
      flow = api.acknowledgeCommissionedCard(flow, {
        id: installed.cardId,
        firmwareVersion: installed.firmwareVersion,
        buildId: installed.buildId,
      }, { now: startedAt + 2 }).flow;
    }
    if (requestedProgress === 'test' || requestedProgress === 'test-installed' || requestedProgress === 'test-legacy') {
      const pendingWiring = {
        wiringRevision: 9,
        wiringDigest: 'd'.repeat(64),
        ledType: 'WS2815',
        colorOrder: 'RGB',
        maxMilliamps: 2400,
        outputs: [{
          id: 'out1', pin: 16, pixels: 44,
          segments: [{ id: 'strip-1', count: 44, direction: 'forward' }],
        }],
      };
      flow = {
        ...flow,
        stage: 'check-lights',
        updatedAt: startedAt + 3,
        project: requestedProgress === 'test' || requestedProgress === 'test-legacy'
          ? { ...flow.project, pendingActivationId: 'test-activation-7', pendingWiring }
          : { ...flow.project, restoredAt: startedAt + 3, restoredFingerprint: flow.project.fingerprint },
      };
    }
    await api.writeCardCommissioning(flow, { locks: null });
    if (requestedProgress === 'test-legacy') {
      const registry = JSON.parse(localStorage.getItem(api.CARD_COMMISSIONING_STORAGE_KEY));
      const saved = registry.flows[flow.flowId].flow;
      delete saved.project.generation;
      delete saved.project.pendingWiring;
      localStorage.setItem(api.CARD_COMMISSIONING_STORAGE_KEY, JSON.stringify(registry));
    }
  }, [progress, postFlashNetwork, ageMs] as any);
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

test('wide desktop footer keeps card, firmware, Studio, and test controls in order', async ({ page }) => {
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
  await expect(page.locator('.card-status-summary')).toHaveCount(0);

  const regions = await page.locator('.status-bar').evaluate(node => {
    const rect = selector => node.querySelector(selector)?.getBoundingClientRect();
    return {
      card: rect('.sb-card'),
      firmware: rect('.sb-firmware'),
      studio: rect('.sb-freshness'),
      test: rect('.sb-teststrip'),
      control: rect('.card-status-control'),
      copy: rect('.card-status-copy'),
      name: rect('.card-status-name'),
      state: rect('.card-status-state'),
    };
  });
  expect(regions.card.right).toBeLessThanOrEqual(regions.firmware.left);
  expect(regions.firmware.right).toBeLessThanOrEqual(regions.studio.left);
  expect(regions.studio.right).toBeLessThanOrEqual(regions.test.left);
  expect(regions.control.right).toBeLessThanOrEqual(regions.card.right);
  expect(regions.name.right).toBeLessThanOrEqual(regions.state.left);
  expect(regions.copy.right).toBeLessThanOrEqual(regions.control.right);
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

  await expect(page.getByTestId('card-setup-steps')).toHaveCount(0);
  await expect(page.getByTestId('card-setup-diagnosis')).toContainText('Finish connecting this card to Wi-Fi.');
  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(page).toHaveURL(/#screen=card&section=setup&task=configure-wifi$/);

  // The preserving installer remains the execution surface. The overview now
  // proves that every entrance resolves through the same exact Setup task first.
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'I’ve joined Lightweaver-EEFF', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-EEFF', exact: true }).click();
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

test('WiFi setup names the card’s real hotspot instead of a placeholder suffix', async ({ page }) => {
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi');
  await page.reload({ waitUntil: 'domcontentloaded' });

  // The seeded card id is lw-aabbccddeeff. The firmware builds its AP SSID from
  // the low 16 bits of the same eFuse MAC, so the real network is
  // Lightweaver-EEFF — never the literal "Lightweaver-XXXX".
  const commissioning = page.locator('.card-commissioning');
  await expect(commissioning).toContainText('Lightweaver-EEFF');
  await expect(commissioning).not.toContainText('Lightweaver-XXXX');

  await page.getByRole('button', { name: 'I’ve joined Lightweaver-EEFF', exact: true }).click();
  await expect(commissioning).toContainText('Lightweaver-EEFF joined.');
  await expect(commissioning).not.toContainText('Lightweaver-XXXX');
});

test('a card that kept its WiFi through the flash never shows the hotspot step', async ({ page }) => {
  // The reported bug: flashing over USB does not always clear NVS, so the card's
  // saved credentials survive, it boots straight onto the LAN, and it never
  // raises a setup hotspot. Studio used to assert AP mode anyway and send the
  // owner to 192.168.4.1, which can never answer.
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi', { state: 'station', stationIp: '192.168.18.70' });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const commissioning = page.locator('.card-commissioning');
  await expect(commissioning.locator('[data-post-flash="station"]')).toBeVisible();
  await expect(commissioning).toContainText('192.168.18.70');
  await expect(page.getByRole('button', { name: /Open the card at 192\.168\.18\.70/ })).toBeVisible();

  // None of the hotspot instructions may appear: there is no hotspot.
  await expect(page.getByRole('button', { name: /I.ve joined Lightweaver-EEFF/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i })).toHaveCount(0);
  await expect(commissioning).not.toContainText('The clean installation reset Wi-Fi');

  // The owner keeps an escape if their eyes disagree with the serial evidence.
  await page.getByRole('button', { name: /No . the card is showing Lightweaver-EEFF/ }).click();
  await expect(page.getByRole('button', { name: 'I\u2019ve joined Lightweaver-EEFF', exact: true })).toBeVisible();
});

test('a genuinely factory-blank card still gets the unchanged hotspot step', async ({ page }) => {
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi', { state: 'setup-ap' });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const commissioning = page.locator('.card-commissioning');
  await expect(commissioning).toContainText('The clean installation reset Wi-Fi');
  await expect(page.getByRole('button', { name: 'I\u2019ve joined Lightweaver-EEFF', exact: true })).toBeVisible();
  // No station claim and no "we could not tell" hedging on a card Studio watched
  // come up as a hotspot.
  await expect(commissioning.locator('[data-post-flash="station"]')).toHaveCount(0);
  await expect(commissioning.locator('[data-post-flash="inconclusive"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'I\u2019ve joined Lightweaver-EEFF', exact: true }).click();
  await expect(page.getByRole('button', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i })).toBeVisible();
});

// The reported confusion: told to join Lightweaver-EEFF, the owner opens Wi-Fi
// settings, the network is not listed yet, and nothing on screen says that is
// normal. Studio now states which phase of the wait it is in and counts down.
test('the setup hotspot step says the network takes a moment, then escalates', async ({ page }) => {
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi', { state: 'setup-ap' });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const wait = page.getByTestId('setup-hotspot-wait');
  await expect(wait).toBeVisible();
  await expect(page.locator('[data-hotspot-wait="appearing"]')).toBeVisible();
  await expect(wait).toContainText('may not be in this device\u2019s Wi-Fi list yet');
  // Nothing that reads as a fault while the card is still perfectly healthy.
  await expect(page.getByTestId('setup-hotspot-no-network')).toHaveCount(0);

  // The countdown is live, not a number printed once at mount.
  const firstReading = await wait.innerText();
  await expect.poll(() => wait.innerText(), { timeout: 4000 }).not.toBe(firstReading);
});

// Two scan cycles after the card started broadcasting, every device that was
// going to notice on its own has had its chance. Studio stops asking for
// patience and names the two things that actually cause a missing network.
test('a setup hotspot that never appears stops asking the owner to wait', async ({ page }) => {
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi', { state: 'setup-ap' }, 90_000);
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.locator('[data-hotspot-wait="overdue"]')).toBeVisible();
  const wait = page.getByTestId('setup-hotspot-wait');
  await expect(wait).toContainText('Wi-Fi off and back on');
  await expect(wait).toContainText('already on your network');
  await expect(wait).not.toContainText('more seconds');
  await expect(page.getByTestId('setup-hotspot-no-network')).toBeVisible();
});

test('an inconclusive post-flash observation offers both routes instead of asserting one', async ({ page }) => {
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi', { state: 'inconclusive' });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const commissioning = page.locator('.card-commissioning');
  await expect(commissioning.locator('[data-post-flash="inconclusive"]')).toBeVisible();
  await expect(commissioning).toContainText('could not confirm how this card came back up');
  // Both paths, side by side, with no claim about which one is true.
  await expect(page.getByRole('button', { name: 'The card is already on my Wi-Fi', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'I\u2019ve joined Lightweaver-EEFF', exact: true })).toBeVisible();
  await expect(commissioning.locator('[data-post-flash="station"]')).toHaveCount(0);
});

test('an opened setup tab that never reaches the card explains why instead of spinning silently', async ({ page }) => {
  await page.addInitScript(() => {
    // Keep the bounded reachability watch inside the Playwright test budget.
    (window as any).__LW_SETUP_REACH_TIMEOUT_MS_FOR_TEST__ = 1200;
    window.open = ((url?: string | URL, target?: string) => (
      { closed: false, postMessage() {}, focus() {}, location: { href: String(url || '') } } as unknown as Window
    )) as typeof window.open;
  });
  // The card never answers: this is the reported symptom — the tab opens, the
  // owner is on the wrong network, and 192.168.4.1 stays unreachable forever.
  await page.route('**://192.168.4.1/**', route => route.abort());
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'wifi');
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'I’ve joined Lightweaver-EEFF', exact: true }).click();
  await page.getByRole('button', { name: /Open 192\.168\.4\.1 Wi-Fi setup/i }).click();

  const alert = page.locator('.card-commissioning [role="alert"]').first();
  await expect(alert).toContainText('never answered at 192.168.4.1', { timeout: 15000 });
  await expect(alert).toContainText('Lightweaver-EEFF');
  await expect(alert).toContainText('Reconnect installed card');
  // The tab the owner opened is theirs; Studio must not close or navigate it.
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

  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await page.getByRole('button', { name: 'Continue Wi-Fi setup', exact: true }).click();
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-EEFF', exact: true }).click();

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

  await page.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await page.getByRole('button', { name: 'Continue Wi-Fi setup', exact: true }).click();
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-EEFF', exact: true }).click();

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
  await page.getByRole('button', { name: 'I’ve joined Lightweaver-EEFF', exact: true }).click();
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
  await page.getByRole('button', { name: 'Install project on card', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeVisible();

  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'test');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await connectCommissioningCard(page);
  steps = page.getByTestId('card-setup-steps').locator('li');
  await expect(steps.nth(3)).toHaveAttribute('data-step-state', 'complete');
  await expect(steps.nth(4)).toHaveAttribute('data-step-state', 'current');
  await page.evaluate(async () => {
    const commissioning = await import('/src/lib/cardCommissioningFlow.js');
    const flow = commissioning.readCardCommissioning();
    const expected = flow.project.pendingWiring;
    (window as any).__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'testing', activationId });
    (window as any).__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'known-good', activationId });
    (window as any).__LW_ROLLBACK_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'known-good', activationId });
    (window as any).__LW_READ_FINAL_COMMISSIONING_WIRING_FOR_TEST__ = async () => ({
      app: 'Lightweaver',
      ok: true,
      state: 'known-good',
      activationId: '',
      cardId: flow.expectedCard.id,
      firmwareVersion: flow.expectedCard.firmwareVersion,
      buildId: flow.expectedCard.buildId,
      projectRevision: flow.project.revision,
      projectFingerprint: flow.project.fingerprint,
      wiringRevision: expected.wiringRevision,
      wiringDigest: expected.wiringDigest,
      ledType: expected.ledType,
      colorOrder: expected.colorOrder,
      maxMilliamps: expected.maxMilliamps,
      outputs: expected.outputs,
    });
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

test('commissioning requires an independent exact final wiring GET before clearing the flow', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'test');
  await connectCommissioningCard(page);
  await page.evaluate(async () => {
    const commissioning = await import('/src/lib/cardCommissioningFlow.js');
    const flow = commissioning.readCardCommissioning();
    const expected = flow.project.pendingWiring;
    (window as any).__finalWiringReads = 0;
    (window as any).__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'testing', activationId });
    (window as any).__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'known-good', activationId });
    (window as any).__LW_READ_FINAL_COMMISSIONING_WIRING_FOR_TEST__ = async () => {
      (window as any).__finalWiringReads += 1;
      return {
        app: 'Lightweaver',
        ok: true,
        state: 'known-good',
        activationId: '',
        cardId: flow.expectedCard.id,
        firmwareVersion: flow.expectedCard.firmwareVersion,
        buildId: flow.expectedCard.buildId,
        projectRevision: flow.project.revision,
        projectFingerprint: 'ffffffffffffffff',
        wiringRevision: expected.wiringRevision,
        wiringDigest: expected.wiringDigest,
        ledType: expected.ledType,
        colorOrder: expected.colorOrder,
        maxMilliamps: expected.maxMilliamps,
        outputs: expected.outputs,
      };
    };
  });

  await page.getByRole('button', { name: 'Test lights', exact: true }).click();
  await page.getByRole('button', { name: 'Start 90-second light test', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, every output is correct', exact: true }).click();

  await expect.poll(() => page.evaluate(() => (window as any).__finalWiringReads)).toBe(1);
  await expect(page.getByRole('alert')).toContainText(/final wiring|project fingerprint|read-back/i);
  await expect(page.getByText('Light check complete', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Yes, every output is correct', exact: true })).toBeVisible();
});

test('legacy staged wiring without authoritative identity cannot confirm and remains recoverable', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await seedCommissioningFlow(page, 'test-legacy');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await connectCommissioningCard(page);
  await page.evaluate(() => {
    (window as any).__legacyConfirmCalls = 0;
    (window as any).__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'testing', activationId });
    (window as any).__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => {
      (window as any).__legacyConfirmCalls += 1;
      return { state: 'known-good', activationId };
    };
    (window as any).__LW_ROLLBACK_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'known-good', activationId });
  });

  await page.getByRole('button', { name: 'Test lights', exact: true }).click();
  await page.getByRole('button', { name: 'Start 90-second light test', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Yes, every output is correct', exact: true });
  await expect(confirm).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText(/older setup|exact wiring evidence|restore/i);
  await expect.poll(() => page.evaluate(() => (window as any).__legacyConfirmCalls)).toBe(0);

  await page.getByRole('button', { name: 'No, restore working setup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore saved project', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__legacyConfirmCalls)).toBe(0);
});

test('an exact nonzero commissioning flow resumed after reload marks the restored local revision installed', async ({ page }) => {
  await page.goto('/#screen=card&section=preferences', { waitUntil: 'domcontentloaded' });
  const projectName = page.locator('.set-row', { hasText: 'Project name' }).locator('input');
  await projectName.fill('Reloaded exact commissioning project');
  await expect.poll(() => page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.name || ''; }
    catch { return ''; }
  })).toBe('Reloaded exact commissioning project');
  await expect.poll(() => page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('lw_project_lifecycle_v1') || 'null')?.dirty; }
    catch { return null; }
  })).toBe(true);

  await page.evaluate(async () => {
    const api = await import('/src/lib/cardCommissioningFlow.js');
    const project = JSON.parse(localStorage.getItem('lw_autosave_v3'));
    const startedAt = Date.now();
    const installed = {
      operation: 'install-current-release',
      cardId: 'lw-aabbccddeeff',
      firmwareVersion: '1.2.3',
      buildId: 'a'.repeat(40),
    };
    let flow = api.beginCardCommissioning({
      source: 'web-serial',
      operation: installed.operation,
      projectRecord: { id: 'reloaded-exact-project', updatedAt: startedAt, project },
      projectRevision: 7,
      projectGeneration: 5,
      flowId: 'flow-reloaded-exact-12345',
      now: startedAt,
    });
    flow = api.completeCardInstall(flow, installed, { now: startedAt + 1 });
    flow = api.acknowledgeCommissionedCard(flow, {
      id: installed.cardId,
      firmwareVersion: installed.firmwareVersion,
      buildId: installed.buildId,
    }, { now: startedAt + 2 }).flow;
    flow = {
      ...flow,
      stage: 'check-lights',
      updatedAt: startedAt + 3,
      project: {
        ...flow.project,
        pendingActivationId: 'reloaded-exact-activation',
        pendingWiring: {
          wiringRevision: 11,
          wiringDigest: 'e'.repeat(64),
          ledType: 'WS2815',
          colorOrder: 'GRB',
          maxMilliamps: 3200,
          outputs: [{
            id: 'out1',
            pin: 16,
            pixels: 60,
            segments: [{ id: 'strip-1', count: 60, direction: 'forward' }],
          }],
        },
      },
    };
    await api.writeCardCommissioning(flow, { locks: null });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('workspace-notice')).toContainText('Restored from recovery copy');
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await connectCommissioningCard(page);
  await page.evaluate(async () => {
    const api = await import('/src/lib/cardCommissioningFlow.js');
    const flow = api.readCardCommissioning();
    const expected = flow.project.pendingWiring;
    (window as any).__resumedFinalReads = 0;
    (window as any).__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'testing', activationId });
    (window as any).__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__ = async (activationId: string) => ({ state: 'known-good', activationId });
    (window as any).__LW_READ_FINAL_COMMISSIONING_WIRING_FOR_TEST__ = async () => {
      (window as any).__resumedFinalReads += 1;
      return {
        app: 'Lightweaver',
        ok: true,
        state: 'known-good',
        activationId: '',
        cardId: flow.expectedCard.id,
        firmwareVersion: flow.expectedCard.firmwareVersion,
        buildId: flow.expectedCard.buildId,
        projectRevision: flow.project.revision,
        projectFingerprint: flow.project.fingerprint,
        wiringRevision: expected.wiringRevision,
        wiringDigest: expected.wiringDigest,
        ledType: expected.ledType,
        colorOrder: expected.colorOrder,
        maxMilliamps: expected.maxMilliamps,
        outputs: expected.outputs,
      };
    };
  });

  await page.getByRole('button', { name: 'Test lights', exact: true }).click();
  await page.getByRole('button', { name: 'Start 90-second light test', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, every output is correct', exact: true }).click();

  await expect.poll(() => page.evaluate(() => (window as any).__resumedFinalReads)).toBe(1);
  await expect.poll(() => page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('lw_project_lifecycle_v1') || '{}').installation))).toBe(true);
  await expect(page.getByTestId('workspace-notice')).toHaveCount(0);
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

test('one Setup rail destination owns the card and exposes ordinary section navigation', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Setup', exact: true }).click();

  // The rail lands on the guided ladder, not on the unguided status board.
  await expect(page).toHaveURL(/#screen=card&section=setup$/);
  await expect(page.getByRole('heading', { name: 'Set up your Lightweaver', level: 1 })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Hardware sections' });
  await expect(sections).toBeVisible();
  for (const label of ['Setup', 'Card status', 'Install or update', 'Hardware settings', 'Advanced & Support']) {
    await expect(sections.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(sections.getByRole('button', { name: 'Setup', exact: true })).toHaveAttribute('aria-current', 'page');
  // Batch production (formerly Workshop setup) is not a section tab.
  await expect(sections.getByRole('button', { name: 'Workshop setup', exact: true })).toHaveCount(0);
  await expect(sections.getByRole('button', { name: 'Batch production', exact: true })).toHaveCount(0);
  // Setup and Hardware were peer rail items asking the same questions. Neither
  // name survives as a second destination — there is one card entry now.
  for (const label of ['Flash', 'Installer', 'Production setup', 'Settings', 'Hardware']) {
    await expect(page.locator('.rail').getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
  await expect(sections.getByRole('menu')).toHaveCount(0);
  await expect(sections.locator('[role="menuitem"]')).toHaveCount(0);
  await expect(sections.locator('[aria-haspopup]')).toHaveCount(0);
});

test('Hardware loads the verified production project that matches the paired card in one action', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  const index = await page.request.get('/production/jobs/index.json').then(response => response.json());
  const entry = index.jobs.find((job: any) => job.jobId === 'bench-fixture-44');
  expect(entry).toBeTruthy();
  const job = await page.request.get(entry.url).then(response => response.json());
  const cardStatus = readyStatus('lw-bench-fixture', {
    buildId: 'bench-build',
    productionJobId: entry.jobId,
    productionJobDigest: entry.digest,
    projectId: job.project.id,
    projectRevision: job.project.revision,
    projectFingerprint: job.project.fingerprint,
    led: { pixels: 44, type: 'WS2815', colorOrder: 'GRB', maxMilliamps: 1500 },
    outputs: [{ id: 'out1', pin: 18, pixels: 44 }],
  });
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({ json: cardStatus }));
  await page.route('http://lightweaver.local/api/firmware-info', route => route.fulfill({ json: {
    ...cardStatus,
    piece: { id: job.project.id, name: job.project.restoreSnapshot.name },
  } }));
  await page.evaluate(async () => {
    const { createDefaultProject } = await import('/src/lib/projectModel.js');
    const project = createDefaultProject();
    project.id = 'work-in-progress';
    project.name = 'Work in progress';
    project.layout.starterPending = false;
    project.layout.strips = [{
      id: 'wip-strip', name: 'Unfinished spiral', pixelCount: 17, pixels: [],
    }];
    localStorage.setItem('lw_autosave_v3', JSON.stringify(project));
    localStorage.setItem('lw_autosave_v3_backup', JSON.stringify(project));
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1, id: 'lw-bench-fixture', firmwareVersion: '1.0.0', buildId: 'bench-build',
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('card-link-status')).toHaveAccessibleName(/Connected/);

  await page.getByRole('region', { name: 'Matching card project' })
    .getByRole('button', { name: /Load .*production job bench-fixture-44, project revision/ }).click();

  await expect(page.getByRole('dialog', { name: 'Replace current project?' })).toHaveCount(0);
  await expect(page).toHaveURL(/#screen=pattern$/);
  await expect(page.getByRole('button', { name: 'Install on card' })).toBeEnabled();
  const savedProjects = await page.evaluate(() => {
    const envelope = JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}');
    return envelope.records?.map(record => record.project) || [];
  });
  expect(savedProjects).toEqual(expect.arrayContaining([expect.objectContaining({
    id: 'work-in-progress',
    name: 'Work in progress',
    layout: expect.objectContaining({
      strips: expect.arrayContaining([expect.objectContaining({
        sourceLayerId: 'wip-strip', name: 'Unfinished spiral', pixelCount: 17,
      })]),
    }),
  })]));
  await expect(page.locator('.pm-targetcard .tc-layer .tc-total')).toHaveText('LEDs44');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}').id)).toBe('bench-fixture');
});

test('Card project switch save failure keeps the current project open with actionable offline guidance', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'offline');
  await region.getByRole('button', { name: /^Load / }).click();

  await expect(region.getByRole('alert')).toHaveText(
    'The current online project has not been saved because Studio is offline. Reconnect, then retry.',
  );
  await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.calls)).toMatchObject({
    save: 1, replace: 0,
  });
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
});

test('Card project switch blocks when the saved workspace changes before replacement', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'changed');
  await region.getByRole('button', { name: /^Load / }).click();

  await expect(region.getByRole('alert')).toHaveText(
    'The current project changed while Studio was saving it. Your edits are still open; retry to save the newest version.',
  );
  await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.calls)).toMatchObject({
    save: 1, replace: 0,
  });
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
});

test('Card project switch rereads the browser library and blocks a deleted match', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'browser-deleted');
  await region.getByRole('button', { name: /^Load / }).click();

  await expect(region.getByRole('alert')).toContainText('selected project changed');
  await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.calls)).toMatchObject({
    save: 1, replace: 0,
  });
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
});

test('Card project discovery reads a browser match created outside the rendered snapshot', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'browser-fresh');
  await expect(region).toContainText('Browser installed project');
});

test('Card project discovery retries when a matching cloud candidate arrives late', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'cloud-late');
  await expect(region).toContainText('Cloud installed project');
});

test('Card project switch hands off persistence association before post-replacement card read', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'association');
  await region.getByRole('button', { name: /^Load / }).click();

  await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.calls)).toMatchObject({
    save: 1, replace: 1, association: 1, associationMarker: { generation: 8, revision: 0 },
  });
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
  await page.evaluate(() => (window as any).__projectSwitchHarness.releasePostReplaceRead());
  await expect(page).toHaveURL(/#screen=pattern$/);
});

test('Card project switch reports and blocks an unsafe persistence association handoff', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'association-failure');
  await region.getByRole('button', { name: /^Load / }).click();

  await expect(region.getByRole('alert')).toHaveText(
    'The matching project was loaded and your previous project was saved, but Studio could not establish a safe save destination for the loaded project. Saving is blocked; open another project or retry after browser storage is available.',
  );
  await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.calls)).toMatchObject({
    save: 1, replace: 1, association: 1,
  });
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
});

test('Card project switch reports final card-check failure after replacement truthfully', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'post-read-failure');
  await region.getByRole('button', { name: /^Load / }).click();

  await expect(region.getByRole('alert')).toHaveText(
    'The matching project was loaded and your previous project was saved, but Studio could not complete the final card check. Reconnect the card before changing patterns.',
  );
  await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.calls)).toMatchObject({
    save: 1, replace: 1, association: 1,
  });
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
});

test('duplicate project switch activation runs one save and one replacement', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'duplicate');
  const load = region.getByRole('button', { name: /^Load / });
  await load.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });

  await expect(region.getByRole('status')).toHaveText('Saving current project…');
  await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.calls)).toMatchObject({
    save: 1, replace: 0,
  });
  await page.evaluate(() => (window as any).__projectSwitchHarness.releaseSave());
  await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.calls)).toEqual({
    save: 1, replace: 1, open: 0, association: 1,
    associationMarker: { generation: 8, revision: 0 }, openOptions: null,
  });
  await expect(page).toHaveURL(/#screen=pattern$/);
});

test('cloud exact match opens with saved-current proof and fresh card verification callback', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'cloud');
  await region.getByRole('button', { name: /^Load / }).click();

  await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.calls)).toMatchObject({
    save: 1,
    replace: 0,
    open: 1,
    openOptions: {
      expectedRevision: 23,
      currentProjectSaved: true,
      beforeMutation: 'function',
    },
  });
});

test('cloud exact match reports a committed replacement when the session changes mid-open', async ({ page }) => {
  const region = await renderProjectSwitchCardHarness(page, 'cloud-stale');
  await region.getByRole('button', { name: /^Load / }).click();

  await expect(region.getByRole('alert')).toHaveText(
    'The matching online project was loaded and your previous project was saved, but your session changed before Studio could associate the loaded project. Sign in again before saving online.',
  );
  await expect.poll(() => page.evaluate(() => (window as any).__projectSwitchHarness.calls)).toMatchObject({
    save: 1, replace: 1, open: 1, association: 1,
  });
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
});

test('Hardware refuses a published job when the card digest does not match its verified artifact', async ({ page }) => {
  const index = await page.request.get('/production/jobs/index.json').then(response => response.json());
  const entry = index.jobs.find((job: any) => job.jobId === 'bench-fixture-44');
  const job = await page.request.get(entry.url).then(response => response.json());
  const cardStatus = readyStatus('lw-bench-fixture-mismatch', {
    productionJobId: entry.jobId,
    productionJobDigest: 'f'.repeat(64),
    projectRevision: job.project.revision,
    projectFingerprint: job.project.fingerprint,
  });
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({ json: cardStatus }));
  await page.route('http://lightweaver.local/api/firmware-info', route => route.fulfill({ json: {
    ...cardStatus,
    piece: { id: job.project.id, name: job.project.restoreSnapshot.name },
  } }));
  await page.addInitScript(() => localStorage.setItem('lw_card_identity_v1', JSON.stringify({
    version: 1, id: 'lw-bench-fixture-mismatch', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
  })));
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Load matching card project' })).toBeVisible();
  await page.getByRole('button', { name: 'Load matching card project' }).click();
  await expect(page.getByRole('alert')).toContainText(/exact|match|digest/i);
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
});

test('Hardware offers an exact current project without intent and auto-opens only with preserved edit intent', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const { createDefaultProject } = await import('/src/lib/projectModel.js');
    const current = createDefaultProject();
    current.id = 'ordinary-gallery-piece';
    current.name = 'Ordinary gallery piece';
    current.layout.starterPending = false;
    localStorage.setItem('lw_autosave_v3', JSON.stringify(current));
    localStorage.setItem('lw_autosave_v3_backup', JSON.stringify(current));
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1, id: 'lw-ordinary-card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(650);
  const fingerprint = await page.evaluate(async () => {
    const resolver = await import('/src/lib/cardProjectResolver.js');
    const { migrateProject } = await import('/src/lib/projectModel.js');
    const normalized = JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}');
    return resolver.cardProjectFingerprint(migrateProject(normalized));
  });
  const cardStatus = readyStatus('lw-ordinary-card', {
    projectRevision: 3,
    projectFingerprint: fingerprint,
    // The firmware reports the installed project on /api/status as `projectId`
    // (runtimeStatusJson, LightweaverStorage.cpp). Omitting it here modelled a
    // card no Studio build can authorize, and the auto-open below then passed
    // only by sampling a transient — see tests/card-edit-handoff.spec.ts.
    projectId: 'ordinary-gallery-piece',
  });
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({ json: cardStatus }));
  await page.route('http://lightweaver.local/api/firmware-info', route => route.fulfill({ json: {
    ...cardStatus,
    projectFingerprint: fingerprint,
    piece: { id: 'ordinary-gallery-piece', name: 'Ordinary gallery piece' },
  } }));
  await page.evaluate(() => { window.location.hash = '#screen=card&section=overview'; });
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: cardStatus.cardId, firmwareVersion: cardStatus.firmwareVersion, buildId: cardStatus.buildId },
    expectedCard: { id: cardStatus.cardId, firmwareVersion: cardStatus.firmwareVersion, buildId: cardStatus.buildId },
    readiness: cardStatus,
  }]);
  await expect(page.getByRole('region', { name: 'Matching card project' })).toContainText(
    'Exact match found: “Ordinary gallery piece — current Studio project”',
    { timeout: 15_000 },
  );
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
  await expect(page.getByRole('button', {
    name: 'Load Ordinary gallery piece — current Studio project',
  })).toBeVisible();

  await page.goto('/?editPattern=aurora#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: cardStatus.cardId, firmwareVersion: cardStatus.firmwareVersion, buildId: cardStatus.buildId },
    expectedCard: { id: cardStatus.cardId, firmwareVersion: cardStatus.firmwareVersion, buildId: cardStatus.buildId },
    readiness: cardStatus,
  }]);
  await expect(page).toHaveURL(/#screen=pattern$/, { timeout: 25_000 });
});

test('Card section navigation becomes one compact switcher on a 390px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });

  const sections = page.getByRole('navigation', { name: 'Hardware sections' });
  const switcher = sections.getByLabel('Hardware section');
  await expect(switcher).toBeVisible();
  await expect(switcher).toHaveValue('overview');
  expect(await switcher.evaluate(element => Number.parseFloat(getComputedStyle(element).height))).toBeGreaterThanOrEqual(44);

  for (const label of ['Setup', 'Card status', 'Install or update', 'Hardware settings', 'Advanced & Support', 'Preferences']) {
    await expect(switcher.getByRole('option', { name: label, exact: true })).toHaveCount(1);
    await expect(sections.getByRole('button', { name: label, exact: true })).toBeHidden();
  }

  await switcher.selectOption('setup');
  await expect(page).toHaveURL(/#screen=card&section=setup$/);
  await expect(page.getByRole('heading', { name: 'Set up your Lightweaver', level: 1 })).toBeFocused();

  const dimensions = await sections.evaluate(node => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

  const pageWidth = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.viewportWidth);
});

test('disconnected Card overview delegates to one exact Setup task without a second ladder', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();
  await dispatchCardLink(page, [{ type: 'bridge-lost', reason: 'never-connected', host: 'lightweaver.local' }]);
  await expect(page.getByTestId('card-detected-state')).toContainText(/not detected|not connected/i);
  await expect(page.getByTestId('card-setup-steps')).toHaveCount(0);
  const diagnosis = page.getByTestId('card-setup-diagnosis');
  await expect(diagnosis).toContainText(/connect/i);
  await diagnosis.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(page).toHaveURL(/#screen=card&section=setup&task=connect-card$/);
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
  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();

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

test('connected Card overview identifies the card and makes Install on card primary', async ({ page }) => {
  const status = readyStatus('lw-gallery-card');
  await page.addInitScript(identity => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify(identity));
  }, {
    version: 1, id: status.cardId, name: 'Gallery card',
    firmwareVersion: status.firmwareVersion, buildId: status.buildId,
  });
  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(status),
  }));
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: 'lw-gallery-card', name: 'Gallery card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    expectedCard: { id: 'lw-gallery-card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    readiness: status,
  }]);

  await expect(page.getByTestId('card-detected-state')).toContainText('Gallery card');
  await expect(page.getByTestId('card-detected-state')).toContainText(/connected/i);
  await expect(page.getByTestId('card-detected-state')).not.toContainText(/has not changed|nothing changed/i);
  await expect(page.getByRole('button', { name: 'Install on card', exact: true })).toHaveClass(/primary/);
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
  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: 'lw-overview-state', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    expectedCard: { id: 'lw-overview-state', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    readiness: status,
  }]);
  await expect(page.getByTestId('card-detected-state')).toContainText('Checking card');

  status = readyStatus('lw-overview-state', {
    runtimePhase: 'factory', knownGoodProject: false, commandReady: false,
    mode: 'factory-flash', source: 'defaults',
  });
  await expect(page.getByTestId('card-detected-state')).toContainText('Blank — load a project');
  await expect(page.getByRole('button', { name: 'Install current project', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start a new project', exact: true }).click();
  await expect(page).toHaveURL(/#screen=layout/);

  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });

  status = readyStatus('lw-overview-state');
  await expect(page.getByTestId('card-detected-state')).toContainText('ready for light check');
});

test('Card overview flags the temporary bench discovery project and offers Find my strips', async ({ page }) => {
  const status = readyStatus('lw-bench-card', {
    projectId: 'lightweaver-bench-discovery-v1',
    projectRevision: 1,
    projectFingerprint: 'f'.repeat(16),
  });
  await page.addInitScript(identity => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify(identity));
  }, { version: 1, id: 'lw-bench-card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) });
  await page.route('**/api/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(status),
  }));
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: 'lw-bench-card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    expectedCard: { id: 'lw-bench-card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    readiness: status,
  }]);

  await expect(page.getByTestId('card-detected-state')).toContainText('temporary Find-my-strips setup');
  // The card is not presented as a commissioned project…
  await expect(page.getByTestId('card-detected-state')).not.toContainText('ready for light check');
  // …and discovery is one tap away without the connection popover.
  await page.getByRole('button', { name: 'Find my strips', exact: true }).click();
  await expect(page).toHaveURL(/#screen=discovery/);
});

test('an unpaired card running the bench discovery project is flagged before pairing', async ({ page }) => {
  const strandedCard = readyStatus('lw-stranded-card', {
    projectId: 'lightweaver-bench-discovery-v1',
    projectRevision: 1,
    projectFingerprint: 'f'.repeat(16),
    bootId: 'boot-stranded-1',
  });
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(strandedCard),
  }));
  await page.route('http://lightweaver.local/api/firmware-info', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(strandedCard),
  }));
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  // No persisted pairing: this origin has never adopted a card.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();

  const detected = page.getByTestId('card-detected-state');
  await expect(detected).toContainText('unfinished Find my strips setup', { timeout: 15000 });
  await expect(detected).toContainText(/connect to pair/i);
});

test('a bench card offers Clear temporary setup and posts the confirmation token', async ({ page }) => {
  // provisionalSetup:true is the NEW firmware claim; the projectId fallback is
  // covered by the bench-overview test above, which omits the field entirely.
  const status = readyStatus('lw-bench-card', {
    projectId: 'lightweaver-bench-discovery-v1',
    projectRevision: 1,
    projectFingerprint: 'f'.repeat(16),
    provisionalSetup: true,
  });
  const clears: string[] = [];
  await page.addInitScript(identity => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify(identity));
  }, { version: 1, id: 'lw-bench-card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) });
  await page.route('**/api/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(status),
  }));
  // Registered after the generic route so it takes precedence for this path.
  await page.route('**/api/clear-project', route => {
    clears.push(route.request().postData() || '');
    return route.fulfill({
      status: 202, contentType: 'application/json',
      body: JSON.stringify({ ok: true, accepted: true, wifiPreserved: true, requiresReboot: true }),
    });
  });
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: 'lw-bench-card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    expectedCard: { id: 'lw-bench-card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    readiness: status,
  }]);

  await expect(page.getByTestId('card-detected-state')).toContainText('temporary Find-my-strips setup');
  await page.getByRole('button', { name: 'Clear temporary setup', exact: true }).click();
  await expect.poll(() => clears.length).toBe(1);
  expect(JSON.parse(clears[0])).toEqual({ confirm: 'CLEAR' });
  await expect(page.getByText(/temporary setup was cleared/i)).toBeVisible();
});

test('reachable recovering factory card uses URL IP and offers blank setup without automatic writes', async ({ page }) => {
  const cardId = 'lw-b0fe81f61b44';
  const buildId = '19369537be823b74362896fdadd32b8182f27417';
  const cardHost = '192.168.18.70';
  const writes: string[] = [];
  const statusRequests: string[] = [];
  const status = {
    app: 'Lightweaver', ok: true, provisioningContractVersion: 1,
    cardId, firmwareVersion: '1.0.0', buildId,
    bootId: 'boot-e11c5733-b0fe81f61b44',
    runtimePhase: 'recovering', knownGoodProject: false,
    commandReady: false, outputReady: false,
    mode: 'factory-flash', source: 'defaults',
    projectId: '', projectRevision: 0, projectFingerprint: '',
    led: { pixels: 0 },
    wifi: {
      transport: 'station', transition: 'handoff-abandoned', transitionPending: true,
      handoffGeneration: 1, apActive: false, stationIp: cardHost, ip: cardHost,
    },
  };
  await page.addInitScript(identity => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify(identity));
    localStorage.setItem('lw_chip_card_host', 'lightweaver.local');
  }, {
    version: 1, id: cardId, firmwareVersion: '1.0.0', buildId,
    hostname: 'lightweaver.local', address: '192.168.4.1',
  });
  await page.route(`http://${cardHost}/**`, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && request.method() !== 'OPTIONS') writes.push(`${request.method()} ${pathname}`);
    if (pathname === '/api/status') {
      statusRequests.push(cardHost);
      await route.fulfill({ json: status });
      return;
    }
    if (pathname === '/api/firmware-info') {
      await route.fulfill({ json: { ...status, outputs: [] } });
      return;
    }
    if (pathname === '/api/zones') {
      await route.fulfill({ json: { zones: [] } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('http://lightweaver.local/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && request.method() !== 'OPTIONS') writes.push(`${request.method()} ${pathname}`);
    if (pathname === '/api/status') {
      statusRequests.push('lightweaver.local');
      await route.fulfill({ json: status });
      return;
    }
    if (pathname === '/api/firmware-info') {
      await route.fulfill({ json: { ...status, outputs: [] } });
      return;
    }
    if (pathname === '/api/zones') {
      await route.fulfill({ json: { zones: [] } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto(`/?cardBridge=1&cardHost=${cardHost}#screen=card&section=overview`, { waitUntil: 'domcontentloaded' });

  await expect.poll(() => statusRequests.length).toBeGreaterThan(0);
  expect(statusRequests[0]).toBe(cardHost);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_chip_card_host'))).toBe(cardHost);
  await expect(page.getByTestId('card-detected-state')).toContainText('Blank — load a project');
  const setupSteps = page.getByTestId('card-setup-steps').locator('li');
  await expect(setupSteps.nth(0)).toHaveAttribute('data-step-state', 'complete');
  await expect(setupSteps.nth(3)).toHaveAttribute('data-step-state', 'current');
  await expect(page.getByRole('button', { name: 'Install current project', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a new project', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Install current project', exact: true }).click();
  await expect(page).toHaveURL(/#screen=card&section=settings$/);
  await expect(page.getByRole('button', { name: 'Install on card', exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(writes.filter(entry => /\/api\/(?:control|config)$/.test(entry))).toEqual([]);
});

test('ready overview offers Batch production as a low-emphasis link, not a setup step', async ({ page }) => {
  const status = readyStatus('lw-gallery-card');
  await page.addInitScript(identity => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify(identity));
  }, {
    version: 1, id: status.cardId, name: 'Gallery card',
    firmwareVersion: status.firmwareVersion, buildId: status.buildId,
  });
  await page.route('**/api/status', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(status),
  }));
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: 'lw-gallery-card', name: 'Gallery card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    expectedCard: { id: 'lw-gallery-card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) },
    readiness: status,
  }]);
  await expect(page.getByRole('button', { name: 'Install on card', exact: true })).toHaveClass(/primary/);
  await expect(page.getByRole('button', { name: 'Verify in workshop', exact: true })).toHaveCount(0);

  await expect(page.getByTestId('card-setup-steps')).not.toContainText('Batch production');
  const batch = page.getByTestId('card-batch-link').getByRole('button', { name: 'Batch production', exact: true });
  await expect(batch).toHaveClass(/link-btn/);
  await expect(batch).not.toHaveClass(/primary/);

  await batch.click();
  await expect(page).toHaveURL(/#screen=card&section=workshop$/);
  await expect(page.getByRole('heading', { name: 'Batch production', level: 1 })).toBeVisible();
  await expect(page.getByText('Manufacturing mode', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Hardware', exact: true }).click();
  await expect(page).toHaveURL(/#screen=card&section=overview$/);
  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();
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
    await expect(page.locator('.rail-item.active')).toHaveAccessibleName('Setup');
    const sections = page.getByRole('navigation', { name: 'Hardware sections' });
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
  await page.getByRole('navigation', { name: 'Hardware sections' }).getByRole('button', { name: 'Hardware settings' }).click();

  await expect(page).toHaveURL(/#screen=card&section=settings$/);
  const heading = page.getByRole('heading', { name: 'Hardware settings', level: 1 });
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
  await expect(page.getByRole('button', { name: 'Back to Hardware', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Hardware sections' }).locator('[aria-current="page"]')).toHaveCount(0);
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
  await page.getByRole('navigation', { name: 'Hardware sections' }).getByRole('button', { name: 'Hardware settings' }).click();
  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();

  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.locator('.rail-item.active')).toHaveAccessibleName('Setup');
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
  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toBeVisible();
  // Section clicks replace history, so push a real Back entry by mutating the
  // hash directly — the same way an external link or bookmark would.
  await page.evaluate(() => { window.location.hash = 'screen=card&section=install'; });
  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: true } })));
  await page.goBack();

  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your Lightweaver hardware' })).toHaveCount(0);
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
    const upstream = await page.request.fetch(`http://localhost:${testPort}${requested.pathname}${requested.search}`);
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
    const cardPushClient = await import('/src/lib/cardPushClient.js');

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
        version: 4,
        id: 'browser-blank-project',
        name: 'Browser blank project',
        layout: {
          strips: [{
            id: 'strip-1', name: 'Mapped ring', pixelCount: 44,
            kaleidoscope: { enabled: true, pointCount: 4, startLed: 0, offsets: [0, 0, 0, 0] },
          }],
          wiring: {
            version: 1, locked: true, verified: true, controllerAnchor: null, migrationWarnings: [],
            outputs: [{ id: 'out1', name: 'Mapped ring', pin: 16, runIds: ['run-strip-1'] }],
            runs: [{
              id: 'run-strip-1', type: 'strip', verified: true,
              source: { stripId: 'strip-1', from: 0, to: 43 },
              directionPolicy: 'flexible', physicalDirection: 'source-forward', seamLed: null,
            }],
          },
          patchBoard: null,
        },
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
      capabilities: { kaleidoscopeReflectionPoints: 1 },
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
            mode: 'factory-flash',
            source: 'defaults',
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
            capabilities: { kaleidoscopeReflectionPoints: 1 },
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
    (window as any).__blankProductionPath = {
      messageTypes, flowId, replacementFlowId, correlation,
      expectedFreshEvidence: structuredClone(status),
      capturedPush: null,
    };
    (window as any).__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__ = async (
      runtimePackage: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      (window as any).__blankProductionPath.capturedPush = structuredClone({ runtimePackage, options });
      return cardPushClient.pushConfigToCard(runtimePackage, options);
    };

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
      capturedPush: fixture.capturedPush,
      expectedFreshEvidence: fixture.expectedFreshEvidence,
      recoveryCleared,
      replacement,
      replacementState,
      staleEnvelopeIgnored: cardLink.getCardLinkState() === stateBeforeStaleEnvelope,
    };
  }, beforeWizardPush);
  expect(productionPath.types.filter(type => type === 'config')).toHaveLength(1);
  expect(productionPath.capturedPush.runtimePackage.config.kaleidoscopeMappings).toHaveLength(1);
  expect(productionPath.capturedPush.options.cardEvidence).toEqual(productionPath.expectedFreshEvidence);
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
              ...(!configured ? { mode: 'factory-flash', source: 'defaults' } : {}),
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
    const upstream = await page.request.fetch(`http://localhost:${testPort}${requested.pathname}${requested.search}`);
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
