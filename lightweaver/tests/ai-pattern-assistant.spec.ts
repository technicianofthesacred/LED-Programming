import { expect, test } from '@playwright/test';

async function gotoFresh(page, screen = 'patterns') {
  await page.goto(`/#screen=${screen}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
}

test('v3 Patterns does not expose the retired inline AI assistant', async ({ page }) => {
  await gotoFresh(page);

  await expect(page.locator('.pm')).toBeVisible();
  await expect(page.getByTestId('pattern-project-preview')).toBeVisible();
  await expect(page.locator('.lw-ai-assistant')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /generate/i })).toHaveCount(0);
});

test('Pattern Lab is the supported custom-pattern authoring surface', async ({ page }) => {
  await gotoFresh(page, 'pattern-lab');

  await expect(page.getByRole('heading', { name: 'Pattern Lab', exact: true })).toBeVisible();
  // The starting pattern is chosen from a searchable tile browser; the native
  // "Base pattern" dropdown it replaced no longer exists.
  await expect(page.getByRole('searchbox', { name: 'Search patterns' })).toBeVisible();
  const workflow = page.getByRole('navigation', { name: 'Pattern Lab workflow' });
  await expect(workflow.getByRole('button', { name: 'Choose' })).toBeVisible();
  await expect(workflow.getByRole('button', { name: 'Sculpt' })).toBeVisible();
  await expect(workflow.getByRole('button', { name: 'Evolve' })).toBeVisible();
  await expect(workflow.getByRole('button', { name: 'Save' })).toBeVisible();
  await expect(page.locator('.lw-ai-assistant')).toHaveCount(0);
});
