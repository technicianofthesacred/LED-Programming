import { test, expect } from '@playwright/test';

async function createTwelveLedLine(page: any) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('kaleidoscope-test-initialized')) return;
    localStorage.clear();
    sessionStorage.setItem('kaleidoscope-test-initialized', 'true');
  });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  const picker = page.getByTestId('layout-primitive-picker');
  await picker.getByLabel('Starting strip LEDs').fill('12');
  await picker.getByRole('button', { name: 'Line', exact: true }).click();
  await picker.getByRole('button', { name: 'Create line' }).click();
  const row = page.locator('.la-strip-row');
  await expect(row).toBeVisible();
  if (await page.getByRole('group', { name: 'Strip actions' }).count() === 0) await row.click();
  await expect(page.getByRole('group', { name: 'Strip actions' })).toBeVisible();
}

test('Kaleidoscope editor exposes bounded count and per-point inline steppers', async ({ page }) => {
  await createTwelveLedLine(page);
  const actions = page.getByRole('group', { name: 'Strip actions' });
  await expect(actions.getByRole('button')).toHaveCount(7);
  await expect(actions.getByRole('button').allTextContents()).resolves.toEqual(['↔', '⇄', '◎', '✦', '', '', '×']);

  await page.getByRole('button', { name: 'Edit Kaleidoscope reflection points' }).click();
  await expect(page.getByTestId('kaleidoscope-summary')).toHaveText('4 points · start LED 1');
  const fineTune = page.getByRole('button', { name: 'Fine-tune LEDs' });
  await expect(fineTune).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Fine-tune reflection point 1' })).toHaveCount(0);
  const count = page.getByRole('group', { name: 'Reflection point count' });
  const countValue = page.getByTestId('kaleidoscope-count-value');
  const decreaseCount = count.getByRole('button', { name: 'Decrease reflection point count' });
  const increaseCount = count.getByRole('button', { name: 'Increase reflection point count' });
  await expect(count.getByRole('button')).toHaveCount(2);
  await expect(count.locator('input')).toHaveCount(0);
  await expect(countValue).toHaveClass(/btn la-stepper-value/);
  await expect(countValue).toHaveAttribute('aria-live', 'polite');
  await expect(countValue).toHaveText('4 points');
  await decreaseCount.click();
  await decreaseCount.click();
  await expect(countValue).toHaveText('2 points');
  await expect(decreaseCount).toBeDisabled();
  const disabledCountStyle = await decreaseCount.evaluate(button => {
    const style = getComputedStyle(button);
    return { opacity: Number(style.opacity), cursor: style.cursor };
  });
  expect(disabledCountStyle.opacity).toBeLessThan(1);
  expect(disabledCountStyle.cursor).not.toBe('pointer');
  for (let pointCount = 2; pointCount < 12; pointCount += 1) await increaseCount.click();
  await expect(countValue).toHaveText('12 points');
  await expect(increaseCount).toBeDisabled();
  await fineTune.click();
  const maxPointValues = page.getByRole('list', { name: 'Reflection points' })
    .getByRole('button', { name: /Fine-tune reflection point/ });
  const labelsBeforeCollision = await maxPointValues.allTextContents();
  const historyBeforeCollision = await page.getByTitle(/Undo/).getAttribute('title');
  await page.getByRole('button', { name: 'Move reflection point 2 forward one LED' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /cannot collide/i })).toBeVisible();
  expect(await maxPointValues.allTextContents()).toEqual(labelsBeforeCollision);
  await expect(page.getByTitle(/Undo/)).toHaveAttribute('title', historyBeforeCollision || '');
  await expect(page.getByRole('button', { name: 'Fine-tune reflection point 2' })).toHaveClass(/active/);
  await fineTune.click();
  for (let pointCount = 12; pointCount > 6; pointCount -= 1) await decreaseCount.click();
  await expect(page.getByTestId('kaleidoscope-summary')).toHaveText('6 points · start LED 1');

  await page.getByRole('button', { name: 'Move all reflection points forward one LED' }).click();
  await expect(page.getByTestId('kaleidoscope-summary')).toHaveText('6 points · start LED 2');
  await fineTune.click();
  await expect(fineTune).toHaveAttribute('aria-expanded', 'true');
  const reflectionPoints = page.getByRole('list', { name: 'Reflection points' }).getByRole('listitem');
  await expect(reflectionPoints).toHaveCount(6);
  for (const point of await reflectionPoints.all()) await expect(point.getByRole('button')).toHaveCount(3);
  const pointValues = reflectionPoints.getByRole('button', { name: /Fine-tune reflection point/ });
  await expect.poll(() => pointValues.evaluateAll(values => (
    values.every(value => value.scrollWidth <= value.clientWidth)
  ))).toBe(true);
  const labelsBeforeNudge = await pointValues.allTextContents();
  const pointTwo = reflectionPoints.nth(1);
  const pointTwoValue = pointTwo.getByRole('button', { name: 'Fine-tune reflection point 2' });
  await expect(pointTwoValue).toHaveText('2: LED 4');
  await pointTwo.getByRole('button', { name: 'Move reflection point 2 forward one LED' }).click();
  await expect(pointTwoValue).toHaveText('2: LED 5');
  expect(await pointValues.allTextContents()).toEqual(
    labelsBeforeNudge.map((label, index) => index === 1 ? '2: LED 5' : label),
  );
  await expect(pointTwoValue).toHaveClass(/active/);
  const pointOneValue = reflectionPoints.nth(0).getByRole('button', { name: 'Fine-tune reflection point 1' });
  const [inactiveStyle, activeStyle] = await Promise.all([
    pointOneValue.evaluate(button => {
      const style = getComputedStyle(button);
      return { color: style.color, background: style.backgroundColor, border: style.borderColor };
    }),
    pointTwoValue.evaluate(button => {
      const style = getComputedStyle(button);
      return { color: style.color, background: style.backgroundColor, border: style.borderColor };
    }),
  ]);
  expect(activeStyle.color).not.toBe(inactiveStyle.color);
  expect(activeStyle.background).not.toBe(inactiveStyle.background);
  expect(activeStyle.border).not.toBe(inactiveStyle.border);
  await expect(page.locator('[data-testid="kaleidoscope-marker"][data-point-index="1"]'))
    .toHaveAttribute('aria-label', 'Reflection point 2, LED 5');
  await expect(page.locator('[data-testid="kaleidoscope-marker"][data-point-index="1"]'))
    .toHaveClass(/selected/);
  await expect(page.getByRole('group', { name: 'Fine tune selected reflection point' })).toHaveCount(0);
  await expect(page.getByText('Custom spacing')).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss());
  await decreaseCount.click();
  await expect(page.getByTestId('kaleidoscope-summary')).toHaveText('6 points · start LED 2');
  page.once('dialog', dialog => dialog.accept());
  await decreaseCount.click();
  await expect(page.getByTestId('kaleidoscope-summary')).toHaveText('5 points · start LED 2');
  await fineTune.click();
  await expect(page.getByRole('button', { name: 'Fine-tune reflection point 1' })).toHaveCount(0);
  await expect(page.locator('[data-testid="kaleidoscope-marker"]')).toHaveCount(5);

  await page.getByRole('button', { name: 'Pick starting reflection point on canvas' }).click();
  await page.getByTestId('strip-led-strip-1-4').click();
  await expect(page.getByTestId('kaleidoscope-summary')).toContainText('start LED 5');

  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
    return saved?.layout?.strips?.[0]?.kaleidoscope?.pointCount;
  })).toBe(5);

  await page.reload({ waitUntil: 'domcontentloaded' });
  const row = page.locator('.la-strip-row');
  if (await page.getByRole('group', { name: 'Strip actions' }).count() === 0) await row.click();
  await page.getByRole('button', { name: 'Edit Kaleidoscope reflection points' }).click();
  await expect(page.getByTestId('kaleidoscope-summary')).toHaveText('5 points · start LED 5');
});

test('marker drag snaps after zoom and pan, rejects collision without consuming undo, and preserves locked wiring', async ({ page }) => {
  await createTwelveLedLine(page);
  await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem('lw_autosave_v3')))).toBe(true);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
    saved.layout.wiring.locked = true;
    saved.layout.wiring.verified = true;
    saved.layout.wiring.runs.forEach((run: any) => { run.verified = true; });
    localStorage.setItem('lw_autosave_v3', JSON.stringify(saved));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const row = page.locator('.la-strip-row');
  if (await page.getByRole('group', { name: 'Strip actions' }).count() === 0) await row.click();
  await page.getByRole('button', { name: 'Edit Kaleidoscope reflection points' }).click();
  await page.getByRole('button', { name: 'Fine-tune LEDs' }).click();
  await page.getByRole('button', { name: 'Fine-tune reflection point 2' }).click();

  await page.getByRole('button', { name: 'Zoom in' }).click();
  const canvas = page.locator('.lw-viewport svg');
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error('canvas unavailable');
  await page.keyboard.down('Space');
  await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 125, canvasBox.y + 115);
  await page.mouse.up();
  await page.keyboard.up('Space');

  const marker = page.locator('[data-testid="kaleidoscope-marker"]').nth(1);
  const collisionTarget = page.getByTestId('strip-led-strip-1-0');
  const acceptedTarget = page.getByTestId('strip-led-strip-1-4');
  const beforeUndo = Number((await page.getByTitle(/Undo/).getAttribute('title'))?.match(/· (\d+) step/)?.[1] || 0);
  const from = await marker.boundingBox();
  const collision = await collisionTarget.boundingBox();
  const accepted = await acceptedTarget.boundingBox();
  if (!from || !collision || !accepted) throw new Error('drag points unavailable');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(collision.x + collision.width / 2, collision.y + collision.height / 2);
  await page.mouse.move(accepted.x + accepted.width / 2, accepted.y + accepted.height / 2);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Fine-tune reflection point 2' })).toContainText('LED 5');
  const afterUndo = Number((await page.getByTitle(/Undo/).getAttribute('title'))?.match(/· (\d+) step/)?.[1] || 0);
  expect(afterUndo).toBe(beforeUndo + 1);
  await page.getByTitle(/Undo/).click();
  await expect(page.getByRole('button', { name: 'Fine-tune reflection point 2' })).toContainText('LED 4');

  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
    return [saved?.layout?.wiring?.locked, saved?.layout?.wiring?.verified];
  })).toEqual([true, true]);
});

test('calibration is active only for the selected strip in Draw mode and reports unavailable delivery honestly', async ({ page }) => {
  await createTwelveLedLine(page);
  await page.getByRole('button', { name: 'Edit Kaleidoscope reflection points' }).click();
  await page.getByRole('button', { name: 'Pick starting reflection point on canvas' }).click();
  const unavailable = page.getByText('Canvas updated · physical preview unavailable');
  await expect(unavailable).toBeVisible();

  await page.getByTestId('layout-add-strip').click();
  await page.getByTestId('layout-add-strip-chooser').getByRole('button', { name: 'Line', exact: true }).click();
  await expect(page.locator('.la-strip-row')).toHaveCount(2);
  await expect(unavailable).toHaveCount(0);

  const firstStrip = page.locator('.la-strip-row').first();
  await firstStrip.click();
  await firstStrip.click();
  await expect(unavailable).toBeVisible();
  await page.getByTestId('layout-mode-wire').click();
  await expect(unavailable).toHaveCount(0);
});

test('malformed saved Kaleidoscope metadata renders an actionable recovery warning', async ({ page }) => {
  await createTwelveLedLine(page);
  await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem('lw_autosave_v3')))).toBe(true);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
    saved.layout.strips[0].kaleidoscope = {
      enabled: true,
      pointCount: 4,
      startLed: 0,
      offsets: [0, -3, 0, 0],
    };
    const serialized = JSON.stringify(saved);
    localStorage.setItem('lw_autosave_v3', serialized);
    localStorage.setItem('lw_autosave_v3_backup', serialized);
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const warning = page.getByRole('alert').filter({ hasText: /reflection point cannot collide/i });
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Reset and edit' }).click();
  await expect(warning).toHaveCount(0);
  await expect(page.getByTestId('kaleidoscope-summary')).toHaveText('4 points · start LED 1');
});

test('Draw resize reports reflection points reset by count reprojection', async ({ page }) => {
  await createTwelveLedLine(page);
  await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem('lw_autosave_v3')))).toBe(true);
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
    saved.layout.strips[0].kaleidoscope = {
      enabled: true,
      pointCount: 3,
      startLed: 0,
      offsets: [-3, 2, -1],
    };
    const serialized = JSON.stringify(saved);
    localStorage.setItem('lw_autosave_v3', serialized);
    localStorage.setItem('lw_autosave_v3_backup', serialized);
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const row = page.locator('.la-strip-row');
  if (await page.getByRole('group', { name: 'Strip actions' }).count() === 0) await row.click();
  await page.getByRole('button', { name: 'Edit Kaleidoscope reflection points' }).click();
  await page.getByRole('button', { name: 'Make strip smaller' }).click();
  await expect(row).toContainText('11 LEDs');
  await expect(page.getByText('Count changed; reset point 3.')).toBeVisible();
});
