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

async function readAutosaveStrips(page: any) {
  return page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
    return saved?.layout?.strips ?? null;
  });
}

test('"+ Add strip" adds a second primitive without touching Duplicate', async ({ page }) => {
  await gotoFreshLayout(page);

  const picker = page.getByTestId('layout-primitive-picker');
  await picker.getByRole('button', { name: 'Create line' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.la-strip-row')).toHaveCount(1);

  const addButton = page.getByTestId('layout-add-strip');
  await expect(addButton).toBeVisible();
  await addButton.click();
  const chooser = page.getByTestId('layout-add-strip-chooser');
  await expect(chooser.getByRole('button', { name: 'Line', exact: true })).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Square', exact: true })).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Free draw', exact: true })).toBeVisible();
  await chooser.getByRole('button', { name: 'Circle', exact: true }).click();

  await expect(page.locator('.la-strip-row')).toHaveCount(2);
  await expect(page.locator('.la-strip-row').filter({ hasText: 'Circle' })).toHaveCount(1);
  await expect(page.locator('path[data-strip-path]')).toHaveCount(2);

  // The new strip is nudged so it never lands exactly on the first one.
  await expect.poll(async () => {
    const strips = await readAutosaveStrips(page);
    const circle = strips?.find((s: any) => s.name === 'Circle');
    return circle ? [circle.x, circle.y] : null;
  }).toEqual([24, 24]);
});

test('the Size + control grows a strip ~23% about a fixed center', async ({ page }) => {
  await gotoFreshLayout(page);
  await page.getByTestId('layout-primitive-picker').getByRole('button', { name: 'Create line' }).click();
  await expect(page.locator('.la-strip-row')).toHaveCount(1);

  // Starter creation leaves the row detail expanded; wait for the autosave baseline.
  const grow = page.getByRole('button', { name: 'Make strip bigger' });
  await expect(grow).toBeVisible();
  let before: any = null;
  await expect.poll(async () => {
    const strips = await readAutosaveStrips(page);
    before = strips?.[0] ?? null;
    return Boolean(before?.svgLength > 0 && before?.pixels?.length > 1);
  }).toBe(true);

  await grow.click();
  await grow.click();

  let after: any = null;
  await expect.poll(async () => {
    const strips = await readAutosaveStrips(page);
    after = strips?.[0] ?? null;
    return Boolean(after?.svgLength > before.svgLength * 1.2);
  }).toBe(true);

  // Two ×(1/0.9) grows = ×1.2346 ≈ +23%.
  const ratio = after.svgLength / before.svgLength;
  expect(ratio).toBeGreaterThan(1.21);
  expect(ratio).toBeLessThan(1.26);

  // Sampled pixels actually spread apart on the canvas.
  const endpointSpread = (s: any) => {
    const first = s.pixels[0];
    const last = s.pixels[s.pixels.length - 1];
    return Math.hypot(last.x - first.x, last.y - first.y);
  };
  expect(endpointSpread(after)).toBeGreaterThan(endpointSpread(before) * 1.2);

  // …while the on-screen center stays put (within 2px).
  const endpointCenter = (s: any) => {
    const first = s.pixels[0];
    const last = s.pixels[s.pixels.length - 1];
    return { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
  };
  const centerBefore = endpointCenter(before);
  const centerAfter = endpointCenter(after);
  expect(Math.abs(centerAfter.x - centerBefore.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(centerAfter.y - centerBefore.y)).toBeLessThanOrEqual(2);
});

test('resized geometry persists across reload', async ({ page }) => {
  await gotoFreshLayout(page);
  await page.getByTestId('layout-primitive-picker').getByRole('button', { name: 'Create line' }).click();

  const grow = page.getByRole('button', { name: 'Make strip bigger' });
  await grow.click();
  await grow.click();
  let grown = 0;
  await expect.poll(async () => {
    const strips = await readAutosaveStrips(page);
    grown = strips?.[0]?.svgLength ?? 0;
    return grown > 450; // starter line is 384px; ×1.2346 ≈ 474
  }).toBe(true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.la-strip-row')).toHaveCount(1);

  // Autosaved geometry survived the reload…
  await expect.poll(async () => {
    const strips = await readAutosaveStrips(page);
    return Math.round(strips?.[0]?.svgLength ?? 0);
  }).toBe(Math.round(grown));

  // …and the on-canvas path really is the scaled one (horizontal line: bbox width = length).
  const width = await page.locator('path[data-strip-path]').evaluate(
    (element: SVGGraphicsElement) => element.getBBox().width);
  expect(Math.abs(width - grown)).toBeLessThan(2);

  // The expanded row's Size readout shows the persisted length.
  await page.locator('.la-strip-row').click();
  await expect(page.getByTestId('strip-size-readout')).toHaveText(`${Math.round(grown)} px`);
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
