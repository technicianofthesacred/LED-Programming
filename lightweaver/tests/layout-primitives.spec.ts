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

test('"+ Add strip" offers icon tiles and sizes the new shape from the LEDs input', async ({ page }) => {
  await gotoFreshLayout(page);

  const picker = page.getByTestId('layout-primitive-picker');
  await picker.getByRole('button', { name: 'Create line' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.la-strip-row')).toHaveCount(1);

  const addButton = page.getByTestId('layout-add-strip');
  await expect(addButton).toBeVisible();
  await addButton.click();
  const chooser = page.getByTestId('layout-add-strip-chooser');
  // Five icon tiles: the four shapes plus the existing SVG import flow.
  await expect(chooser.getByRole('button', { name: 'Line', exact: true })).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Circle', exact: true })).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Square', exact: true })).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Free draw', exact: true })).toBeVisible();
  await expect(chooser.getByRole('button', { name: 'Import vector', exact: true })).toBeVisible();

  // The LEDs input is the ground truth: a 120-LED strip at 60 LEDs/m arrives
  // 2 m long — svgLength = (count / density) × 1000 mm × pxPerMm.
  await chooser.getByLabel('New strip LEDs').fill('120');
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

  const layout = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.layout);
  const circle = layout.strips.find((s: any) => s.name === 'Circle');
  expect(circle.pixelCount).toBe(120);
  const expectedLength = (120 / layout.density) * 1000 * layout.pxPerMm;
  expect(Math.abs(circle.svgLength - expectedLength)).toBeLessThan(1);

  // Import vector reuses the existing hidden SVG input (native file chooser).
  await addButton.click();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await chooser.getByRole('button', { name: 'Import vector', exact: true }).click();
  expect(await fileChooserPromise).toBeTruthy();
});

test('an expanded strip lets the maker choose its reel density', async ({ page }) => {
  await gotoFreshLayout(page);
  const picker = page.getByTestId('layout-primitive-picker');
  await picker.getByRole('button', { name: 'Circle', exact: true }).click();
  await picker.getByRole('button', { name: 'Create circle' }).click();

  const density = page.getByTestId('strip-density-control');
  await expect(density).toBeVisible();
  await expect(density.getByRole('button', { name: '60 LEDs/m' })).toHaveAttribute('aria-pressed', 'true');
  await density.getByRole('button', { name: '144 LEDs/m' }).click();

  await expect.poll(async () => {
    const layout = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.layout);
    const strip = layout?.strips?.[0];
    return strip ? layout.stripDensities?.[strip.id] : null;
  }).toBe(144);

  await expect(page.getByText(/Count follows size at this strip's density/)).toHaveCount(0);
});

test('physical strip values can be typed and density is chosen before creating a strip', async ({ page }) => {
  await gotoFreshLayout(page);

  const picker = page.getByTestId('layout-primitive-picker');
  await picker.getByLabel('Starting strip LEDs').fill('120');
  const starterDensity = page.getByTestId('primitive-density-control');
  await starterDensity.getByRole('button', { name: '96 LEDs/m' }).click();
  await picker.getByRole('button', { name: 'Circle', exact: true }).click();
  await picker.getByRole('button', { name: 'Create circle' }).click();

  await expect.poll(async () => {
    const layout = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.layout);
    const strip = layout?.strips?.[0];
    return strip ? [strip.pixelCount, layout.stripDensities?.[strip.id]] : null;
  }).toEqual([120, 96]);

  const size = page.getByLabel('Strip length in metres');
  await size.fill('0.5');
  await size.press('Tab');
  await expect.poll(async () => {
    const layout = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.layout);
    const strip = layout?.strips?.[0];
    return strip ? [strip.pixelCount, strip.svgLength / layout.pxPerMm / 1000] : null;
  }).toEqual([48, 0.5]);

  const ledCount = page.getByRole('spinbutton', { name: 'Strip LED count', exact: true });
  await ledCount.fill('60');
  await ledCount.press('Enter');
  await expect.poll(async () => {
    const strips = await readAutosaveStrips(page);
    return strips?.[0]?.pixelCount;
  }).toBe(60);
});

test('the Add strip chooser sets density before the new shape is drawn', async ({ page }) => {
  await gotoFreshLayout(page);
  await page.getByTestId('layout-primitive-picker').getByRole('button', { name: 'Create line' }).click();

  await page.getByTestId('layout-add-strip').click();
  const chooser = page.getByTestId('layout-add-strip-chooser');
  await chooser.getByLabel('New strip LEDs').fill('144');
  const density = page.getByTestId('add-strip-density-control');
  await density.getByRole('button', { name: '144 LEDs/m' }).click();
  await chooser.getByRole('button', { name: 'Circle', exact: true }).click();

  await expect.poll(async () => {
    const layout = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.layout);
    const strip = layout?.strips?.find((item: any) => item.name === 'Circle');
    return strip ? [strip.pixelCount, layout.stripDensities?.[strip.id]] : null;
  }).toEqual([144, 144]);
});

test('the physical creation controls keep LEDs, size, and density linked', async ({ page }) => {
  await gotoFreshLayout(page);

  const picker = page.getByTestId('layout-primitive-picker');
  await picker.getByLabel('Starting strip LEDs').fill('60');
  await picker.getByTestId('primitive-density-control').getByRole('button', { name: '30 LEDs/m' }).click();
  await expect(picker.getByLabel('Starting strip size in metres')).toHaveValue('2.00');
  await picker.getByLabel('Starting strip size in metres').fill('1.5');
  await picker.getByLabel('Starting strip size in metres').press('Tab');
  await expect(picker.getByLabel('Starting strip LEDs')).toHaveValue('45');
  await picker.getByRole('button', { name: 'Create line' }).click();

  await expect.poll(async () => {
    const layout = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.layout);
    const strip = layout?.strips?.[0];
    return strip ? [strip.pixelCount, layout.stripDensities?.[strip.id], strip.svgLength / layout.pxPerMm / 1000] : null;
  }).toEqual([45, 30, 1.5]);
});

test('the compact Add strip row links its size input to LEDs and density', async ({ page }) => {
  await gotoFreshLayout(page);
  await page.getByTestId('layout-primitive-picker').getByRole('button', { name: 'Create line' }).click();
  await page.getByTestId('layout-add-strip').click();

  const chooser = page.getByTestId('layout-add-strip-chooser');
  await chooser.getByLabel('New strip LEDs').fill('60');
  await chooser.getByTestId('add-strip-density-control').getByRole('button', { name: '30 LEDs/m' }).click();
  await expect(chooser.getByLabel('New strip size in metres')).toHaveValue('2.00');
  await chooser.getByLabel('New strip size in metres').fill('1.5');
  await chooser.getByLabel('New strip size in metres').press('Tab');
  await expect(chooser.getByLabel('New strip LEDs')).toHaveValue('45');
});

test('linked controls resize the strip while fine LED nudges preserve its size', async ({ page }) => {
  await gotoFreshLayout(page);
  await page.getByTestId('layout-primitive-picker').getByRole('button', { name: 'Create line' }).click();

  let starting: any = null;
  await expect.poll(async () => {
    const strips = await readAutosaveStrips(page);
    starting = strips?.[0] ?? null;
    return Boolean(starting?.svgLength > 0);
  }).toBe(true);

  await page.getByRole('button', { name: 'One LED more' }).click();
  await expect.poll(async () => {
    const strips = await readAutosaveStrips(page);
    const strip = strips?.[0];
    return strip ? [strip.pixelCount, strip.svgLength > starting.svgLength] : null;
  }).toEqual([starting.pixelCount + 1, true]);

  const linked = (await readAutosaveStrips(page))?.[0];
  await page.getByRole('button', { name: 'Fine tune 5 LEDs more' }).click();
  await expect.poll(async () => {
    const strips = await readAutosaveStrips(page);
    const strip = strips?.[0];
    return strip ? [strip.pixelCount, strip.svgLength] : null;
  }).toEqual([linked.pixelCount + 5, linked.svgLength]);

  const actions = page.getByLabel('Strip actions');
  await expect(actions.getByRole('button', { name: 'Reverse strip' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Duplicate strip' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Remove strip' })).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Calibrate scale from LED count' })).toHaveCount(0);
  await expect(page.getByText(/Drag on canvas to move/)).toHaveCount(0);
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

  // Physical-first: a non-pinned strip's LED count is re-derived from the new
  // length at the fixed density (count = length(m) × density) on every resize.
  const layout = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.layout);
  expect(after.pixelCount).toBe(
    Math.max(1, Math.round((after.svgLength / layout.pxPerMm) * layout.density / 1000)));

  // A hand-pinned count survives resize: pin it via the LEDs fine-tune input,
  // grow again, and the count must not recount.
  const count = page.getByRole('spinbutton', { name: 'Strip LED count', exact: true });
  await count.fill('60');
  await count.blur();
  await grow.click();
  await expect.poll(async () => {
    const strips = await readAutosaveStrips(page);
    const s = strips?.[0];
    return s ? [s.pixelCount, s.svgLength > after.svgLength * 1.05] : null;
  }).toEqual([60, true]);
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

  // The expanded row keeps the persisted physical length directly editable.
  await page.locator('.la-strip-row').click();
  const layout = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.layout);
  const meters = grown / layout.pxPerMm / 1000;
  const metersText = meters >= 10 ? meters.toFixed(1) : meters.toFixed(2);
  const readout = page.getByTestId('strip-size-readout');
  await expect(readout.getByRole('spinbutton', { name: 'Strip length in metres' })).toHaveValue(metersText);
  await expect(readout).toContainText('m');
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
