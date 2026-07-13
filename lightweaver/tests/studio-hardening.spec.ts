import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
});

test('pattern cards are native selected buttons and load in exact batches of 24', async ({ page }) => {
  const cards = page.locator('.pm-cards .pmcard');
  await expect(cards).toHaveCount(24);
  await expect(cards.first()).toHaveJSProperty('tagName', 'BUTTON');
  await cards.nth(1).click();
  await expect(cards.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('patterns-show-more').click();
  await expect(cards).toHaveCount(48);
});

test('pattern preview uses project LED geometry and active symmetry', async ({ page }) => {
  const preview = page.getByTestId('pattern-project-preview');
  await expect(preview).toHaveAttribute('data-preview-led-count', '44');
  await expect(preview).toHaveAttribute('data-preview-order', /default-(outer|inner)-circle/);
  await expect(preview).toHaveAttribute('data-preview-symmetry', 'none');
  await page.locator('.geo-seg').getByRole('button', { name: 'Mirror' }).click();
  await expect(preview).toHaveAttribute('data-preview-symmetry', 'mirror-hv');
});

test('installer signoff persists and exposes a ready state', async ({ page }) => {
  await page.locator('.rail-item', { hasText: 'Installer' }).click();
  const checks = page.locator('.inst-signoff input[type="checkbox"]');
  await expect(checks).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) await checks.nth(index).check();
  await expect(page.getByText('Ready to ship')).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.inst-signoff input[type="checkbox"]:checked')).toHaveCount(6);
});

test('Daylight is a complete supported theme', async ({ page }) => {
  await page.locator('.rail-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Daylight', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
  const colors = await page.locator('.app').evaluate(node => {
    const style = getComputedStyle(node);
    return [style.getPropertyValue('--bg-app'), style.getPropertyValue('--bg-panel'), style.getPropertyValue('--text-hi')];
  });
  expect(colors.every(Boolean)).toBe(true);
});

test('flash erase requires a final confirmation before starting', async ({ page }) => {
  await page.locator('.rail-item', { hasText: 'Flash' }).click();
  await expect(page.getByText(/final confirmation/i)).toBeVisible();
});
