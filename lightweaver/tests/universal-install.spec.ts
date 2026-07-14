import { test, expect } from '@playwright/test';

test('install mode is a single safe workflow without technician controls', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
  });
  await page.goto('/#screen=flash&mode=install&url=https://evil.example/fw.bin&target=esp32&callback=https://evil.example');

  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await expect(page.getByText(/Official Lightweaver .* verified and ready/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toBeVisible();
  await expect(page.getByText('Technician diagnostics')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Browse \.bin/i })).toHaveCount(0);
  await expect(page.getByText('Address', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Erase all', { exact: true })).toHaveCount(0);
  await expect(page.locator('textarea.fl-log')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('evil.example');
});

test('tampered release is blocked before the card can be selected', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
  });
  await page.route('**/firmware/release-manifest.sig', async route => {
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  });
  await page.goto('/#screen=flash&mode=install');

  await expect(page.getByText(/Official firmware could not be verified/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Erase card and install/i })).toHaveCount(0);
});

test('unsupported install mode gives the card connection handoff and keeps the project in Studio', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.goto('/#screen=flash&mode=install');

  await expect(page.getByRole('heading', { name: /supported (browser|computer)/i })).toBeVisible();
  await expect(page.getByText(/Chrome or Edge|Mac, Windows, or Linux/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toHaveCount(0);
  await expect(page).toHaveURL(/#screen=flash&mode=install$/);
});

test('technician controls remain separately labelled outside install mode', async ({ page }) => {
  await page.goto('/#screen=flash');
  await expect(page.getByRole('heading', { name: 'Technician diagnostics' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Browse \.bin/i })).toBeVisible();
  await expect(page.getByText('Address', { exact: true })).toBeVisible();
  await expect(page.locator('textarea.fl-log')).toBeVisible();
});
