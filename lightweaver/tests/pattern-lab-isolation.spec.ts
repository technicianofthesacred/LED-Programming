import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const APP_SOURCE = readFileSync(resolve(SRC_DIR, 'v3/app.jsx'), 'utf8');
const LAB_SOURCE = readFileSync(resolve(SRC_DIR, 'pattern-lab/PatternLabScreen.jsx'), 'utf8');
const LAB_CSS = readFileSync(resolve(SRC_DIR, 'pattern-lab/pattern-lab.css'), 'utf8');

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

test('Pattern Lab is an isolated lazy Studio route', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  const patterns = page.getByRole('button', { name: 'Patterns', exact: true });
  await expect(patterns).toBeVisible();
  await page.getByRole('button', { name: 'Pattern Lab', exact: true }).click();

  await expect(page).toHaveURL(/#screen=pattern-lab$/);
  await expect(page.getByTestId('pattern-lab-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pattern Lab' })).toBeVisible();
  await expect(patterns).toBeVisible();
});

test('Pattern Lab keeps one lazy route descriptor and owns its stylesheet', () => {
  expect(APP_SOURCE).toMatch(/lazy\(\(\)\s*=>\s*import\(['"]\.\.\/pattern-lab\/PatternLabScreen\.jsx['"]\)\)/);
  expect(APP_SOURCE).toContain('const STUDIO_SCREENS');
  expect(APP_SOURCE).toContain('const SCREEN_BY_ID');

  const styleImporters = sourceFilesUnder(SRC_DIR)
    .filter(file => readFileSync(file, 'utf8').includes("import './pattern-lab.css'"))
    .map(file => relative(SRC_DIR, file));
  expect(styleImporters).toEqual(['pattern-lab/PatternLabScreen.jsx']);
});

test('Pattern Lab shell exposes its current step and decorative preview safely', async ({ page }) => {
  expect(LAB_SOURCE).toContain("aria-current={index === 0 ? 'step' : undefined}");
  expect(LAB_CSS).not.toMatch(/color:\s*var\(--text-faint\)/);
  expect(LAB_CSS).not.toMatch(/(?:^|[;{]\s*)color:\s*var\(--accent\)/m);

  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  const workflow = page.getByRole('list', { name: 'Pattern Lab workflow' });
  await expect(workflow.locator('li').first()).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('svg.plab-sculpture')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('svg.plab-sculpture')).toHaveAttribute('focusable', 'false');
});

test('existing Studio routes remain available beside Pattern Lab', async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-lab-screen')).toBeVisible();

  const routes = [
    { label: 'Layout', mountedContent: 'layout-mode-switch' },
    { label: 'Patterns', mountedContent: 'pattern-project-preview' },
    { label: 'Playlist', mountedContent: 'playlist-physical-preview-status' },
    { label: 'Show', mountedContent: 'show-stage' },
    { label: 'Card', mountedContent: 'card-setup-steps' },
  ];

  for (const route of routes) {
    const railItem = page.getByRole('button', { name: route.label, exact: true });
    await railItem.click();
    await expect(railItem).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId(route.mountedContent)).toBeVisible();
    await expect(page.getByTestId('pattern-lab-screen')).toHaveCount(0);
  }
});
