import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
page.on('console', msg => {
  const t = msg.text();
  if (!t.startsWith('[vite]')) console.log('CONSOLE:', t);
});

const pathD = 'M 50,200 L 550,200';
await context.addInitScript((data) => {
  localStorage.setItem('lw-layout-autosave', JSON.stringify(data));
}, {
  version: 2, density: 60,
  strips: [{
    id: 's1', name: 'Test Strip', pathData: pathD, pixelCount: 30,
    color: '#88aaff', emit: 'dir', angle: 0, reversed: false,
    speed: 1, brightness: 1, hueShift: 0, patternId: null
  }],
  layers: [], editCounts: {}, hidden: {},
  svgText: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><g id="layer-0"><path d="${pathD}"/></g></svg>`,
  viewBox: '0 0 640 400', layerGroups: [], layerOrder: [],
});

await page.goto('http://localhost:9998/#screen=layout');
await page.waitForTimeout(2000);

const countCircles = () => page.evaluate(() => document.querySelectorAll('circle').length);

console.log('Initial circles:', await countCircles());

// Click 30/m
try {
  await page.locator('button', { hasText: '30/m' }).first().click({ timeout: 5000 });
  await page.waitForTimeout(500);
  console.log('After 30/m circles:', await countCircles());
} catch (e) {
  console.log('30/m click failed:', e.message);
}

// Click 144/m
try {
  await page.locator('button', { hasText: '144/m' }).first().click({ timeout: 5000 });
  await page.waitForTimeout(500);
  console.log('After 144/m circles:', await countCircles());
} catch (e) {
  console.log('144/m click failed:', e.message);
}

await page.screenshot({ path: 'test-density-result.png' });
await browser.close();
