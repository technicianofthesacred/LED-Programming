import { test, expect, Page } from '@playwright/test';

const CARD_ID = 'lw-shot';
const CARD_HOST = 'lightweaver.local';
const PIN = 18;
const LIGHTS = 41;
const OUT = process.env.SHOT_DIR || 'test-results/shots';

async function boot(page: Page) {
  await page.route(`http://${CARD_HOST}/api/status`, r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      app: 'Lightweaver', provisioningContractVersion: 1, cardId: CARD_ID,
      firmwareVersion: '1.4.0', buildId: 'b'.repeat(40), bootId: 'boot-shot-1',
      runtimePhase: 'ready', knownGoodProject: true, commandReady: true,
      outputReady: true, projectId: '', outputs: [],
    }),
  }));
  await page.route(`http://${CARD_HOST}/**`, r => r.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.goto('/#screen=setup', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Set up your Lightweaver/i })).toBeVisible();
  await page.evaluate(async ({ cardId, host }) => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    const readiness = {
      app: 'Lightweaver', cardId, firmwareVersion: '1.4.0', buildId: 'b'.repeat(40),
      bootId: 'boot-shot-1', runtimePhase: 'ready', knownGoodProject: true,
      commandReady: true, outputReady: true, provisioningContractVersion: 1,
    };
    const e = { type: 'card-verified', via: 'direct', host, card: { id: cardId }, readiness };
    link.dispatch(e); link.dispatch(e);
  }, { cardId: CARD_ID, host: CARD_HOST });
  await expect.poll(() => page.locator('[data-testid="setup-step-pin"]').getAttribute('data-status'), { timeout: 15000 }).toBe('current');
}

async function walk(page: Page) {
  await page.getByTestId('setup-pin-value').selectOption(String(PIN));
  await page.getByTestId('setup-pin-apply').click();
  await page.getByTestId('setup-colour-value').selectOption('RGB');
  await page.getByTestId('setup-colour-set').click();
  await page.getByTestId('setup-count-value').fill(String(LIGHTS));
  await page.getByTestId('setup-count-apply').click();
  await expect.poll(() => page.locator('[data-testid="setup-step-count"]').getAttribute('data-status')).toBe('done');
}

for (const [name, width, height] of [['desktop', 1440, 1000], ['laptop', 1180, 900], ['mobile', 390, 844]] as const) {
  test(`shots ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await boot(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${name}-mid.png`, fullPage: true });
    await walk(page);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${name}-install.png`, fullPage: true });
    await page.getByTestId('setup-step-count-change').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}-reopened.png`, fullPage: true });
  });
}
