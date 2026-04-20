/**
 * pw-diag-v2-layers.mjs — targeted layer opacity / SVG render diagnostic for v2
 * Tests: SVG import, layer click, opacity changes, mouse-move regression
 * Run: node pw-diag-v2-layers.mjs
 */
import { chromium } from './node_modules/playwright/index.mjs';
import fs from 'fs';

const OUT_DIR  = process.env.TMPDIR + '/playwright-diag';
const SVG_PATH = '/tmp/claude-501/test-layers.svg';
const BASE_URL = 'http://localhost:9998';

fs.mkdirSync(OUT_DIR, { recursive: true });
console.log('Output dir:', OUT_DIR);

async function inspectArtworkG(page, label) {
  const result = await page.evaluate(() => {
    const mainSvg = document.querySelector('svg');
    if (!mainSvg) return { error: 'No SVG in DOM' };

    // The artworkRef <g> is the first <g> in the SVG that has dangerouslySetInnerHTML content
    // It will contain the child <g id="layer1"> and <g id="layer2"> nodes
    const topGs = Array.from(mainSvg.children).filter(el => el.tagName.toLowerCase() === 'g');

    let artworkG = null;
    for (const g of topGs) {
      // Look for the one that contains layer1 or layer2 as children
      if (g.querySelector('#layer1') || g.querySelector('#layer2')) {
        artworkG = g;
        break;
      }
      // Fallback: any <g> with substantial innerHTML (SVG content)
      if (g.innerHTML.length > 100 && g.children.length > 0) {
        artworkG = g;
        break;
      }
    }

    const allTopGsInfo = topGs.map(g => ({
      id: g.id || '(no-id)',
      opacity: g.style.opacity || '',
      childCount: g.children.length,
      innerHTML_len: g.innerHTML.length,
      hasLayer1: !!g.querySelector('#layer1'),
    }));

    if (!artworkG) {
      return {
        found: false,
        topGs_count: topGs.length,
        topGs: allTopGsInfo,
      };
    }

    const childGs = Array.from(artworkG.children).filter(el => el.tagName.toLowerCase() === 'g');

    return {
      found: true,
      artworkG: {
        id: artworkG.id || '(no-id)',
        style_opacity: artworkG.style.opacity || '(empty)',
        computed_opacity: window.getComputedStyle(artworkG).opacity,
        style_filter: artworkG.style.filter || '(empty)',
        innerHTML_length: artworkG.innerHTML.length,
        child_count: artworkG.children.length,
      },
      childGs: childGs.map((g, i) => ({
        index: i,
        id: g.id || '(no-id)',
        style_opacity: g.style.opacity || '(empty)',
        computed_opacity: window.getComputedStyle(g).opacity,
      })),
      allTopGsInfo,
    };
  });

  console.log(`\n── DOM [${label}] ──`);
  if (result.error) {
    console.log('  ERROR:', result.error);
  } else if (!result.found) {
    console.log('  artworkRef <g>: NOT FOUND');
    console.log('  topGs count:', result.topGs_count);
    console.log('  topGs:', JSON.stringify(result.topGs, null, 2));
  } else {
    console.log('  artworkRef <g> FOUND');
    console.log('  style.opacity:', result.artworkG.style_opacity);
    console.log('  computed opacity:', result.artworkG.computed_opacity);
    console.log('  innerHTML length:', result.artworkG.innerHTML_length);
    console.log('  child count:', result.artworkG.child_count);
    console.log('  children:');
    (result.childGs || []).forEach(g => {
      console.log(`    [${g.index}] id="${g.id}" style.opacity="${g.style_opacity}" computed="${g.computed_opacity}"`);
    });
  }
  return result;
}

async function run() {
  console.log('Launching Chromium (headless)...');
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

  // ── Step 1: Load and screenshot ──────────────────────────────────────────
  console.log('\nStep 1: Navigate to', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT_DIR}/01-initial.png` });
  console.log('Screenshot: 01-initial.png');

  // Report what mode/screen is shown
  const modeInfo = await page.evaluate(() => {
    const root = document.getElementById('root');
    return { rootHTML: root?.innerHTML?.slice(0, 300) ?? 'no #root', title: document.title };
  });
  console.log('Page title:', modeInfo.title);
  console.log('Root HTML snippet:', modeInfo.rootHTML);

  // ── Step 2: Upload SVG ───────────────────────────────────────────────────
  console.log('\nStep 2: Finding file input and uploading SVG');
  const fileInputs = await page.$$('input[type="file"]');
  console.log('File inputs found:', fileInputs.length);
  for (let i = 0; i < fileInputs.length; i++) {
    const accept = await fileInputs[i].getAttribute('accept');
    console.log(`  input[${i}]: accept="${accept}"`);
  }

  const svgInput = await page.$('input[accept=".svg"]');
  if (!svgInput) {
    console.log('No input[accept=".svg"] — trying input[type="file"]');
    if (fileInputs.length > 0) {
      await fileInputs[0].setInputFiles(SVG_PATH);
    } else {
      console.log('ERROR: No file input found at all');
      await browser.close();
      return;
    }
  } else {
    await svgInput.setInputFiles(SVG_PATH);
    console.log('SVG uploaded via input[accept=".svg"]');
  }

  // ── Step 3: Screenshot after import ─────────────────────────────────────
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT_DIR}/02-after-import.png` });
  console.log('Screenshot: 02-after-import.png');

  // ── Step 4: Inspect DOM ──────────────────────────────────────────────────
  console.log('\nStep 4: Inspect DOM after import');
  const dom1 = await inspectArtworkG(page, 'after-import');

  // Also report layer panel state
  const layerPanelInfo = await page.evaluate(() => {
    // Look for divs with layer names
    const withCursorPointer = Array.from(document.querySelectorAll('div[style*="cursor: pointer"], div[style*="cursor:pointer"]'));
    return {
      count: withCursorPointer.length,
      items: withCursorPointer.slice(0, 8).map(d => ({
        text: d.textContent?.trim()?.slice(0, 60),
        style: d.getAttribute('style')?.slice(0, 120),
      })),
    };
  });
  console.log('\nLayer panel divs (cursor:pointer):', layerPanelInfo.count);
  layerPanelInfo.items.forEach((item, i) => console.log(`  [${i}] "${item.text}" | style: ${item.style}`));

  // ── Step 5: Click first layer row ───────────────────────────────────────
  console.log('\nStep 5: Clicking first layer row');
  let clickedText = null;

  // Try text-based locators first
  const layerNames = ['Background', 'Foreground', 'Layer 1', 'layer1', 'layer2'];
  for (const name of layerNames) {
    const count = await page.locator(`text="${name}"`).count();
    if (count > 0) {
      await page.locator(`text="${name}"`).first().click({ timeout: 3000 });
      clickedText = name;
      console.log(`Clicked layer row: "${name}"`);
      break;
    }
  }

  if (!clickedText) {
    // Fall back: click first cursor:pointer div with text
    const clickableDivs = await page.$$('div[style*="cursor: pointer"], div[style*="cursor:pointer"]');
    console.log(`Fallback: found ${clickableDivs.length} cursor:pointer divs`);
    if (clickableDivs.length > 0) {
      const txt = await clickableDivs[0].textContent();
      await clickableDivs[0].click();
      clickedText = txt?.trim()?.slice(0, 40);
      console.log(`Clicked first cursor:pointer div: "${clickedText}"`);
    } else {
      console.log('WARNING: No clickable layer row found');
    }
  }

  // ── Step 6: Screenshot after click ──────────────────────────────────────
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT_DIR}/03-after-click.png` });
  console.log('Screenshot: 03-after-click.png');

  // ── Step 7: Re-inspect opacity ───────────────────────────────────────────
  console.log('\nStep 7: DOM inspection after layer click');
  const dom2 = await inspectArtworkG(page, 'after-layer-click');

  // ── Step 8: Mouse to (0,0) ───────────────────────────────────────────────
  console.log('\nStep 8: Mouse.move(0, 0) — testing mouse-leave regression');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT_DIR}/04-after-mouse-move.png` });
  console.log('Screenshot: 04-after-mouse-move.png');

  // ── Step 9: Re-inspect opacity ───────────────────────────────────────────
  console.log('\nStep 9: DOM inspection after mouse move');
  const dom3 = await inspectArtworkG(page, 'after-mouse-move');

  // ── Final summary ────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('════════════════════════════════════════');

  console.log('\n[1] After SVG import:');
  if (dom1.found) {
    console.log(`    artworkRef <g>: PRESENT (innerHTML ${dom1.artworkG.innerHTML_length} bytes)`);
    console.log(`    artworkRef opacity: ${dom1.artworkG.style_opacity}`);
    (dom1.childGs || []).forEach(g =>
      console.log(`    child "${g.id}": style.opacity="${g.style_opacity}" computed="${g.computed_opacity}"`));
  } else {
    console.log('    artworkRef <g>: NOT FOUND (SVG content not injected)');
  }

  console.log('\n[2] After clicking layer row:');
  if (dom2.found) {
    console.log(`    artworkRef opacity: ${dom2.artworkG.style_opacity}`);
    (dom2.childGs || []).forEach(g =>
      console.log(`    child "${g.id}": style.opacity="${g.style_opacity}" computed="${g.computed_opacity}"`));
    const opacitiesChanged = dom1.childGs?.some((g, i) => g.style_opacity !== dom2.childGs?.[i]?.style_opacity);
    console.log(`    Opacities changed vs import: ${opacitiesChanged ? 'YES' : 'NO'}`);
  } else {
    console.log('    artworkRef <g>: DISAPPEARED after click (React re-render wiped innerHTML?)');
  }

  console.log('\n[3] After mouse.move(0,0):');
  if (dom3.found) {
    console.log(`    artworkRef opacity: ${dom3.artworkG.style_opacity}`);
    (dom3.childGs || []).forEach(g =>
      console.log(`    child "${g.id}": style.opacity="${g.style_opacity}" computed="${g.computed_opacity}"`));
    const opacitiesResetAfterMove = dom2.childGs?.some((g, i) => g.style_opacity !== dom3.childGs?.[i]?.style_opacity);
    console.log(`    Opacities reset vs after-click: ${opacitiesResetAfterMove ? 'YES (regression!)' : 'NO (stable)'}`);
  } else {
    console.log('    artworkRef <g>: DISAPPEARED after mouse move');
  }

  console.log('\n[4] Console errors:');
  if (consoleErrors.length === 0) {
    console.log('    (none)');
  } else {
    consoleErrors.forEach(e => console.log('   ', e));
  }

  console.log('\n[5] All console messages:');
  consoleMsgs.slice(0, 30).forEach(m => console.log('   ', m));
  if (consoleMsgs.length > 30) console.log(`    ... (${consoleMsgs.length - 30} more)`);

  console.log(`\nScreenshots in: ${OUT_DIR}`);

  await browser.close();
  console.log('Done.');
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
