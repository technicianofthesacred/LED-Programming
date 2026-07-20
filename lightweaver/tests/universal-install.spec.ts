import { test, expect } from '@playwright/test';

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
  let attempts = 0;
  await page.route('**/firmware/release-manifest.sig', async route => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
      return;
    }
    await route.fallback();
  });
  await page.goto('/#screen=flash&mode=install');

  await expect(page.getByText(/Official firmware could not be verified/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Erase card and install/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry official firmware' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry official firmware' }).click();
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
    // card-page handoff (join Lightweaver-XXXX, then Continue opens the card
    // page bridge window).
    window.localStorage.setItem('lw_chip_card_host', '192.168.4.1');
  });
  await page.goto('/#screen=flash&mode=install');

  await page.getByTestId('card-link-status').click();
  await page.getByRole('button', { name: /My card already lights up/ }).click();
  await expect(page.getByText(/Join the .*Lightweaver-XXXX.* Wi-Fi network/)).toBeVisible();
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
