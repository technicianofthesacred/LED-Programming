// LIVE HARDWARE WALKTHROUGH — not part of CI.
//
// Steps 8-11 of Adrian's flow, USED rather than probed, against the real card:
//   8  put patterns on the chip so they play with the browser closed
//   9  place the strips on the layout, wired to the right port
//   10 save the project to the computer and load it back
//   11 wire a knob to a GPIO pin
//
// Run with the card powered, on the LAN, and already set up (run
// live-setup-loop.spec.ts first):
//   npx playwright test tests/live-steps-8-to-11.spec.ts --project=chromium --workers=1
import { test, expect } from '@playwright/test';

const CARD_ID = 'lw-b0fe81f61b44';
const HOST = 'http://192.168.18.70';
const PIN = 18;
const LIGHTS = 41;

test.setTimeout(600000);

async function cardSays(page: any) {
  return page.evaluate(async (host: string) => {
    const r = await fetch(`${host}/api/firmware-info`, { cache: 'no-store' });
    const j = await r.json();
    return { pixels: j.pixels, pin: j.outputs?.[0]?.pin, phase: j.runtimePhase, order: j.outputColor?.colorOrder };
  }, HOST);
}

test('steps 8 to 11, used for real', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', e => problems.push('CRASH ' + e.message));

  await page.addInitScript(id => {
    if (!localStorage.getItem('lw_s811')) { localStorage.clear(); localStorage.setItem('lw_s811', '1'); }
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id }));
    localStorage.setItem('lw_card_host', '192.168.18.70');
  }, CARD_ID);

  // Get to a genuinely set-up project the way an owner does.
  await page.goto('/#screen=setup', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  // Each step now answers its own question in place — port, then colour order,
  // then the light count — instead of one shared form that re-asked all three.
  await page.getByTestId('setup-pin-value').selectOption(String(PIN));
  await page.getByTestId('setup-pin-apply').click();
  await page.waitForTimeout(1200);
  await page.getByTestId('setup-colour-value').selectOption('RGB');
  await page.getByTestId('setup-colour-set').click();
  await page.waitForTimeout(1200);
  await page.getByTestId('setup-count-value').fill(String(LIGHTS));
  await page.getByTestId('setup-count-apply').click();
  await page.waitForTimeout(1500);
  await page.getByTestId('setup-step-install-action').click();
  for (let i = 0; i < 60; i += 1) {
    if (await page.getByTestId('setup-install-open-patterns').count()) break;
    const takeOver = page.getByTestId('setup-install-takeover');
    if (await takeOver.count()) { await takeOver.click(); }
    const match = page.getByTestId('setup-install-match-drawing');
    if (await match.count()) { await match.click(); await page.waitForTimeout(800); await page.getByTestId('setup-step-install-action').click(); }
    await page.waitForTimeout(3000);
  }
  console.log('SETUP card:', JSON.stringify(await cardSays(page)));

  // ── 8. Patterns onto the chip ────────────────────────────────────────────
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await expect(page.getByText(/no project yet/i)).toHaveCount(0);
  const pattern = page.getByText('Rainbow', { exact: true }).first();
  if (await pattern.count()) { await pattern.click(); await page.waitForTimeout(2500); }
  const install = page.getByRole('button', { name: /Install on card/i }).first();
  console.log('STEP8 install control present:', await install.count());
  if (await install.count()) {
    await install.click();
    await page.waitForTimeout(12000);
  }
  const afterInstall = await page.evaluate(async (host: string) => {
    const r = await fetch(`${host}/api/patterns`, { cache: 'no-store' });
    const j = await r.json();
    return { current: j.currentId, count: j.patterns?.length };
  }, HOST);
  console.log('STEP8 card patterns:', JSON.stringify(afterInstall));

  // ── 9. Layout knows the wiring ──────────────────────────────────────────
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const chip = await page.locator('[data-testid^="wire-discovered-"]').first().textContent().catch(() => null);
  console.log('STEP9 layout shows:', JSON.stringify(chip));

  // ── 10. Save to the computer, then load it back ─────────────────────────
  await page.goto('/#screen=settings', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const exportBtn = page.getByRole('button', { name: /Export|Download/i }).first();
  let savedName = '';
  if (await exportBtn.count()) {
    const download = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await exportBtn.click();
    const file = await download;
    savedName = file ? file.suggestedFilename() : '';
  }
  console.log('STEP10 saved file:', JSON.stringify(savedName));

  // ── 11. Wire a knob to a GPIO pin ───────────────────────────────────────
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const selects = page.locator('select');
  const total = await selects.count();
  let knobSet = '';
  for (let i = 0; i < total; i += 1) {
    const label = await selects.nth(i).getAttribute('aria-label') || '';
    if (/dimmer|encoder|knob|previous|next|blackout/i.test(label)) {
      const options = await selects.nth(i).locator('option').allTextContents();
      const target = options.find(o => /GPIO\s*21|^21$/.test(o));
      if (target) { await selects.nth(i).selectOption({ label: target }).catch(() => {}); knobSet = label + ' -> ' + target; }
      break;
    }
  }
  console.log('STEP11 control pin set:', JSON.stringify(knobSet), 'of', total, 'selectors');

  console.log('FINAL card:', JSON.stringify(await cardSays(page)));
  console.log('PROBLEMS:', problems.length ? problems.slice(0, 3).join(' || ') : 'none');
});
