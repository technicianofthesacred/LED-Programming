import { test, expect } from '@playwright/test';

// One line under a strip's controls does all the labelling: it describes the
// strip at rest and names whatever is under the pointer otherwise. Nothing in
// the panel carries a permanent word, so no word repeats down a list of strips.

async function oneStrip(page: any) {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('layout-primitive-picker').getByRole('button', { name: 'Create line' }).click();
  await expect(page.locator('.la-strip-row')).toHaveCount(1);
}

test('the caption describes the strip at rest and names what the mouse touches', async ({ page }) => {
  await oneStrip(page);
  const caption = page.locator('.la-strip-caption').first();
  await expect(caption).toHaveText('Data in at LED 1');

  await page.getByRole('button', { name: 'Flip path direction' }).first().hover();
  await expect(caption).toHaveText('Flip the drawing path so LED 1 swaps ends');

  await page.getByRole('button', { name: 'Duplicate strip' }).first().hover();
  await expect(caption).toHaveText('Duplicate this strip');

  // Off every labelled control, the line goes back to being about the strip.
  await page.locator('.panel-head').first().hover();
  await expect(caption).toHaveText('Data in at LED 1');
});

test('a touch names a control and the name stays up afterwards', async ({ page }) => {
  await oneStrip(page);
  const caption = page.locator('.la-strip-caption').first();

  const duplicate = page.getByRole('button', { name: 'Duplicate strip' }).first();
  await duplicate.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
  await expect(caption).toHaveText('Duplicate this strip');

  // No hover to leave, so the last thing named stays named.
  await duplicate.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
  await expect(caption).toHaveText('Duplicate this strip');
});

test('the size rule appears only while the count or size is touched', async ({ page }) => {
  await oneStrip(page);
  const caption = page.locator('.la-strip-caption').first();

  await page.getByLabel('Strip LED count', { exact: true }).hover();
  await expect(caption).toHaveText('Size sets the count. Editing LEDs keeps the size.');

  await page.getByLabel('Strip length in metres', { exact: true }).hover();
  await expect(caption).toHaveText('Size sets the count. Editing LEDs keeps the size.');
});

test('the caption reports the data-in end after reversing it', async ({ page }) => {
  await oneStrip(page);
  const caption = page.locator('.la-strip-caption').first();
  const leds = Number.parseInt(await page.locator('.la-strip-row .layer-len').first().innerText(), 10);

  await page.getByRole('button', { name: /Reverse data direction/ }).first().click();
  await page.locator('.panel-head').first().hover();
  await expect(caption).toHaveText(`Data in at LED ${leds}`);
});

test('hide sits on the strip row and does not close the open strip', async ({ page }) => {
  await oneStrip(page);
  await expect(page.locator('.la-strip-detail')).toHaveCount(1);

  const eye = page.locator('.la-strip-row .la-strip-row-eye').first();
  await expect(eye).toHaveAttribute('aria-label', 'Hide Line');
  await eye.click();

  await expect(eye).toHaveAttribute('aria-label', 'Show Line');
  await expect(page.locator('.la-strip-detail')).toHaveCount(1);
});

test('split joins duplicate and remove — the row with width to spare', async ({ page }) => {
  await oneStrip(page);
  await expect(page.getByLabel('Strip actions').locator('[data-testid^="split-strip-"]')).toHaveCount(1);
  // The count row had 10px spare and the button needs 36 — putting it there
  // pushed the size control past the panel edge.
  await expect(page.locator('.la-strip-physical-row [data-testid^="split-strip-"]')).toHaveCount(0);
});

// Every control added to this panel competes for one fixed width. This is the
// assertion that catches the next one that does not fit.
for (const width of [1280, 430]) {
  test(`the open strip panel fits its width at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await oneStrip(page);
    const overflowing = await page.evaluate(() => {
      const detail = document.querySelector('.la-strip-detail');
      const row = document.querySelector('.la-strip-row');
      return [...(detail ? detail.querySelectorAll('.actions, .row') : []), row, detail]
        .filter(Boolean)
        .map(el => ({ c: (el as HTMLElement).className, over: el!.scrollWidth - el!.clientWidth }))
        .filter(entry => entry.over > 1);
    });
    expect(overflowing).toEqual([]);
  });
}
