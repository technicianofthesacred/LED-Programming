import { test, expect } from '@playwright/test';

// The owner picks the chipset when starting a piece, and can still change it
// afterwards. It is one value for the whole card, so it lives on the project,
// not on a strip.

async function gotoFreshLayout(page: any) {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
}

function savedLedType(page: any) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')
    ?.devices?.standaloneController?.led?.type ?? null);
}

test('the layout starter offers both card chipsets and nothing else', async ({ page }) => {
  await gotoFreshLayout(page);

  const picker = page.getByTestId('layout-primitive-picker');
  await expect(picker).toBeVisible();
  const chipset = picker.getByTestId('led-chipset-control');
  await expect(chipset).toBeVisible();
  await expect(chipset.getByRole('button')).toHaveText(['WS2812B', 'WS2815']);
  await expect(picker.getByTestId('led-chipset-hint')).toContainText('stages it and asks you to confirm');
});

test('a chipset picked in the starter persists into the project and reaches the strips list', async ({ page }) => {
  await gotoFreshLayout(page);

  const picker = page.getByTestId('layout-primitive-picker');
  await expect(picker.getByTestId('led-chipset-WS2815')).toHaveAttribute('aria-pressed', 'true');

  await picker.getByTestId('led-chipset-WS2812B').click();
  await expect(picker.getByTestId('led-chipset-WS2812B')).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByTestId('led-chipset-WS2815')).toHaveAttribute('aria-pressed', 'false');

  await picker.getByRole('button', { name: 'Create line' }).click();

  // The starter is gone, but the choice stays editable next to the LED total.
  await expect(page.getByTestId('layout-primitive-picker')).toHaveCount(0);
  const projectChipset = page.getByTestId('project-led-chipset');
  await expect(projectChipset).toBeVisible();
  await expect(projectChipset.getByTestId('led-chipset-WS2812B')).toHaveAttribute('aria-pressed', 'true');

  await expect.poll(() => savedLedType(page)).toBe('WS2812B');
});

test('changing the chipset after the layout exists survives a reload', async ({ page }) => {
  await gotoFreshLayout(page);
  await page.getByTestId('layout-primitive-picker').getByRole('button', { name: 'Create line' }).click();

  const projectChipset = page.getByTestId('project-led-chipset');
  await expect(projectChipset.getByTestId('led-chipset-WS2815')).toHaveAttribute('aria-pressed', 'true');
  await projectChipset.getByTestId('led-chipset-WS2812B').click();
  await expect.poll(() => savedLedType(page)).toBe('WS2812B');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-led-chipset').getByTestId('led-chipset-WS2812B'))
    .toHaveAttribute('aria-pressed', 'true');
});

test('a project saved with no chipset loads on a supported one instead of failing', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_autosave_v3', JSON.stringify({
      version: 3,
      id: 'legacy-no-chipset',
      name: 'Saved before the chipset picker',
      layout: {
        strips: [{
          id: 'legacy-line',
          name: 'Legacy line',
          pathData: 'M 120 200 L 520 200',
          closed: false,
          pixelCount: 30,
          x: 0, y: 0, emit: 'omni', angle: 0, reversed: false,
          speed: 1, brightness: 1, hueShift: 0, patternId: null,
        }],
        viewBox: '0 0 640 400',
        svgText: null,
        layers: [],
        density: 60,
        pxPerMm: 3.7795,
        patchBoard: null,
        wiring: null,
      },
      devices: { standaloneController: { led: { colorOrder: 'GRB' } } },
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const projectChipset = page.getByTestId('project-led-chipset');
  await expect(projectChipset).toBeVisible();
  await expect(projectChipset.getByRole('button', { name: /WS2815/ })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => savedLedType(page)).toBe('WS2815');
});
