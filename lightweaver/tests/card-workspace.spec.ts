import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

test('Card replaces the setup rail destinations and exposes ordinary section navigation', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Card', exact: true }).click();

  await expect(page).toHaveURL(/#screen=card&section=overview$/);
  const sections = page.getByRole('navigation', { name: 'Card sections' });
  await expect(sections).toBeVisible();
  for (const label of ['Install or update', 'Card settings', 'Workshop setup', 'Advanced & Support']) {
    await expect(sections.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  for (const label of ['Flash', 'Installer', 'Production setup', 'Settings']) {
    await expect(page.locator('.rail').getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
  await expect(sections.getByRole('menu')).toHaveCount(0);
  await expect(sections.locator('[role="menuitem"]')).toHaveCount(0);
  await expect(sections.locator('[aria-haspopup]')).toHaveCount(0);
});

test('disconnected Card overview shows the ordered setup path and Connect as primary', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();
  await expect(page.getByTestId('card-detected-state')).toContainText(/not detected|not connected/i);
  const steps = page.getByTestId('card-setup-steps').locator('li');
  await expect(steps).toHaveCount(5);
  await expect(steps.locator('.card-setup-label')).toHaveText(['Connect', 'Install', 'WiFi', 'Load project', 'Test']);
  await expect(page.getByRole('button', { name: 'Connect card', exact: true })).toHaveClass(/primary/);
});

test('connected Card overview identifies the card and makes Load changes primary', async ({ page }) => {
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Your Lightweaver card' })).toBeVisible();
  await page.evaluate(async () => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    link.dispatch({
      type: 'card-verified',
      via: 'bridge',
      host: link.getState().host || 'lightweaver.local',
      card: { id: 'lw-gallery-card', name: 'Gallery card' },
    });
  });

  await expect(page.getByTestId('card-detected-state')).toContainText('Gallery card');
  await expect(page.getByTestId('card-detected-state')).toContainText(/connected/i);
  await expect(page.getByTestId('card-detected-state')).not.toContainText(/has not changed|nothing changed/i);
  await expect(page.getByRole('button', { name: 'Load changes', exact: true })).toHaveClass(/primary/);
});

test('top-bar Preferences opens the canonical Card preferences section', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();

  await expect(page).toHaveURL(/#screen=card&section=preferences$/);
  await expect(page.getByRole('heading', { name: 'Preferences', level: 1 })).toBeFocused();
  await expect(page.getByText('Project', { exact: true })).toBeVisible();
});

for (const legacy of [
  { hash: '#screen=flash&mode=install', section: 'Install or update', heading: 'Install Lightweaver' },
  { hash: '#screen=flash', section: 'Advanced & Support', heading: 'Manual firmware tools' },
  { hash: '#screen=installer', section: 'Advanced & Support', heading: 'Worker install' },
  { hash: '#screen=production&job=moon-batch-7', section: 'Workshop setup', heading: 'Workshop setup' },
  { hash: '#screen=settings', section: 'Preferences', heading: 'Preferences' },
]) {
  test(`legacy ${legacy.hash} stays intact and opens ${legacy.section}`, async ({ page }) => {
    await page.goto(`/${legacy.hash}`, { waitUntil: 'domcontentloaded' });

    await expect(page).toHaveURL(new RegExp(`${legacy.hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await expect(page.locator('.rail-item.active')).toHaveAccessibleName('Card');
    await expect(page.getByRole('navigation', { name: 'Card sections' }).getByRole('button', { name: legacy.section, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: legacy.heading, exact: true }).first()).toBeVisible();
  });
}

test('new section navigation emits canonical Card hashes and moves focus to the section heading', async ({ page }) => {
  await page.goto('/#screen=flash', { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation', { name: 'Card sections' }).getByRole('button', { name: 'Card settings' }).click();

  await expect(page).toHaveURL(/#screen=card&section=settings$/);
  await expect(page.getByRole('heading', { name: 'Card settings', level: 1 })).toBeFocused();
  await expect(page.getByText('Card connection', { exact: true })).toBeVisible();
});

test('embedded install uses the Card heading as the only h1', async ({ page }) => {
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Install or update', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Install Lightweaver', level: 2 })).toBeVisible();
});

test('embedded unsupported install uses the Card heading as the only h1', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
  });
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Install or update', level: 1 })).toBeVisible();
  await expect(page.locator('.install-handoff').getByRole('heading', { level: 2 })).toBeVisible();
});

test('legacy technician path uses the Card heading as the only h1', async ({ page }) => {
  await page.goto('/#screen=flash', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Advanced & Support', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Manual firmware tools', level: 2 })).toBeVisible();
});

test('legacy installer guide path uses the Card heading as the only h1', async ({ page }) => {
  await page.goto('/#screen=installer', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Advanced & Support', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Worker install', level: 2 })).toBeVisible();
});

test('embedded workshop uses the Card heading as the only h1', async ({ page }) => {
  await page.goto('/#screen=card&section=workshop', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Workshop setup', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
});

test('Advanced & Support exposes its tools without a collapsed disclosure', async ({ page }) => {
  await page.goto('/#screen=card&section=support', { waitUntil: 'domcontentloaded' });

  for (const label of ['Technician firmware & logs', 'GPIO & install guide', 'Designer JSON', 'Recovery']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.locator('details')).toHaveCount(0);
  await page.getByRole('button', { name: 'Technician firmware & logs' }).click();
  await expect(page.getByRole('heading', { name: 'Manual firmware tools' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Flash firmware' })).toBeVisible();
});

test('an active firmware install keeps rail navigation locked to install', async ({ page }) => {
  await page.goto('/#screen=card&section=install', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Install Lightweaver' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw-install-active', { detail: { active: true } })));
  await page.getByRole('button', { name: 'Layout', exact: true }).click();

  await expect(page).toHaveURL(/#screen=card&section=install$/);
  await expect(page.locator('.rail-item.active')).toHaveAccessibleName('Card');
});
