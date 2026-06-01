import { test, expect } from '@playwright/test';

const SCREENS = ['Patterns', 'Playlist', 'Layout', 'Settings', 'Flash', 'Installer'];

test('layout opens with the default two-circle hardware layout', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('default-circle-layout-panel')).toBeVisible();
  await expect(page.locator('.lw-strip-row')).toHaveCount(2);
  await expect(page.locator('path[data-strip-path]')).toHaveCount(2);
  await expect(page.locator('.lw-strip-row', { hasText: 'Outer circle' })).toContainText('22');
  await expect(page.locator('.lw-strip-row', { hasText: 'Inner circle' })).toContainText('22');
  await expect(page.getByText('Default two-circle hardware')).toBeVisible();
});

test('settings screen prioritizes card setup and keeps raw config advanced', async ({ page }) => {
  await page.goto('/#screen=settings', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Ready to save to card' })).toBeVisible();
  await expect(page.getByTestId('settings-ring-summary')).toBeVisible();
  await expect(page.getByText('Card setup')).toBeVisible();
  await expect(page.getByText('What the card will run')).toBeVisible();
  await expect(page.getByText('Studio project')).toBeVisible();
  await expect(page.getByTestId('output-routing-summary')).toContainText('2 outputs');
  await expect(page.locator('.lw-chip-output-row')).toHaveCount(2);
  await expect(page.locator('.lw-chip-output-row', { hasText: 'Outer circle' })).toContainText('GPIO 16');
  await expect(page.locator('.lw-chip-output-row', { hasText: 'Inner circle' })).toContainText('GPIO 17');
  await expect(page.locator('.lw-card-load-summary')).toContainText('Outputs2');

  await page.getByRole('button', { name: 'Single output' }).click();
  await expect(page.getByTestId('output-routing-summary')).toContainText('1 output');
  await expect(page.locator('.lw-chip-output-row')).toHaveCount(1);
  await expect(page.locator('.lw-card-load-summary')).toContainText('Outputs1');
  await expect(page.locator('.lw-chip-settings-json')).toHaveCount(0);

  await page.getByText('Advanced').click();
  await expect(page.locator('.lw-chip-settings-json')).toBeVisible();
});

test('flash screen is reachable for public chip setup', async ({ page }) => {
  await page.goto('/#screen=flash', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByText('Bootloader mode')).toBeVisible();
  await expect(page.getByText('Lightweaver firmware', { exact: true })).toBeVisible();
  await expect(page.getByText('Fetch latest WLED')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Flash firmware' })).toBeVisible();
});

test('installer screen gives a worker the full chip setup checklist', async ({ page }) => {
  await page.goto('/#screen=installer', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Worker install' })).toBeVisible();
  await expect(page.getByText('Use Chrome or Edge on a laptop')).toBeVisible();
  await expect(page.locator('.lw-installer-wire-row', { hasText: 'Dial A' })).toContainText('GPIO 4');
  await expect(page.locator('.lw-installer-wire-row', { hasText: 'Dial press' })).toContainText('GPIO 6');
  await expect(page.locator('.lw-installer-wire-row', { hasText: 'Shared ground' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Flash chip' })).toHaveAttribute('href', '#screen=flash');
});

test('status bar card item retries discovery and stores the found card host', async ({ page }) => {
  const statusRequests: string[] = [];
  await page.route('http://lightweaver.local/api/status', async route => {
    statusRequests.push(route.request().url());
    await route.abort();
  });
  await page.route('http://192.168.18.70/api/status', async route => {
    statusRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        wifi: { ip: '192.168.18.70', hostname: 'lightweaver' },
        led: { pixels: 44 },
      }),
    });
  });
  await page.route('http://192.168.4.1/api/status', async route => {
    statusRequests.push(route.request().url());
    await route.abort();
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  const statusButton = page.getByTestId('card-status-reconnect');
  await expect(statusButton).toBeVisible();
  await statusButton.click();

  await expect.poll(() => statusRequests.some(url => url.includes('192.168.18.70'))).toBe(true);
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('lw_chip_card_host'))).toBe('192.168.18.70');
  await expect(statusButton).toContainText('connected');
});

test('patterns target selector stacks downward and footer stays single-line', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.lw-target-grid').evaluate(el => {
    const existing = Array.from(el.querySelectorAll('.lw-section-target'));
    const source = existing[existing.length - 1] || existing[0];
    if (!source) return;
    for (let index = existing.length; index < 10; index += 1) {
      const clone = source.cloneNode(true) as HTMLElement;
      clone.setAttribute('data-testid', `section-target-test-${index + 1}`);
      const nameInput = clone.querySelector('.lw-target-name-input') as HTMLInputElement | null;
      if (nameInput) {
        nameInput.value = `Ring ${index + 1}`;
        nameInput.setAttribute('value', `Ring ${index + 1}`);
      }
      const ledInput = clone.querySelector('.lw-target-led-input') as HTMLInputElement | null;
      if (ledInput) {
        ledInput.value = '39';
        ledInput.setAttribute('value', '39');
      }
      const patternLabel = clone.querySelector('b');
      if (patternLabel) patternLabel.textContent = 'Aurora';
      el.appendChild(clone);
    }
  });

  const targetMetrics = await page.locator('.lw-target-grid').evaluate(el => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    overflowX: getComputedStyle(el).overflowX,
    overflowY: getComputedStyle(el).overflowY,
    targetTops: Array.from(el.querySelectorAll('.lw-section-target'), target =>
      Math.round(target.getBoundingClientRect().top),
    ),
  }));
  expect(targetMetrics.overflowX).toBe('hidden');
  expect(targetMetrics.overflowY).toBe('auto');
  expect(targetMetrics.scrollWidth).toBeLessThanOrEqual(targetMetrics.clientWidth + 1);
  expect(new Set(targetMetrics.targetTops).size).toBeGreaterThan(3);
  expect(targetMetrics.scrollHeight).toBeGreaterThan(targetMetrics.clientHeight);

  const statusMetrics = await page.locator('.lw-statusbar').evaluate(el => ({
    height: el.getBoundingClientRect().height,
    lineHeight: getComputedStyle(el).lineHeight,
    overflowX: getComputedStyle(el).overflowX,
    whiteSpace: getComputedStyle(el).whiteSpace,
    childTops: Array.from(el.querySelectorAll('.lw-status-item, .sep'), child =>
      Math.round(child.getBoundingClientRect().top),
    ),
  }));
  expect(statusMetrics.height).toBeLessThanOrEqual(25);
  expect(statusMetrics.overflowX).toBe('hidden');
  expect(statusMetrics.whiteSpace).toBe('nowrap');
  expect(new Set(statusMetrics.childTops).size).toBe(1);
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`main screens load without overflow or console errors on ${viewport.name}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', err => consoleErrors.push(err.message));

    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });

    for (const label of SCREENS) {
      await page.locator('.lw-rail-btn', { hasText: label }).click();
      await expect(page.locator('.lw-app')).toBeVisible();
      await expect.poll(async () => page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }))).toEqual({ scrollW: viewport.width, clientW: viewport.width });
    }

    expect(consoleErrors).toEqual([]);
  });
}
