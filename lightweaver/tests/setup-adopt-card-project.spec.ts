// Adopting the project a card already holds must visibly finish Setup — even
// for a "legacy" card flashed before fingerprint reporting, which answers with
// projectRevision 0 and an empty projectFingerprint for a project it genuinely
// holds. That exact card shape (Adrian's real gallery card, firmware build
// 1306) used to make "Use this card's project" look dead: adoption applied,
// but no fingerprint could ever match, so Setup stayed on phase 1 offering the
// same buttons forever.
import { test, expect } from '@playwright/test';

const CARD_ID = 'lw-legacy-fp-card';
const PROJECT_ID = 'lwproj-legacy-piece';

function legacyStatus(overrides = {}) {
  return {
    app: 'Lightweaver', provisioningContractVersion: 1,
    cardId: CARD_ID, firmwareVersion: '1.1.15', buildId: 'a'.repeat(40), buildNumber: 1306,
    bootId: 'boot-legacy-1', runtimePhase: 'ready', knownGoodProject: true,
    commandReady: true, outputReady: true, playbackReady: true,
    configValid: true, provisionalSetup: false, safeMode: false,
    projectId: PROJECT_ID, projectRevision: 0, projectFingerprint: '',
    piece: { id: PROJECT_ID, name: 'Legacy piece' },
    outputs: [{
      id: 'out1', pin: 18, pixels: 41, gpio: 18, count: 41,
      segments: [{ id: 'run-strip-1', count: 41, direction: 'forward' }],
    }],
    ...overrides,
  };
}

async function dispatchCardLink(page, events) {
  await page.evaluate(async (nextEvents) => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    for (const event of nextEvents) link.dispatch(event);
  }, events);
}

test.beforeEach(async ({ page }) => {
  const status = legacyStatus();
  await page.route('http://lightweaver.local/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/status' || url.pathname === '/api/firmware-info') {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ...status, bridgeVersion: 6 }),
      });
    }
    // Patterns/zones readback is optional for adoption; a legacy card without
    // them must still adopt from the status skeleton alone.
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' });
  });
  await page.addInitScript(({ cardId, firmwareVersion, buildId }) => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: cardId, firmwareVersion, buildId }));
    localStorage.setItem('lw_chip_card_host', 'lightweaver.local');
  }, status);
});

async function connectLegacyCard(page) {
  const status = legacyStatus();
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: CARD_ID, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    expectedCard: { id: CARD_ID, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    readiness: status,
  }]);
}

async function expectSetupComplete(page) {
  await expect(page.getByText('This exact card is already set up')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('setup-progress')).toHaveText('Setup complete');
  await expect(page.getByTestId('setup-identity-row')).toContainText('Installed project matches');
  await expect(page.getByTestId('setup-adoption-error')).toHaveCount(0);
  await expect(page.getByTestId('setup-open-patterns')).toBeVisible();
}

test('a fresh Studio adopts the legacy card project and finishes Setup by itself', async ({ page }) => {
  await page.goto('/#screen=setup', { waitUntil: 'domcontentloaded' });
  await connectLegacyCard(page);
  await expectSetupComplete(page);

  // And it must survive a reload: the restored installation record re-verifies
  // against the same legacy evidence rather than demoting back to phase 1.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await connectLegacyCard(page);
  await expect(page.getByTestId('setup-progress')).toHaveText('Setup complete', { timeout: 10000 });
  await expect(page.getByTestId('setup-identity-row')).toContainText('Installed project matches');
});

test('"Use this card’s project" visibly finishes Setup when another project is open', async ({ page }) => {
  await page.goto('/#screen=setup', { waitUntil: 'domcontentloaded' });
  // Open a different project with its own described wiring, so nothing
  // auto-adopts and the unresolved-project task must offer the choice.
  await page.evaluate(async () => {
    const { createDefaultProject } = await import('/src/lib/projectModel.js');
    const project = createDefaultProject();
    project.id = 'my-other-piece';
    project.name = 'My other piece';
    project.layout.starterPending = false;
    project.portRoles = [{ pin: 5, role: 'strip', pixelCount: 30, controlKind: '' }];
    localStorage.setItem('lw_autosave_v3', JSON.stringify(project));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await connectLegacyCard(page);

  // The unresolved-project task names what the card holds and offers adoption.
  await expect(page.getByTestId('setup-card-project-note')).toContainText(PROJECT_ID, { timeout: 10000 });
  await page.getByTestId('setup-start-from-card').click();
  await expectSetupComplete(page);
});
