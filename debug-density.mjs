import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const logs = [];
page.on('console', msg => { const t = msg.text(); logs.push(t); });
page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

const pathD = 'M 50,200 L 550,200';
const savedProject = {
  version: 2, density: 60,
  strips: [{
    id: 's1', name: 'Test Strip', pathData: pathD, pixelCount: 30,
    color: '#88aaff', emit: 'dir', angle: 0, reversed: false,
    speed: 1, brightness: 1, hueShift: 0, patternId: null
  }],
  layers: [], editCounts: {}, hidden: {},
  svgText: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><g id="layer-0"><path d="${pathD}"/></g></svg>`,
  viewBox: '0 0 640 400', layerGroups: [], layerOrder: [],
};

await context.addInitScript((data) => {
  localStorage.setItem('lw-layout-autosave', JSON.stringify(data));
}, savedProject);

await page.goto('http://localhost:9998/#screen=layout');
await page.waitForTimeout(3000);

const getStripState = () => page.evaluate(() => {
  const el = document.querySelector('[class*="lw-canvas"]');
  if (!el) return null;
  const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
  if (!fk) return null;
  let f = el[fk];
  while (f) {
    let s = f.memoizedState;
    while (s) {
      if (Array.isArray(s.memoizedState) && s.memoizedState[0]?.pixels) {
        return s.memoizedState.map(x => ({ id: x.id, pixelCount: x.pixelCount, pLen: x.pixels?.length }));
      }
      s = s.next;
    }
    f = f.return;
  }
  return null;
});

const countCircles = () => page.evaluate(() => document.querySelectorAll('circle').length);

console.log('Initial strips:', JSON.stringify(await getStripState()));
console.log('Initial circles:', await countCircles());

// Use Playwright's built-in click (dispatches real mouse events)
await page.locator('button', { hasText: '30/m' }).click();
await page.waitForTimeout(500);
console.log('After 30/m — strips:', JSON.stringify(await getStripState()));
console.log('After 30/m — circles:', await countCircles());

await page.locator('button', { hasText: '144/m' }).click();
await page.waitForTimeout(500);
console.log('After 144/m — strips:', JSON.stringify(await getStripState()));
console.log('After 144/m — circles:', await countCircles());

// Print all density-related logs
const densityLogs = logs.filter(l => l.includes('[density]') || l.includes('strip') || l.includes('ERROR'));
console.log('\nDensity logs:', densityLogs);
console.log('All non-vite logs:', logs.filter(l => !l.startsWith('[vite]')));

await page.screenshot({ path: 'debug-density-result.png' });
await browser.close();
