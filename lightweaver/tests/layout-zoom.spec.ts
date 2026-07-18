import { test, expect } from '@playwright/test';

async function svgPointAtClient(svg: any, clientX: number, clientY: number) {
  return svg.evaluate((element: SVGSVGElement, point: { x: number; y: number }) => {
    const matrix = element.getScreenCTM();
    if (!matrix) throw new Error('SVG screen transform unavailable');
    const svgPoint = element.createSVGPoint();
    svgPoint.x = point.x;
    svgPoint.y = point.y;
    const localPoint = svgPoint.matrixTransform(matrix.inverse());
    return { x: localPoint.x, y: localPoint.y };
  }, { x: clientX, y: clientY });
}

test('wheel zoom keeps the artwork point beneath an off-center cursor fixed', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  const svg = page.locator('.lw-viewport svg');
  await expect(svg).toBeVisible();
  const box = await svg.boundingBox();
  if (!box) throw new Error('layout canvas unavailable');

  const cursor = {
    x: box.x + box.width * 0.78,
    y: box.y + box.height * 0.31,
  };
  const before = await svgPointAtClient(svg, cursor.x, cursor.y);
  const initialViewBox = await svg.getAttribute('viewBox');

  await page.mouse.move(cursor.x, cursor.y);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(initialViewBox);

  const after = await svgPointAtClient(svg, cursor.x, cursor.y);
  // The rendered viewBox is rounded to hundredths, so sub-tenth SVG-unit
  // tolerance is tighter than a screen pixel while allowing that rounding.
  expect(Math.abs(after.x - before.x)).toBeLessThan(0.1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(0.1);
});
