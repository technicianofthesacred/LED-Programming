import { test, expect } from '@playwright/test';
import { createDefaultProject, migrateProject } from '../src/lib/projectModel.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';
import { prepareCardStoragePayload } from '../src/lib/cardStoragePayload.js';
import { CARD_PATTERN_BANK } from '../src/lib/cardPatternBank.js';

function makeOversizedProject() {
  const project = createDefaultProject();
  project.id = 'oversized-card-ui-fixture';
  project.name = 'Oversized card UI fixture';
  const patterns = CARD_PATTERN_BANK.slice(0, 32);
  project.devices.standaloneController.playlist = patterns.map((pattern, order) => ({
    id: pattern.id,
    // Save-to-card promotes the active first pattern with its standard label.
    // Keep that first label standard so the independently prepared fixture is
    // byte-identical to the package built by the action under test.
    label: order === 0 ? pattern.label : `${pattern.label} ${'oversized-label-'.repeat(24)}`,
    type: 'pattern',
    patternId: pattern.id,
    enabled: true,
    order,
  }));
  project.devices.standaloneController.controls.encoder.patternCycleIds = patterns.map(pattern => pattern.id);
  return project;
}

function capacityErrorForProject(project) {
  project = migrateProject(project);
  const runtimePackage = buildCardRuntimePackageFromProject({
    projectId: project.id,
    projectName: project.name,
    strips: project.layout.strips,
    patchBoard: project.layout.patchBoard,
    standaloneController: project.devices.standaloneController,
  });
  try {
    prepareCardStoragePayload(runtimePackage);
  } catch (error) {
    return error;
  }
  throw new Error('fixture must exceed card storage');
}

async function gotoSavedProject(page, project, screen) {
  await page.addInitScript((savedProject) => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(savedProject));
  }, project);
  const route = screen === 'settings'
    ? '/#screen=card&section=settings'
    : `/#screen=${screen}`;
  await page.goto(route, { waitUntil: 'domcontentloaded' });
}

test('Settings renders an oversized project and reports exact capacity on save', async ({ page }) => {
  const project = makeOversizedProject();
  capacityErrorForProject(project);
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));

  await gotoSavedProject(page, project, 'settings');

  await expect(page.getByRole('heading', { name: 'Hardware settings', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Install on card', exact: true }).click();
  await expect(page.getByTestId('settings-card-status')).toHaveText(
    /Card configuration is \d+ bytes, exceeding the 3968-byte flash storage limit\./,
  );
  expect(requests.filter(url => url.includes('/api/config') || url.includes('/api/firmware-info'))).toHaveLength(0);
});

// Patterns gates its Install button on a card that classifies as ready and on
// a current edit authorization (src/lib/cardInstallGate.js). A status envelope
// of `{ ok, led }` describes no card at all, so the button stays disabled and
// the capacity guarantee below is unreachable. Publish the canonical readiness
// contract, then bind the authorization to the project the page actually holds.
async function pairReadyCard(page, cardId: string) {
  const firmwareVersion = '1.0.0';
  const buildId = `${cardId}-build`;
  const bootId = `${cardId}-boot`;
  const held: { id: string; fingerprint: string } = { id: '', fingerprint: '' };
  const envelope = () => ({
    ok: true,
    app: 'Lightweaver',
    provisioningContractVersion: 1,
    cardId,
    firmwareVersion,
    buildId,
    bootId,
    runtimePhase: 'ready',
    knownGoodProject: true,
    commandReady: true,
    outputReady: true,
    playbackReady: true,
    projectId: held.id,
    piece: { id: held.id },
    projectRevision: 0,
    projectFingerprint: held.fingerprint,
    led: { pixels: 44 },
  });
  await page.route('**/api/status', route => route.fulfill({ json: envelope() }));
  await page.route('**/api/firmware-info', route => route.fulfill({ json: envelope() }));
  await page.addInitScript(({ id, version, build }) => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1, id, firmwareVersion: version, buildId: build,
    }));
  }, { id: cardId, version: firmwareVersion, build: buildId });
  return async () => {
    const project = await page.evaluate(async () => {
      const { cardProjectFingerprint } = await import('/src/lib/cardProjectResolver.js');
      const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || 'null');
      return { id: saved?.id || '', fingerprint: cardProjectFingerprint(saved) };
    });
    held.id = project.id;
    held.fingerprint = project.fingerprint;
    await page.reload({ waitUntil: 'domcontentloaded' });
    const authorized = await page.evaluate(async binding => {
      const { issueCardEditAuthorization } = await import('/src/lib/cardEditAuthorization.js');
      return issueCardEditAuthorization(binding);
    }, {
      cardId,
      firmwareVersion,
      buildId,
      bootId,
      installedProjectId: project.id,
      installedProjectFingerprint: project.fingerprint,
      studioProjectId: project.id,
      studioProjectFingerprint: project.fingerprint,
      projectGeneration: 0,
    });
    expect(authorized).toBe(true);
  };
}

test('Patterns Install on card preserves exact capacity feedback', async ({ page }) => {
  const project = makeOversizedProject();
  capacityErrorForProject(project);
  const bindCardToOpenProject = await pairReadyCard(page, 'lw-card-storage-ui');

  await gotoSavedProject(page, project, 'patterns');
  await bindCardToOpenProject();

  await page.getByRole('button', { name: 'Install on card', exact: true }).click();
  await expect(page.getByText(
    /Card configuration is \d+ bytes, exceeding the 3968-byte flash storage limit\./,
  )).toBeVisible();
});
