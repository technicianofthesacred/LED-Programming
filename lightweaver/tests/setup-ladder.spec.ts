import { test, expect } from '@playwright/test';

// The guided Setup ladder, walked without hardware. The card is a route mock and
// the link is driven straight through the shared card link, so every assertion
// here is about what the SCREEN does with an answer — which is exactly the part
// that was broken: rows that read as instructions but carried no action.
const CARD_ID = 'lw-setup-ladder';
// The link's default host. Dispatching a verification for any other host is
// ignored by the reducer, so the mock answers on this one.
const CARD_HOST = 'lightweaver.local';
const PIN = 18;
const LIGHTS = 41;

function readyStatus() {
  return {
    app: 'Lightweaver', provisioningContractVersion: 1,
    cardId: CARD_ID, firmwareVersion: '1.4.0', buildId: 'b'.repeat(40),
    bootId: 'boot-ladder-1', runtimePhase: 'ready', knownGoodProject: true,
    commandReady: true, outputReady: true,
    projectId: '', outputs: [],
    wifi: { transport: 'station', transition: 'station', transitionPending: false, stationIp: '192.168.18.70', ip: '192.168.18.70' },
  };
}

test.beforeEach(async ({ page }) => {
  await page.route(`http://${CARD_HOST}/api/status`, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(readyStatus()),
  }));
  // No project on the card: this is a blank card being set up for the first time.
  await page.route(`http://${CARD_HOST}/**`, route => route.fulfill({
    status: 404, contentType: 'application/json', body: '{}',
  }));
  await page.route('http://192.168.4.1/**', route => route.abort());

  await page.goto('/#screen=setup', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: /Set up your Lightweaver/i })).toBeVisible();

  await page.evaluate(async ({ cardId, host }) => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    const readiness = {
      app: 'Lightweaver', cardId, firmwareVersion: '1.4.0', buildId: 'b'.repeat(40),
      bootId: 'boot-ladder-1', runtimePhase: 'ready', knownGoodProject: true,
      commandReady: true, outputReady: true, provisioningContractVersion: 1,
    };
    const event = { type: 'card-verified', via: 'direct', host, card: { id: cardId }, readiness };
    // Two matching envelopes: the link requires a stable revalidation before it
    // treats a card as trusted.
    link.dispatch(event);
    link.dispatch(event);
  }, { cardId: CARD_ID, host: CARD_HOST });
});

const statusOf = (page, id: string) =>
  page.locator(`[data-testid="setup-step-${id}"]`).getAttribute('data-status');

// What the project actually recorded, read back out of the autosave the app
// writes. This is the answer the card is later built from.
const readStrip = (page) => page.evaluate(() => {
  const project = JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}');
  const strip = (project.portRoles || []).find((entry: any) => entry.role === 'strip');
  return {
    pin: strip?.pin,
    pixelCount: strip?.pixelCount,
    order: project?.devices?.standaloneController?.led?.colorOrder,
  };
});

test('each step answers its own question in place, and answering it advances the ladder', async ({ page }) => {
  await expect.poll(() => statusOf(page, 'pin'), { timeout: 15000 }).toBe('current');

  // The port picker is the step itself — not a collapsed panel inside it that
  // re-asks the colour order and the light count as well.
  await expect(page.getByTestId('setup-pin-value')).toBeVisible();
  await expect(page.getByTestId('setup-colour-value')).toHaveCount(0);
  await expect(page.getByTestId('setup-count-value')).toHaveCount(0);

  await page.getByTestId('setup-pin-value').selectOption(String(PIN));
  await page.getByTestId('setup-pin-apply').click();
  await expect.poll(() => statusOf(page, 'pin')).toBe('done');
  await expect.poll(() => statusOf(page, 'colour')).toBe('current');

  // Colour can be answered directly. It used to be answerable only by running a
  // hardware probe, or through the shared form that also reset the port.
  await page.getByTestId('setup-colour-value').selectOption('RGB');
  await page.getByTestId('setup-colour-set').click();
  await expect.poll(() => statusOf(page, 'colour')).toBe('done');
  await expect.poll(() => statusOf(page, 'count')).toBe('current');

  // The count field is present before the ruler has ever been lit.
  await page.getByTestId('setup-count-value').fill(String(LIGHTS));
  await page.getByTestId('setup-count-apply').click();
  await expect.poll(() => statusOf(page, 'count')).toBe('done');
  await expect.poll(() => statusOf(page, 'install')).toBe('current');

  await expect.poll(() => readStrip(page)).toEqual({ pin: PIN, pixelCount: LIGHTS, order: 'RGB' });
});

test('a zero count is refused instead of being recorded as an answer', async ({ page }) => {
  await expect.poll(() => statusOf(page, 'pin'), { timeout: 15000 }).toBe('current');
  await page.getByTestId('setup-pin-value').selectOption(String(PIN));
  await page.getByTestId('setup-pin-apply').click();
  await page.getByTestId('setup-colour-value').selectOption('RGB');
  await page.getByTestId('setup-colour-set').click();
  await expect.poll(() => statusOf(page, 'count')).toBe('current');

  await page.getByTestId('setup-count-value').fill('0');
  await page.getByTestId('setup-count-apply').click();
  await expect(page.getByTestId('setup-counting')).toContainText('above zero');
  expect(await statusOf(page, 'count')).toBe('current');
});

test('Change on a finished step opens that step\'s controls, seeded with its answer', async ({ page }) => {
  await expect.poll(() => statusOf(page, 'pin'), { timeout: 15000 }).toBe('current');
  await page.getByTestId('setup-pin-value').selectOption(String(PIN));
  await page.getByTestId('setup-pin-apply').click();
  await expect.poll(() => statusOf(page, 'pin')).toBe('done');

  // Reopening a done step used to render an empty box for every step except the
  // three that shared the wiring form, and those showed a blank form that wiped
  // the answer on submit.
  await page.getByTestId('setup-step-pin-change').click();
  await expect(page.getByTestId('setup-pin-value')).toHaveValue(String(PIN));

  await page.getByTestId('setup-step-wifi-change').click();
  await expect(page.getByTestId('setup-wifi-connect')).toBeVisible();

  await page.getByTestId('setup-step-flash-change').click();
  await expect(page.getByTestId('setup-connect-card')).toBeVisible();
});

test('changing the port keeps the light count rather than resetting the ladder', async ({ page }) => {
  await expect.poll(() => statusOf(page, 'pin'), { timeout: 15000 }).toBe('current');
  await page.getByTestId('setup-pin-value').selectOption(String(PIN));
  await page.getByTestId('setup-pin-apply').click();
  await page.getByTestId('setup-colour-value').selectOption('RGB');
  await page.getByTestId('setup-colour-set').click();
  await page.getByTestId('setup-count-value').fill(String(LIGHTS));
  await page.getByTestId('setup-count-apply').click();
  await expect.poll(() => statusOf(page, 'count')).toBe('done');

  await page.getByTestId('setup-step-pin-change').click();
  const otherPin = await page.getByTestId('setup-pin-value')
    .locator('option')
    .evaluateAll((options, current) => options.map(o => (o as HTMLOptionElement).value).find(v => v !== current), String(PIN));
  await page.getByTestId('setup-pin-value').selectOption(String(otherPin));
  await page.getByTestId('setup-pin-apply').click();

  await expect.poll(() => readStrip(page))
    .toEqual({ pin: Number(otherPin), pixelCount: LIGHTS, order: 'RGB' });
  expect(await statusOf(page, 'count')).toBe('done');
});

test('every "Any time" row does the thing it names', async ({ page }) => {
  await expect(page.getByTestId('setup-step-layout')).toBeVisible();

  await page.getByTestId('setup-step-controls-action').click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('mode=wire');

  await page.goto('/#screen=setup', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('setup-step-layout-action').click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('screen=layout');

  await page.goto('/#screen=setup', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('setup-step-save-action').click();
  // Saving is the top bar's save: it reports back through the workspace notice.
  await expect(page.locator('.workspace-notice, [data-testid=workspace-notice]')).toBeVisible({ timeout: 10000 });
});
