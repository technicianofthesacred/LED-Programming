import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const release = JSON.parse(await readFile(new URL('../public/firmware/release-manifest.json', import.meta.url), 'utf8'));
const studioRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const studioBuild = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());

function currentStudioMarker() {
  return {
    schemaVersion: 1,
    sourceRevision: studioRevision,
    buildId: studioRevision.slice(0, 12),
    buildNumber: studioBuild,
  };
}

function studioBuildGraph(marker) {
  const markerText = `${JSON.stringify(marker)}\n`;
  return {
    schemaVersion: 1,
    files: [
      { path: 'assets/footer-ready.js', bytes: 1, sha256: '1'.repeat(64) },
      { path: 'index.html', bytes: 1, sha256: '2'.repeat(64) },
      { path: 'studio-release.json', bytes: Buffer.byteLength(markerText), sha256: createHash('sha256').update(markerText).digest('hex') },
    ],
  };
}

async function openStudio(page, card = null, { marker = currentStudioMarker(), releaseUnknown = false } = {}) {
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
    body: `${JSON.stringify(marker)}\n`,
  }));
  await page.route('**/studio-build-graph.json', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: `${JSON.stringify(studioBuildGraph(marker))}\n`,
  }));
  await page.route('**/assets/footer-ready.js', route => route.fulfill({ status: 200, body: 'x' }));
  if (releaseUnknown) {
    await page.route('**/firmware/release-manifest.sig', route => route.fulfill({ status: 200, body: 'invalid' }));
  }
  // Filled in once the Studio has an autosaved project: a real card names the
  // project it holds, and the footer only shows the card's name when Studio and
  // card agree about it. Without this the fixture models a healthy card holding
  // an unnamed project, which no firmware reports, and the footer correctly
  // renders that contradiction as "Needs attention".
  let projectEvidence: Record<string, unknown> = {};
  const cardStatus = () => ({
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
    playbackReady: true,
    outputReady: true,
    ...projectEvidence,
  });
  const cardRoute = route => card
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cardStatus()) })
    : route.abort();
  await page.route('http://lightweaver.local/**', cardRoute);
  await page.route('http://192.168.4.1/**', cardRoute);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  if (!card) return;

  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_autosave_v3'))).not.toBeNull();
  projectEvidence = await page.evaluate(async () => {
    const { cardProjectFingerprint } = await import('/src/lib/cardProjectResolver.js');
    const project = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
    return { projectId: project.id, projectRevision: 0, projectFingerprint: cardProjectFingerprint(project) };
  });
  await page.evaluate(async readiness => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    const event = {
      type: 'card-verified',
      via: 'direct',
      host: 'lightweaver.local',
      card: {
        id: readiness.cardId,
        name: readiness.cardName,
        firmwareVersion: readiness.firmwareVersion,
        buildId: readiness.buildId,
        buildNumber: readiness.buildNumber,
      },
      readiness,
    };
    // Two matching envelopes: the link requires a stable revalidation before it
    // treats a card as trusted.
    link.dispatch(event);
    link.dispatch(event);
  }, cardStatus());
}

test('footer reduces telemetry to card, firmware, Studio and Test strip controls', async ({ page }) => {
  await openStudio(page, { buildNumber: release.buildNumber - 1, buildId: 'a'.repeat(40) });

  const footer = page.locator('.status-bar');
  await expect(page.getByTestId('card-link-status')).toContainText('Gallery card');
  await expect(page.getByTestId('footer-firmware-status')).toHaveText(
    `Card firmware ${release.buildNumber - 1} → ${release.buildNumber}`,
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
  await expect(page.getByRole('button', { name: 'Stop testing strip' })).toHaveText('Testing 30 LEDs');
  await expect(page.getByTestId('test-strip-control')).not.toContainText('your design is unchanged');
});

test('desktop footer is one row in Card, Firmware, Studio, Test strip order', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStudio(page, { buildNumber: release.buildNumber, buildId: release.buildId });

  const layout = await page.locator('.status-bar').evaluate(node => {
    const selectors = ['.sb-card', '[data-testid="footer-firmware-status"]', '[data-testid="studio-freshness"]', '[data-testid="test-strip-control"]'];
    const boxes = selectors.map(selector => node.querySelector(selector)?.getBoundingClientRect());
    return {
      order: [...node.children].map(child => child.matches('.sb-card') ? 'card' : child.getAttribute('data-testid')).filter(Boolean),
      centers: boxes.map(box => Math.round(box.top + (box.height / 2))),
      lefts: boxes.map(box => box.left),
      cardWidth: boxes[0].width,
      cardRight: boxes[0].right,
      firmwareLeft: boxes[1].left,
      testRight: boxes[3].right,
      footerWidth: node.getBoundingClientRect().width,
      footerRight: node.getBoundingClientRect().right,
    };
  });
  // Relative order of the four controls this test is about. The footer also
  // carries the offline-update control, which renders only in some states, so
  // an exact-equality assertion here fails on an unrelated footer addition
  // rather than on the ordering it is meant to protect.
  const subjects = ['card', 'footer-firmware-status', 'studio-freshness', 'test-strip-control'];
  expect(layout.order.filter(id => subjects.includes(id))).toEqual(subjects);
  expect(new Set(layout.centers).size).toBe(1);
  expect(layout.lefts).toEqual([...layout.lefts].sort((a, b) => a - b));
  expect(layout.cardWidth).toBeLessThan(300);
  expect(layout.firmwareLeft - layout.cardRight).toBeGreaterThan(layout.footerWidth * 0.25);
  expect(layout.footerRight - layout.testRight).toBeLessThanOrEqual(16);
});

test('outdated firmware opens the canonical install route without starting hardware work', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__hardwareOperations = 0;
    window.addEventListener('lw-hardware-operation-active', () => {
      (window as any).__hardwareOperations += 1;
    });
  });
  await openStudio(page, { buildNumber: release.buildNumber - 1, buildId: 'a'.repeat(40) });

  const firmware = page.getByTestId('footer-firmware-status');
  await expect(firmware).toHaveText(`Card firmware ${release.buildNumber - 1} → ${release.buildNumber}`);
  await expect(firmware).toHaveRole('button');
  await firmware.click();

  await expect(page).toHaveURL(/#screen=card&section=install$/);
  expect(await page.evaluate(() => (window as any).__hardwareOperations)).toBe(0);
});

test('phone footer keeps firmware and Studio identities visible without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStudio(page, { buildNumber: release.buildNumber, buildId: release.buildId });

  await expect(page.getByTestId('footer-firmware-status')).toHaveText(`Card firmware ${release.buildNumber} ✓`);
  await expect(page.getByTestId('footer-firmware-status')).toBeVisible();
  await expect(page.getByTestId('studio-freshness')).toBeVisible();
  const dimensions = await page.locator('.status-bar').evaluate(node => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test('footer exposes a legacy card as an actionable update', async ({ page }) => {
  await openStudio(page, { buildNumber: 0, buildId: 'a'.repeat(40) });
  await expect(page.getByTestId('footer-firmware-status')).toHaveText(`Card firmware legacy → ${release.buildNumber}`);
});

test('footer exposes a newer development card without offering an update', async ({ page }) => {
  await openStudio(page, { buildNumber: release.buildNumber + 6, buildId: 'd'.repeat(40) });
  const status = page.getByTestId('footer-firmware-status');
  await expect(status).toHaveText(`Card firmware ${release.buildNumber + 6} · latest ${release.buildNumber}`);
  await expect(status).not.toHaveRole('button');
});

test('footer fails closed when the signed release cannot be verified', async ({ page }) => {
  await openStudio(page, { buildNumber: release.buildNumber, buildId: release.buildId }, { releaseUnknown: true });
  await expect(page.getByTestId('footer-firmware-status')).toHaveText(`Card firmware ${release.buildNumber} · latest unknown`);
  await expect(page.getByTestId('footer-firmware-status')).toHaveAttribute('data-state', 'release-unknown');
});

test('disconnected footer distinguishes the unknown card build from the latest signed release', async ({ page }) => {
  await openStudio(page);
  await expect(page.getByTestId('footer-firmware-status')).toHaveText(`Card firmware unknown · latest ${release.buildNumber}`);
});

test('update-ready Studio keeps showing the build actually open', async ({ page }) => {
  const marker = currentStudioMarker();
  await page.addInitScript(() => {
    sessionStorage.clear();
    (window as any).__LW_STUDIO_RELOAD_FOR_TEST__ = () => {};
  });
  await openStudio(page, null, { marker });
  const studio = page.getByTestId('studio-freshness');
  await expect(studio).toHaveClass(/is-current/);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lw-hardware-operation-active', { detail: { active: true } })));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  marker.sourceRevision = 'b'.repeat(40);
  marker.buildId = marker.sourceRevision.slice(0, 12);
  marker.buildNumber = studioBuild + 1;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(studio).toHaveText(`Studio ${studioBuild}`);
  await expect(studio).toHaveAttribute('aria-label', new RegExp(`Build ${studioBuild + 1}.*revision ${'b'.repeat(12)}`));
  await expect(studio).toHaveAttribute('tabindex', '0');
});
