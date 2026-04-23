import { test, expect } from '@playwright/test';

test('glow has no dark lines — pixel score < 5%', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.lw-rail-btn', { hasText: 'Pattern' }).click();
  await page.waitForSelector('canvas', { timeout: 10000 });
  await page.waitForTimeout(3000);

  await page.screenshot({ path: 'test-results/glow-full.png' });

  const result = await page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    if (!canvas) return { score: -1, msg: 'no canvas' };
    const ctx = canvas.getContext('2d');
    if (!ctx) return { score: -1, msg: 'no ctx' };
    const { width, height } = canvas;
    if (!width || !height) return { score: -1, msg: `zero canvas: ${width}x${height}` };
    const d = ctx.getImageData(0, 0, width, height).data;
    let darkInGlow = 0, glowPixels = 0;
    const maxCh = (i: number) => Math.max(d[i], d[i+1], d[i+2]);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4;
        const b = (d[i] + d[i+1] + d[i+2]) / 3;
        const nb = Math.max(
          maxCh(((y-1)*width+x)*4),
          maxCh(((y+1)*width+x)*4),
          maxCh((y*width+(x-1))*4),
          maxCh((y*width+(x+1))*4),
        );
        if (nb > 60) { glowPixels++; if (b < 15) darkInGlow++; }
      }
    }
    return { score: glowPixels > 100 ? darkInGlow / glowPixels : 0, glowPixels, darkInGlow, width, height };
  });

  console.log('Result:', JSON.stringify(result));
  // Must have at least some glow (not a blank canvas)
  expect((result as any).glowPixels).toBeGreaterThan(100);
  // Dark line score must be under 5%
  expect((result as any).score).toBeLessThan(0.05);
});
