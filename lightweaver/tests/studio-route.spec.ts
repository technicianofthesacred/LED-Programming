import { test, expect, type Page } from '@playwright/test';

// The URL and the screen it names must never disagree. They used to be two
// separate states reconciled by an effect, and every way that reconciliation
// could fire from stale state was a way for the owner to end up on one screen
// while the URL — which a reload, a bookmark and the recovery diagnostic all
// read — named another.

const TAB_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const STORED_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const ACCEPTED_RESULT = {
  operation: 'restart-card',
  status: 'awaiting-card-acknowledgement',
  code: 'operation-complete',
  target: 'lightweaver-controller-esp32s3',
  verification: 'not-verified',
  physicalOutput: 'unconfirmed',
  physicalProof: false,
};

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

function railItem(page: Page, label: string) {
  return page.locator(`.rail-item[aria-label="${label}"]`);
}

async function routeHash(page: Page) {
  return page.evaluate(() => window.location.hash);
}

// A Bridge operation that finished in the card tab and was accepted by this
// tab before it reloaded. On the next boot the shell moves the owner to Layout
// and opens the connection center over it — a screen change that originates in
// storage, not in a click and not in the URL.
async function seedAcceptedBridgeResult(page: Page) {
  await page.addInitScript(({ tabId, ttl, result }) => {
    const acceptedAt = Date.now();
    window.sessionStorage.setItem('lightweaver.bridge.origin-tab.v1', tabId);
    window.localStorage.setItem(
      'lightweaver.bridge.accepted-result-registry.v1',
      JSON.stringify({ version: 1, records: [{ acceptedAt, expiresAt: acceptedAt + ttl, result, tabId }] }),
    );
  }, { tabId: TAB_ID, ttl: STORED_RESULT_TTL_MS, result: ACCEPTED_RESULT });
}

test('a stored Bridge result that moves the owner to Layout moves the URL with it', async ({ page }) => {
  // The regression: this navigation is not a click, so it never announced
  // itself to the reconciler, which then declined to touch a URL naming the
  // card. Layout rendered under #screen=card&section=setup, and reloading —
  // or reading the route for a support code — sent the owner back to the card.
  await seedAcceptedBridgeResult(page);
  await page.goto('/#screen=card&section=setup', { waitUntil: 'domcontentloaded' });

  await expect(railItem(page, 'Layout')).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => routeHash(page)).toBe('#screen=layout');
  await expect(railItem(page, 'Setup')).not.toHaveAttribute('aria-current', 'page');
});

test('a screen that hands off by writing the hash keeps the screen it asked for', async ({ page }) => {
  // The card's "continue to Patterns" handoff. The hash assignment moves the
  // URL a task before hashchange lands; nothing may rewrite it in that gap.
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(railItem(page, 'Setup')).toHaveAttribute('aria-current', 'page');

  await page.evaluate(() => { window.location.hash = '#screen=pattern'; });

  await expect(railItem(page, 'Patterns')).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => routeHash(page)).toBe('#screen=pattern');
});

test('arriving at the screen you are already on leaves the route naming it', async ({ page }) => {
  // Re-selecting the current rail item is a no-op navigation. The previous fix
  // armed a one-shot permission here that nothing consumed, so it stayed armed
  // and authorized a later overwrite of somebody else's navigation.
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await expect(railItem(page, 'Layout')).toHaveAttribute('aria-current', 'page');

  await railItem(page, 'Layout').click();
  await expect.poll(() => routeHash(page)).toBe('#screen=layout&mode=wire');

  // …and the next real navigation, from a screen rather than the rail, still wins.
  await page.evaluate(() => { window.location.hash = '#screen=pattern'; });
  await expect(railItem(page, 'Patterns')).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => routeHash(page)).toBe('#screen=pattern');
});

test('rail navigation canonicalizes the route it lands on', async ({ page }) => {
  await page.goto('/#screen=card&section=setup', { waitUntil: 'domcontentloaded' });

  await railItem(page, 'Patterns').click();
  await expect(railItem(page, 'Patterns')).toHaveAttribute('aria-current', 'page');
  // A card section means nothing on Patterns and must not follow the owner.
  await expect.poll(() => routeHash(page)).toBe('#screen=pattern');

  await railItem(page, 'Setup').click();
  await expect.poll(() => routeHash(page)).toBe('#screen=card&section=setup');
});

test('a legacy card entrance still resolves and is left in the URL as written', async ({ page }) => {
  // Printed handoff cards and old bookmarks carry these.
  await page.goto('/#screen=setup', { waitUntil: 'domcontentloaded' });
  await expect(railItem(page, 'Setup')).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => routeHash(page)).toBe('#screen=setup');
});
