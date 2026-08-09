import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const release = JSON.parse(await readFile(new URL('../public/firmware/release-manifest.json', import.meta.url), 'utf8'));
const studioRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const studioBuild = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());

async function openStudio(page, card = null) {
  if (card) {
    await page.addInitScript(({ buildNumber, buildId }) => {
      localStorage.setItem('lw_card_identity_v1', JSON.stringify({
        version: 1,
        id: 'lw-aabbccddeeff',
        name: 'Gallery card',
        firmwareVersion: '1.0.0',
        buildNumber,
        buildId,
      }));
    }, card);
  }
  await page.route('**/studio-release.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: `${JSON.stringify({
      schemaVersion: 1,
      sourceRevision: studioRevision,
      buildId: studioRevision.slice(0, 12),
      buildNumber: studioBuild,
    })}\n`,
  }));
  const cardRoute = route => card
    ? route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          app: 'Lightweaver',
          provisioningContractVersion: 1,
          cardId: 'lw-aabbccddeeff',
          cardName: 'Gallery card',
          firmwareVersion: '1.0.0',
          buildNumber: card.buildNumber,
          buildId: card.buildId,
          bootId: 'footer-test-boot',
          runtimePhase: 'ready',
          knownGoodProject: true,
          commandReady: true,
          outputReady: true,
        }),
      })
    : route.abort();
  await page.route('http://lightweaver.local/**', cardRoute);
  await page.route('http://192.168.4.1/**', cardRoute);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
}

test('footer reduces telemetry to card, firmware, Studio and Test strip controls', async ({ page }) => {
  await openStudio(page, { buildNumber: release.buildNumber - 1, buildId: 'a'.repeat(40) });

  const footer = page.locator('.status-bar');
  await expect(page.getByTestId('card-link-status')).toContainText('Gallery card');
  await expect(page.getByTestId('footer-firmware-status')).toHaveText(
    `Card ${release.buildNumber - 1} → ${release.buildNumber}`,
  );
  await expect(page.getByTestId('studio-freshness')).toContainText(`Studio ${studioBuild}`);
  await expect(footer).not.toContainText('GPIO');
  await expect(footer).not.toContainText('pixels');
  await expect(footer).not.toContainText('firmware 1.0.0');
  await expect(footer).not.toContainText('density');
  await expect(footer).not.toContainText('LEDs ·');
  await expect(footer).not.toContainText('fps');

  await expect(page.getByLabel('Test strip LED count')).toHaveCount(0);
  await page.getByRole('button', { name: 'Test strip' }).click();
  await expect(page.getByLabel('Test strip LED count')).toBeVisible();
  await expect(page.getByTestId('test-strip-control')).toContainText('your design is unchanged');
});

test('outdated firmware opens the canonical install route without starting hardware work', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__hardwareOperations = 0;
    window.addEventListener('lw-hardware-operation-active', () => {
      (window as any).__hardwareOperations += 1;
    });
  });
  await openStudio(page, { buildNumber: release.buildNumber - 1, buildId: 'a'.repeat(40) });

  await page.getByTestId('footer-firmware-status').click();

  await expect(page).toHaveURL(/#screen=card&section=install$/);
  expect(await page.evaluate(() => (window as any).__hardwareOperations)).toBe(0);
});

test('phone footer keeps firmware and Studio identities visible without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStudio(page, { buildNumber: release.buildNumber, buildId: release.buildId });

  await expect(page.getByTestId('footer-firmware-status')).toHaveText(`Card ${release.buildNumber} ✓`);
  await expect(page.getByTestId('footer-firmware-status')).toBeVisible();
  await expect(page.getByTestId('studio-freshness')).toBeVisible();
  const dimensions = await page.locator('.status-bar').evaluate(node => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});
