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
  await page.goto(`/#screen=${screen}`, { waitUntil: 'domcontentloaded' });
}

test('Settings renders an oversized project and reports exact capacity on save', async ({ page }) => {
  const project = makeOversizedProject();
  const capacityError: any = capacityErrorForProject(project);
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));

  await gotoSavedProject(page, project, 'settings');

  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Save to card', exact: true }).click();
  await expect(page.getByTestId('settings-card-status')).toHaveText(capacityError.message);
  expect(requests.filter(url => url.includes('/api/config') || url.includes('/api/firmware-info'))).toHaveLength(0);
});

test('Patterns Save to card preserves exact capacity feedback', async ({ page }) => {
  const project = makeOversizedProject();
  const capacityError: any = capacityErrorForProject(project);
  await page.route('**/api/status', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, led: { pixels: 44 } }),
    });
  });

  await gotoSavedProject(page, project, 'patterns');

  await page.getByRole('button', { name: 'Save to card', exact: true }).click();
  await expect(page.getByText(capacityError.message, { exact: true })).toBeVisible();
});
