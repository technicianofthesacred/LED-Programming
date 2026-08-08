import { expect, test, type Page } from '@playwright/test';

const FOUND_HOST = '192.168.77.17';

async function installFindCardHarness(page: Page, {
  wrongCard = false,
  verificationTimeout = false,
  popupBlocked = false,
}: { wrongCard?: boolean; verificationTimeout?: boolean; popupBlocked?: boolean } = {}) {
  await page.addInitScript(({ foundHost, wrongCard, verificationTimeout, popupBlocked }) => {
    const state = {
      opens: [] as Array<{ url: string; name: string }>,
      navigations: [] as string[],
      captureSweep: false,
      sweepStarted: false,
      releaseSweep: null as null | (() => void),
    };
    Object.defineProperty(window, '__findCardHarness', { value: state, configurable: true });

    const emit = (source: object, origin: string, data: object) => {
      const event = new Event('message');
      Object.defineProperties(event, {
        source: { value: source }, origin: { value: origin }, data: { value: data },
      });
      window.dispatchEvent(event);
    };
    const proxy: any = {
      closed: false,
      focus() {},
      postMessage(message: any) {
        if (message.type !== 'firmware-info') return;
        if (verificationTimeout) return;
        setTimeout(() => emit(proxy, `http://${foundHost}`, {
          app: 'LightweaverCardBridge', id: message.id, ok: true, version: 2,
          response: {
            cardId: wrongCard ? 'lw-wrong-card-test' : 'lw-find-card-test',
            firmwareVersion: '1.0.0', buildId: 'build-find-card',
          },
        }), 0);
      },
    };
    Object.defineProperty(proxy, 'location', {
      value: {
        set href(value: string) {
          state.navigations.push(String(value));
          setTimeout(() => emit(proxy, `http://${foundHost}`, {
            app: 'LightweaverCardBridge', type: 'ready', host: foundHost, version: 2,
          }), 0);
        },
      },
    });
    window.open = ((url?: string | URL, name?: string) => {
      state.opens.push({ url: String(url || ''), name: String(name || '') });
      return popupBlocked ? null : proxy;
    }) as typeof window.open;

    const realFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!/^http:\/\/192\.168\.77\.\d+\/api\/status$/.test(url)) return realFetch(input, init);
      if (!state.captureSweep) {
        return Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
      }
      state.sweepStarted = true;
      if (url !== `http://${foundHost}/api/status`) {
        return Promise.resolve(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } }));
      }
      return new Promise<Response>(resolve => {
        state.releaseSweep = () => resolve(new Response(JSON.stringify({
          app: 'Lightweaver', cardId: wrongCard ? 'lw-expected-card-test' : 'lw-find-card-test',
          firmwareVersion: '1.0.0', buildId: 'build-find-card',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      });
    }) as typeof window.fetch;
  }, { foundHost: FOUND_HOST, wrongCard, verificationTimeout, popupBlocked });

  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
  await page.goto('/#screen=setup', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_chip_card_host', '192.168.77.1');
    localStorage.setItem('lw_chip_card_host_history', JSON.stringify(['192.168.77.1']));
  });
  if (wrongCard) await page.evaluate(() => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-expected-card-test' }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('setup-connect-card')).toBeVisible({ timeout: 15000 });
  await page.evaluate(() => { (window as any).__findCardHarness.captureSweep = true; });
}

test('Find my card reserves the named window synchronously, then navigates that exact proxy once', async ({ page }) => {
  await installFindCardHarness(page);

  await page.getByTestId('setup-connect-card').click();
  await expect.poll(() => page.evaluate(() => (window as any).__findCardHarness.sweepStarted)).toBe(true);
  expect(await page.evaluate(() => (window as any).__findCardHarness.opens)).toEqual([
    { url: '', name: 'lightweaver-card-bridge' },
  ]);
  expect(await page.evaluate(() => (window as any).__findCardHarness.navigations)).toEqual([]);

  await page.evaluate(() => (window as any).__findCardHarness.releaseSweep());
  await expect(page.getByRole('dialog', { name: 'Connect Lightweaver' })).toBeVisible();
  const result = await page.evaluate(() => (window as any).__findCardHarness);
  expect(result.opens).toHaveLength(1);
  expect(result.navigations).toHaveLength(1);
  expect(new URL(result.navigations[0]).origin).toBe(`http://${FOUND_HOST}`);
});

test('Find my card reports bridge verification separately from subnet scan failure', async ({ page }) => {
  await installFindCardHarness(page, { wrongCard: true });
  await page.getByTestId('setup-connect-card').click();
  await expect.poll(() => page.evaluate(() => (window as any).__findCardHarness.sweepStarted)).toBe(true);
  await page.evaluate(() => (window as any).__findCardHarness.releaseSweep());
  await expect(page.getByTestId('setup-find-status')).toContainText('verify');
  await expect(page.getByTestId('setup-find-status')).not.toContainText('search your network');
});

test('Find my card reports a blocked reservation before starting its scan', async ({ page }) => {
  await installFindCardHarness(page, { popupBlocked: true });
  await page.getByTestId('setup-connect-card').click();
  await expect(page.getByTestId('setup-find-status')).toContainText('Allow the Lightweaver card window');
  expect(await page.evaluate(() => (window as any).__findCardHarness.sweepStarted)).toBe(false);
});

test('Find my card labels an unresponsive verified target as a bridge timeout', async ({ page }) => {
  await installFindCardHarness(page, { verificationTimeout: true });
  await page.getByTestId('setup-connect-card').click();
  await expect.poll(() => page.evaluate(() => (window as any).__findCardHarness.sweepStarted)).toBe(true);
  await page.evaluate(() => (window as any).__findCardHarness.releaseSweep());
  await expect(page.getByTestId('setup-find-status')).toContainText('did not answer Studio', { timeout: 6000 });
});
