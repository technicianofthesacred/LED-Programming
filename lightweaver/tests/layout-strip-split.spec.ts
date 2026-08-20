import { test, expect } from '@playwright/test';

// Splitting one drawn strip into two named strips is the inverse of
// "Combine into one strip": the LED total never changes, and the second half
// lands directly after the first on the same output.

async function gotoFreshLayout(page: any) {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
}

// A freshly created strip is selected, so its actions are already open.
async function createOneStrip(page: any) {
  await page.getByTestId('layout-primitive-picker').getByRole('button', { name: 'Create line' }).click();
  await expect(page.locator('.la-strip-row')).toHaveCount(1);
  await expect(page.locator('[data-testid^="split-strip-"]')).toHaveCount(1);
}

// Autosave is debounced, so a reload assertion must wait for the write.
function savedStripNames(page: any) {
  return page.evaluate(() => (JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')
    ?.layout?.strips || []).map((strip: any) => strip.name));
}

function rowCounts(page: any) {
  return page.locator('.la-strip-row .layer-len').allTextContents()
    .then((texts: string[]) => texts.map(text => Number.parseInt(text, 10)));
}

test('splitting a strip makes two strips and keeps every LED', async ({ page }) => {
  await gotoFreshLayout(page);
  await createOneStrip(page);

  const [total] = await rowCounts(page);
  const head = Math.ceil(total / 2);

  const split = page.locator('[data-testid^="split-strip-"]');
  await expect(split).toBeEnabled();
  await expect(split).toHaveAttribute('title', new RegExp(`${head} LEDs \\+ ${total - head} LEDs`));
  await split.click();

  await expect(page.locator('.la-strip-row')).toHaveCount(2);
  expect(await rowCounts(page)).toEqual([head, total - head]);

  // Both halves stay on one output, in the order the data travels.
  await expect(page.locator('.la-gpio-group')).toHaveCount(1);
});

test('the second half is named after the first and survives a reload', async ({ page }) => {
  await gotoFreshLayout(page);
  await createOneStrip(page);

  const firstName = await page.locator('.la-strip-row .layer-name').first().innerText();
  await page.locator('[data-testid^="split-strip-"]').first().click();
  await expect(page.locator('.la-strip-row .layer-name')).toHaveText([firstName, `${firstName} 2`]);

  await expect.poll(() => savedStripNames(page)).toEqual([firstName, `${firstName} 2`]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.la-strip-row .layer-name')).toHaveText([firstName, `${firstName} 2`]);
  await expect(page.locator('.la-gpio-group')).toHaveCount(1);
});

test('a one-LED strip cannot be split', async ({ page }) => {
  await gotoFreshLayout(page);
  await createOneStrip(page);

  const count = page.locator('.la-strip-detail input[type="number"]').first();
  await count.fill('1');
  await count.blur();

  const split = page.locator('[data-testid^="split-strip-"]').first();
  await expect(split).toBeDisabled();
  await expect(split).toHaveAttribute('title', /at least 2 LEDs/);
});

test('a flipped strip splits at the same end it lights from', async ({ page }) => {
  await gotoFreshLayout(page);
  await createOneStrip(page);

  // Flipped strips light end-first, so the first half is the far end of the
  // drawn path — the cut has to mirror with it.
  await page.getByRole('button', { name: 'Flip path direction' }).first().click();

  const savedPixels = () => page.evaluate(() => (JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')
    ?.layout?.strips || []).map((strip: any) => [strip.pixels[0], strip.pixels[strip.pixels.length - 1]]));
  await expect.poll(() => savedPixels().then(list => list.length)).toBe(1);
  const [[firstLed, lastLed]] = await savedPixels();

  await page.locator('[data-testid^="split-strip-"]').first().click();
  await expect(page.locator('.la-strip-row')).toHaveCount(2);
  await expect.poll(() => savedPixels().then(list => list.length)).toBe(2);
  const [[headFirst], [, tailLast]] = await savedPixels();

  // LED 1 of the piece and its last LED have not moved.
  expect(Math.hypot(headFirst.x - firstLed.x, headFirst.y - firstLed.y)).toBeLessThan(2);
  expect(Math.hypot(tailLast.x - lastLed.x, tailLast.y - lastLed.y)).toBeLessThan(2);
});
