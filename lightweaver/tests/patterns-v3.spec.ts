import { test, expect } from '@playwright/test';
import { REAL_PATTERNS } from '../src/v3/v3-data.js';

// These specs assert on the EXACT mockup PatternScreen that now ships
// (src/v3/lw-pattern.jsx). The DOM is the mockup's own: .pm wrapper, .pmcard
// browse cards, .pm-targetcard, .pm-stripfinder, .chips/.chip, and the testids
// that the live component exposes (strip-color-order, save-current-combo,
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

test('v3 patterns mounts the mockup shell with a chip-ready catalog', async ({ page }) => {
  await gotoFreshPatterns(page);

  // The mockup shell and the browse grid render.
  await expect(page.locator('.pm')).toBeVisible();
  await expect(page.locator('.pm-stripfinder')).toBeVisible();
  await expect(page.locator('.pm-targetcard')).toBeVisible();

  // Every chip-ready pattern renders as a .pmcard (no load-more in this DOM).
  await expect(page.locator('.pm-cards .pmcard')).toHaveCount(REAL_PATTERNS.length);
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
  await expect(page.getByText('Blue and teal rolling wave movement.')).toBeVisible();
  // Live preview pushes the selected pattern to the card.
  await expect.poll(() => controlRequests.some(r => r.patternId === 'ocean')).toBe(true);
});

test('category chips filter the grid', async ({ page }) => {
  await gotoFreshPatterns(page);

  // Let the full grid settle before measuring (auto-retrying assertion).
  await expect(page.locator('.pm-cards .pmcard')).toHaveCount(REAL_PATTERNS.length);
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

test('the strip finder order pill cycles to the next color order', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('**/api/status', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, led: { pixels: 44, colorOrder: 'RGB' }, wifi: { ip: 'lightweaver.local' } }),
    });
  });
  await page.route('**/api/control', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    controlRequests.push(body);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, colorOrder: body.colorOrder || 'RGB' }),
    });
  });
  await page.route('**/api/recover-lights', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await gotoFreshPatterns(page);

  await expect(page.getByTestId('strip-color-order')).toHaveText('RGB');
  await page.locator('.pm-stripfinder').getByRole('button', { name: 'Try next order' }).click();

  await expect(page.getByTestId('strip-color-order')).toHaveText('GRB');
  await expect.poll(() => controlRequests.some(r => r.colorOrder === 'GRB')).toBe(true);
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
  await expect(page.locator('.pm-cards .pmcard')).toHaveCount(before + 1);
});

test('the mirror geometry control switches the active geometry', async ({ page }) => {
  await gotoFreshPatterns(page);

  await page.locator('.geo-seg').getByRole('button', { name: 'Mirror' }).click();

  await expect(page.locator('.geo-seg button.on')).toHaveText(/Mirror/);
});
