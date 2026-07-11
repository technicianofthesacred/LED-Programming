import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Phase 2 step 8 (docs/layout-redesign-plan.md) — the Size mode panel: the
// artwork-size → density → per-strip-count derivation chain, plus the
// `stripCountOverrides` behaviour fix (a manual per-strip count survives
// density / scale / calibrate rescales instead of being silently overwritten).

function writeLayerFixture(tmp: string, fileName = 'size-mode-layers.svg') {
  const fixture = path.join(tmp, fileName);
  fs.writeFileSync(fixture, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
  <g id="bg-layer" data-name="Background">
    <path d="M 20 20 H 380 V 280 H 20 Z" fill="none" stroke="#888" stroke-width="2"/>
  </g>
  <g id="circle-layer" data-name="Circle">
    <path d="M 200 130 m -70 0 a 70 70 0 1 0 140 0 a 70 70 0 1 0 -140 0" fill="none" stroke="#e74c3c" stroke-width="3"/>
  </g>
  <g id="bar-layer" data-name="Bar">
    <path d="M 60 230 H 340" fill="none" stroke="#27ae60" stroke-width="4"/>
  </g>
</svg>`);
  return fixture;
}

async function importThreeStrips(page: any, tmp: string) {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', writeLayerFixture(tmp));
  await expect(page.locator('.layer-row')).toHaveCount(3);
  await page.getByRole('button', { name: /\+ All \(3\)/ }).click();
  await expect(page.locator('.la-strip-row')).toHaveCount(3);
}

test('Size mode chain renders; a manual count overrides, survives density, resets, and calibrates', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-size-mode-'));
  await importThreeStrips(page, tmp);

  // Enter Size mode via the keyboard (focus is on the "+ All" button, not an
  // input, so the global 1/2/3 handler fires).
  await page.keyboard.press('2');
  await expect(page.getByTestId('layout-mode-size')).toHaveClass(/on/);

  // The derivation chain: artwork size field, density segmented control, one
  // row per strip.
  await expect(page.getByTestId('layout-size-panel')).toBeVisible();
  // (the toolbar carries a twin Size width control this step — dupes trim in
  // step 10 — so scope the width-field assertion to the panel)
  await expect(page.getByTestId('layout-size-panel').getByLabel(/Artwork width in cm/)).toBeVisible();
  await expect(page.getByTestId('layout-size-density')).toBeVisible();
  await expect(page.getByTestId('layout-size-strip-row')).toHaveCount(3);

  const bgCount = page.getByLabel('Background LED count');
  const circleCount = page.getByLabel('Circle LED count');

  // No override to start with.
  await expect(page.getByTestId('layout-size-count-override-badge')).toHaveCount(0);

  // ── Manually set the Background strip's count → override badge appears ──
  await bgCount.fill('99');
  await bgCount.blur();
  await expect(page.getByTestId('layout-size-count-override-badge')).toHaveCount(1);
  await expect(bgCount).toHaveValue('99');

  const circleBefore = await circleCount.inputValue();

  // ── Change density → the overridden strip is untouched, others rescale ──
  await page.getByTestId('layout-size-density').getByRole('button', { name: '144' }).click();
  await expect(bgCount).toHaveValue('99');                 // override preserved
  await expect(circleCount).not.toHaveValue(circleBefore); // non-overridden rescaled
  await expect(page.getByTestId('layout-size-count-override-badge')).toHaveCount(1);

  // ── Reset → badge clears and the count rejoins the computed value ──
  await page.getByTestId('layout-size-count-override-badge').getByRole('button').click();
  await expect(page.getByTestId('layout-size-count-override-badge')).toHaveCount(0);
  await expect(bgCount).not.toHaveValue('99');

  // ── Calibrate from a strip rescales every other (non-overridden) strip ──
  const barCount = page.getByLabel('Bar LED count');
  const barBefore = await barCount.inputValue();
  // Skew the Background strip to a distinctly different count, then declare it
  // ground truth — the whole piece's scale back-solves and the others follow.
  await bgCount.fill('220');
  await bgCount.blur();
  await page.getByTestId('layout-size-strip-row')
    .filter({ hasText: 'Background' })
    .getByRole('button', { name: 'Calibrate from this strip' })
    .click();
  await expect(barCount).not.toHaveValue(barBefore);
  // The calibrating strip keeps the counted value it was calibrated from.
  await expect(bgCount).toHaveValue('220');
});

test('a count set in Draw mode strip detail shows as an override in Size mode', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-size-shared-'));
  await importThreeStrips(page, tmp);

  // Draw mode is active; open the first strip's detail and set its count.
  await page.locator('.la-strip-row').first().click();
  const drawCount = page.getByLabel('Strip LED count', { exact: true });
  await expect(drawCount).toBeVisible();
  await drawCount.fill('55');
  await drawCount.blur();

  // Switch to Size mode (click the segment — focus is in an input, so the
  // keyboard handler is intentionally suppressed).
  await page.getByTestId('layout-mode-size').click();
  await expect(page.getByTestId('layout-size-panel')).toBeVisible();

  // The shared override state surfaces here: the first strip carries the badge
  // and the hand-set count.
  await expect(page.getByTestId('layout-size-count-override-badge')).toHaveCount(1);
  await expect(page.getByLabel('Background LED count')).toHaveValue('55');
});
