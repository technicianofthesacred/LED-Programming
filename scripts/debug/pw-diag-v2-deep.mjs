/**
 * pw-diag-v2-deep.mjs — deeper DOM inspection for the Lightweaver v2 layer opacity bugs
 * Run: node pw-diag-v2-deep.mjs
 */
import { chromium } from './node_modules/playwright/index.mjs';
import fs from 'fs';

const SVG_PATH = '/tmp/claude-501/test-layers.svg';
const BASE_URL = 'http://localhost:9998';
const OUT_DIR  = '/tmp/claude-501/playwright-diag';

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log('Output dir:', OUT_DIR);

async function run() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true, timeout: 20000 });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const consoleMsgs   = [];
  page.on('console', m => {
    const entry = `[${m.type()}] ${m.text()}`;
    consoleMsgs.push(entry);
    if (m.type() === 'error') consoleErrors.push(entry);
  });
  page.on('pageerror', e => {
    const entry = `[PAGE ERROR] ${e.message}`;
    consoleErrors.push(entry);
    consoleMsgs.push(entry);
  });

  console.log('\nStep 1: Navigate');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT_DIR}/01-initial.png` });
  console.log('Screenshot: 01-initial.png');

  console.log('\nStep 2: Upload SVG');
  const svgInput = await page.$('input[accept=".svg"]');
  await svgInput.setInputFiles(SVG_PATH);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT_DIR}/02-after-import.png` });
  console.log('Screenshot: 02-after-import.png');

  // ── Deep DOM inspection ──────────────────────────────────────────────────
  const deepInspect = await page.evaluate(() => {
    // 1. Find ALL SVG elements on the page
    const allSvgs = Array.from(document.querySelectorAll('svg'));

    // 2. For each SVG, report its children
    const svgReport = allSvgs.map((svg, si) => {
      const children = Array.from(svg.children).map((el, ci) => ({
        index: ci,
        tag: el.tagName,
        id: el.id || '',
        class: el.className?.baseVal || el.className || '',
        opacity: el.style?.opacity || '',
        innerHTML_len: el.innerHTML.length,
        childCount: el.children.length,
        // Check if dangerouslySetInnerHTML was used (has inline SVG content)
        innerHTMLSnippet: el.innerHTML.slice(0, 200),
      }));

      return {
        svgIndex: si,
        id: svg.id || '',
        class: svg.className?.baseVal || '',
        viewBox: svg.getAttribute('viewBox'),
        width: svg.getBoundingClientRect().width,
        height: svg.getBoundingClientRect().height,
        childCount: svg.children.length,
        children,
      };
    });

    // 3. Look for layer1 / layer2 anywhere in the document
    const layer1El = document.getElementById('layer1');
    const layer2El = document.getElementById('layer2');

    // 4. Check the React root for component structure hints
    const root = document.getElementById('root');

    // 5. Find the lw-viewport div
    const viewport = document.querySelector('.lw-viewport');
    const viewportSvg = viewport?.querySelector('svg');

    return {
      allSvgCount: allSvgs.length,
      svgReport,
      layer1Found: !!layer1El,
      layer1ParentTag: layer1El?.parentElement?.tagName,
      layer1ParentId: layer1El?.parentElement?.id,
      layer1Opacity: layer1El?.style?.opacity || '',
      layer2Found: !!layer2El,
      layer2Opacity: layer2El?.style?.opacity || '',
      viewportExists: !!viewport,
      viewportSvgChildCount: viewportSvg?.children?.length ?? -1,
      viewportSvgViewBox: viewportSvg?.getAttribute('viewBox'),
      // Get the full innerHTML of the viewport SVG to see what's there
      viewportSvgHTML: viewportSvg?.innerHTML?.slice(0, 2000) ?? 'no viewport SVG',
    };
  });

  console.log('\n── Deep DOM after import ──');
  console.log('All SVG count:', deepInspect.allSvgCount);
  console.log('layer1 in DOM:', deepInspect.layer1Found, '| parent:', deepInspect.layer1ParentTag, '#', deepInspect.layer1ParentId);
  console.log('layer2 in DOM:', deepInspect.layer2Found);
  console.log('lw-viewport exists:', deepInspect.viewportExists);
  console.log('viewport SVG viewBox:', deepInspect.viewportSvgViewBox);
  console.log('viewport SVG child count:', deepInspect.viewportSvgChildCount);
  console.log('\nviewport SVG innerHTML:\n', deepInspect.viewportSvgHTML);
  console.log('\nAll SVGs:');
  deepInspect.svgReport.forEach(s => {
    console.log(`  SVG[${s.svgIndex}] id="${s.id}" class="${s.class}" viewBox="${s.viewBox}" size=${Math.round(s.width)}x${Math.round(s.height)} children=${s.childCount}`);
    s.children.forEach(c => {
      console.log(`    <${c.tag}> id="${c.id}" opacity="${c.opacity}" innerHTML_len=${c.innerHTML_len} childCount=${c.childCount}`);
      if (c.innerHTML_len > 0) console.log(`      snippet: ${c.innerHTMLSnippet.slice(0, 150)}`);
    });
  });

  // ── Click layer and re-inspect ───────────────────────────────────────────
  console.log('\nStep 5: Click "Background" layer row');
  const bgRow = page.locator('text="Background"').first();
  const bgCount = await bgRow.count();
  console.log('"Background" element count:', bgCount);

  if (bgCount > 0) {
    await bgRow.click();
    await page.waitForTimeout(400);
  } else {
    // Try cursor:pointer divs
    const cpDivs = await page.$$('div[style*="cursor: pointer"]');
    if (cpDivs.length > 0) {
      await cpDivs[0].click();
      await page.waitForTimeout(400);
    }
  }
  await page.screenshot({ path: `${OUT_DIR}/03-after-click.png` });
  console.log('Screenshot: 03-after-click.png');

  const afterClickInspect = await page.evaluate(() => {
    const layer1El = document.getElementById('layer1');
    const layer2El = document.getElementById('layer2');
    const viewportSvg = document.querySelector('.lw-viewport svg');
    return {
      layer1Opacity: layer1El?.style?.opacity || '(not set)',
      layer2Opacity: layer2El?.style?.opacity || '(not set)',
      layer1ComputedOpacity: layer1El ? window.getComputedStyle(layer1El).opacity : 'N/A',
      layer2ComputedOpacity: layer2El ? window.getComputedStyle(layer2El).opacity : 'N/A',
      artworkGOpacity: (() => {
        if (!viewportSvg) return 'no viewport SVG';
        const gs = Array.from(viewportSvg.children).filter(el => el.tagName.toLowerCase() === 'g');
        for (const g of gs) {
          if (g.querySelector('#layer1') || g.querySelector('#layer2')) {
            return g.style.opacity || '(empty)';
          }
        }
        return '(artworkRef g not found in viewport SVG)';
      })(),
      viewportSvgHTML: viewportSvg?.innerHTML?.slice(0, 1500) ?? 'no viewport SVG',
    };
  });

  console.log('\n── After layer click ──');
  console.log('layer1 style.opacity:', afterClickInspect.layer1Opacity);
  console.log('layer1 computed opacity:', afterClickInspect.layer1ComputedOpacity);
  console.log('layer2 style.opacity:', afterClickInspect.layer2Opacity);
  console.log('layer2 computed opacity:', afterClickInspect.layer2ComputedOpacity);
  console.log('artworkRef <g> opacity:', afterClickInspect.artworkGOpacity);
  console.log('viewport SVG innerHTML:\n', afterClickInspect.viewportSvgHTML);

  // ── Mouse move ───────────────────────────────────────────────────────────
  console.log('\nStep 8: Mouse move to (0,0)');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT_DIR}/04-after-mouse-move.png` });
  console.log('Screenshot: 04-after-mouse-move.png');

  const afterMoveInspect = await page.evaluate(() => {
    const layer1El = document.getElementById('layer1');
    const layer2El = document.getElementById('layer2');
    const viewportSvg = document.querySelector('.lw-viewport svg');
    return {
      layer1Opacity: layer1El?.style?.opacity || '(not set)',
      layer2Opacity: layer2El?.style?.opacity || '(not set)',
      layer1ComputedOpacity: layer1El ? window.getComputedStyle(layer1El).opacity : 'N/A',
      viewportSvgHTML: viewportSvg?.innerHTML?.slice(0, 1500) ?? 'no viewport SVG',
    };
  });

  console.log('\n── After mouse move ──');
  console.log('layer1 style.opacity:', afterMoveInspect.layer1Opacity);
  console.log('layer2 style.opacity:', afterMoveInspect.layer2Opacity);
  console.log('layer1 computed opacity:', afterMoveInspect.layer1ComputedOpacity);
  console.log('viewport SVG innerHTML:\n', afterMoveInspect.viewportSvgHTML);

  // ── Console output ───────────────────────────────────────────────────────
  console.log('\n── Console errors ──');
  if (consoleErrors.length === 0) console.log('  (none)');
  else consoleErrors.forEach(e => console.log(' ', e));

  console.log('\n── All console messages ──');
  consoleMsgs.forEach(m => console.log(' ', m));

  console.log(`\nScreenshots: ${OUT_DIR}`);
  await browser.close();
  console.log('Done.');
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
