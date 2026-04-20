/**
 * pw-quick-test.mjs — quick visual capture of v1 and v2
 */
import { chromium } from './node_modules/playwright/index.mjs';

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/claude-501/playwright-check';
const SVG_PATH = '/tmp/claude-501/test-layers.svg';

async function run() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true, timeout: 15000 });
  console.log('Browser launched');

  // ── V1 ────────────────────────────────────────────────────────────────────
  console.log('\n=== V1 (port 9999) ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.goto('http://localhost:9999', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/v1-01-initial.png` });
    console.log('[v1] screenshot: v1-01-initial.png');

    // List all buttons
    const btns = await page.$$eval('button', els => els.map(el => ({ text: el.textContent?.trim(), id: el.id, cls: el.className })));
    console.log('[v1] Buttons:', JSON.stringify(btns.slice(0, 15)));

    // Find file input
    const fileInputCount = await page.$$eval('input[type="file"]', els => els.length);
    console.log('[v1] File inputs:', fileInputCount);

    if (fileInputCount > 0) {
      // Set file on the hidden input
      const [fileInput] = await page.$$('input[type="file"]');
      await fileInput.setInputFiles(SVG_PATH);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/v1-02-after-import.png` });
      console.log('[v1] screenshot: v1-02-after-import.png');

      // Check for layers
      const layerRows = await page.$$eval('[class*="layer-row"], [class*="LayerRow"]', els => els.map(e => e.textContent?.trim()));
      console.log('[v1] Layer rows found:', layerRows.length, layerRows.slice(0,5));

      // Try to click a layer
      const layerEl = await page.$('[class*="layer-row"], [class*="section-row"], aside li, .panel li');
      if (layerEl) {
        await layerEl.click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/v1-03-layer-selected.png` });
        console.log('[v1] screenshot: v1-03-layer-selected.png');
      }
    }

    // Check SVG/canvas
    const svgEls = await page.$$eval('svg', els => els.map(e => ({ id: e.id, cls: e.className?.baseVal, w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height })));
    console.log('[v1] SVG elements:', JSON.stringify(svgEls.slice(0, 5)));

    if (consoleErrors.length) console.log('[v1] Console errors:', consoleErrors);
    await ctx.close();
  }

  // ── V2 ────────────────────────────────────────────────────────────────────
  console.log('\n=== V2 (port 9998) ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const consoleErrors = [];
    const consoleLogs = [];
    page.on('console', m => {
      if (m.type() === 'error') consoleErrors.push(m.text());
      else consoleLogs.push(`[${m.type()}] ${m.text()}`);
    });
    page.on('pageerror', e => consoleErrors.push('PAGE ERR: ' + e.message));

    await page.goto('http://localhost:9998', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/v2-01-initial.png` });
    console.log('[v2] screenshot: v2-01-initial.png');

    // List all buttons
    const btns = await page.$$eval('button', els => els.map(el => ({ text: el.textContent?.trim().slice(0,40), id: el.id, cls: el.className?.slice(0,60) })));
    console.log('[v2] Buttons:', JSON.stringify(btns.slice(0, 20)));

    // Check active screen
    const screenInfo = await page.$eval('body', el => ({
      classes: el.className,
      html: el.innerHTML.slice(0, 500),
    })).catch(() => ({ classes: '', html: '' }));
    console.log('[v2] Body classes:', screenInfo.classes);
    console.log('[v2] Body HTML snippet:', screenInfo.html);

    // Find file input
    const fileInputs = await page.$$('input[type="file"]');
    console.log('[v2] File inputs found:', fileInputs.length);
    for (let i = 0; i < fileInputs.length; i++) {
      const accept = await fileInputs[i].getAttribute('accept');
      console.log(`[v2]   input[${i}] accept="${accept}"`);
    }

    // Find the SVG import button specifically (v2 layout screen has "Import SVG")
    const importBtn = await page.$('button:has-text("Import SVG")').catch(() => null);
    console.log('[v2] Import SVG button found:', !!importBtn);

    // Find the .svg file input (hidden)
    const svgFileInput = await page.$('input[accept=".svg"]').catch(() => null)
      || await page.$('input[accept*="svg"]').catch(() => null);
    console.log('[v2] SVG file input found:', !!svgFileInput);

    if (svgFileInput) {
      await svgFileInput.setInputFiles(SVG_PATH);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/v2-02-after-import.png` });
      console.log('[v2] screenshot: v2-02-after-import.png');

      // Inspect layers panel
      const layerPanelHTML = await page.$eval('[class*="layout"]', el => el.innerHTML.slice(0, 2000)).catch(() => 'not found');
      console.log('[v2] Layout screen HTML snippet:', layerPanelHTML);

      // Check SVG elements
      const svgEls = await page.$$eval('svg', els => els.map(e => ({
        id: e.id,
        cls: e.className?.baseVal,
        w: Math.round(e.getBoundingClientRect().width),
        h: Math.round(e.getBoundingClientRect().height),
        childCount: e.children.length,
      })));
      console.log('[v2] SVG elements after import:', JSON.stringify(svgEls.slice(0, 8)));

      // Check for artwork content in the SVG
      const artworkGroupsCount = await page.$$eval('svg g', els => els.length);
      console.log('[v2] SVG <g> elements:', artworkGroupsCount);

      // Check layer list
      const layerListHTML = await page.$eval('div[style*="overflow: auto"]', el => el.outerHTML.slice(0, 1000)).catch(() => 'no overflow div');
      console.log('[v2] Layer list container:', layerListHTML);

      // Try clicking a layer row
      // Layer rows are divs inside the layers list, with onClick for selectLayer
      const layerDivs = await page.$$eval('div[style*="cursor: pointer"]', els => els.map(e => ({
        text: e.textContent?.trim().slice(0, 60),
        style: e.getAttribute('style')?.slice(0, 100),
      })));
      console.log('[v2] Clickable divs:', JSON.stringify(layerDivs.slice(0, 10)));

      // Click the first non-toolbar clickable div that looks like a layer
      const clickableDivs = await page.$$('div[style*="cursor: pointer"]');
      console.log('[v2] Total cursor:pointer divs:', clickableDivs.length);

      if (clickableDivs.length > 0) {
        // Skip toolbar buttons, click first layer-like row
        await clickableDivs[0].click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/v2-03-layer-selected.png` });
        console.log('[v2] screenshot: v2-03-layer-selected.png');

        // Check SVG g-element opacity after selection
        const gOpacities = await page.$$eval('svg g', els => els.map(e => ({
          id: e.id,
          opacity: e.style?.opacity,
          cls: e.className?.baseVal?.slice(0, 30),
        })));
        console.log('[v2] SVG <g> opacities after layer click:', JSON.stringify(gOpacities.slice(0, 12)));
      }

      // Hover test
      if (clickableDivs.length > 0) {
        await clickableDivs[0].hover();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/v2-04-layer-hover.png` });
        console.log('[v2] screenshot: v2-04-layer-hover.png');
      }
    } else {
      // No file input found — screenshot the full DOM
      const allInputs = await page.$$eval('input', els => els.map(e => ({
        type: e.type, name: e.name, id: e.id, accept: e.accept, cls: e.className,
      })));
      console.log('[v2] All inputs:', JSON.stringify(allInputs));

      const fullHTML = await page.$eval('body', e => e.innerHTML.slice(0, 3000));
      console.log('[v2] Full body HTML:', fullHTML);
    }

    if (consoleErrors.length) {
      console.log('[v2] Console errors:');
      consoleErrors.forEach(e => console.log('  ', e));
    }
    console.log('[v2] Console logs (first 15):');
    consoleLogs.slice(0, 15).forEach(l => console.log('  ', l));

    await ctx.close();
  }

  await browser.close();
  console.log('\nDone!');
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
