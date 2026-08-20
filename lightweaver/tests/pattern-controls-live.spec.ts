import { expect, test } from '@playwright/test';

// End-to-end on the real canvas: the Patterns preview must animate, and the
// Color controls must move it in proportion to how far they were moved.
//
// The lurch this guards was structural. The color post-pass is skipped when hue
// and saturation sit exactly on their defaults, so everything the RGB->HSV->RGB
// trip lost landed in one lump on the first notch either control moved: with
// FastLED's rainbow ramp as the inverse, one notch recolored the strip about as
// far as thirty did. Comparing the two on screen is the assertion — an absolute
// threshold would only encode whatever this pattern happens to measure today.
//
// Speed's matching defect (`t * speed`, which teleports the pattern by
// `t * delta` and grows with uptime) is measured where it is visible without
// the preview's motion smoothing damping it: tests/preview-animation.mjs.

const SAMPLE = `(() => {
  const canvas = document.querySelector('[data-testid="pattern-piece-preview"] canvas');
  if (!canvas || !canvas.width) return null;
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  return Array.from(data);
})()`;

function drift(a: number[], b: number[]) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    count += 3;
  }
  return sum / count;
}

test('the Patterns preview animates and a Color notch moves it a notch worth', async ({ page }) => {
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  const saturation = page.getByTestId('look-saturation-slider');
  await expect(saturation).toBeVisible();
  await expect.poll(async () => await page.evaluate(SAMPLE) !== null).toBe(true);

  const first = await page.evaluate(SAMPLE) as number[];
  await page.waitForTimeout(700);
  expect(drift(first, await page.evaluate(SAMPLE) as number[]), 'the pattern preview must animate')
    .toBeGreaterThan(0);

  // Stopping the animation isolates the color change from ordinary motion, and
  // lets the preview's frame smoothing settle before either sample is taken.
  await page.getByTestId('look-speed-slider').evaluate((element: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, element.min);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const setSaturation = async (value: number) => {
    await saturation.evaluate((element: HTMLInputElement, next) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(element, String(next));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await page.waitForTimeout(600);
    return await page.evaluate(SAMPLE) as number[];
  };

  const neutral = await setSaturation(230);   // LW_DEFAULT_CUSTOM_SATURATION
  const oneNotch = drift(neutral, await setSaturation(229));
  const thirtyNotches = drift(neutral, await setSaturation(200));

  expect(thirtyNotches, `one notch moved ${oneNotch} and thirty moved ${thirtyNotches} — the control must not spend itself on the first notch`)
    .toBeGreaterThan(oneNotch * 3);
});
