import { test, expect, type Page, type Route } from '@playwright/test';

declare global {
  interface Window { __patternLabFrames: string[]; }
}

async function installCardHarness(page: Page) {
  const controlBodies: Record<string, unknown>[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1,
      id: 'test-card',
      name: 'Test card',
      host: 'lightweaver.local',
    }));
    window.__patternLabFrames = [];
    class FakeWebSocket {
      readyState = 0;
      bufferedAmount = 0;
      onopen: null | (() => void) = null;
      onerror: null | (() => void) = null;
      onclose: null | (() => void) = null;
      constructor(_url: string) {
        setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
      }
      send(payload: string) { window.__patternLabFrames.push(payload); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeWebSocket });
  });
  await page.route('http://lightweaver.local/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Content-Type': 'application/json',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers, body: '' });
      return;
    }
    if (url.pathname === '/api/zones') {
      await route.fulfill({ status: 200, headers, json: {
        syncZones: false,
        zones: [{
          id: 'all', patternId: 'aurora', brightness: 0.62,
          driftHueMin: 12, driftHueMax: 211,
        }],
      } });
      return;
    }
    if (url.pathname === '/api/firmware-info' || url.pathname === '/api/status') {
      await route.fulfill({ status: 200, headers, json: {
        cardId: 'test-card', name: 'Test card', firmwareVersion: '1.0.0', buildId: 'test-build',
      } });
      return;
    }
    if (url.pathname === '/api/control' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      controlBodies.push(body);
      await route.fulfill({ status: 200, headers, json: body.cancelStream && !body.patternId
        ? { ok: true }
        : { ok: true, cardId: 'test-card', patternId: body.patternId || 'aurora' } });
      return;
    }
    await route.fulfill({ status: 404, headers, json: { ok: false } });
  });
  return controlBodies;
}

test('physical preview is opt-in and Stop cancels the stream before restoring the snapshot', async ({ page }) => {
  const controls = await installCardHarness(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByRole('slider', { name: 'Movement', exact: true }).fill('75');

  const preview = page.getByRole('button', { name: 'Preview on Lights' });
  await expect(preview).toBeEnabled();
  expect(controls).toEqual([]);
  expect(await page.evaluate(() => window.__patternLabFrames.length)).toBe(0);

  await preview.click();
  await expect(page.getByRole('button', { name: 'Stop preview' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__patternLabFrames.length)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Stop preview' }).click();
  await expect(page.locator('.plab-live-preview [role="status"]')).toContainText('Previous card look restored');
  expect(controls).toEqual([
    { cancelStream: true },
    expect.objectContaining({
      patternId: 'aurora', brightness: 0.62, zone: 'all', syncZones: false,
      driftMin: 12, driftMax: 211,
    }),
  ]);
});

test('leaving Pattern Lab rolls back an active physical preview', async ({ page }) => {
  const controls = await installCardHarness(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByRole('button', { name: 'Preview on Lights' }).click();
  await expect(page.getByRole('button', { name: 'Stop preview' })).toBeVisible();

  await page.getByRole('button', { name: 'Patterns', exact: true }).click();
  await expect(page.getByTestId('pattern-lab-screen')).toHaveCount(0);
  await expect.poll(() => controls.filter(body => body.cancelStream && !body.patternId).length).toBe(1);
  await expect.poll(() => controls.some(body => body.patternId === 'aurora' && body.zone === 'all')).toBe(true);
});
