import { chromium } from '@playwright/test';
import { mkdirSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

mkdirSync('test-results', { recursive: true });

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Start a fresh Vite dev server on port 9997 using the current source files
const vite = spawn('npx', ['vite', '--port', '9997', '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});

let viteReady = false;
const viteReady$ = new Promise((resolve, reject) => {
  vite.stdout.on('data', d => {
    process.stdout.write('[vite] ' + d);
    if (d.toString().includes('9997')) { viteReady = true; resolve(); }
  });
  vite.stderr.on('data', d => process.stderr.write('[vite err] ' + d));
  vite.on('exit', code => { if (!viteReady) reject(new Error(`Vite exited ${code}`)); });
  setTimeout(() => reject(new Error('Vite start timeout')), 25000);
});

try {
  await viteReady$;
  console.log('Vite ready on port 9997');
} catch (e) {
  console.error('Failed to start Vite:', e.message);
  vite.kill();
  process.exit(1);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));

await page.goto('http://localhost:9997/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// Click Pattern in the left navigation rail
await page.locator('.lw-rail-btn', { hasText: 'Pattern' }).click();

// Wait for canvas to appear
const canvasHandle = await page.waitForSelector('canvas', { timeout: 10000 }).catch(() => null);
if (!canvasHandle) {
  const domInfo = await page.evaluate(() => ({
    screenClass: [...document.querySelectorAll('[class*="screen"]')].map(el => el.className),
    allTags: [...document.querySelectorAll('canvas, svg')].map(el => el.tagName + ' ' + el.className).slice(0, 10),
    errors: window.__lwErrors || [],
  }));
  console.error('NO CANVAS FOUND. DOM:', JSON.stringify(domInfo, null, 2));
  console.log('Console errors:', errors);
  await page.screenshot({ path: 'test-results/pattern-screen.png' });
  await browser.close();
  vite.kill();
  process.exit(1);
}

// Let the animation run for a moment
await page.waitForTimeout(3000);
await page.screenshot({ path: 'test-results/pattern-screen.png' });

const info = await page.evaluate(() => {
  const canvases = [...document.querySelectorAll('canvas')];
  return {
    canvasCount: canvases.length,
    canvasDims: canvases.map(c => ({ w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight })),
    screenClass: [...document.querySelectorAll('[class*="screen"]')].map(el => el.className),
  };
});

console.log('Console errors:', errors);
console.log('Info:', JSON.stringify(info, null, 2));

// Pixel quality analysis
if (info.canvasCount > 0) {
  const result = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    if (!width || !height) return { score: -1, msg: `zero-size canvas: ${width}x${height}` };
    const d = ctx.getImageData(0, 0, width, height).data;
    let darkInGlow = 0, glowPixels = 0, totalBrightness = 0;
    const maxCh = (i) => Math.max(d[i], d[i+1], d[i+2]);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4;
        const b = (d[i] + d[i+1] + d[i+2]) / 3;
        totalBrightness += b;
        // Use per-channel max for neighbor brightness — catches blue-heavy glow
        const nb = Math.max(
          maxCh(((y-1)*width+x)*4),
          maxCh(((y+1)*width+x)*4),
          maxCh((y*width+x-1)*4),
          maxCh((y*width+x+1)*4),
        );
        if (nb > 60) { glowPixels++; if (b < 15) darkInGlow++; }
      }
    }
    const avgBrightness = totalBrightness / ((width - 2) * (height - 2));
    return { score: glowPixels > 100 ? darkInGlow / glowPixels : 0, glowPixels, darkInGlow, avgBrightness: avgBrightness.toFixed(2), width, height };
  });
  console.log('Pixel result:', JSON.stringify(result));
  if (result.score >= 0) {
    const pct = (result.score * 100).toFixed(2);
    const pass = result.score < 0.05;
    console.log(`Dark line score: ${pct}% — ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
    if (!pass) process.exitCode = 1;
  }
}

await browser.close();
vite.kill();
