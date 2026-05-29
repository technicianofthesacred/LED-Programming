import { test, expect } from '@playwright/test';

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

test('v3 patterns saves section-specific Looks that appear in Load', async ({ page }) => {
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
  await page.locator('.lw-save-look-row button').click();

  await expect(page.locator('.lw-saved-look-card', { hasText: 'Inner circle Ocean' })).toBeVisible();
  await page.getByText('Load', { exact: true }).click();

  await expect(page.getByText('Sections in this load')).toBeVisible();
  await expect(page.locator('section', { hasText: 'Sections in this load' }).getByText('Inner circle', { exact: true })).toBeVisible();
  await expect(page.locator('textarea')).toContainText('"patternId": "ocean"');
});

test('v3 patterns keeps separate unsaved section choices before saving the Look', async ({ page }) => {
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

  await page.locator('.lw-save-look-row button').click();
  await page.getByText('Load', { exact: true }).click();

  const config = JSON.parse(await page.locator('textarea').inputValue());
  const zonePatterns = Object.fromEntries(config.zones.map(zone => [zone.id, zone.patternId]));
  expect(zonePatterns['patch-default-outer-circle']).toBe('ocean');
  expect(zonePatterns['patch-default-inner-circle']).toBe('sparkle');
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
