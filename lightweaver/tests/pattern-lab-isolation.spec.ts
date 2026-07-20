import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

test('Pattern Lab is an isolated lazy Studio route', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'networkidle' });

  const initialResources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => entry.name),
  );
  expect(initialResources.some(url => /PatternLabScreen|pattern-lab\.css/.test(url))).toBe(false);

  const patterns = page.getByRole('button', { name: 'Patterns', exact: true });
  await expect(patterns).toBeVisible();
  await page.getByRole('button', { name: 'Pattern Lab', exact: true }).click();

  await expect(page).toHaveURL(/#screen=pattern-lab$/);
  await expect(page.getByTestId('pattern-lab-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pattern Lab' })).toBeVisible();
  await expect(patterns).toBeVisible();

  const loadedResources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => entry.name),
  );
  expect(loadedResources.some(url => /PatternLabScreen/.test(url))).toBe(true);
  expect(loadedResources.some(url => /pattern-lab\.css/.test(url))).toBe(true);
});

test('existing Studio routes remain available beside Pattern Lab', async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-lab-screen')).toBeVisible();

  for (const route of ['Layout', 'Patterns', 'Playlist', 'Show', 'Card']) {
    await page.getByRole('button', { name: route, exact: true }).click();
    await expect(page.getByRole('button', { name: route, exact: true })).toHaveAttribute('aria-current', 'page');
  }
});
