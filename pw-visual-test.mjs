/**
 * pw-visual-test.mjs
 * Run with: node pw-visual-test.mjs
 * Tests v1 (9999) and v2 (9998) LED art mapper apps.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/claude-501/playwright-check';
const SVG_PATH = '/tmp/claude-501/test-layers.svg';
const V1_URL = 'http://localhost:9999';
const V2_URL = 'http://localhost:9998';

async function screenshot(page, name, description) {
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`[screenshot] ${name}: ${description}`);
  return filePath;
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function testV1(browser) {
  console.log('\n=== Testing V1 (http://localhost:9999) ===');
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // Capture console errors
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push(`PAGE ERROR: ${err.message}`));

  await page.goto(V1_URL, { waitUntil: 'networkidle' });
  await delay(1000);
  await screenshot(page, 'v1-01-initial', 'V1 initial load');

  // Find SVG import button
  console.log('[v1] Looking for SVG import button...');

  // Try various selectors for file input or import button
  const fileInputSelectors = [
    'input[type="file"]',
    'input[accept*="svg"]',
    'input[accept*=".svg"]',
  ];

  let fileInput = null;
  for (const sel of fileInputSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      fileInput = el;
      console.log(`[v1] Found file input with selector: ${sel}`);
      break;
    }
  }

  if (!fileInput) {
    // Look for a button that triggers import
    const importBtnSelectors = [
      'button:has-text("Import")',
      'button:has-text("Load")',
      'button:has-text("SVG")',
      'button:has-text("Open")',
      '[data-testid="import"]',
      '.import-btn',
      '#import-btn',
    ];
    for (const sel of importBtnSelectors) {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        console.log(`[v1] Found import button: ${sel}`);
        break;
      }
    }
    // Just dump all buttons
    const btns = await page.locator('button').all();
    for (const btn of btns) {
      const txt = await btn.textContent();
      console.log(`[v1] Button found: "${txt?.trim()}"`);
    }
  }

  // Try to set SVG via file input
  if (fileInput) {
    await fileInput.setInputFiles(SVG_PATH);
    await delay(1500);
    await screenshot(page, 'v1-02-after-svg-import', 'V1 after SVG import');

    // Check if any layers appeared
    const layerItems = page.locator('[class*="layer"], [class*="section"], [class*="strip"], li, .panel-row');
    const count = await layerItems.count();
    console.log(`[v1] Layer-like items found after import: ${count}`);

    await screenshot(page, 'v1-03-layer-list', 'V1 layer list visible');

    // Click first layer if found
    const firstLayer = page.locator('[class*="layer-row"], [class*="section-row"], [class*="strip-row"]').first();
    if (await firstLayer.count() > 0) {
      await firstLayer.click();
      await delay(500);
      await screenshot(page, 'v1-04-layer-selected', 'V1 after clicking first layer');
    } else {
      // Try clicking any list item in the sidebar
      const sidebarItems = page.locator('aside li, .sidebar li, .panel li, [class*="list"] li').first();
      if (await sidebarItems.count() > 0) {
        await sidebarItems.click();
        await delay(500);
        await screenshot(page, 'v1-04-layer-selected', 'V1 after clicking sidebar item');
      }
    }
  } else {
    console.log('[v1] Could not find file input');
    // Take screenshot of the DOM
    const html = await page.content();
    console.log('[v1] Page HTML snippet (first 2000 chars):', html.slice(0, 2000));
  }

  // Check for SVG in canvas area
  const svgInCanvas = await page.locator('canvas, svg').count();
  console.log(`[v1] Canvas/SVG elements found: ${svgInCanvas}`);

  if (errors.length > 0) {
    console.log('[v1] Console errors:', errors);
  }

  await context.close();
}

async function testV2(browser) {
  console.log('\n=== Testing V2 (http://localhost:9998) ===');
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // Capture console messages
  const errors = [];
  const logs = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
    else logs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', err => errors.push(`PAGE ERROR: ${err.message}`));

  await page.goto(V2_URL, { waitUntil: 'networkidle' });
  await delay(1000);
  await screenshot(page, 'v2-01-initial', 'V2 initial load');

  // Inspect the DOM structure to understand v2
  const bodyText = await page.locator('body').innerHTML();
  console.log('[v2] Body HTML snippet (first 3000 chars):\n', bodyText.slice(0, 3000));

  // Find all buttons
  const btns = await page.locator('button').all();
  for (const btn of btns) {
    const txt = await btn.textContent();
    const cls = await btn.getAttribute('class');
    console.log(`[v2] Button: text="${txt?.trim()}" class="${cls}"`);
  }

  // Find file inputs
  const fileInputs = await page.locator('input[type="file"]').all();
  console.log(`[v2] File inputs found: ${fileInputs.length}`);

  let fileInput = null;
  if (fileInputs.length > 0) {
    fileInput = fileInputs[0];
    const accept = await fileInput.getAttribute('accept');
    console.log(`[v2] File input accept: ${accept}`);
  }

  if (fileInput) {
    await fileInput.setInputFiles(SVG_PATH);
    await delay(2000);
    await screenshot(page, 'v2-02-after-svg-import', 'V2 after SVG import');

    // Inspect DOM after import
    const bodyAfter = await page.locator('body').innerHTML();
    console.log('[v2] Post-import HTML snippet (first 3000 chars):\n', bodyAfter.slice(0, 3000));

    // Check canvas/SVG
    const canvasCount = await page.locator('canvas').count();
    const svgCount = await page.locator('svg').count();
    console.log(`[v2] After import - canvas elements: ${canvasCount}, SVG elements: ${svgCount}`);

    await screenshot(page, 'v2-03-layer-list', 'V2 layer list after import');

    // Find layer list items
    const layerItems = await page.locator('[class*="layer"], li, [class*="row"], [class*="item"]').all();
    console.log(`[v2] Layer-like elements: ${layerItems.length}`);
    for (const item of layerItems.slice(0, 10)) {
      const txt = await item.textContent();
      const cls = await item.getAttribute('class');
      console.log(`  - class="${cls}" text="${txt?.trim().slice(0, 80)}"`);
    }

    // Try clicking first layer-like clickable element
    const firstClickable = page.locator('[class*="layer-row"], [class*="LayerRow"], [class*="layer-item"], [class*="LayerItem"]').first();
    if (await firstClickable.count() > 0) {
      await firstClickable.click();
      await delay(500);
      await screenshot(page, 'v2-04-layer-selected', 'V2 after clicking first layer');
    } else {
      // Try clicking an <li> inside a list/sidebar
      const listItem = page.locator('aside li, [class*="list"] li, [class*="panel"] li').first();
      if (await listItem.count() > 0) {
        await listItem.click();
        await delay(500);
        await screenshot(page, 'v2-04-layer-selected', 'V2 after clicking list item');
      } else {
        console.log('[v2] Could not find clickable layer items');
        await screenshot(page, 'v2-04-no-layers', 'V2 no clickable layers found');
      }
    }
  } else {
    // No file input found — try clicking an import button first
    const importButtons = [
      'button:has-text("Import")',
      'button:has-text("Load")',
      'button:has-text("SVG")',
      'button:has-text("Open")',
      '[data-action="import"]',
    ];

    for (const sel of importButtons) {
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        console.log(`[v2] Clicking import button: ${sel}`);

        // Setup file chooser handler BEFORE clicking
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 3000 }).catch(() => null),
          el.click(),
        ]);

        if (fileChooser) {
          await fileChooser.setFiles(SVG_PATH);
          await delay(2000);
          await screenshot(page, 'v2-02-after-svg-import', 'V2 after SVG import via button');
        }
        break;
      }
    }

    if (fileInputs.length === 0) {
      console.log('[v2] No file input found at all');
      await screenshot(page, 'v2-02-no-import', 'V2 no import mechanism found');
    }
  }

  // Final DOM inspection
  const finalHTML = await page.locator('body').innerHTML();
  console.log('[v2] Final HTML snippet (first 2000 chars):\n', finalHTML.slice(0, 2000));

  // Check for SVG display
  const svgElements = await page.locator('svg').all();
  for (let i = 0; i < Math.min(svgElements.length, 5); i++) {
    const id = await svgElements[i].getAttribute('id');
    const cls = await svgElements[i].getAttribute('class');
    const bbox = await svgElements[i].boundingBox();
    console.log(`[v2] SVG[${i}]: id="${id}" class="${cls}" bbox=${JSON.stringify(bbox)}`);
  }

  if (errors.length > 0) {
    console.log('[v2] Console errors:');
    errors.forEach(e => console.log(' ', e));
  }
  console.log('[v2] Console logs (first 20):');
  logs.slice(0, 20).forEach(l => console.log(' ', l));

  await context.close();
}

async function main() {
  console.log('Starting Playwright visual comparison...');
  console.log(`Screenshots will be saved to: ${SCREENSHOT_DIR}`);

  const browser = await chromium.launch({ headless: true });

  try {
    await testV1(browser);
  } catch (err) {
    console.error('[v1] ERROR:', err.message);
  }

  try {
    await testV2(browser);
  } catch (err) {
    console.error('[v2] ERROR:', err.message);
  }

  await browser.close();
  console.log('\nDone. Check screenshots in:', SCREENSHOT_DIR);
}

main().catch(console.error);
