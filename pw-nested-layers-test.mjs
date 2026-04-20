/**
 * pw-nested-layers-test.mjs
 * Tests LED art mapper v2 (port 9998) with a nested-layers SVG that mimics
 * an Illustrator export with a wrapper group.
 */
import { chromium } from './node_modules/playwright/index.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE_URL      = 'http://localhost:9998';
const SVG_PATH      = process.env.SVG_PATH || '/tmp/claude-501/nested-layers.svg';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/claude-501/playwright-nested';

mkdirSync(SCREENSHOT_DIR, { recursive: true });

const ss = (name) => join(SCREENSHOT_DIR, name);

async function run() {
  console.log('=== Nested-layers SVG test — LED art mapper v2 ===');
  console.log(`SVG:        ${SVG_PATH}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page    = await ctx.newPage();

  const consoleErrors = [];
  const consoleLogs   = [];
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(m.text());
    else consoleLogs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', e => consoleErrors.push('PAGE ERR: ' + e.message));

  // ── 1. Navigate ───────────────────────────────────────────────────────────
  console.log('\n[1] Navigating to', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: ss('00-initial.png') });
  console.log('    screenshot: 00-initial.png');

  // ── 2. Upload SVG ─────────────────────────────────────────────────────────
  console.log('\n[2] Uploading SVG via input[accept=".svg"]');
  const svgInput = await page.$('input[accept=".svg"]')
    ?? await page.$('input[accept*="svg"]')
    ?? await page.$('input[type="file"]');

  if (!svgInput) {
    console.error('ERROR: No SVG file input found. Dumping body HTML...');
    const html = await page.$eval('body', e => e.innerHTML.slice(0, 3000));
    console.log(html);
    await browser.close();
    process.exit(1);
  }

  await svgInput.setInputFiles(SVG_PATH);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: ss('01-imported.png') });
  console.log('    screenshot: 01-imported.png');

  // ── 3. Count layer rows ───────────────────────────────────────────────────
  console.log('\n[3] Counting layer rows in the right panel');

  // Collect all text visible in the layers section
  const layerPanelInfo = await page.evaluate(() => {
    // Look for elements with "Background", "Circle", "Bar" text
    const allText = Array.from(document.querySelectorAll('*'))
      .filter(el => {
        const t = el.textContent?.trim();
        return (t === 'Background' || t === 'Circle' || t === 'Bar') && el.children.length === 0;
      })
      .map(el => ({
        tag:  el.tagName,
        text: el.textContent?.trim(),
        cls:  el.className,
        id:   el.id,
      }));
    return allText;
  });
  console.log('    Layer name elements:', JSON.stringify(layerPanelInfo, null, 2));

  // Count via artwork-layers-list or any known container
  const artworkLayerCount = await page.evaluate(() => {
    const list = document.getElementById('artwork-layers-list');
    if (!list) return { found: false, html: 'no #artwork-layers-list' };
    const rows = Array.from(list.querySelectorAll('[data-layer-id], .layer-row, [id^="alr-row-"]'));
    // Fallback: count direct children that look like rows
    const children = Array.from(list.children);
    return {
      found:         true,
      rowsFound:     rows.length,
      childCount:    children.length,
      childTexts:    children.map(c => c.textContent?.trim().slice(0, 60)),
      listHTML:      list.innerHTML.slice(0, 2000),
    };
  });
  console.log('    artwork-layers-list:', JSON.stringify(artworkLayerCount, null, 2));

  // ── 4. Click "Circle" layer in the panel ─────────────────────────────────
  console.log('\n[4] Clicking "Circle" layer in the panel');

  // Try finding the Circle layer by text
  const circleClicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('*'))
      .filter(el => el.textContent?.trim() === 'Circle' && el.children.length === 0);
    if (!candidates.length) return { clicked: false, reason: 'no element with text "Circle"' };
    // Walk up to find clickable ancestor
    let el = candidates[0];
    for (let i = 0; i < 5; i++) {
      if (el.onclick || el.getAttribute('data-layer-id') || el.tagName === 'BUTTON') {
        el.click();
        return { clicked: true, tag: el.tagName, cls: el.className, id: el.id };
      }
      el = el.parentElement;
      if (!el) break;
    }
    // Just click the text node's nearest ancestor
    candidates[0].parentElement?.click();
    return { clicked: true, fallback: true, tag: candidates[0].parentElement?.tagName };
  });
  console.log('    Circle click result:', JSON.stringify(circleClicked));

  // If above failed, try Playwright's text selector
  if (!circleClicked.clicked) {
    const circleEl = await page.locator('text=Circle').first().elementHandle().catch(() => null);
    if (circleEl) {
      await circleEl.click();
      console.log('    Clicked via Playwright text locator');
    }
  }

  await page.waitForTimeout(500);
  await page.screenshot({ path: ss('02-circle-selected.png') });
  console.log('    screenshot: 02-circle-selected.png');

  // ── 5. Evaluate canvas SVG structure ─────────────────────────────────────
  console.log('\n[5] Evaluating canvas SVG DOM');

  const svgInspection = await page.evaluate(() => {
    // Find the big canvas SVG — the one with viewBox "0 0 400 300" (matches imported SVG)
    const allSvgs = Array.from(document.querySelectorAll('svg'));
    const canvasSvg = allSvgs.find(s => s.getAttribute('viewBox') === '0 0 400 300')
      ?? allSvgs.find(s => {
        const bb = s.getBoundingClientRect();
        return bb.width > 400 && bb.height > 300;
      });

    if (!canvasSvg) {
      return {
        error:    'canvas SVG not found',
        allSvgs:  allSvgs.map(s => ({
          id:      s.id,
          viewBox: s.getAttribute('viewBox'),
          w:       Math.round(s.getBoundingClientRect().width),
          h:       Math.round(s.getBoundingClientRect().height),
        })),
      };
    }

    const importedSvg = canvasSvg.querySelector('#imported-svg');
    if (!importedSvg) {
      return { error: '#imported-svg not found in canvas SVG' };
    }

    // artworkRef is the <g> with style "pointer-events: none; filter: ..."
    // Actually it's the #imported-svg element itself that holds the layers.
    // Its children are the artwork groups.
    const children = Array.from(importedSvg.children);

    const circleLyr  = canvasSvg.querySelector('#circle-layer');
    const bgLyr      = canvasSvg.querySelector('#bg-layer');
    const barLyr     = canvasSvg.querySelector('#bar-layer');
    const outerWrap  = canvasSvg.querySelector('#outer-wrapper');

    return {
      importedSvgChildCount:    children.length,
      importedSvgChildIds:      children.map(c => c.id || c.tagName),
      importedSvgStyle:         importedSvg.getAttribute('style'),
      importedSvgOpacity:       importedSvg.style.opacity,

      outerWrapper: outerWrap ? {
        found:    true,
        opacity:  outerWrap.style.opacity,
        children: Array.from(outerWrap.children).map(c => ({ id: c.id, opacity: c.style.opacity })),
      } : { found: false },

      circleLayer: circleLyr ? {
        found:   true,
        opacity: circleLyr.style.opacity,
      } : { found: false },

      bgLayer: bgLyr ? {
        found:   true,
        opacity: bgLyr.style.opacity,
      } : { found: false },

      barLayer: barLyr ? {
        found:   true,
        opacity: barLyr.style.opacity,
      } : { found: false },
    };
  });
  console.log('\n    SVG inspection:', JSON.stringify(svgInspection, null, 2));

  // ── 6. Click on the canvas at the red circle location ────────────────────
  console.log('\n[6] Clicking on canvas at red circle position');

  // First get the canvas SVG bounding box to calculate correct page coords
  const canvasBBox = await page.evaluate(() => {
    const allSvgs = Array.from(document.querySelectorAll('svg'));
    const s = allSvgs.find(sv => sv.getAttribute('viewBox') === '0 0 400 300')
      ?? allSvgs.reduce((biggest, sv) => {
        const bb = sv.getBoundingClientRect();
        const bbb = biggest?.getBoundingClientRect() ?? { width: 0 };
        return bb.width > bbb.width ? sv : biggest;
      }, null);
    if (!s) return null;
    const bb = s.getBoundingClientRect();
    return { x: bb.x, y: bb.y, width: bb.width, height: bb.height };
  });

  console.log('    Canvas SVG bounding box:', JSON.stringify(canvasBBox));

  if (canvasBBox) {
    // SVG viewBox is 0 0 400 300; circle is at cx=200 cy=130 r=70
    // Map SVG coords to page coords
    const scaleX = canvasBBox.width  / 400;
    const scaleY = canvasBBox.height / 300;
    const circlePageX = canvasBBox.x + 200 * scaleX;
    const circlePageY = canvasBBox.y + 130 * scaleY;
    console.log(`    Clicking circle at page coords (${Math.round(circlePageX)}, ${Math.round(circlePageY)})`);
    await page.mouse.click(circlePageX, circlePageY);
  } else {
    // Fallback: use the approximate coords from the task description
    console.log('    Falling back to approximate coords (540, 250)');
    await page.mouse.click(540, 250);
  }

  await page.waitForTimeout(500);
  await page.screenshot({ path: ss('03-canvas-click.png') });
  console.log('    screenshot: 03-canvas-click.png');

  // ── 7. Post-click inspection ──────────────────────────────────────────────
  console.log('\n[7] Post-canvas-click SVG inspection');

  const postClickInspection = await page.evaluate(() => {
    const canvasSvg = Array.from(document.querySelectorAll('svg'))
      .find(s => s.getAttribute('viewBox') === '0 0 400 300')
      ?? Array.from(document.querySelectorAll('svg')).reduce((b, s) => {
        const bb = s.getBoundingClientRect();
        const bbb = b?.getBoundingClientRect() ?? { width: 0 };
        return bb.width > bbb.width ? s : b;
      }, null);

    if (!canvasSvg) return { error: 'canvas not found' };

    const importedSvg = canvasSvg.querySelector('#imported-svg');
    const children    = importedSvg ? Array.from(importedSvg.children) : [];
    const outerWrap   = canvasSvg.querySelector('#outer-wrapper');
    const circleLyr   = canvasSvg.querySelector('#circle-layer');
    const bgLyr       = canvasSvg.querySelector('#bg-layer');

    // Check what layer is "selected" by the state — look for any highlighted layer row
    const highlightedRows = Array.from(document.querySelectorAll('[class*="selected"], [class*="active"], [style*="background"]'))
      .filter(el => el.textContent?.includes('Circle') || el.textContent?.includes('Background') || el.textContent?.includes('Bar'))
      .map(el => ({ text: el.textContent?.trim().slice(0, 50), cls: el.className, style: el.getAttribute('style') }));

    return {
      importedSvgChildCount: children.length,
      importedSvgChildIds:   children.map(c => c.id || c.tagName),
      importedSvgOpacity:    importedSvg?.style.opacity,

      outerWrapper: outerWrap ? {
        found:    true,
        opacity:  outerWrap.style.opacity,
        children: Array.from(outerWrap.children).map(c => ({ id: c.id, opacity: c.style.opacity })),
      } : { found: false },

      circleLayer: circleLyr ? { found: true, opacity: circleLyr.style.opacity } : { found: false },
      bgLayer:     bgLyr     ? { found: true, opacity: bgLyr.style.opacity     } : { found: false },
      highlightedRows,
    };
  });
  console.log('    Post-click inspection:', JSON.stringify(postClickInspection, null, 2));

  // ── 8. Final layer panel count ────────────────────────────────────────────
  console.log('\n[8] Final layer panel inspection');

  const finalLayerCount = await page.evaluate(() => {
    // Check state.artworkLayers length via the count badge
    const countEl = document.getElementById('artwork-layer-count');
    const sectionEl = document.getElementById('artwork-layers-section');
    const listEl    = document.getElementById('artwork-layers-list');

    const foundNames = ['Background', 'Circle', 'Bar'].map(name => {
      const el = Array.from(document.querySelectorAll('*'))
        .find(e => e.textContent?.trim() === name && e.children.length === 0);
      return { name, found: !!el };
    });

    return {
      countBadge:        countEl?.textContent?.trim(),
      sectionVisible:    sectionEl ? !sectionEl.classList.contains('hidden') : false,
      layerListChildren: listEl ? listEl.children.length : -1,
      foundLayerNames:   foundNames,
    };
  });
  console.log('    Final layer count:', JSON.stringify(finalLayerCount, null, 2));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=== SUMMARY ===');

  const layersDetected = finalLayerCount.foundLayerNames.filter(n => n.found).length;
  console.log(`Layers detected in panel: ${layersDetected}/3 (Background, Circle, Bar)`);
  console.log(`Layer count badge: "${finalLayerCount.countBadge}"`);

  const circleOp = svgInspection.circleLayer?.opacity;
  const bgOp     = svgInspection.bgLayer?.opacity;
  console.log(`After clicking "Circle" in panel:`);
  console.log(`  #circle-layer opacity: ${circleOp || '(not set)'} (expected 0.9)`);
  console.log(`  #bg-layer opacity:     ${bgOp     || '(not set)'} (expected 0.06)`);

  const postCircleOp = postClickInspection.circleLayer?.opacity;
  const postBgOp     = postClickInspection.bgLayer?.opacity;
  console.log(`After canvas click:`);
  console.log(`  #circle-layer opacity: ${postCircleOp || '(not set)'}`);
  console.log(`  #bg-layer opacity:     ${postBgOp     || '(not set)'}`);

  // Detect if wrapper causes issues (outer-wrapper = single child of #imported-svg)
  const importedChildren = svgInspection.importedSvgChildCount ?? 0;
  if (importedChildren === 1 && svgInspection.importedSvgChildIds?.[0] === 'outer-wrapper') {
    console.log('\nWARNING: #imported-svg has only 1 child (outer-wrapper). The 3 inner layers');
    console.log('         are nested one level deeper. setLayerHighlight() walks importedSvg.children,');
    console.log('         so it will only dim/highlight the outer-wrapper itself, not individual layers.');
    console.log('         Bug: the wrapper group is not being unwrapped on background load.');
  } else {
    console.log(`\n#imported-svg children: ${importedChildren} (${svgInspection.importedSvgChildIds?.join(', ')})`);
  }

  if (consoleErrors.length) {
    console.log('\nConsole errors:');
    consoleErrors.forEach(e => console.log('  ', e));
  } else {
    console.log('\nNo console errors.');
  }

  await browser.close();
  console.log('\nDone. Screenshots in:', SCREENSHOT_DIR);
}

run().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
