import { test, expect } from '@playwright/test';

async function gotoFreshLayout(page: any) {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
}

test('a fresh layout offers primitive choices and creates a centered selected circle', async ({ page }) => {
  await gotoFreshLayout(page);

  const picker = page.getByTestId('layout-primitive-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Line', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(picker.getByRole('button', { name: 'Circle', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Square', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Free draw', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Import SVG' })).toBeVisible();

  await picker.getByRole('button', { name: 'Circle', exact: true }).click();
  await picker.getByRole('button', { name: 'Create circle' }).click();

  await expect(picker).toHaveCount(0);
  await expect(page.locator('.la-strip-row')).toHaveCount(1);
  await expect(page.locator('.la-strip-row')).toContainText('Circle');
  await expect(page.locator('.la-strip-row')).toHaveClass(/sel/);
  const path = page.locator('path[data-strip-path]');
  await expect(path).toHaveCount(1);
  await expect(path).toHaveAttribute('d', /A/);
  const center = await path.evaluate((element: SVGGraphicsElement) => {
    const box = element.getBBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  expect(center.x).toBeCloseTo(320, 0);
  expect(center.y).toBeCloseTo(200, 0);

  await page.getByTestId('layout-mode-size').click();
  await expect(page.getByTestId('layout-size-panel')).toContainText('Circle');
});

test('Free draw keeps the existing manual path workflow', async ({ page }) => {
  await gotoFreshLayout(page);

  const picker = page.getByTestId('layout-primitive-picker');
  await picker.getByRole('button', { name: 'Free draw', exact: true }).click();
  await picker.getByRole('button', { name: 'Start drawing' }).click();

  await expect(page.locator('.la-draw-hint')).toContainText('Drawing mode');
  await expect(page.getByTitle('Draw a new LED strip path on the artwork.')).toHaveClass(/active/);
  await expect(page.locator('path[data-strip-path]')).toHaveCount(0);
});
