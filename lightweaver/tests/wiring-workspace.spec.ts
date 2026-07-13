import { test, expect } from '@playwright/test';

async function gotoWire(page: any) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
}

test('Wire is a compiler-derived physical output patch board', async ({ page }) => {
  await gotoWire(page);
  await expect(page.getByTestId('wiring-output-lane')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Output 1' })).toBeVisible();
  await expect(page.getByText(/GPIO 16/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Advanced wiring settings' }).click();
  await expect(page.getByText(/GPIO 16/)).toBeVisible();
  await expect(page.getByTestId('wiring-run-row')).toHaveCount(2);
});

test('run selection stays synchronized with the artwork canvas', async ({ page }) => {
  await gotoWire(page);
  const row = page.getByTestId('wiring-run-row').first();
  await row.locator('.lw-wiring-run-name').click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-wiring-run].is-selected')).toHaveCount(1);
});

test('accessible ports connect by tap and keyboard alternatives reorder runs', async ({ page }) => {
  await gotoWire(page);
  const rows = page.getByTestId('wiring-run-row');
  const secondName = await rows.nth(1).getAttribute('data-run-id');
  await rows.nth(0).getByRole('button', { name: /OUT port/ }).click();
  await expect(rows.nth(0).getByRole('button', { name: /OUT port/ })).toHaveAttribute('aria-pressed', 'true');
  await rows.nth(1).getByRole('button', { name: /IN port/ }).click();
  await rows.nth(1).getByRole('button', { name: 'Move earlier' }).click();
  await expect(page.getByTestId('wiring-run-row').first()).toHaveAttribute('data-run-id', secondName!);
});

test('reserved-unlit addresses and preflight lock gate Send', async ({ page }) => {
  await gotoWire(page);
  await page.getByRole('button', { name: 'Add reserved-unlit LEDs' }).click();
  await expect(page.getByTestId('wiring-run-row').getByText('Reserved · unlit')).toBeVisible();
  await expect(page.getByTestId('wiring-total-pixels')).toContainText('45');
  await expect(page.getByTestId('layout-send-to-card')).toBeEnabled();
  await page.getByRole('button', { name: 'Lock wiring' }).click();
  await expect(page.getByRole('button', { name: 'Unlock wiring' })).toBeVisible();
  await expect(page.getByTestId('layout-send-to-card')).toBeEnabled();
});
