import { test, expect } from '@playwright/test';

const DRAG_SVG = 'e2e/fixtures/drag-section.svg';

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

test('dragging an imported section keeps its vector, LEDs, and artwork aligned', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.locator('input#file-input').setInputFiles(DRAG_SVG);

  const layerRow = page.locator('#artwork-layers-list .alr-row.alr-layer[data-layer-id="wave-layer"]');
  await expect(layerRow).toHaveCount(1, { timeout: 5000 });
  await layerRow.click();
  await page.locator('#inspector-add-btn').click();
  await page.waitForSelector('#strips-layer g[data-strip-id] path', { state: 'attached' });

  const measure = () =>
    page.evaluate(() => {
      const svg = document.querySelector<SVGSVGElement>('#drawing-canvas');
      const stripGroup = document.querySelector<SVGGElement>('#strips-layer g[data-strip-id]');
      const stripPath = stripGroup?.querySelector<SVGPathElement>('path');
      const artPath = document.querySelector<SVGPathElement>('#imported-svg #wave-layer path');
      const dotsGroup = Array.from(stripGroup?.children ?? []).find(
        (el) => el.tagName.toLowerCase() === 'g' && !el.classList.contains('connector'),
      ) as SVGGElement | undefined;
      const firstDot = dotsGroup?.querySelector<SVGCircleElement>('circle');

      if (!svg || !stripPath || !artPath || !firstDot) {
        throw new Error('Expected strip path, artwork path, and LED dot to exist.');
      }

      const toScreen = (el: SVGGraphicsElement, x: number, y: number) => {
        const point = svg.createSVGPoint();
        point.x = x;
        point.y = y;
        const screenPoint = point.matrixTransform(el.getScreenCTM()!);
        return { x: screenPoint.x, y: screenPoint.y };
      };

      const stripStart = stripPath.getPointAtLength(0);
      const artStart = artPath.getPointAtLength(0);
      return {
        strip: toScreen(stripPath, stripStart.x, stripStart.y),
        dot: toScreen(
          firstDot,
          Number(firstDot.getAttribute('cx')),
          Number(firstDot.getAttribute('cy')),
        ),
        artwork: toScreen(artPath, artStart.x, artStart.y),
      };
    });

  const before = await measure();

  const dragStart = await page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>('#drawing-canvas');
    const hitPath = document.querySelector<SVGPathElement>('#strips-layer g[data-strip-id] path:nth-of-type(2)');
    if (!svg || !hitPath) throw new Error('Expected strip hit path to exist.');
    const point = hitPath.getPointAtLength(hitPath.getTotalLength() * 0.5);
    const screenPoint = svg.createSVGPoint();
    screenPoint.x = point.x;
    screenPoint.y = point.y;
    const transformed = screenPoint.matrixTransform(hitPath.getScreenCTM()!);
    return { x: transformed.x, y: transformed.y };
  });

  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 80, dragStart.y + 35, { steps: 8 });
  await page.mouse.up();

  const after = await measure();

  expect(distance(before.strip, before.dot)).toBeLessThan(1);
  expect(distance(before.strip, before.artwork)).toBeLessThan(1);
  expect(distance(before.strip, after.strip)).toBeGreaterThan(20);
  expect(distance(after.strip, after.dot)).toBeLessThan(1);
  expect(distance(after.strip, after.artwork)).toBeLessThan(1);
});
