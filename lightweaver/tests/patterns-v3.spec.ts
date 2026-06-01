import { test, expect } from '@playwright/test';
import { createDefaultCircleLayout } from '../src/lib/defaultCircleLayout.js';
import { createDefaultPatchBoard } from '../src/lib/patchBoard.js';

async function setRangeValue(locator, value: string) {
  await locator.evaluate((node: HTMLInputElement, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(node, nextValue);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('v3 patterns show a chip-ready catalog with live local preview', async ({ page }) => {
  const controlRequests: unknown[] = [];
  const configRequests: unknown[] = [];
  await page.route('http://lightweaver.local/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('http://lightweaver.local/api/config', async route => {
    configRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.locator('.lw-look-card')).toHaveCount(30);
  await expect(page.locator('.lw-look-orbit')).toHaveCount(0);
  await expect(page.locator('.lw-look-led-field i')).not.toHaveCount(0);
  await expect(page.locator('.lw-pattern-led-preview canvas')).toBeVisible();
  await expect(page.getByText('30 chip-ready / 30 on knob')).toBeVisible();
  await expect(page.getByTestId('card-startup-label')).toHaveText('Aurora');

  await page.locator('button[data-pattern-id="ocean"]').click();

  await expect.poll(() => controlRequests.length).toBe(1);
  expect(controlRequests[0]).toMatchObject({ patternId: 'ocean', cancelStream: true });
  await expect(page.locator('.lw-look-card.is-previewing strong')).toHaveText('Ocean');
  await expect(page.getByText('Blue and teal rolling wave movement.')).toBeVisible();
  await expect(page.getByTestId('card-live-preview-label')).toHaveText('Ocean');
  await expect(page.getByTestId('card-startup-label')).toHaveText('Aurora');

  await page.getByRole('button', { name: 'Save to card' }).click();

  await expect.poll(() => configRequests.length).toBe(1);
  expect(configRequests[0]).toMatchObject({ startupPatternId: 'ocean' });
  await expect(page.getByTestId('card-startup-label')).toHaveText('Ocean');
});

test('v3 patterns saves section-specific combos that appear in Settings', async ({ page }) => {
  await page.route('http://lightweaver.local/api/control', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByTestId('section-target-patch-default-inner-circle').click();
  await expect(page.getByTestId('card-target-label')).toHaveText('Inner circle');

  await page.locator('button[data-pattern-id="ocean"]').click();
  await expect(page.locator('.lw-look-card.is-previewing strong')).toHaveText('Ocean');
  await page.getByTestId('save-current-combo').click();

  await expect(page.locator('.lw-saved-look-card', { hasText: 'Inner circle Ocean' })).toBeVisible();
  await page.getByText('Settings', { exact: true }).click();

  await expect(page.getByText('What the card will run')).toBeVisible();
  await expect(page.locator('section', { hasText: 'What the card will run' }).getByText('Inner circle', { exact: true })).toBeVisible();
  await page.getByText('Advanced').click();
  await expect(page.locator('textarea')).toContainText('"patternId": "ocean"');
});

test('v3 patterns keeps separate unsaved section choices before saving the combo', async ({ page }) => {
  await page.route('http://lightweaver.local/api/control', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByTestId('section-target-patch-default-outer-circle').click();
  await page.locator('button[data-pattern-id="ocean"]').click();
  await expect(page.getByTestId('section-target-patch-default-outer-circle')).toContainText('Ocean');

  await page.getByTestId('section-target-patch-default-inner-circle').click();
  await page.locator('button[data-pattern-id="sparkle"]').click();

  await expect(page.getByTestId('section-target-patch-default-outer-circle')).toContainText('Ocean');
  await expect(page.getByTestId('section-target-patch-default-inner-circle')).toContainText('Sparkle');

  await page.getByTestId('save-current-combo').click();
  await expect(page.locator('.lw-saved-look-card', { hasText: 'Outer circle Ocean + Inner circle Sparkle' })).toBeVisible();
  await page.getByText('Settings', { exact: true }).click();
  await page.getByText('Advanced').click();

  const config = JSON.parse(await page.locator('textarea').inputValue());
  const zonePatterns = Object.fromEntries(config.zones.map(zone => [zone.id, zone.patternId]));
  expect(zonePatterns['patch-default-outer-circle']).toBe('ocean');
  expect(zonePatterns['patch-default-inner-circle']).toBe('sparkle');
});

test('v3 patterns edits design target names and LED counts inline', async ({ page }) => {
  await page.route('http://lightweaver.local/api/control', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByTestId('section-target-name-patch-default-outer-circle').fill('Halo ring');
  await page.getByTestId('section-target-leds-patch-default-outer-circle').fill('30');
  await page.getByTestId('section-target-leds-patch-default-outer-circle').blur();

  await expect(page.getByTestId('section-target-name-patch-default-outer-circle')).toHaveValue('Halo ring');
  await expect(page.getByTestId('section-target-leds-patch-default-outer-circle')).toHaveValue('30');
  await expect(page.getByTestId('section-target-leds-all')).toHaveValue('52');

  await page.getByText('Settings', { exact: true }).click();
  await page.getByText('Advanced').click();
  const config = JSON.parse(await page.locator('textarea').inputValue());
  const editedZone = config.zones.find(zone => zone.id === 'patch-default-outer-circle');
  expect(editedZone.label).toBe('Halo ring');
  expect(editedZone.ranges).toEqual([{ start: 0, count: 30 }]);
  expect(config.led.pixels).toBe(52);
});

test('v3 patterns saves multiple outer and inner combos that can be re-applied', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('http://lightweaver.local/api/zones', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        syncZones: false,
        zones: [
          { id: 'patch-default-outer-circle', label: 'Outer circle', ranges: [{ start: 0, count: 22 }] },
          { id: 'patch-default-inner-circle', label: 'Inner circle', ranges: [{ start: 22, count: 22 }] },
        ],
      }),
    });
  });
  await page.route('http://lightweaver.local/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByTestId('section-target-patch-default-outer-circle').click();
  await page.locator('button[data-pattern-id="ocean"]').click();
  await page.getByTestId('section-target-patch-default-inner-circle').click();
  await page.locator('button[data-pattern-id="sparkle"]').click();
  await page.getByTestId('save-current-combo').click();

  await expect(page.locator('.lw-saved-look-card', { hasText: 'Outer circle Ocean + Inner circle Sparkle' })).toBeVisible();

  await page.getByTestId('section-target-patch-default-outer-circle').click();
  await page.locator('button[data-pattern-id="fire"]').click();
  await page.getByTestId('section-target-patch-default-inner-circle').click();
  await page.locator('button[data-pattern-id="ocean"]').click();
  await page.getByTestId('save-current-combo').click();

  await expect(page.locator('.lw-saved-look-card')).toHaveCount(2);
  await expect(page.locator('.lw-saved-look-card', { hasText: 'Outer circle Fire + Inner circle Ocean' })).toBeVisible();

  controlRequests.length = 0;
  await page.locator('.lw-saved-look-card', { hasText: 'Outer circle Ocean + Inner circle Sparkle' }).click();

  await expect(page.getByTestId('section-target-patch-default-outer-circle')).toContainText('Ocean');
  await expect(page.getByTestId('section-target-patch-default-inner-circle')).toContainText('Sparkle');
  await expect.poll(() => controlRequests.some(request => request.zone === 'patch-default-outer-circle' && request.patternId === 'ocean')).toBe(true);
  await expect.poll(() => controlRequests.some(request => request.zone === 'patch-default-inner-circle' && request.patternId === 'sparkle')).toBe(true);
  await expect(page.locator('.lw-chip-status')).toContainText('previewing on the card');
});

test('v3 patterns scales saved combos to four hardware sections', async ({ page }) => {
  const configRequests: Record<string, unknown>[] = [];
  const strips = createDefaultCircleLayout({ totalPixels: 80, sectionCount: 4 });
  const project = {
    version: 3,
    name: 'Four Ring Test',
    layout: {
      strips,
      viewBox: '0 0 640 400',
      svgText: null,
      hidden: {},
      layers: [],
      density: 60,
      pxPerMm: 3.7795,
      editCounts: {},
      layerGroups: [],
      layerOrder: [],
      patchBoard: createDefaultPatchBoard(strips),
    },
  };
  await page.addInitScript(savedProject => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(savedProject));
  }, project);
  await page.route('http://lightweaver.local/api/control', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('http://lightweaver.local/api/config', async route => {
    configRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('.lw-section-target')).toHaveCount(5);
  await expect(page.locator('.lw-combo-targets > span')).toHaveCount(4);

  await page.getByTestId('section-target-patch-default-outer-circle').click();
  await page.locator('button[data-pattern-id="ocean"]').click();
  await page.getByTestId('section-target-patch-default-inner-circle').click();
  await page.locator('button[data-pattern-id="sparkle"]').click();
  await page.getByTestId('section-target-patch-default-ring-3').click();
  await page.locator('button[data-pattern-id="fire"]').click();
  await page.getByTestId('section-target-patch-default-ring-4').click();
  await page.locator('button[data-pattern-id="calm"]').click();
  await page.getByTestId('save-current-combo').click();

  const savedCard = page.locator('.lw-saved-look-card').first();
  await expect(savedCard).toContainText('4-section combo');
  await expect(savedCard).toContainText('Ring 3: Fire');
  await expect(savedCard).toContainText('Ring 4: Calm');
  await expect(savedCard.locator('.lw-look-preview')).toHaveCount(3);
  await expect(savedCard.locator('.lw-saved-combo-overflow')).toContainText('+1');

  await savedCard.getByRole('button', { name: 'Load to card' }).click();
  await expect.poll(() => configRequests.length).toBe(1);
  const zonePatterns = Object.fromEntries(configRequests[0].zones.map(zone => [zone.id, zone.patternId]));
  expect(zonePatterns['patch-default-outer-circle']).toBe('ocean');
  expect(zonePatterns['patch-default-inner-circle']).toBe('sparkle');
  expect(zonePatterns['patch-default-ring-3']).toBe('fire');
  expect(zonePatterns['patch-default-ring-4']).toBe('calm');
});

test('v3 patterns includes searchable visual pattern browsing', async ({ page }) => {
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByPlaceholder('Search chip patterns').fill('ocean');

  await expect(page.locator('.lw-look-card')).toHaveCount(1);
  await expect(page.locator('button[data-pattern-id="ocean"]')).toBeVisible();
  await expect(page.getByText('1 shown')).toBeVisible();
});

test('v3 tuning controls show immediate values and send card-ready color modifiers', async ({ page }) => {
  const controlRequests: unknown[] = [];
  await page.route('http://lightweaver.local/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('button[data-pattern-id="ocean"]').click();
  await expect.poll(() => controlRequests.length).toBe(1);

  const tunedPreviewLed = page.locator('.lw-patterns-aside .lw-look-preview.is-large .lw-look-led-field i').first();
  const initialLedColor = await tunedPreviewLed.evaluate(node => getComputedStyle(node).getPropertyValue('--led-color').trim());

  await setRangeValue(page.getByTestId('look-hue-slider'), '160');
  await expect(page.getByTestId('look-hue-readout')).toHaveText('226 deg');
  await expect.poll(async () => (
    await tunedPreviewLed.evaluate(node => getComputedStyle(node).getPropertyValue('--led-color').trim())
  )).not.toBe(initialLedColor);

  await setRangeValue(page.getByTestId('look-saturation-slider'), '80');
  await expect(page.getByTestId('look-saturation-readout')).toHaveText('31%');

  await setRangeValue(page.getByTestId('look-brightness-slider'), '0.42');
  await expect(page.getByTestId('look-brightness-readout')).toHaveText('42%');

  await setRangeValue(page.getByTestId('look-speed-slider'), '1.75');
  await expect(page.getByTestId('look-speed-readout')).toHaveText('1.75x');

  await setRangeValue(page.getByTestId('look-hue-shift-slider'), '-24');
  await expect(page.getByTestId('look-hue-shift-readout')).toHaveText('-24');

  await expect.poll(() => controlRequests.some(request => {
    const body = request as Record<string, unknown>;
    return body.patternId === 'ocean'
      && body.hue === 160
      && body.saturation === 80
      && body.brightness === 0.42
      && body.speed === 1.75
      && body.hueShift === -24;
  })).toBe(true);
});

test('v3 patterns restores the WLED/live mirror geometry control', async ({ page }) => {
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('button', { name: 'Mirror' })).toBeVisible();
  await page.getByRole('button', { name: 'Mirror' }).click();

  await expect(page.locator('section', { hasText: 'Geometry' })).toContainText('mirror-hv');
  await expect(page.getByRole('button', { name: 'Top/bottom' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Left/right' })).toBeVisible();
});

test('v3 patterns previews on the whole card when the card has not loaded section zones yet', async ({ page }) => {
  const controlRequests: unknown[] = [];
  await page.route('http://lightweaver.local/api/zones', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        syncZones: true,
        zones: [{ id: 'all', label: 'All', ranges: [{ start: 0, count: 44 }] }],
      }),
    });
  });
  await page.route('http://lightweaver.local/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByTestId('section-target-patch-default-inner-circle').click();
  await page.locator('button[data-pattern-id="ocean"]').click();

  await expect.poll(() => controlRequests.length).toBe(1);
  expect(controlRequests[0]).toMatchObject({ patternId: 'ocean' });
  expect(controlRequests[0]).not.toHaveProperty('zone');
  await expect(page.locator('.lw-chip-status')).toContainText('whole card');
});

test('v3 patterns can apply the split zone config, then live-preview each section physically', async ({ page }) => {
  const configRequests: unknown[] = [];
  const controlRequests: unknown[] = [];
  let splitConfigApplied = false;

  await page.route('http://lightweaver.local/api/zones', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(splitConfigApplied
        ? {
            syncZones: false,
            zones: [
              { id: 'patch-default-outer-circle', label: 'Outer circle', ranges: [{ start: 0, count: 22 }] },
              { id: 'patch-default-inner-circle', label: 'Inner circle', ranges: [{ start: 22, count: 22 }] },
            ],
          }
        : {
            syncZones: true,
            zones: [{ id: 'all', label: 'All', ranges: [{ start: 0, count: 44 }] }],
          }),
    });
  });
  await page.route('http://lightweaver.local/api/config', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    configRequests.push(body);
    splitConfigApplied = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('http://lightweaver.local/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByTestId('section-target-patch-default-outer-circle').click();
  await page.locator('button[data-pattern-id="ocean"]').click();
  await page.getByTestId('section-target-patch-default-inner-circle').click();
  await page.locator('button[data-pattern-id="sparkle"]').click();

  await page.getByRole('button', { name: 'Apply split to card' }).click();

  await expect.poll(() => configRequests.length).toBe(1);
  expect(configRequests[0].syncZones).toBe(false);
  expect(configRequests[0].zones.map(zone => zone.id)).toEqual([
    'patch-default-outer-circle',
    'patch-default-inner-circle',
  ]);
  expect(Object.fromEntries(configRequests[0].zones.map(zone => [zone.id, zone.patternId]))).toMatchObject({
    'patch-default-outer-circle': 'ocean',
    'patch-default-inner-circle': 'sparkle',
  });
  await expect(page.locator('.lw-chip-status')).toContainText('Split preview is live');

  await page.getByTestId('section-target-patch-default-outer-circle').click();
  await page.locator('button[data-pattern-id="fire"]').click();

  await expect.poll(() => controlRequests.some(request => request.zone === 'patch-default-outer-circle' && request.patternId === 'fire')).toBe(true);
});
