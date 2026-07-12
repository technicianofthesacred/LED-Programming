import { test, expect } from '@playwright/test';

// Phase 2 step 9 (docs/layout-redesign-plan.md) — the Wire-mode finish line:
// Send to card + Export ledmap.json. Reuses the `mockLocalCard` route pattern
// from workflow.spec.ts. The default project boots the two-circle hardware
// layout (strips already present), so Wire mode has a chain + a real config to
// push and export without importing an SVG.

async function mockLocalCard(page: any, options: any = {}) {
  const card = {
    savedConfig: null as any,
    operations: [] as string[],
  };
  await page.route('http://lightweaver.local/**', async (route: any) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/status') {
      await route.fulfill({ json: { ok: true, led: { pixels: 44 }, wifi: { ip: 'lightweaver.local' } } });
      return;
    }
    if (pathname === '/api/firmware-info') {
      await route.fulfill({
        json: {
          ok: true,
          pixels: 44,
          outputs: [
            { id: 'out1', pin: 16, pixels: 22 },
            { id: 'out2', pin: 17, pixels: 22 },
          ],
        },
      });
      return;
    }
    if (pathname === '/api/config') {
      card.operations.push('config');
      if (options.failConfig) {
        await route.fulfill({ status: 500, json: { ok: false, error: 'boom' } });
        return;
      }
      card.savedConfig = JSON.parse(request.postData() || '{}');
      await route.fulfill({ json: { ok: true, requiresReboot: false } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  return card;
}

async function gotoWire(page: any) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
  await expect(page.getByTestId('layout-send-to-card')).toBeVisible();
}

test('Send to card renders in Wire mode with an ambient status dot', async ({ page }) => {
  await mockLocalCard(page);
  await gotoWire(page);

  const send = page.getByTestId('layout-send-to-card');
  await expect(send).toBeEnabled(); // NOT disabled when disconnected
  await expect(send.locator('.la-card-push-dot')).toHaveCount(1);
  await expect(page.getByTestId('layout-export-ledmap')).toBeVisible();
});

test('a successful push shows a green banner mentioning zones', async ({ page }) => {
  const card = await mockLocalCard(page);
  await gotoWire(page);

  await page.getByTestId('layout-send-to-card').click();

  const banner = page.locator('.la-card-push-banner');
  await expect(banner).toBeVisible({ timeout: 5000 });
  await expect(banner).toHaveClass(/is-ok/);
  await expect(banner).toContainText(/zone/i);
  expect(card.operations).toContain('config');
  expect(card.savedConfig).not.toBeNull();
});

test('a failed push shows a red banner', async ({ page }) => {
  await mockLocalCard(page, { failConfig: true });
  await gotoWire(page);

  await page.getByTestId('layout-send-to-card').click();

  const banner = page.locator('.la-card-push-banner');
  await expect(banner).toBeVisible({ timeout: 5000 });
  await expect(banner).toHaveClass(/is-err/);
});

test('Export ledmap.json downloads a valid { n, map } WLED ledmap', async ({ page }) => {
  await mockLocalCard(page);
  await gotoWire(page);

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('layout-export-ledmap').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('ledmap.json');

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  expect(typeof json.n).toBe('number');
  expect(json.n).toBeGreaterThan(0);
  expect(Array.isArray(json.map)).toBe(true);
  expect(json.map.length).toBe(json.n);
  expect(json.map[0]).toHaveLength(2);
});

// Mixed-content fail (browser blocks HTTP push from an HTTPS designer) surfaces
// the read-only JSON fallback textarea. Not reproducible here: Playwright serves
// the app over plain HTTP, so `canPushDirectlyToCard('http:')` is always true
// and the mixed-content branch never triggers. Skipped until an HTTPS harness
// exists.
test.skip('mixed-content push shows the JSON fallback textarea', async () => {});
