import { expect, test, type Page } from '@playwright/test';

async function installFindCardHarness(page: Page) {
  await page.addInitScript(() => {
    const state = {
      opens: [] as Array<{ url: string; name: string; features: string }>,
      captureSweep: false,
      sweepStarted: false,
    };
    Object.defineProperty(window, '__findCardHarness', { value: state, configurable: true });
    window.open = ((url?: string | URL, name?: string, features?: string) => {
      state.opens.push({
        url: String(url || ''),
        name: String(name || ''),
        features: String(features || ''),
      });
      return null;
    }) as typeof window.open;

    const realFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!/^http:\/\/192\.168\.77\.\d+\/api\/status$/.test(url)) return realFetch(input, init);
      if (!state.captureSweep) {
        return Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
      }
      state.sweepStarted = true;
      return Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
    }) as typeof window.fetch;
  });

  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
  await page.goto('/#screen=setup', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_chip_card_host', '192.168.77.1');
    localStorage.setItem('lw_chip_card_host_history', JSON.stringify(['192.168.77.1']));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('setup-connect-card')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => { (window as any).__findCardHarness.captureSweep = true; });
}

test('Find my card opens the contained connection setup before launching a local card page', async ({ page }) => {
  await installFindCardHarness(page);

  await page.getByTestId('setup-connect-card').click();

  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__findCardHarness.opens)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__findCardHarness.sweepStarted)).toBe(false);
});
