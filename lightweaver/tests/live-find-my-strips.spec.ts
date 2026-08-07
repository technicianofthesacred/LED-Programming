// LIVE HARDWARE WALKTHROUGH — not part of CI.
//
// Walks "Find my strips" on Adrian's real card at 192.168.18.70 the way an owner
// who knows nothing about their wiring would: pick the port, watch the probe,
// answer the colour check, enter the count, confirm the end marker, and install.
// The guided Setup screen is the other entrance to the same questions and has its
// own walkthrough in live-setup-loop.spec.ts.
//
// Run with the card powered and on the LAN:
//   npx playwright test tests/live-find-my-strips.spec.ts --project=chromium --workers=1
//
// It writes to the card. Do not run it against a piece that is installed somewhere.
import { test, expect } from '@playwright/test';

const CARD_ID = 'lw-b0fe81f61b44';
const PIN = 18;
const LIGHTS = 41;

test.setTimeout(600000);

test('find my strips, on the real card', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', e => problems.push('CRASH ' + e.message));

  await page.addInitScript(id => {
    if (!localStorage.getItem('lw_find_seeded')) {
      localStorage.clear();
      localStorage.setItem('lw_find_seeded', '1');
    }
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id }));
    localStorage.setItem('lw_card_host', '192.168.18.70');
  }, CARD_ID);

  await page.goto('/#screen=discovery', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('discovery-plan')).toBeVisible({ timeout: 30000 });
  console.log('FIND plan: visible');

  // Click the port to light it — the owner watches the strip, not a sweep.
  await page.getByTestId(`discovery-probe-${PIN}`).click();
  await page.waitForTimeout(2500);
  console.log('FIND probe: pinned GPIO ' + PIN);

  // Claim the port right where it is lit — one tap, no hunting back through the list.
  await page.getByTestId(`discovery-claim-${PIN}`).click();
  await page.waitForTimeout(500);
  console.log('FIND claim: GPIO ' + PIN + ' marked as the strip');
  const start = page.getByRole('button', { name: /Start|Find|Begin/i }).first();
  await start.click().catch(() => {});

  for (let i = 0; i < 60; i += 1) {
    if (await page.getByTestId('discovery-probe').count()) break;
    await page.waitForTimeout(3000);
  }
  if (!(await page.getByTestId('discovery-probe').count())) {
    const failure = await page.getByTestId('discovery-failure').textContent().catch(() => null);
    console.log('FIND probe FAILED:', failure || '(no message)');
    throw new Error('probe never started');
  }
  console.log('FIND probe: lit,', await page.getByTestId('discovery-lit-count').textContent(), 'lights');

  // The colour check, skipped here — the guided screen's reorder is the real one.
  if (await page.getByTestId('discovery-color-skip').count()) {
    await page.getByTestId('discovery-color-skip').click();
    console.log('FIND colour: skipped');
  }

  await page.getByTestId('discovery-enough').click();
  await page.getByTestId(`discovery-count-${PIN}`).fill(String(LIGHTS));
  await page.getByTestId('discovery-counts-done').click();
  await page.waitForTimeout(2000);
  console.log('FIND count: entered', LIGHTS);

  await page.getByTestId('discovery-end-yes').click();
  await page.waitForTimeout(1500);
  console.log('FIND end marker: confirmed');

  await page.getByTestId('discovery-record-save').click();
  for (let i = 0; i < 80; i += 1) {
    if (await page.getByTestId('discovery-done').count()) break;
    if (await page.getByTestId('discovery-install-takeover').count()) {
      console.log('FIND install: card was spoken for, taking it over');
      await page.getByTestId('discovery-install-takeover').click();
      await page.waitForTimeout(2000);
      continue;
    }
    if (await page.getByTestId('discovery-install-failed').count()) {
      console.log('FIND install FAILED:', (await page.getByTestId('discovery-install-failed').textContent())?.slice(0, 200));
      throw new Error('install failed');
    }
    await page.waitForTimeout(3000);
  }
  // The walk ends on a screen that still needs the real setup pressed onto the card.
  await page.getByTestId('discovery-install').click();
  for (let i = 0; i < 80; i += 1) {
    if (await page.getByTestId('discovery-installed').count()) break;
    if (await page.getByTestId('discovery-install-takeover').count()) {
      console.log('FIND install: card was spoken for, taking it over');
      await page.getByTestId('discovery-install-takeover').click();
      await page.waitForTimeout(2000);
      continue;
    }
    if (await page.getByTestId('discovery-install-failed').count()) {
      console.log('FIND install FAILED:', (await page.getByTestId('discovery-install-failed').textContent())?.slice(0, 200));
      throw new Error('install failed');
    }
    await page.waitForTimeout(3000);
  }
  console.log('FIND install: done?', await page.getByTestId('discovery-installed').count());
  // The card must end up driving what was MEASURED, not the temporary bench setup.
  const onCard = await page.evaluate(async () => {
    const r = await fetch('http://192.168.18.70/api/firmware-info', { cache: 'no-store' });
    const j = await r.json();
    return { pixels: j.pixels, pin: j.outputs?.[0]?.pin, phase: j.runtimePhase };
  });
  console.log('FIND card holds:', JSON.stringify(onCard), '(want pixels ' + LIGHTS + ' on pin ' + PIN + ')');
  console.log('PROBLEMS:', problems.length ? problems.join(' || ') : 'none');
});
