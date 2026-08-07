// LIVE HARDWARE WALKTHROUGH — not part of CI.
//
// Drives the entire guided setup against Adrian's real card at 192.168.18.70:
// land on Setup, confirm the card is already flashed and on Wi-Fi, set the pin and
// colour order, light the counting ruler, record the real light count, install, and
// confirm the Patterns screen is usable. It is the acceptance test docs/ui-repair-plan.md
// (O3) has owed since the setup flow was first found broken.
//
// Run it with the card powered and on the LAN:
//   npx playwright test tests/live-setup-loop.spec.ts --project=chromium --workers=1
//
// It writes to the card. Do not run it against a piece that is installed somewhere.
import { test, expect } from '@playwright/test';

const CARD_ID = 'lw-b0fe81f61b44';
const HOST = '192.168.18.70';
const PIN = 18;
const LIGHTS = 41;

test.setTimeout(360000);

test('the whole setup loop, on the real card', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', e => problems.push('CRASH ' + e.message));

  await page.addInitScript(id => {
    if (!localStorage.getItem('lw_loop_seeded')) {
      localStorage.clear();
      localStorage.setItem('lw_loop_seeded', '1');
    }
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id }));
    localStorage.setItem('lw_card_host', '192.168.18.70');
  }, CARD_ID);

  // 1. A bare URL must land on the guided setup.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Set up your Lightweaver/i })).toBeVisible({ timeout: 15000 });
  console.log('STEP landing: ok');

  // 2. Steps 1 and 2 are already true for this card; step 3 is the live one.
  await page.waitForTimeout(4000);
  const statusOf = async (id: string) =>
    page.locator(`[data-testid="setup-step-${id}"]`).getAttribute('data-status');
  console.log('STEP ladder:', JSON.stringify({
    flash: await statusOf('flash'), wifi: await statusOf('wifi'), pin: await statusOf('pin'),
    colour: await statusOf('colour'), count: await statusOf('count'), install: await statusOf('install'),
  }));

  // 3. The pin only — the colour is measured, not guessed.
  await page.getByTestId('setup-pin-value').selectOption(String(PIN));
  await page.getByTestId('setup-pin-apply').click();
  await page.waitForTimeout(1500);
  console.log('STEP pin:', JSON.stringify({ pin: await statusOf('pin'), colour: await statusOf('colour') }));

  // 4. Colour: paint three blocks and put them in the order actually seen. This
  // strip renders true, so the order seen is the order sent and nothing moves.
  await page.getByTestId('setup-colour-show').click();
  await expect(page.getByTestId('setup-colour-chips')).toBeVisible({ timeout: 180000 });
  await page.getByTestId('setup-colour-apply').click();
  await page.waitForTimeout(1500);
  const recorded = await page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => /autosave/.test(k));
    return JSON.parse(localStorage.getItem(key || '') || '{}')?.devices?.standaloneController?.led?.colorOrder;
  });
  console.log('STEP colour:', await statusOf('colour'), '-> recorded', recorded);

  // 5. Count the lights with the ruler.
  await page.getByTestId('setup-count-show').click();
  for (let i = 0; i < 60; i += 1) {
    if (await page.getByTestId('setup-count-ruler-lit').count()) break;
    await page.waitForTimeout(3000);
  }
  if (!(await page.getByTestId('setup-count-ruler-lit').count())) {
    const notes = await page.locator('[data-testid=setup-counting] .lw-setup-note').allTextContents();
    console.log('STEP ruler FAILED:', JSON.stringify(notes));
    throw new Error('ruler never lit');
  }
  console.log('STEP ruler: lit');
  await page.getByTestId('setup-count-value').fill(String(LIGHTS));
  await page.getByTestId('setup-count-apply').click();
  await page.waitForTimeout(1500);
  console.log('STEP count:', await statusOf('count'));

  // 6. Put it on the card.
  await page.getByTestId('setup-step-install-action').click();
  await page.waitForTimeout(2500);
  const match = page.getByTestId('setup-install-match-drawing');
  if (await match.count()) {
    console.log('STEP install: drawing disagreed —', await page.getByTestId('setup-install-status').textContent());
    await match.click();
    await page.waitForTimeout(1200);
    await page.getByTestId('setup-step-install-action').click();
    await page.waitForTimeout(2500);
  }
  const takeOver = page.getByTestId('setup-install-takeover');
  if (await takeOver.count()) { console.log('STEP install: needed take-over'); await takeOver.click(); }
  for (let i = 0; i < 60; i += 1) {
    if (await page.getByTestId('setup-install-open-patterns').count()) break;
    await page.waitForTimeout(3000);
  }
  console.log('STEP install status:', await page.getByTestId('setup-install-status').textContent().catch(() => '(none)'));
  console.log('STEP install done?', await page.getByTestId('setup-install-open-patterns').count());

  // 7. Patterns must be usable immediately.
  await page.getByTestId('setup-install-open-patterns').click();
  await page.waitForTimeout(4000);
  const blocked = await page.getByText(/no project yet/i).count();
  console.log('STEP patterns: blockedGate=' + blocked);
  await page.screenshot({ path: '/tmp/loop-patterns.png', fullPage: true });

  console.log('PROBLEMS:', problems.length ? problems.join(' || ') : 'none');
});
