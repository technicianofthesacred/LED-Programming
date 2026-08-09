import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

test('install mode is a single safe workflow without technician controls', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
  });
  await page.goto('/#screen=flash&mode=install&url=https://evil.example/fw.bin&target=esp32&callback=https://evil.example');

  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await expect(page.getByText(/Official Lightweaver .* verified and ready/)).toBeVisible();
  for (const label of ['Connect card', 'Install safely', 'Set up card', 'Check lights']) {
    await expect(page.getByRole('listitem').filter({ hasText: label })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Find connected card' })).toBeVisible();
  await expect(page.getByText('Technician diagnostics')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Browse \.bin/i })).not.toBeVisible();
  await expect(page.getByText('Address', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Erase all', { exact: true })).toHaveCount(0);
  await expect(page.locator('textarea.fl-log')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('evil.example');
});

test('tampered release is blocked before the card can be selected', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
  });
  let serveTamperedSignature = true;
  await page.route('**/firmware/release-manifest.sig', async route => {
    if (serveTamperedSignature) {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
      return;
    }
    await route.fallback();
  });
  await page.goto('/#screen=flash&mode=install');

  const retryOfficialFirmware = page.getByRole('button', { name: 'Retry official firmware' });
  await expect(retryOfficialFirmware).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Official firmware could not be verified/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Erase card and install/i })).toHaveCount(0);
  serveTamperedSignature = false;
  await retryOfficialFirmware.click();
  await expect(page.getByText(/Official Lightweaver .* verified and ready/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toBeEnabled();
});

test('desktop without browser USB offers Lightweaver Bridge and keeps the canonical Studio URL', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.goto('/#screen=flash&mode=install');

  await expect(page.getByRole('button', { name: 'Open Lightweaver Bridge' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toHaveCount(0);
  await expect(page).toHaveURL(/#screen=flash&mode=install$/);
  await expect(page.locator('body')).not.toContainText('/design');
});

test('installer inside a secure iframe escapes to the fixed top-level installer', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
  });
  await page.goto('/#screen=layout');
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'installer-frame';
    frame.src = `${location.origin}/#screen=flash&mode=install&url=https://evil.example/fw.bin`;
    document.body.append(frame);
  });
  const installer = page.frameLocator('#installer-frame');
  await expect(installer.getByRole('heading', { name: 'Open secure installer' })).toBeVisible();
  const escape = installer.getByRole('link', { name: 'Open secure installer' });
  await expect(escape).toHaveAttribute('href', 'https://led.mandalacodes.com/#screen=flash&mode=install');
  // The escape reuses one stable named Studio tab (the same name the firmware
  // card page targets) instead of minting a new unnamed tab on every click.
  await expect(escape).toHaveAttribute('target', 'lightweaver-studio');
  await expect(escape).toHaveAttribute('rel', 'noopener noreferrer');
  // The surrounding copy states WHY the escape is required.
  await expect(installer.getByText(/only allows USB install from a separate secure top-level tab/)).toBeVisible();
});

test('a secure top-level installer that can use browser USB never offers the secure-installer escape', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
  });
  await page.goto('/#screen=flash&mode=install');

  await expect(page.getByRole('button', { name: 'Find connected card' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open secure installer' })).toHaveCount(0);
  await expect(page.locator('a[href="https://led.mandalacodes.com/#screen=flash&mode=install"]')).toHaveCount(0);
});

test('a blocked card-page popup on the install-to-card handoff shows visible popup guidance', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
    // Simulate a popup blocker refusing the named card-page window.
    window.open = () => null;
    // A stored setup-network host routes the working-card flow to the
    // card-page handoff (join the card's setup network, then Continue opens the card
    // page bridge window).
    window.localStorage.setItem('lw_chip_card_host', '192.168.4.1');
  });
  await page.goto('/#screen=flash&mode=install');

  await page.getByTestId('card-link-status').click();
  await page.getByRole('button', { name: /My card already lights up/ }).click();
  await expect(page.getByText(/Join the card’s own Wi-Fi network \(its name starts with “Lightweaver-”\)/)).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The browser could not open the card page. Allow popups, then try again.');
});

test('technician controls remain separately labelled outside install mode', async ({ page }) => {
  await page.goto('/#screen=flash');
  await expect(page.getByText('Technician diagnostics', { exact: true })).toBeVisible();
  await expect(page.locator('details')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Browse \.bin/i })).toBeVisible();
  await expect(page.getByText('Address', { exact: true })).toBeVisible();
  await expect(page.locator('textarea.fl-log')).toBeVisible();
});

test('Studio navigation is held on the installer while an install is active', async ({ page }) => {
  await page.goto('/#screen=flash&mode=install');
  await expect(page.getByRole('heading', { name: /secure Lightweaver Studio|Continue on a computer|Install Lightweaver/i })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: true } })));
  await page.getByRole('button', { name: 'Layout' }).click();
  await expect(page).toHaveURL(/#screen=flash&mode=install$/);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: false } })));
  await page.getByRole('button', { name: 'Layout' }).click();
  await expect(page).toHaveURL(/#screen=layout$/);
});

test('an interrupted browser install inspects the exact result and never flashes again automatically', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
  });
  await page.goto('/#screen=flash&mode=install');
  await page.evaluate(async () => {
    const { beginCardCommissioning, writeCardCommissioning } = await import('/src/lib/cardCommissioningFlow.js');
    const { saveCurrentProjectToLibrary } = await import('/src/lib/projectStorage.js');
    const { createDefaultProject } = await import('/src/lib/projectModel.js');
    const project = createDefaultProject();
    const record = saveCurrentProjectToLibrary(project);
    await writeCardCommissioning(beginCardCommissioning({
      source: 'web-serial', operation: 'install-current-release', strategy: 'clean-recovery',
      projectRecord: record, projectRevision: 3,
      installTarget: { id: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/will not flash again automatically/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect and inspect card' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Erase card and install/i })).toHaveCount(0);

  await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const event = {
      type: 'card-verified', via: 'bridge', host: 'lightweaver.local',
      card: { id: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40) },
      readiness: {
        app: 'Lightweaver', provisioningContractVersion: 1,
        cardId: 'lw-aabbccddeeff', firmwareVersion: '1.2.3', buildId: 'a'.repeat(40),
        bootId: 'boot-install-recovery', runtimePhase: 'ready', knownGoodProject: true,
        commandReady: true, outputReady: true,
      },
    };
    getSharedCardLink().dispatch(event);
    getSharedCardLink().dispatch(event);
  });
  await expect(page.getByRole('heading', { name: 'Set up card' })).toBeVisible();
});

test('an interrupted browser install accepts the exact recovering blank card without flashing again', async ({ page }) => {
  const cardWrites: string[] = [];
  await page.route('http://192.168.18.70/**', route => {
    const request = route.request();
    if (!['GET', 'OPTIONS'].includes(request.method())) cardWrites.push(`${request.method()} ${request.url()}`);
    return route.abort();
  });
  await page.addInitScript(() => {
    window.__LW_SERIAL_REQUESTS__ = 0;
    window.localStorage.setItem('lw_chip_card_host', '192.168.18.70');
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: { requestPort: async () => { window.__LW_SERIAL_REQUESTS__ += 1; return {}; } },
    });
  });
  await page.goto('/#screen=flash&mode=install');
  await page.evaluate(async () => {
    const { beginCardCommissioning, writeCardCommissioning } = await import('/src/lib/cardCommissioningFlow.js');
    const { saveCurrentProjectToLibrary } = await import('/src/lib/projectStorage.js');
    const { createDefaultProject } = await import('/src/lib/projectModel.js');
    const project = createDefaultProject();
    const record = saveCurrentProjectToLibrary(project);
    await writeCardCommissioning(beginCardCommissioning({
      source: 'web-serial', operation: 'install-current-release', strategy: 'clean-recovery',
      projectRecord: record, projectRevision: 3,
      installTarget: { id: 'lw-b0fe81f61b44', firmwareVersion: '1.0.0', buildId: '19369537be823b74362896fdadd32b8182f27417' },
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/will not flash again automatically/i)).toBeVisible();

  const linkState = await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const event = {
      type: 'card-verified', via: 'bridge', host: '192.168.18.70',
      card: {
        id: 'lw-b0fe81f61b44', firmwareVersion: '1.0.0',
        buildId: '19369537be823b74362896fdadd32b8182f27417',
      },
      readiness: {
        app: 'Lightweaver', provisioningContractVersion: 1,
        cardId: 'lw-b0fe81f61b44', firmwareVersion: '1.0.0',
        buildId: '19369537be823b74362896fdadd32b8182f27417',
        bootId: 'boot-e11c5733-b0fe81f61b44', runtimePhase: 'recovering',
        knownGoodProject: false, commandReady: false, outputReady: false,
        mode: 'factory-flash', source: 'defaults',
        projectId: '', projectRevision: 0, projectFingerprint: '',
        wifi: {
          transport: 'station', transition: 'handoff-abandoned', transitionPending: true,
          handoffGeneration: 1, apActive: false, stationIp: '192.168.18.70', ip: '192.168.18.70',
        },
      },
    };
    getSharedCardLink().dispatch(event);
    getSharedCardLink().dispatch(event);
    return getSharedCardLink().getState();
  });

  expect(linkState).toMatchObject({
    state: 'connected-bridge', cardBlank: true,
    validatedBootId: 'boot-e11c5733-b0fe81f61b44',
  });
  await expect(page.getByRole('heading', { name: 'Set up card' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__LW_SERIAL_REQUESTS__)).toBe(0);
  expect(cardWrites).toEqual([]);
});

test('post-flash commissioning remains a protected Studio operation during Wi-Fi handoff', async ({ page }) => {
  const remoteRelease = {
    schemaVersion: 1,
    sourceRevision: 'c'.repeat(40),
    buildId: 'c'.repeat(12),
    buildNumber: 99,
  };
  const marker = `${JSON.stringify(remoteRelease)}\n`;
  const graph = {
    schemaVersion: 1,
    files: [
      { path: 'assets/freshness-ready.js', bytes: 1, sha256: '1'.repeat(64) },
      { path: 'index.html', bytes: 1, sha256: '2'.repeat(64) },
      {
        path: 'studio-release.json', bytes: Buffer.byteLength(marker),
        sha256: createHash('sha256').update(marker).digest('hex'),
      },
    ],
  };
  let updateAvailable = false;
  let graphRequests = 0;
  await page.route('**/studio-release.json', route => updateAvailable
    ? route.fulfill({ status: 200, body: marker, headers: { 'cache-control': 'private, no-store' } })
    : route.continue());
  await page.route('**/studio-build-graph.json', route => {
    graphRequests += 1;
    return route.fulfill({
      status: 200,
      body: `${JSON.stringify(graph)}\n`,
      headers: { 'cache-control': 'private, no-store' },
    });
  });
  await page.route('**/assets/freshness-ready.js', route => route.fulfill({ status: 200, body: 'x' }));
  await page.addInitScript(() => {
    window.__LW_STUDIO_RELOADS__ = 0;
    window.__LW_STUDIO_RELOAD_FOR_TEST__ = () => { window.__LW_STUDIO_RELOADS__ += 1; };
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: { requestPort: async () => ({}) },
    });
  });
  await page.goto('/#screen=flash&mode=install');
  await page.evaluate(async () => {
    const {
      beginCardCommissioning,
      completeCardInstall,
      writeCardCommissioning,
    } = await import('/src/lib/cardCommissioningFlow.js');
    const { saveCurrentProjectToLibrary } = await import('/src/lib/projectStorage.js');
    const { createDefaultProject } = await import('/src/lib/projectModel.js');
    const project = createDefaultProject();
    const record = saveCurrentProjectToLibrary(project);
    const started = beginCardCommissioning({
      source: 'web-serial', operation: 'install-current-release', strategy: 'clean-recovery',
      projectRecord: record, projectRevision: 3,
      installTarget: { id: 'lw-b0fe81f61b44', firmwareVersion: '1.0.0', buildId: 'b'.repeat(40) },
    });
    await writeCardCommissioning(completeCardInstall(started, {
      operation: 'install-current-release', cardId: 'lw-b0fe81f61b44',
      firmwareVersion: '1.0.0', buildId: 'b'.repeat(40),
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Set up card' })).toBeVisible();
  await page.getByRole('button', { name: 'Layout' }).click();
  await expect(page).toHaveURL(/#screen=layout$/);

  updateAvailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => graphRequests).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__LW_STUDIO_RELOADS__)).toBe(0);

  await page.evaluate(async () => {
    const { clearCardCommissioning, inspectCardCommissioning } = await import('/src/lib/cardCommissioningFlow.js');
    const flowId = inspectCardCommissioning().flow?.flowId;
    if (!flowId) throw new Error('Expected a persisted commissioning flow');
    await clearCardCommissioning({ flowId });
  });
  await expect.poll(() => page.evaluate(() => window.__LW_STUDIO_RELOADS__)).toBe(1);
});
