import { test, expect } from '@playwright/test';

const PATTERN_MODULE = '**/src/v3/lw-pattern.jsx*';
const PLAYLIST_MODULE = '**/src/v3/lw-playlist.jsx*';

test('a transient screen load failure recovers automatically', async ({ page }) => {
  let attempts = 0;
  await page.route(PATTERN_MODULE, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.goto('/#screen=layout');
  await page.getByRole('button', { name: 'Patterns' }).click();

  await expect(page.getByRole('heading', { name: 'Patterns & Looks' })).toBeVisible();
  await expect(page.getByTestId('screen-error-fallback')).toHaveCount(0);
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test('a repeated screen load failure guides the user without a reload loop', async ({ page }) => {
  let attempts = 0;
  await page.route(PATTERN_MODULE, async (route) => {
    attempts += 1;
    await route.abort('failed');
  });

  await page.goto('/#screen=layout');
  await page.getByRole('button', { name: 'Patterns' }).click();

  const recovery = page.getByTestId('screen-error-fallback');
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('heading', { name: 'Let’s get you back to your work' })).toBeVisible();
  await expect(recovery).toContainText('Your project is safe');
  await expect(recovery.getByRole('button', { name: 'Try this screen again' })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Open Layout' })).toBeVisible();
  await expect(recovery).not.toContainText('screen could not open');
  // Bounded sanitized diagnostics: support code + route + error name only.
  const supportCode = recovery.getByTestId('screen-recovery-support-code');
  await expect(supportCode).toBeVisible();
  await expect(supportCode).toContainText('LW-UI-102');
  await expect(supportCode).toContainText('screen=pattern');
  const supportText = await supportCode.textContent();
  expect(supportText).not.toMatch(/token|password|http:\/\/192\.|lightweaver\.local/i);
  expect(attempts).toBe(2);

  await recovery.getByRole('button', { name: 'Open Layout' }).click();
  await expect(page).toHaveURL(/#screen=layout/);
  await expect(page.getByRole('main')).toBeVisible();
});

test('automatic recovery preserves an edit made immediately before the failure', async ({ page }) => {
  let attempts = 0;
  await page.route(PLAYLIST_MODULE, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.goto('/#screen=pattern');
  const aurora = page.locator('[data-pattern-id="aurora"]');
  await aurora.click();
  await page.getByRole('button', { name: 'Playlist', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Playlist' })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null')?.pattern?.activePatternId)).toBe('aurora');
});
