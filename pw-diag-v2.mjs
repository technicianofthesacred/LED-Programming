/**
 * pw-diag-v2.mjs — diagnostic script for Lightweaver v2 (port 9998)
 * Run: node pw-diag-v2.mjs
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const OUT_DIR  = process.env.TMPDIR + '/playwright-diag';
const SVG_PATH = '/tmp/claude-501/test-layers.svg';
const BASE_URL = 'http://localhost:9998';

fs.mkdirSync(OUT_DIR, { recursive: true });

const consoleLogs = [];
const consoleErrors = [];

async function inspectArtwork(page, label) {
  const result = await page.evaluate(() => {
    // Look for the artworkRef <g> — it's a <g> inside the main SVG that has
    // dangerouslySetInnerHTML content (will contain child <g id="layer1"> etc.)
    const mainSvg = document.querySelector('svg');
    if (!mainSvg) return { error: 'No SVG found' };

    // Find all direct <g> children of the SVG
    const topGs = Array.from(mainSvg.children).filter(el => el.tagName.toLowerCase() === 'g');

    // The artworkRef <g> is the one whose innerHTML contains layer1/layer2
    let artworkG = null;
    for (const g of topGs) {
      if (g.querySelector('#layer1') || g.querySelector('#layer2') || g.innerHTML.length > 50) {
        artworkG = g;
        break;
      }
    }

    if (!artworkG) {
      return {
        found: false,
        totalTopGs: topGs.length,
        topGIds: topGs.map(g => g.id || '(no id)'),
        svgChildCount: mainSvg.children.length,
      };
    }

    const childGs = Array.from(artworkG.children).filter(el => el.tagName.toLowerCase() === 'g');

    return {
      found: true,
      artworkG: {
        id: artworkG.id || '(no id)',
        style_opacity: artworkG.style.opacity || '(not set)',
        style_filter: artworkG.style.filter || '(not set)',
        innerHTML_length: artworkG.innerHTML.length,
        childCount: artworkG.children.length,
      },
      childGs: childGs.map((g, i) => ({
        index: i,
        id: g.id || '(no id)',
        style_opacity: g.style.opacity || '(not set)',
        computed_opacity: window.getComputedStyle(g).opacity,
      })),
      allTopGs: topGs.length,
    };
  });
  console.log(`\n=== DOM inspection [${label}] ===`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx     = browser.newContext ? await browser.newContext() : null;
  const page    = ctx ? await ctx.newPage() : await browser.newPage();

  page.on('console', msg => {
    const entry = `[${msg.type()}] ${msg.text()}`;
    consoleLogs.push(entry);
    if (msg.type() === 'error') consoleErrors.push(entry);
  });
  page.on('pageerror', err => {
    const entry = `[PAGE ERROR] ${err.message}`;
    consoleErrors.push(entry);
    consoleLogs.push(entry);
  });

  // ── Step 1: Navigate and screenshot ────────────────────────────────────────
  console.log('Step 1: Navigating to', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '01-initial.png'), fullPage: true });
  console.log('Screenshot: 01-initial.png');

  // ── Step 2: Upload SVG ─────────────────────────────────────────────────────
  console.log('\nStep 2: Uploading SVG from', SVG_PATH);
  const fileInput = await page.$('input[accept=".svg"]');
  if (!fileInput) {
    console.error('ERROR: Could not find input[accept=".svg"]');
    // Try alternatives
    const allInputs = await page.$$('input[type="file"]');
    console.log('All file inputs found:', allInputs.length);
  } else {
    await fileInput.setInputFiles(SVG_PATH);
    console.log('SVG file set on input');
  }

  // ── Step 3: Wait and screenshot ────────────────────────────────────────────
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT_DIR, '02-after-import.png'), fullPage: true });
  console.log('Screenshot: 02-after-import.png');

  // ── Step 4: Inspect DOM ────────────────────────────────────────────────────
  console.log('\nStep 4: DOM inspection after import');
  const dom1 = await inspectArtwork(page, 'after-import');

  // ── Step 5: Click first layer row ─────────────────────────────────────────
  console.log('\nStep 5: Looking for layer rows in right panel');

  // Try to find and click the first layer row
  const layerRowInfo = await page.evaluate(() => {
    // Look for elements containing "Background" or "Foreground" text
    const allDivs = Array.from(document.querySelectorAll('div'));
    const layerRows = allDivs.filter(d => {
      const txt = d.textContent?.trim();
      return (txt === 'Background' || txt === 'Foreground' || txt === 'Layer 1' || txt === 'layer1') &&
             d.children.length === 0; // leaf text node
    });

    // Also look for divs with cursor:pointer in the right panel area
    const clickables = allDivs.filter(d => {
      const cs = window.getComputedStyle(d);
      const txt = d.textContent?.trim() || '';
      return cs.cursor === 'pointer' && (txt.includes('Background') || txt.includes('Foreground') || txt.includes('Layer'));
    });

    return {
      textMatches: layerRows.map(d => ({
        text: d.textContent?.trim(),
        tagName: d.tagName,
        className: d.className,
      })).slice(0, 5),
      clickableMatches: clickables.map(d => ({
        text: d.textContent?.trim()?.slice(0, 40),
        tagName: d.tagName,
        className: d.className,
        hasOnClick: !!d.onclick,
      })).slice(0, 5),
    };
  });
  console.log('Layer row candidates:', JSON.stringify(layerRowInfo, null, 2));

  // Try clicking by text content
  let clicked = false;
  const layerNames = ['Background', 'Foreground', 'Layer 1', 'layer1'];
  for (const name of layerNames) {
    try {
      const el = page.locator(`text="${name}"`).first();
      const count = await el.count();
      if (count > 0) {
        console.log(`Found element with text "${name}", clicking...`);
        await el.click({ timeout: 2000 });
        clicked = true;
        console.log(`Clicked "${name}"`);
        break;
      }
    } catch (e) {
      console.log(`Could not click "${name}":`, e.message);
    }
  }

  if (!clicked) {
    console.log('Trying to click any element with cursor:pointer containing layer text...');
    try {
      // Use evaluate to click the first matching element
      await page.evaluate(() => {
        const allDivs = Array.from(document.querySelectorAll('div'));
        for (const d of allDivs) {
          const txt = d.textContent?.trim() || '';
          const cs = window.getComputedStyle(d);
          if (cs.cursor === 'pointer' && txt.length > 0 && txt.length < 50) {
            d.click();
            return txt;
          }
        }
        return null;
      });
    } catch (e) {
      console.log('Fallback click failed:', e.message);
    }
  }

  // ── Step 6: Wait and screenshot ────────────────────────────────────────────
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '03-after-click.png'), fullPage: true });
  console.log('Screenshot: 03-after-click.png');

  // ── Step 7: Re-inspect DOM ─────────────────────────────────────────────────
  console.log('\nStep 7: DOM inspection after click');
  const dom2 = await inspectArtwork(page, 'after-layer-click');

  // ── Step 8: Move mouse to neutral area ────────────────────────────────────
  console.log('\nStep 8: Moving mouse to (0, 0)');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '04-after-mouse-move.png'), fullPage: true });
  console.log('Screenshot: 04-after-mouse-move.png');

  // ── Step 9: Re-inspect DOM ─────────────────────────────────────────────────
  console.log('\nStep 9: DOM inspection after mouse move');
  const dom3 = await inspectArtwork(page, 'after-mouse-move');

  // ── Step 10: Console log summary ──────────────────────────────────────────
  console.log('\n=== Console errors during session ===');
  if (consoleErrors.length === 0) {
    console.log('(none)');
  } else {
    consoleErrors.forEach(e => console.log(e));
  }

  console.log('\n=== All console messages ===');
  consoleLogs.forEach(l => console.log(l));

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n=== SUMMARY ===');
  console.log('After import — artworkRef <g> found:', dom1.found);
  if (dom1.found) {
    console.log('  artworkRef style.opacity:', dom1.artworkG.style_opacity);
    console.log('  innerHTML length:', dom1.artworkG.innerHTML_length);
    console.log('  child <g> count:', dom1.childGs?.length);
    dom1.childGs?.forEach(g => console.log(`    child[${g.index}] id="${g.id}" opacity="${g.style_opacity}" computed="${g.computed_opacity}"`));
  }

  console.log('\nAfter layer click — artworkRef <g> found:', dom2.found);
  if (dom2.found) {
    console.log('  artworkRef style.opacity:', dom2.artworkG.style_opacity);
    dom2.childGs?.forEach(g => console.log(`    child[${g.index}] id="${g.id}" opacity="${g.style_opacity}" computed="${g.computed_opacity}"`));
  }

  console.log('\nAfter mouse move — artworkRef <g> found:', dom3.found);
  if (dom3.found) {
    console.log('  artworkRef style.opacity:', dom3.artworkG.style_opacity);
    dom3.childGs?.forEach(g => console.log(`    child[${g.index}] id="${g.id}" opacity="${g.style_opacity}" computed="${g.computed_opacity}"`));
  }

  console.log(`\nScreenshots saved to: ${OUT_DIR}`);

  await browser.close();
})();
