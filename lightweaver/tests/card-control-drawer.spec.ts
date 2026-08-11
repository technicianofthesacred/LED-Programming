import { expect, test, type Page } from '@playwright/test';

const CARD_ID = 'lw-drawer-card';
const PROJECT_ID = 'drawer-gallery-project';

async function verifyCard(page: Page, projectFingerprint: string) {
  await page.evaluate(async ({ projectFingerprint }) => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const event = {
      type: 'card-verified', via: 'direct', host: 'lightweaver.local',
      card: { id: 'lw-drawer-card', name: 'Gallery Lightweaver', firmwareVersion: '1.1.1', buildId: 'a'.repeat(40) },
      expectedCard: { id: 'lw-drawer-card', firmwareVersion: '1.1.1', buildId: 'a'.repeat(40) },
      readiness: {
        app: 'Lightweaver', provisioningContractVersion: 1, cardId: 'lw-drawer-card',
        firmwareVersion: '1.1.1', buildId: 'a'.repeat(40), bootId: 'drawer-boot',
        runtimePhase: 'ready', knownGoodProject: true, commandReady: true, outputReady: true, playbackReady: true,
        projectId: 'drawer-gallery-project', projectRevision: 0, projectFingerprint,
      },
    };
    const link = getSharedCardLink();
    link.dispatch(event);
    link.dispatch(event);
  }, { projectFingerprint });
}

test('a connected footer opens customer card controls without a popup', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let controlBody: Record<string, unknown> | null = null;
  let controlRequestCount = 0;
  let rejectBrightnessOnce = true;
  let releasePendingControl: (() => void) | null = null;
  let projectFingerprint = '';
  await page.route('http://lightweaver.local/api/zones', route => route.fulfill({ json: {
    zones: [{ id: 'all', label: 'Whole piece', patternId: 'bench-warm', brightness: 0.7, speed: 1, hueShift: 0, customHue: 32, customSaturation: 230, customBreathe: false, customDrift: false, driftHueMin: 17, driftHueMax: 203, blackout: false }],
  } }));
  await page.route('http://lightweaver.local/api/patterns', route => route.fulfill({ json: {
    currentId: 'bench-warm', currentIndex: 0,
    patterns: [
      { id: 'bench-warm', label: 'Warm bench', mode: 'preset', runtimePatternId: 'warm-white', zones: [], controls: { customColor: true, breathe: false, drift: true } },
      { id: 'combo-moon-look', label: 'Moon look', mode: 'combo', runtimePatternId: 'ocean', zones: [], controls: { customColor: false, breathe: false, drift: false } },
    ],
  } }));
  const cardRuntime = () => ({
    app: 'Lightweaver', provisioningContractVersion: 1, cardId: CARD_ID, firmwareVersion: '1.1.1', buildId: 'a'.repeat(40),
    bootId: 'drawer-boot', runtimePhase: 'ready', knownGoodProject: true, commandReady: true, outputReady: true, playbackReady: true,
    projectId: PROJECT_ID, projectFingerprint, projectRevision: 0, piece: { id: PROJECT_ID, name: 'Gallery Lightweaver' },
  });
  await page.route('http://lightweaver.local/api/firmware-info', route => route.fulfill({ json: cardRuntime() }));
  await page.route('http://lightweaver.local/api/status', route => route.fulfill({ json: cardRuntime() }));
  await page.route('http://lightweaver.local/api/control', async route => {
    controlRequestCount += 1;
    controlBody = JSON.parse(route.request().postData() || '{}');
    if (controlBody.brightness === 0.4 && rejectBrightnessOnce) {
      rejectBrightnessOnce = false;
      await route.fulfill({ status: 503, json: { ok: false, error: 'busy' } });
      return;
    }
    if (controlBody.speed === 1.5 && !releasePendingControl) {
      await new Promise<void>(resolve => { releasePendingControl = resolve; });
    }
    await route.fulfill({ json: { ok: true, cardId: CARD_ID, ...controlBody, appliedPatternId: controlBody.patternId } });
  });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  projectFingerprint = await page.evaluate(async (projectId) => {
    const { createDefaultProject, migrateProject } = await import('/src/lib/projectModel.js');
    const { normalizeSavedLooks } = await import('/src/lib/sectionLookModel.js');
    const { cardProjectFingerprint } = await import('/src/lib/cardProjectResolver.js');
    const project = createDefaultProject();
    project.id = projectId;
    project.name = 'Drawer gallery project';
    project.layout.starterPending = false;
    project.devices.standaloneController.looks = normalizeSavedLooks([{
      id: 'moon-look', label: 'Moon look', defaultLook: { patternId: 'ocean', brightness: 0.7 }, sectionLooks: {},
    }]);
    project.devices.standaloneController.activeLookId = '';
    localStorage.clear();
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-drawer-card' }));
    localStorage.setItem('lw_autosave_v3', JSON.stringify(project));
    localStorage.setItem('lw_autosave_v3_backup', JSON.stringify(project));
    return cardProjectFingerprint(migrateProject(project));
  }, PROJECT_ID);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await verifyCard(page, projectFingerprint);

  const footer = page.getByTestId('card-link-status');
  await expect(footer).toHaveAccessibleName(/Gallery Lightweaver.*Connected/);
  await footer.click();
  const drawer = page.getByRole('dialog', { name: 'Gallery Lightweaver controls' });
  await expect(drawer).toBeVisible();

  const matchingProjectFingerprint = projectFingerprint;
  projectFingerprint = 'c'.repeat(64);
  await verifyCard(page, projectFingerprint);
  const blockedRequests = controlRequestCount;
  await expect(drawer.getByRole('slider', { name: 'Brightness' })).toBeDisabled();
  await expect(drawer).toContainText('exact card and installed project are verified');
  expect(controlRequestCount).toBe(blockedRequests);
  projectFingerprint = matchingProjectFingerprint;
  await verifyCard(page, projectFingerprint);
  await expect(drawer.getByRole('slider', { name: 'Brightness' })).toBeEnabled();

  await expect(drawer).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(drawer.getByRole('button', { name: 'Blackout' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const phoneBox = await drawer.boundingBox();
  expect(phoneBox).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopBox = await drawer.boundingBox();
  expect(desktopBox?.width).toBeLessThanOrEqual(430);
  expect(desktopBox?.height).toBe(800);
  expect(Math.round((desktopBox?.x || 0) + (desktopBox?.width || 0))).toBe(1280);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer.locator('select[aria-label="Pattern"]')).toHaveValue('bench-warm');
  const blackout = drawer.getByRole('button', { name: 'Blackout' });
  await expect(blackout).toHaveAttribute('aria-pressed', 'false');
  await drawer.getByRole('button', { name: 'Close card controls' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(blackout).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(footer).toBeFocused();
  await footer.click();
  await expect(drawer).toBeVisible();

  const speed = drawer.getByRole('slider', { name: 'Speed' });
  await speed.focus();
  await speed.fill('1.5');
  await expect.poll(() => Boolean(releasePendingControl)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
  await page.keyboard.press('Tab');
  await expect(drawer.getByRole('button', { name: 'Close card controls' })).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Shift+Tab');
  await expect(drawer.getByRole('button', { name: 'Close card controls' })).toBeFocused();
  releasePendingControl?.();
  await expect(speed).toBeEnabled();

  await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    getSharedCardLink().dispatch({ type: 'operation-failed' });
  });
  await expect(footer).toHaveAccessibleName(/Needs attention/);
  await expect(drawer.getByRole('slider', { name: 'Brightness' })).toBeDisabled();
  await drawer.getByRole('button', { name: 'Reconnect' }).click();
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toBeVisible();
  await page.getByRole('button', { name: 'Close connection center' }).click();
  await footer.click();
  await expect(page).toHaveURL(/#screen=card&section=setup/);
  await expect(page.getByRole('heading', { name: 'Set up your Lightweaver' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toHaveCount(0);
  await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    getSharedCardLink().dispatch({ type: 'operation-confirmed' });
  });
  await footer.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Warm palette' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Cool palette' })).toBeVisible();
  await expect(drawer.getByRole('checkbox', { name: 'Breathe' })).toHaveCount(0);
  const brightness = drawer.getByRole('slider', { name: 'Brightness' });
  await brightness.fill('40');
  await expect(drawer.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(brightness).toHaveValue('70');
  await drawer.getByRole('button', { name: 'Retry' }).click();
  await expect(brightness).toHaveValue('40');
  await drawer.getByRole('button', { name: 'Rainbow palette' }).click();
  await expect.poll(() => controlBody?.drift).toBe(true);
  expect(controlBody).toMatchObject({ driftMin: 0, driftMax: 255 });
  await expect(drawer.getByText(/GPIO|Wiring|Wi-?Fi|Firmware|Install|Reboot|Factory reset/i)).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Next pattern' }).click();
  await expect.poll(() => controlBody?.patternId).toBe('combo-moon-look');
  expect(controlBody?.syncZones).toBe(true);
  await expect(drawer.locator('select[aria-label="Pattern"]')).toHaveValue('combo-moon-look');
  await drawer.getByRole('button', { name: 'Advanced editing' }).click();
  await expect(page).toHaveURL(/#screen=pattern$/, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: /Moon look mix/i })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => new URL(page.url()).searchParams.has('editLook')).toBe(false);
});
