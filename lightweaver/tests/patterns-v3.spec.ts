import { test, expect } from '@playwright/test';
import { REAL_PATTERNS } from '../src/v3/v3-data.js';
import { createDefaultProject } from '../src/lib/projectModel.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';
import { prepareCardStoragePayload } from '../src/lib/cardStoragePayload.js';
import { CARD_PATTERN_BANK } from '../src/lib/cardPatternBank.js';

// These specs assert on the EXACT mockup PatternScreen that now ships
// (src/v3/lw-pattern.jsx). The DOM is the mockup's own: .pm wrapper, .pmcard
// browse cards, .pm-targetcard, .chips/.chip, and the testids
// that the live component exposes (save-current-combo,
// section-target-*, look-color-picker, look-*-slider/-readout, card-*-label).

async function setRangeValue(locator, value: string) {
  await locator.evaluate((node: HTMLInputElement, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(node, nextValue);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function gotoFreshPatterns(page) {
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function gotoSavedProjectPatterns(page, project) {
  await page.addInitScript((savedProject) => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(savedProject));
  }, project);
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
}

test('v3 patterns mounts the mockup shell with a chip-ready catalog', async ({ page }) => {
  await gotoFreshPatterns(page);

  // The mockup shell and the browse grid render.
  await expect(page.locator('.pm')).toBeVisible();
  await expect(page.locator('.pm-stripfinder')).toHaveCount(0);
  await expect(page.getByText('Strip finder', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try next order' })).toHaveCount(0);
  await expect(page.locator('.pm-targetcard')).toBeVisible();

  // The catalog starts with one exact 24-card batch.
  await expect(page.locator('.pm-cards .pmcard')).toHaveCount(24);
  await expect(page.locator('.sec-h .m').first()).toContainText(`of ${REAL_PATTERNS.length} chip-ready`);
});

test('first load reads warm (Lava Lamp) on a fresh, untitled project', async ({ page }) => {
  await gotoFreshPatterns(page);

  // The factory default look is aurora (green); on a fresh untitled project with
  // no saved looks the screen prefers the warm default for the INITIAL preview,
  // matching the mockup's Lava Lamp opening. Saved state is not mutated.
  await expect(page.getByTestId('card-live-preview-label')).toHaveText('Lava Lamp');
  await expect(page.getByTestId('card-startup-label')).toHaveText('Lava Lamp');
  await expect(page.getByTestId('card-live-preview-label')).not.toHaveText('Aurora');
});

test('search filters the browse grid', async ({ page }) => {
  await gotoFreshPatterns(page);

  await page.getByPlaceholder('Search chip patterns').fill('ocean');

  await expect(page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]')).toBeVisible();
  const shown = await page.locator('.pm-cards .pmcard').count();
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(REAL_PATTERNS.length);
  // Every visible card label matches the query.
  for (const name of await page.locator('.pm-cards .pmcard .pmcard-nm').allTextContents()) {
    expect(name.toLowerCase()).toContain('ocean');
  }
});

test('clicking a card updates the preview', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('**/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await gotoFreshPatterns(page);

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();

  // Selected card is marked, and the preview/labels reflect Ocean.
  await expect(page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]')).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('card-live-preview-label')).toHaveText('Ocean');
  await expect(page.locator('.pm-preview-pane')).toContainText('Ocean');
  // Live preview pushes the selected pattern to the card.
  await expect.poll(() => controlRequests.some(r => r.patternId === 'ocean')).toBe(true);
});

test('first local-card pattern click opens one bridge and sends only the newest selection', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('**/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.addInitScript(() => {
    (window as any).__bridgeOpenCalls = [];
    const bridge = { closed: false, postMessage: () => {} };
    window.open = ((url?: string | URL, name?: string) => {
      (window as any).__bridgeOpenCalls.push({ url: String(url || ''), name });
      return bridge as any;
    }) as typeof window.open;
  });
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_local_chip_default', '1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  await page.locator('.pm-cards .pmcard[data-pattern-id="plasma"]').click();
  await expect(page.getByTestId('card-live-preview-label')).toHaveText('Plasma');
  expect(await page.evaluate(() => (window as any).__bridgeOpenCalls)).toHaveLength(1);
  await page.waitForTimeout(150);
  expect(controlRequests).toHaveLength(0);

  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://lightweaver.local',
      data: {
        app: 'LightweaverCardBridge',
        type: 'ready',
        host: 'lightweaver.local',
        version: 1,
      },
    }));
  });

  await expect.poll(() => controlRequests.length).toBe(1);
  expect(controlRequests[0].patternId).toBe('plasma');
  expect(controlRequests.some(request => request.patternId === 'ocean')).toBe(false);
});

test('blocked automatic card window gives one concrete recovery action', async ({ page }) => {
  await page.addInitScript(() => {
    window.open = (() => null) as typeof window.open;
  });
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_local_chip_default', '1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();

  await expect(page.getByRole('alert')).toHaveText(
    'Allow the Lightweaver card window, then try the pattern again.',
  );
});

test('an older card bridge points to the single Flash recovery action', async ({ page }) => {
  await page.addInitScript(() => {
    const bridge = { closed: false, postMessage: () => {} };
    window.open = (() => bridge as any) as typeof window.open;
  });
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_local_chip_default', '1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://lightweaver.local',
      data: {
        app: 'LightweaverCardBridge',
        type: 'ready',
        host: 'lightweaver.local',
      },
    }));
  });

  await expect(page.getByRole('alert')).toHaveText(
    "This card is running older firmware that can't do this yet. Open Flash to update the card, then try again.",
  );
});

test('setup JSON copy and download use the same compact card payload', async ({ page }) => {
  const project = createDefaultProject();
  project.id = 'setup-json-fixture';
  project.name = 'Setup JSON fixture';
  const expected = prepareCardStoragePayload(buildCardRuntimePackageFromProject({
    projectId: project.id,
    projectName: project.name,
    strips: project.layout.strips,
    patchBoard: project.layout.patchBoard,
    standaloneController: project.devices.standaloneController,
  })).json;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => { (window as any).__copiedSetup = text; },
      },
    });
  });
  await gotoSavedProjectPatterns(page, project);

  await page.getByRole('button', { name: /Card tools/ }).click();
  await page.getByRole('menuitem', { name: /Copy setup/ }).click();
  const copied = await page.evaluate(() => (window as any).__copiedSetup || '');

  await page.getByRole('button', { name: /Card tools/ }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Download setup/ }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloaded = Buffer.concat(chunks).toString('utf8');

  expect(copied).toBe(downloaded);
  expect(copied).toBe(expected);
  expect(copied).not.toContain('\n');
  const config = JSON.parse(copied);
  expect(config.patterns).toBeUndefined();
  expect(config.controls?.encoder?.patternCycleIds).toBeUndefined();
});

test('oversized setup JSON stops copy and download before browser side effects', async ({ page }) => {
  const project = createDefaultProject();
  project.id = 'oversized-setup-fixture';
  project.name = 'Oversized setup fixture';
  const patterns = CARD_PATTERN_BANK.slice(0, 32);
  project.devices.standaloneController.playlist = patterns.map((pattern, order) => ({
    id: pattern.id,
    label: `${pattern.label} ${'oversized-label-'.repeat(24)}`,
    type: 'pattern',
    patternId: pattern.id,
    enabled: true,
    order,
  }));
  project.devices.standaloneController.controls.encoder.patternCycleIds = patterns.map(pattern => pattern.id);
  const runtimePackage = buildCardRuntimePackageFromProject({
    projectId: project.id,
    projectName: project.name,
    strips: project.layout.strips,
    patchBoard: project.layout.patchBoard,
    standaloneController: project.devices.standaloneController,
  });
  let capacityError: any = null;
  try {
    prepareCardStoragePayload(runtimePackage);
  } catch (error) {
    capacityError = error;
  }
  expect(capacityError?.reason).toBe('config-too-large');

  await page.addInitScript(() => {
    (window as any).__setupSideEffects = { clipboard: 0, objectUrl: 0, anchorClick: 0 };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => { (window as any).__setupSideEffects.clipboard += 1; },
      },
    });
    URL.createObjectURL = () => {
      (window as any).__setupSideEffects.objectUrl += 1;
      return 'blob:unexpected';
    };
    HTMLAnchorElement.prototype.click = function click() {
      (window as any).__setupSideEffects.anchorClick += 1;
    };
  });
  await gotoSavedProjectPatterns(page, project);

  await page.getByRole('button', { name: /Card tools/ }).click();
  await page.getByRole('menuitem', { name: /Copy setup/ }).click();
  await expect(page.getByText(capacityError.message, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__setupSideEffects)).toEqual({
    clipboard: 0,
    objectUrl: 0,
    anchorClick: 0,
  });

  await page.getByRole('button', { name: /Card tools/ }).click();
  await page.getByRole('menuitem', { name: /Download setup/ }).click();
  await expect(page.getByText(capacityError.message, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__setupSideEffects)).toEqual({
    clipboard: 0,
    objectUrl: 0,
    anchorClick: 0,
  });
});

test('Recover lights performs one complete recovery request', async ({ page }) => {
  const recoveries: Record<string, unknown>[] = [];
  await page.route('**/api/recover-lights', async route => {
    recoveries.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, recovered: true }) });
  });
  await gotoFreshPatterns(page);

  await page.getByTestId('recover-lights').click();
  await expect.poll(() => recoveries.length).toBe(1);
  await page.waitForTimeout(150);
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]).toMatchObject({ patternId: 'warm-white', brightness: 1, syncZones: true });
});

test('category chips filter the grid', async ({ page }) => {
  await gotoFreshPatterns(page);

  // Let the full grid settle before measuring (auto-retrying assertion).
  await expect(page.locator('.pm-cards .pmcard')).toHaveCount(24);
  const allCount = await page.locator('.pm-cards .pmcard').count();

  // Pick the Water category chip in the browse tools.
  await page.locator('.pt-tools .chips .chip', { hasText: 'Water' }).click();

  // The grid shrinks to just the Water-category patterns.
  await expect.poll(() => page.locator('.pm-cards .pmcard').count()).toBeLessThan(allCount);
  const waterCount = await page.locator('.pm-cards .pmcard').count();
  expect(waterCount).toBeGreaterThan(0);
  await expect(page.locator('.pt-tools .chips .chip.on')).toHaveText('Water');
});

test('a slider changes its readout and sends a tuned color modifier', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('**/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await gotoFreshPatterns(page);

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();

  // Brightness slider readout follows the input value.
  await setRangeValue(page.getByTestId('look-brightness-slider'), '0.42');
  await expect(page.getByTestId('look-brightness-readout')).toHaveText('42%');

  // Speed slider readout follows the input value.
  await setRangeValue(page.getByTestId('look-speed-slider'), '1.75');
  await expect(page.getByTestId('look-speed-readout')).toHaveText('1.75×');

  // The hue spectrum slider readout updates too.
  await setRangeValue(page.getByTestId('look-hue-slider'), '160');
  await expect(page.getByTestId('look-hue-readout')).toContainText('°');

  // The tuned look is pushed to the card.
  await expect.poll(() => controlRequests.some(r => (
    r.patternId === 'ocean' && r.brightness === 0.42 && r.speed === 1.75
  ))).toBe(true);
});

test('the advanced hue-shift slider exposes its testids', async ({ page }) => {
  await gotoFreshPatterns(page);

  await page.locator('.pmx-advanced summary').click();
  await setRangeValue(page.getByTestId('look-hue-shift-slider'), '-24');
  await expect(page.getByTestId('look-hue-shift-readout')).toHaveText('-24');
});

test('saving the current look as a mix adds a mix card to the grid', async ({ page }) => {
  await page.route('**/api/control', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await gotoFreshPatterns(page);

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  const before = await page.locator('.pm-cards .pmcard').count();

  await page.getByTestId('save-current-combo').click();

  // A new mix card (tagged 'mix') appears in the grid.
  await expect(page.locator('.pm-cards .pmcard .mixtag')).toHaveCount(1);
  await expect(page.locator('.pm-cards .pmcard')).toHaveCount(before);
});

test('the mirror geometry control switches the active geometry', async ({ page }) => {
  await gotoFreshPatterns(page);

  await page.locator('.geo-seg').getByRole('button', { name: 'Mirror' }).click();

  await expect(page.locator('.geo-seg button.on')).toHaveText(/Mirror/);
});
