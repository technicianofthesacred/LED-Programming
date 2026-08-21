import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SVG_UNITS_PER_MM = 3.7795;
const FIVE_METRES_MM = 5000;
const FIVE_METRES_SVG_UNITS = FIVE_METRES_MM * SVG_UNITS_PER_MM;

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

test('toolbar zoom travels below the former 15% limit', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  const zoomOut = page.getByTitle('Zoom out (-)');
  for (let index = 0; index < 12; index += 1) await zoomOut.click();

  const visibleWidth = Number((await page.locator('.lw-viewport svg').getAttribute('viewBox'))?.split(/\s+/)[2]);
  expect(visibleWidth).toBeGreaterThan(640 / 0.1);
});

test('toolbar shows an accessible non-live zoom percentage', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  const percentage = page.getByTestId('layout-zoom-percentage');
  await expect(percentage).toHaveText(/^\d+%$/);
  await expect(percentage).not.toHaveAttribute('role', 'status');
  await expect(percentage).not.toHaveAttribute('aria-live');
  await expect(percentage).toHaveAttribute('aria-label', /^Zoom \d+%$/);
  const before = Number((await percentage.textContent())?.replace('%', ''));

  await page.getByTitle('Zoom out (-)').click();
  await expect.poll(async () => Number((await percentage.textContent())?.replace('%', ''))).toBeLessThan(before);
});

test('a subtle canvas control fits the complete board', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  const svg = page.locator('.lw-viewport svg');
  const fitBoard = page.locator('.body').getByRole('button', { name: 'Fit board' });
  await expect(fitBoard).toBeVisible();
  await expect(fitBoard).toHaveAttribute('title', 'Fit board (F, Cmd/Ctrl+0)');
  await expect(fitBoard).toHaveCSS('opacity', '1');

  await page.getByRole('button', { name: 'Fit all' }).click();
  const fittedViewBox = await svg.getAttribute('viewBox');
  await page.getByTitle('Zoom in (+)').click();
  await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(fittedViewBox);

  await fitBoard.click();
  await expect.poll(() => svg.getAttribute('viewBox')).toBe(fittedViewBox);
});

test('the canvas Fit board control remains keyboard-operable', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  const svg = page.locator('.lw-viewport svg');
  const fitBoard = page.locator('.body').getByRole('button', { name: 'Fit board' });
  await page.getByRole('button', { name: 'Fit all' }).click();
  const fittedViewBox = await svg.getAttribute('viewBox');
  await page.getByTitle('Zoom in (+)').click();
  await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(fittedViewBox);

  await fitBoard.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => svg.getAttribute('viewBox')).toBe(fittedViewBox);
});

test('Fit all frames artwork geometry outside the imported viewBox', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-fit-all-'));
  const fixture = path.join(tmp, 'five-metre-strip.svg');
  fs.writeFileSync(fixture, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
  <g id="long-strip" data-name="Five metre strip">
    <path d="M 0 200 H ${FIVE_METRES_SVG_UNITS}" fill="none" stroke="#fff" stroke-width="2"/>
  </g>
</svg>`);

  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  // Wait for the artwork to actually be in the document before fitting. Reading
  // the file is async, and on a slower host the import lands AFTER this click —
  // so "Fit all" framed an empty canvas, the fitted viewBox captured below was
  // the empty-canvas one, and the later reset (which fits the real artwork)
  // could never match it. That is exactly how this spec failed in CI while
  // passing locally: the expected string in the CI log is the pre-import view.
  await expect(page.locator('[data-artwork-path-id]').first()).toBeAttached();

  await page.getByRole('button', { name: 'Fit all' }).click();
  const canvasBox = await page.locator('.lw-viewport svg').boundingBox();
  const artworkBox = await page.locator('[data-artwork-path-id="long-strip-p0"]').boundingBox();
  if (!canvasBox || !artworkBox) throw new Error('layout fit geometry unavailable');

  expect(artworkBox.x).toBeGreaterThan(canvasBox.x);
  expect(artworkBox.x + artworkBox.width).toBeLessThan(canvasBox.x + canvasBox.width);
});

test('Cmd/Ctrl+0 prevents browser zoom and fits all content', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-shortcut-fit-'));
  const fixture = path.join(tmp, 'five-metre-shortcut.svg');
  fs.writeFileSync(fixture, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
  <g id="shortcut-strip" data-name="Five metre shortcut strip">
    <path d="M 0 200 H ${FIVE_METRES_SVG_UNITS}" fill="none" stroke="#fff" stroke-width="2"/>
  </g>
</svg>`);

  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  // Wait for the artwork to actually be in the document before fitting. Reading
  // the file is async, and on a slower host the import lands AFTER this click —
  // so "Fit all" framed an empty canvas, the fitted viewBox captured below was
  // the empty-canvas one, and the later reset (which fits the real artwork)
  // could never match it. That is exactly how this spec failed in CI while
  // passing locally: the expected string in the CI log is the pre-import view.
  await expect(page.locator('[data-artwork-path-id]').first()).toBeAttached();

  const svg = page.locator('.lw-viewport svg');
  await page.getByRole('button', { name: 'Fit all' }).click();
  const fittedViewBox = await svg.getAttribute('viewBox');
  await page.getByTitle('Zoom in (+)').click();
  await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(fittedViewBox);

  await page.evaluate(() => {
    (window as any).__zoomZeroDefaultPrevented = false;
    window.addEventListener('keydown', event => {
      if (event.key === '0' && (event.ctrlKey || event.metaKey)) {
        (window as any).__zoomZeroDefaultPrevented = event.defaultPrevented;
      }
    });
    const input = document.createElement('input');
    input.dataset.testid = 'zoom-shortcut-focused-input';
    document.body.appendChild(input);
    input.focus();
  });
  await expect(page.getByTestId('zoom-shortcut-focused-input')).toBeFocused();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+0' : 'Control+0');

  await expect.poll(() => svg.getAttribute('viewBox')).toBe(fittedViewBox);
  expect(await page.evaluate(() => (window as any).__zoomZeroDefaultPrevented)).toBe(true);
});

test('F remains a Fit all shortcut', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  const svg = page.locator('.lw-viewport svg');
  await page.getByRole('button', { name: 'Fit all' }).click();
  const fittedViewBox = await svg.getAttribute('viewBox');
  await page.getByTitle('Zoom in (+)').click();
  await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(fittedViewBox);

  await page.keyboard.press('f');
  await expect.poll(() => svg.getAttribute('viewBox')).toBe(fittedViewBox);
});
