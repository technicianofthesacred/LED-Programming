import { test, expect } from '@playwright/test';

test('v3 patterns show a chip-ready catalog with live local preview', async ({ page }) => {
  const controlRequests: unknown[] = [];
  const configRequests: unknown[] = [];
  await page.route('http://lightweaver.local/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('http://lightweaver.local/api/config', async route => {
    configRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.locator('.lw-look-card')).toHaveCount(30);
  await expect(page.locator('.lw-pattern-led-preview canvas')).toBeVisible();
  await expect(page.getByText('30 chip-ready / 30 on knob')).toBeVisible();
  await expect(page.getByTestId('card-startup-label')).toHaveText('Aurora');

  await page.locator('button[data-pattern-id="ocean"]').click();

  await expect.poll(() => controlRequests.length).toBe(1);
  expect(controlRequests[0]).toMatchObject({ patternId: 'ocean', cancelStream: true });
  await expect(page.locator('.lw-look-card.is-previewing strong')).toHaveText('Ocean');
  await expect(page.getByText('Blue and teal rolling wave movement.')).toBeVisible();
  await expect(page.getByTestId('card-live-preview-label')).toHaveText('Ocean');
  await expect(page.getByTestId('card-startup-label')).toHaveText('Aurora');

  await page.getByRole('button', { name: 'Save to card' }).click();

  await expect.poll(() => configRequests.length).toBe(1);
  expect(configRequests[0]).toMatchObject({ startupPatternId: 'ocean' });
  await expect(page.getByTestId('card-startup-label')).toHaveText('Ocean');
});
