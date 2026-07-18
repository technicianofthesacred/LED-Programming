import { test, expect } from '@playwright/test';

async function gotoFreshLayout(page: any) {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function seedLegacyDefaultCircles(page: any) {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const circle = (id: string, name: string, radius: number, pixelCount: number) => ({
      id,
      name,
      pathData: `M ${320 - radius} 200 A ${radius} ${radius} 0 1 0 ${320 + radius} 200 A ${radius} ${radius} 0 1 0 ${320 - radius} 200 Z`,
      closed: true,
      pixelCount,
      generatedLayout: 'default-circle-v1',
      x: 0,
      y: 0,
      emit: 'omni',
      angle: 0,
      reversed: false,
      speed: 1,
      brightness: 1,
      hueShift: 0,
      patternId: null,
    });
    localStorage.clear();
    localStorage.setItem('lw_autosave_v3', JSON.stringify({
      version: 3,
      id: 'legacy-default-circles',
      name: 'Saved circle project',
      layout: {
        strips: [
          circle('default-outer-circle', 'Outer circle', 144, 27),
          circle('default-inner-circle', 'Inner circle', 64, 17),
        ],
        viewBox: '0 0 640 400',
        svgText: null,
        layers: [],
        density: 60,
        pxPerMm: 3.7795,
        patchBoard: null,
        wiring: null,
      },
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
}

test('a fresh layout offers primitive choices and creates a centered selected circle', async ({ page }) => {
  await gotoFreshLayout(page);

  const picker = page.getByTestId('layout-primitive-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Line', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByRole('button', { name: 'Circle', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Square', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Free draw', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Import SVG' })).toBeVisible();

  await picker.getByRole('button', { name: 'Circle', exact: true }).click();
  await picker.getByRole('button', { name: 'Create circle' }).click();

  await expect(picker).toHaveCount(0);
  await expect(page.locator('.la-strip-row')).toHaveCount(1);
  await expect(page.locator('.la-strip-row')).toContainText('Circle');
  await expect(page.locator('.la-strip-row')).toHaveClass(/sel/);
  const path = page.locator('path[data-strip-path]');
  await expect(path).toHaveCount(1);
  await expect(path).toHaveAttribute('d', /A/);
  const center = await path.evaluate((element: SVGGraphicsElement) => {
    const box = element.getBBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  expect(center.x).toBeCloseTo(320, 0);
  expect(center.y).toBeCloseTo(200, 0);

  await page.getByTestId('layout-mode-size').click();
  await expect(page.getByTestId('layout-size-panel')).toContainText('Circle');

  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
    return saved ? [saved.layout?.starterPending, saved.layout?.strips?.length] : null;
  })).toEqual([false, 1]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('layout-mode-draw').click();
  await expect(page.getByTestId('layout-primitive-picker')).toHaveCount(0);
  await expect(page.locator('.la-strip-row')).toHaveCount(1);
});

test('an untouched fresh starter survives autosave reload, but a saved legacy circle layout is never hidden', async ({ page }) => {
  await gotoFreshLayout(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_autosave_v3') !== null)).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-primitive-picker')).toBeVisible();
  await expect(page.locator('path[data-strip-path]')).toHaveCount(0);

  await seedLegacyDefaultCircles(page);
  await expect(page.getByTestId('layout-primitive-picker')).toHaveCount(0);
  await expect(page.locator('.la-strip-row')).toHaveCount(2);
  await expect(page.locator('path[data-strip-path]')).toHaveCount(2);
});

test('editing the seeded geometry clears starter provenance before reload', async ({ page }) => {
  await gotoFreshLayout(page);

  await page.getByTestId('layout-mode-size').click();
  await page.getByTestId('layout-size-density').getByRole('button', { name: '144' }).click();
  await page.getByTestId('layout-mode-draw').click();
  await expect(page.getByTestId('layout-primitive-picker')).toHaveCount(0);
  await expect(page.locator('.la-strip-row')).toHaveCount(2);

  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
    return saved ? [saved.layout?.starterPending, saved.layout?.strips?.length] : null;
  })).toEqual([false, 2]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-primitive-picker')).toHaveCount(0);
  await expect(page.locator('.la-strip-row')).toHaveCount(2);
});

test('importing artwork clears starter provenance before reload', async ({ page }) => {
  await gotoFreshLayout(page);

  await page.setInputFiles('input[accept=".svg"]', {
    name: 'imported-shape.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><g id="shape" data-name="Shape"><path d="M 100 200 H 540" fill="none" stroke="#fff"/></g></svg>'),
  });
  await expect(page.getByTestId('layout-primitive-picker')).toHaveCount(0);
  await expect(page.getByText('Artwork layers')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
    return saved ? [saved.layout?.starterPending, Boolean(saved.layout?.svgText)] : null;
  })).toEqual([false, true]);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-primitive-picker')).toHaveCount(0);
  await expect(page.getByText('Artwork layers')).toBeVisible();
});

test('Free draw keeps the existing manual path workflow', async ({ page }) => {
  await gotoFreshLayout(page);

  const picker = page.getByTestId('layout-primitive-picker');
  await picker.getByRole('button', { name: 'Free draw', exact: true }).click();
  await picker.getByRole('button', { name: 'Start drawing' }).click();

  await expect(page.locator('.la-draw-hint')).toContainText('Drawing mode');
  await expect(page.getByTitle('Draw a new LED strip path on the artwork.')).toHaveClass(/active/);
  await expect(page.locator('path[data-strip-path]')).toHaveCount(0);
});
