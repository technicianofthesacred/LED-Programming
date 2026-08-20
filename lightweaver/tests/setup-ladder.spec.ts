import { test, expect } from '@playwright/test';

// The guided Setup ladder, walked without hardware. The card is a route mock and
// the link is driven straight through the shared card link, so every assertion
// here is about what the SCREEN does with an answer — which is exactly the part
// that was broken: rows that read as instructions but carried no action.
const CARD_ID = 'lw-setup-ladder';
// The link's default host. Dispatching a verification for any other host is
// ignored by the reducer, so the mock answers on this one.
const CARD_HOST = 'lightweaver.local';

// A factory-blank card, reported the way the firmware actually reports one.
// The previous fixture claimed to be blank in a comment while answering
// runtimePhase 'ready' with knownGoodProject true, which no card does: the
// readiness classifier read it as a healthy card holding a project it would
// not name, and every screen below derived its state from that contradiction.
function blankStatus() {
  return {
    app: 'Lightweaver', provisioningContractVersion: 1,
    cardId: CARD_ID, firmwareVersion: '1.4.0', buildId: 'b'.repeat(40),
    bootId: 'boot-ladder-1', runtimePhase: 'factory', knownGoodProject: false,
    commandReady: false, playbackReady: false, outputReady: false,
    mode: 'factory-flash', source: 'defaults',
    projectId: '', outputs: [],
    wifi: { transport: 'station', transition: 'station', transitionPending: false, stationIp: '192.168.18.70', ip: '192.168.18.70' },
  };
}

// A commissioned card that is running normally. Used by the one test about a
// failed operation: 'blank' outranks a failed operation in the lifecycle, so a
// factory card can never reach the recover-operation task that test is about.
function commissionedStatus() {
  return {
    ...blankStatus(),
    runtimePhase: 'ready', knownGoodProject: true,
    commandReady: true, playbackReady: true, outputReady: true,
    mode: 'project', source: 'stored', projectId: 'ladder-piece',
  };
}

test.beforeEach(async ({ page }) => {
  await page.route(`http://${CARD_HOST}/api/status`, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(blankStatus()),
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

  // Drive the link with the same payload the route serves, so the screen and
  // the card agree about what this card is.
  await page.evaluate(async ({ cardId, host, readiness }) => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    const event = { type: 'card-verified', via: 'direct', host, card: { id: cardId }, readiness };
    // Two matching envelopes: the link requires a stable revalidation before it
    // treats a card as trusted.
    link.dispatch(event);
    link.dispatch(event);
  }, { cardId: CARD_ID, host: CARD_HOST, readiness: blankStatus() });
});

test('Setup presents four outcome phases with one active task', async ({ page }) => {
  const phases = page.locator('[data-testid^="setup-phase-"]');
  await expect(phases).toHaveCount(4);
  expect(await phases.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-phase-id'))))
    .toEqual(['connect', 'lights', 'layout', 'verify']);
  await expect(page.locator('[data-testid^="setup-phase-"][aria-current="step"]')).toHaveCount(1);
  await expect(page.getByTestId('setup-phase-lights')).toHaveAttribute('data-status', 'current');
  await expect(page.getByTestId('setup-phase-lights')).toContainText('Find and verify the lights');
  await expect(page.getByTestId('setup-phase-layout')).toContainText('Place lights in the artwork');
  await expect(page.getByTestId('setup-phase-verify')).toContainText('Test and save to card');
});

test('bottom-left attention opens the exact Setup task instead of a competing connection screen', async ({ page }) => {
  await page.route(`http://${CARD_HOST}/api/status`, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(commissionedStatus()),
  }));
  await page.evaluate(async ({ cardId, host, readiness }) => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    const event = { type: 'card-verified', via: 'direct', host, card: { id: cardId }, readiness };
    link.dispatch(event);
    link.dispatch(event);
    link.dispatch({ type: 'operation-failed' });
  }, { cardId: CARD_ID, host: CARD_HOST, readiness: commissionedStatus() });
  const status = page.getByTestId('card-link-status');
  await expect(status).toHaveAccessibleName(/Needs attention/);
  await status.click();
  await expect(page).toHaveURL(/#screen=card&section=setup&task=recover-operation$/);
  await expect(page.getByTestId('setup-phase-connect')).toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('setup-active-task')).toBeVisible();
});

test('blank card enters shared light discovery before Layout', async ({ page }) => {
  await page.getByTestId('setup-lights-action').click();
  await expect(page.getByTestId('card-setup-overlay')).toBeVisible();
  await expect(page.getByTestId('strip-discovery')).toBeVisible();
  await expect(page.getByTestId('setup-phase-layout')).toHaveAttribute('data-status', 'upcoming');
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('Setup removes the optional shelf and competing first-run actions', async ({ page }) => {
  await expect(page.getByText('Any time', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save the project', exact: true })).toHaveCount(0);
  await expect(page.getByText('Add knobs and buttons', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('setup-skip')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Open Layout/i })).toHaveCount(0);
});

test('Setup identity row names the exact card project and installed match', async ({ page }) => {
  const identity = page.getByTestId('setup-identity-row');
  await expect(identity).toBeVisible();
  await expect(identity).toContainText(CARD_ID);
  // A reached factory card is linked but holds nothing, and the row must say
  // which of those two facts it is reporting. 'Not connected' would be the
  // wrong answer here and is asserted against explicitly, because it contains
  // the word 'connected' and would otherwise satisfy a looser pattern.
  await expect(identity).not.toContainText('Not connected');
  await expect(identity).toContainText(/needs project/i);
  await expect(identity).toContainText(/project/i);
  await expect(identity).toContainText(/not installed|temporary setup|match/i);
});

test('Setup controls remain touchable in the focused mobile task column', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const task = page.getByTestId('setup-active-task');
  await expect(task).toBeVisible();
  const box = await task.boundingBox();
  expect(box?.width || 0).toBeLessThanOrEqual(366);
  expect(await task.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  for (const control of await task.locator('button, input, select').all()) {
    if (!(await control.isVisible())) continue;
    expect((await control.boundingBox())?.height || 0).toBeGreaterThanOrEqual(44);
  }
});
