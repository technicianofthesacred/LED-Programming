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
  await expect(page.getByRole('button', { name: /Browse \.bin/i })).not.toBeVisible();
  await expect(page.getByText('Address', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Erase all', { exact: true })).toHaveCount(0);
  await expect(page.locator('textarea.fl-log')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('evil.example');
});

test('tampered release is blocked before the card can be selected', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => ({}) } });
  });
  let attempts = 0;
  await page.route('**/firmware/release-manifest.sig', async route => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
      return;
    }
    await route.fallback();
  });
  await page.goto('/#screen=flash&mode=install');

  await expect(page.getByText(/Official firmware could not be verified/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Erase card and install/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry official firmware' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry official firmware' }).click();
  await expect(page.getByText(/Official Lightweaver .* verified and ready/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toBeEnabled();
});

test('desktop without browser USB offers Lightweaver Bridge and keeps the canonical Studio URL', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.goto('/#screen=flash&mode=install');

  await expect(page.getByRole('button', { name: 'Open Lightweaver Bridge' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find connected card' })).toHaveCount(0);
  await expect(page).toHaveURL(/#screen=flash&mode=install$/);
  await expect(page.locator('body')).not.toContainText('/design');
});

test('installer inside a secure iframe escapes to the fixed top-level installer', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {} });
  });
  await page.goto('/#screen=layout');
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'installer-frame';
    frame.src = `${location.origin}/#screen=flash&mode=install&url=https://evil.example/fw.bin`;
    document.body.append(frame);
  });
  const installer = page.frameLocator('#installer-frame');
  await expect(installer.getByRole('heading', { name: 'Open secure installer' })).toBeVisible();
  const escape = installer.getByRole('link', { name: 'Open secure installer' });
  await expect(escape).toHaveAttribute('href', 'https://led.mandalacodes.com/#screen=flash&mode=install');
  await expect(escape).toHaveAttribute('target', '_blank');
});

test('technician controls remain separately labelled outside install mode', async ({ page }) => {
  await page.goto('/#screen=flash');
  const disclosure = page.getByText('Technician diagnostics', { exact: true });
  await expect(disclosure).toBeVisible();
  await expect(page.getByRole('button', { name: /Browse \.bin/i })).toHaveCount(0);
  await disclosure.click();
  await expect(page.getByRole('button', { name: /Browse \.bin/i })).toBeVisible();
  await expect(page.getByText('Address', { exact: true })).toBeVisible();
  await expect(page.locator('textarea.fl-log')).toBeVisible();
});

test('Studio navigation is held on the installer while an install is active', async ({ page }) => {
  await page.goto('/#screen=flash&mode=install');
  await expect(page.getByRole('heading', { name: /secure Lightweaver Studio|Continue on a computer|Install Lightweaver/i })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: true } })));
  await page.getByRole('button', { name: 'Layout' }).click();
  await expect(page).toHaveURL(/#screen=flash&mode=install$/);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: false } })));
  await page.getByRole('button', { name: 'Layout' }).click();
  await expect(page).toHaveURL(/#screen=layout$/);
});
