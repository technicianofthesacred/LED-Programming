import { test, expect } from '@playwright/test';
import { REAL_PATTERNS } from '../src/v3/v3-data.js';
import { createDefaultProject } from '../src/lib/projectModel.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';
import { prepareCardStoragePayload } from '../src/lib/cardStoragePayload.js';
import { CARD_PATTERN_BANK } from '../src/lib/cardPatternBank.js';
import { createDefaultKaleidoscope } from '../src/lib/kaleidoscope.js';
import { compileWiring } from '../src/lib/wiringCompiler.js';

// These specs assert on the EXACT mockup PatternScreen that now ships
// (src/v3/lw-pattern.jsx). The DOM is the mockup's own: .pm wrapper, .pmcard
// browse cards, .pm-targetcard, .chips/.chip, and the testids
// that the live component exposes (save-current-combo,
// section-target-*, look-color-picker, look-*-slider/-readout, and visible
// preview state exposed by the compact preview toolbar).

async function setRangeValue(locator, value: string) {
  await locator.evaluate((node: HTMLInputElement, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(node, nextValue);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function mockDefaultCardZones(page) {
  await page.route('**/api/zones', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      zones: [
        { id: 'patch-default-outer-circle' },
        { id: 'patch-default-inner-circle' },
      ],
    }),
  }));
}

async function gotoFreshPatterns(page) {
  await mockDefaultCardZones(page);
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
}

async function gotoSavedProjectPatterns(page, project) {
  await page.route('**/api/zones', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      zones: (project.layout?.patchBoard?.patches || []).map(patch => ({ id: patch.id })),
    }),
  }));
  await page.addInitScript((savedProject) => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(savedProject));
  }, project);
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
}

function createPiecePreviewProject(id = 'piece-preview-fixture') {
  const project = createDefaultProject();
  project.id = id;
  project.name = 'Piece preview fixture';
  project.layout.layers = [
    { id: 'art-only-layer', name: 'Artwork only — no LEDs', visible: true },
  ];
  project.layout.patchBoard.patches[0].playback.patternId = 'fire';
  project.layout.patchBoard.patches[1].playback.patternId = 'ocean';
  return project;
}

function compileProjectWiring(project) {
  return compileWiring({
    wiring: project.layout.wiring,
    strips: project.layout.strips,
    groups: project.layout.layerGroups,
  });
}

async function mockVerifiedInstallCard(page, project, cardId = 'lw-pattern-install', options: any = {}) {
  let installedConfig = buildCardRuntimePackageFromProject({
    projectId: project.id,
    projectName: project.name,
    strips: project.layout.strips,
    patchBoard: project.layout.patchBoard,
    compiledWiring: compileProjectWiring(project),
    standaloneController: project.devices.standaloneController,
  }).config;
  await page.route('**/api/firmware-info', async route => {
    if (options.verificationGate && options.posted?.()) await options.verificationGate();
    await route.fulfill({ json: {
      app: 'Lightweaver',
      cardId,
      firmwareVersion: '1.0.0',
      buildId: 'pattern-install-build',
      projectRevision: installedConfig.projectRevision,
      projectFingerprint: installedConfig.projectFingerprint,
      outputs: installedConfig.led.outputs,
    } });
  });
  await page.route('**/api/status', route => route.fulfill({
    json: { ok: true, cardId, firmwareVersion: '1.0.0', led: { pixels: installedConfig.led.pixels } },
  }));
  await page.route('**/api/config', async route => {
    if (route.request().method() === 'GET') {
      if (options.verificationGate && options.posted?.()) await options.verificationGate();
      await route.fulfill({ json: installedConfig });
      return;
    }
    const requestedConfig = JSON.parse(route.request().postData() || '{}');
    options.onConfigRequest?.(structuredClone(requestedConfig));
    if (options.configGate) await options.configGate();
    if (options.failConfig) {
      await route.fulfill({ status: 503, json: { ok: false } });
      return;
    }
    installedConfig = requestedConfig;
    await route.fulfill({ json: { ok: true, requiresReboot: false } });
  });
  await page.route('**/api/control', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ json: { ok: true, cardId, patternId: body.patternId, revision: body.revision } });
  });
  await page.addInitScript((id) => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id }));
  }, cardId);
}

test('fresh strip preview and design target stay synchronized without committing the audition', async ({ page }) => {
  await gotoFreshPatterns(page);

  const targetSelect = page.getByLabel('Preview target');
  const outerTarget = page.getByTestId('section-target-patch-default-outer-circle');
  const stage = page.getByTestId('pattern-piece-preview');
  const previewHeading = page.getByTestId('pattern-preview-meta');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_autosave_v3'))).not.toBeNull();
  const savedBefore = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}');
    return JSON.stringify(project.layout?.patchBoard || null);
  });

  await expect(targetSelect).toHaveValue('patch-default-outer-circle');
  await expect(outerTarget).toHaveClass(/\bon\b/);
  await expect(previewHeading).toContainText('Lava Lamp');
  await expect(stage).toHaveAttribute('data-preview-patterns', 'lava');

  await page.getByLabel('Preview taps on the LED card').uncheck();
  await page.locator('.pm-cards .pmcard[data-pattern-id="plasma"]').click();
  await expect(previewHeading).toContainText('Plasma');
  await expect(stage).toHaveAttribute('data-preview-patterns', 'plasma');

  await page.getByRole('button', { name: 'On my piece' }).click();
  await expect(outerTarget).toHaveClass(/\bon\b/);
  await expect(stage).toHaveAttribute('data-preview-patterns', 'plasma,lava');
  await page.waitForTimeout(650);
  const savedAfter = await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}');
    return JSON.stringify(project.layout?.patchBoard || null);
  });
  expect(savedAfter).toBe(savedBefore);
});

test('mapped preview lists LED-backed targets only and crops to the selected geometry', async ({ page }) => {
  const project = createPiecePreviewProject();
  await gotoSavedProjectPatterns(page, project);

  const targetSelect = page.getByLabel('Preview target');
  await expect(targetSelect.locator('option')).toHaveText(['Whole piece', 'Outer circle', 'Inner circle']);
  await expect(targetSelect.locator('option', { hasText: 'Artwork only — no LEDs' })).toHaveCount(0);
  await expect(targetSelect).toHaveValue('patch-default-outer-circle');

  const stage = page.getByTestId('pattern-piece-preview');
  await expect(stage).toHaveAttribute('data-preview-mode', 'strip');
  await expect(stage).toHaveAttribute('data-preview-target', 'patch-default-outer-circle');
  await expect(stage).toHaveAttribute('data-preview-led-count', '27');
  await expect(stage).not.toHaveAttribute('data-preview-view-box', project.layout.viewBox);
});

test('preview toolbar is one compact desktop row and the redundant card panel is absent', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const project = createPiecePreviewProject('piece-preview-desktop-controls');
  await gotoSavedProjectPatterns(page, project);

  const controls = page.getByLabel('Pattern preview controls');
  const metadata = page.getByTestId('pattern-preview-meta');
  const previous = page.getByRole('button', { name: 'Previous LED target' });
  const target = page.getByLabel('Preview target');
  const next = page.getByRole('button', { name: 'Next LED target' });
  const toggle = page.getByRole('button', { name: 'On my piece' });
  const boxes = await Promise.all([
    controls.boundingBox(), metadata.boundingBox(), previous.boundingBox(), target.boundingBox(), next.boundingBox(), toggle.boundingBox(),
  ]);
  const [controlsBox, metadataBox, previousBox, targetBox, nextBox, toggleBox] = boxes;
  expect(controlsBox && metadataBox && previousBox && targetBox && nextBox && toggleBox).toBeTruthy();
  const rowY = metadataBox!.y;
  for (const box of [previousBox!, targetBox!, nextBox!, toggleBox!]) {
    expect(Math.abs(box.y - rowY)).toBeLessThanOrEqual(1);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect(controlsBox!.height).toBeLessThanOrEqual(44);
  await expect(page.getByText('Card', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Card local page host' })).toHaveCount(0);
});

test('phone preview toolbar uses no more than two compact rows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const project = createPiecePreviewProject('piece-preview-phone-controls');
  await gotoSavedProjectPatterns(page, project);

  const toolbar = page.getByLabel('Pattern preview controls');
  const items = [
    page.getByTestId('pattern-preview-meta'),
    page.getByRole('button', { name: 'Previous LED target' }),
    page.getByLabel('Preview target'),
    page.getByRole('button', { name: 'Next LED target' }),
    page.getByRole('button', { name: 'On my piece' }),
  ];
  const boxes = await Promise.all(items.map(item => item.boundingBox()));
  expect(boxes.every(Boolean)).toBe(true);
  const rows = new Set(boxes.map(box => Math.round(box!.y)));
  expect(rows.size).toBeLessThanOrEqual(2);
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox).toBeTruthy();
  expect(toolbarBox!.height).toBeLessThanOrEqual(92);
  for (const box of boxes) {
    expect(box!.x).toBeGreaterThanOrEqual(toolbarBox!.x - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width + 1);
  }
});

test('preview dropdown and chevrons move through LED targets without wrapping', async ({ page }) => {
  const project = createPiecePreviewProject();
  const savedBefore = JSON.stringify(project.layout.patchBoard);
  await gotoSavedProjectPatterns(page, project);

  const previous = page.getByRole('button', { name: 'Previous LED target' });
  const next = page.getByRole('button', { name: 'Next LED target' });
  const targetSelect = page.getByLabel('Preview target');
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();

  await next.click();
  await expect(targetSelect).toHaveValue('patch-default-inner-circle');
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();

  await targetSelect.selectOption('patch-default-outer-circle');
  await expect(previous).toBeDisabled();
  await targetSelect.selectOption('piece');
  await expect(page.getByTestId('pattern-piece-preview')).toHaveAttribute('data-preview-mode', 'piece');
  await expect(previous).toBeDisabled();
  await expect(next).toBeDisabled();
  await page.waitForTimeout(650);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}'));
  expect(JSON.stringify(saved.layout.patchBoard)).toBe(savedBefore);
});

test('On my piece returns to the last strip and restores preview state per project', async ({ page, browser }) => {
  const project = createPiecePreviewProject('piece-preview-restore');
  await gotoSavedProjectPatterns(page, project);

  const targetSelect = page.getByLabel('Preview target');
  const toggle = page.getByRole('button', { name: 'On my piece' });
  await targetSelect.selectOption('patch-default-inner-circle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(targetSelect).toHaveValue('piece');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(targetSelect).toHaveValue('patch-default-inner-circle');

  await toggle.click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'On my piece' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Preview target')).toHaveValue('piece');
  await expect(page.getByTestId('section-target-patch-default-inner-circle')).toHaveClass(/\bon\b/);

  const anotherProject = createPiecePreviewProject('piece-preview-other');
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await otherPage.addInitScript(({ savedProject, previousProjectId }) => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(savedProject));
    localStorage.setItem(`lw_pattern_piece_preview_v1:${previousProjectId}`, JSON.stringify({
      mode: 'piece',
      lastTargetId: 'patch-default-inner-circle',
    }));
  }, { savedProject: anotherProject, previousProjectId: project.id });
  await otherPage.goto(new URL('/#screen=patterns', page.url()).toString(), { waitUntil: 'domcontentloaded' });
  await expect(otherPage.getByRole('button', { name: 'On my piece' })).toHaveAttribute('aria-pressed', 'false');
  await expect(otherPage.getByLabel('Preview target')).toHaveValue('patch-default-outer-circle');
  await otherContext.close();
});

test('deleted remembered target falls back to the first LED-backed target', async ({ page }) => {
  const project = createPiecePreviewProject('piece-preview-deleted');
  await page.addInitScript(({ savedProject, key }) => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(savedProject));
    localStorage.setItem(key, JSON.stringify({ mode: 'strip', lastTargetId: 'deleted-target' }));
  }, {
    savedProject: project,
    key: `lw_pattern_piece_preview_v1:${project.id}`,
  });
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });

  await expect(page.getByLabel('Preview target')).toHaveValue('patch-default-outer-circle');
  await expect(page.getByTestId('pattern-piece-preview')).toHaveAttribute('data-preview-target', 'patch-default-outer-circle');
});

test('whole-piece preview composites saved assignments plus the unsaved selected draft without saving it', async ({ page }) => {
  const project = createPiecePreviewProject('piece-preview-draft');
  const savedBefore = JSON.stringify(project.layout.patchBoard);
  await gotoSavedProjectPatterns(page, project);

  await page.getByTestId('section-target-patch-default-inner-circle').click();
  await page.getByLabel('Preview taps on the LED card').uncheck();
  await page.locator('.pm-cards .pmcard[data-pattern-id="plasma"]').click();
  await page.getByRole('button', { name: 'On my piece' }).click();

  const stage = page.getByTestId('pattern-piece-preview');
  await expect(stage).toHaveAttribute('data-preview-mode', 'piece');
  await expect(stage).toHaveAttribute('data-preview-patterns', 'fire,plasma');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}'));
  expect(JSON.stringify(saved.layout.patchBoard)).toBe(savedBefore);
});

test('leaving whole-piece preview restores the remembered strip as the edit target', async ({ page }) => {
  const project = createPiecePreviewProject('piece-preview-all-toggle');
  await gotoSavedProjectPatterns(page, project);

  const innerTarget = page.getByTestId('section-target-patch-default-inner-circle');
  const allTarget = page.getByTestId('section-target-all');
  const toggle = page.getByRole('button', { name: 'On my piece' });
  const stage = page.getByTestId('pattern-piece-preview');
  await page.getByLabel('Preview taps on the LED card').uncheck();
  await innerTarget.click();
  await allTarget.click();
  await expect(stage).toHaveAttribute('data-preview-mode', 'piece');
  await expect(allTarget).toHaveClass(/\bon\b/);

  await toggle.click();
  await expect(stage).toHaveAttribute('data-preview-target', 'patch-default-inner-circle');
  await expect(innerTarget).toHaveClass(/\bon\b/);

  await page.locator('.pm-cards .pmcard[data-pattern-id="plasma"]').click();
  await setRangeValue(page.getByTestId('look-brightness-slider'), '0.42');
  await toggle.click();
  await expect(page.getByTestId('pattern-piece-preview')).toHaveAttribute('data-preview-patterns', 'fire,plasma');
});

test('verified Install persists the auditioned section assignment in Studio', async ({ page }) => {
  const project = createPiecePreviewProject('piece-preview-install');
  await mockVerifiedInstallCard(page, project);
  await gotoSavedProjectPatterns(page, project);

  await page.getByTestId('section-target-patch-default-inner-circle').click();
  await page.getByLabel('Preview taps on the LED card').uncheck();
  await page.locator('.pm-cards .pmcard[data-pattern-id="plasma"]').click();
  await setRangeValue(page.getByTestId('look-brightness-slider'), '0.42');
  await page.getByTitle('Install the current look on the card').click();

  await expect(page.locator('.savechip')).toContainText('Installed on card');
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}');
    return saved.layout?.patchBoard?.patches?.[1]?.playback?.patternId;
  })).toBe('plasma');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}'));
  expect(saved.layout.patchBoard.patches[0].playback.patternId).toBe('fire');
  expect(saved.layout.patchBoard.patches[1].playback).toMatchObject({ patternId: 'plasma', brightness: 0.42 });
  expect(saved.devices.standaloneController.playlist[0].patternId).toBe('plasma');
});

test('rapid duplicate Install clicks start only one card write', async ({ page }) => {
  const project = createPiecePreviewProject('piece-preview-single-install');
  const configRequests: any[] = [];
  let releaseConfig: (() => void) | null = null;
  const configGate = new Promise<void>(resolve => { releaseConfig = resolve; });
  await mockVerifiedInstallCard(page, project, 'lw-pattern-single-install', {
    onConfigRequest: config => configRequests.push(config),
    configGate: () => configGate,
  });
  await gotoSavedProjectPatterns(page, project);

  const install = page.getByTitle('Install the current look on the card');
  await expect(install).toBeEnabled();
  await Promise.all([
    install.dispatchEvent('click'),
    install.dispatchEvent('click'),
  ]);
  await expect.poll(() => configRequests.length).toBeGreaterThan(0);
  await page.waitForTimeout(200);
  expect(configRequests).toHaveLength(1);
  releaseConfig?.();
  await expect(install).toBeEnabled();
});

test('an edit made during verification remains a draft above the installed snapshot', async ({ page }) => {
  const project = createPiecePreviewProject('piece-preview-install-newer-draft');
  let posted = false;
  let releaseVerification: (() => void) | null = null;
  const verificationGate = new Promise<void>(resolve => { releaseVerification = resolve; });
  await mockVerifiedInstallCard(page, project, 'lw-pattern-newer-draft', {
    onConfigRequest: () => { posted = true; },
    posted: () => posted,
    verificationGate: () => verificationGate,
  });
  await gotoSavedProjectPatterns(page, project);

  const innerTarget = page.getByTestId('section-target-patch-default-inner-circle');
  const install = page.getByTitle('Install the current look on the card');
  await innerTarget.click();
  await page.getByLabel('Preview taps on the LED card').uncheck();
  await page.locator('.pm-cards .pmcard[data-pattern-id="plasma"]').click();
  await install.click();
  await expect.poll(() => posted).toBe(true);
  await expect(install).toBeDisabled();

  await page.locator('.pm-cards .pmcard[data-pattern-id="ripple"]').click();
  await expect(page.getByTestId('pattern-preview-meta')).toContainText('Ripple');
  releaseVerification?.();
  await expect(install).toBeEnabled();
  await page.waitForTimeout(300);

  await expect(page.locator('.savechip')).toContainText('Unsaved changes');
  await expect(page.getByTestId('pattern-preview-meta')).toContainText('Ripple');
  await expect(innerTarget).toHaveClass(/\bon\b/);
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}');
    return saved.layout?.patchBoard?.patches?.[1]?.playback?.patternId;
  })).toBe('plasma');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}'));
  expect(saved.devices.standaloneController.playlist[0].patternId).toBe('plasma');
});

test('a rejected Install preserves canonical Studio state and the current draft', async ({ page }) => {
  const project = createPiecePreviewProject('piece-preview-rejected-install');
  const canonicalBefore = JSON.stringify(project.layout.patchBoard);
  await mockVerifiedInstallCard(page, project, 'lw-pattern-rejected-install', { failConfig: true });
  await gotoSavedProjectPatterns(page, project);

  await page.getByTestId('section-target-patch-default-inner-circle').click();
  await page.getByLabel('Preview taps on the LED card').uncheck();
  await page.locator('.pm-cards .pmcard[data-pattern-id="plasma"]').click();
  await page.getByTitle('Install the current look on the card').click();

  await expect(page.getByTitle('Install the current look on the card')).toHaveText(/Retry install/);
  await expect(page.getByTestId('pattern-preview-meta')).toContainText('Plasma');
  await page.waitForTimeout(650);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}'));
  expect(JSON.stringify(saved.layout.patchBoard)).toBe(canonicalBefore);
  expect(saved.devices.standaloneController.playlist).toHaveLength(0);
});

test('v3 patterns mounts the mockup shell with a chip-ready catalog', async ({ page }) => {
  await gotoFreshPatterns(page);

  // The mockup shell and the browse grid render.
  await expect(page.locator('.pm')).toBeVisible();
  await expect(page.locator('.pm-stripfinder')).toHaveCount(0);
  await expect(page.getByText('Strip finder', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try next order' })).toHaveCount(0);
  await expect(page.locator('.pm-targetcard')).toBeVisible();

  // The catalog starts with one exact 24-card batch.
  await expect(page.locator('.pm-cards .pmcard')).toHaveCount(24);
  await expect(page.locator('.sec-h .m').first()).toContainText(`of ${REAL_PATTERNS.length} chip-ready`);
});

test('Advanced exposes a gentle bounded breathing envelope', async ({ page }) => {
  await gotoFreshPatterns(page);
  await page.getByTestId('section-target-all').click();

  await expect(page.getByTestId('breathe-summary')).toHaveText('Breathe off');
  await page.locator('.pmx-advanced summary').click();
  await page.getByLabel('Breathe', { exact: true }).check();

  await expect(page.getByTestId('breathe-lower-slider')).toHaveValue('85');
  await expect(page.getByTestId('breathe-upper-slider')).toHaveValue('100');
  await expect(page.getByTestId('breathe-cycle-slider')).toHaveValue('9');

  await setRangeValue(page.getByTestId('breathe-lower-slider'), '78');
  await setRangeValue(page.getByTestId('breathe-upper-slider'), '96');
  await setRangeValue(page.getByTestId('breathe-cycle-slider'), '14');

  await expect(page.getByTestId('breathe-summary')).toHaveText('Breathe · 78–96% · 14s');
  await expect(page.getByTestId('breathe-lower-slider')).toHaveAttribute('max', '96');
  await expect(page.getByTestId('breathe-upper-slider')).toHaveAttribute('min', '78');

  await setRangeValue(page.getByTestId('breathe-lower-slider'), '92');
  await setRangeValue(page.getByTestId('breathe-upper-slider'), '92');
  await expect(page.getByTestId('breathe-summary')).toHaveText('Breathe · 92% steady');

  const sectionTarget = page.locator('[data-testid^="section-target-"]:not([data-testid="section-target-all"])').first();
  await sectionTarget.click();
  await page.getByLabel('Breathe', { exact: true }).check();
  await setRangeValue(page.getByTestId('breathe-lower-slider'), '76');
  await setRangeValue(page.getByTestId('breathe-upper-slider'), '94');
  await setRangeValue(page.getByTestId('breathe-cycle-slider'), '12');
  await page.getByTestId('section-target-all').click();
  await expect(page.getByTestId('breathe-summary')).toHaveText('Breathe · 92% steady');
  await sectionTarget.click();
  await expect(page.getByTestId('breathe-summary')).toHaveText('Breathe · 76–94% · 12s');

  await page.getByTestId('save-current-combo').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_autosave_v3') || '')).toContain('"breatheLowerPct":92');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.pmx-advanced summary').click();
  await page.getByTestId('section-target-all').click();
  await expect(page.getByTestId('breathe-summary')).toHaveText('Breathe · 92% steady');
  await page.getByTestId('look-reset').click();
  await expect(page.getByTestId('breathe-summary')).toHaveText('Breathe off');
  await expect(page.getByTestId('breathe-lower-slider')).toHaveCount(0);
});

test('Patterns reports a blocked card-page popup with a recovery action', async ({ page }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await gotoFreshPatterns(page);

  await page.getByRole('button', { name: 'Open card page' }).click();

  const alert = page.getByRole('alert').filter({ hasText: 'browser blocked the card window' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Allow popups for Studio, then try again.');
});

test('a duplicate encoder press is resolved before Patterns renders', async ({ page }) => {
  const project = createDefaultProject();
  project.devices.standaloneController.controls.encoder.press = 6;

  await page.addInitScript((savedProject) => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(savedProject));
  }, project);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Patterns', exact: true }).click();

  await expect(page.locator('.pm')).toBeVisible();
  await expect(page.getByTestId('hardware-configuration-warning')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Install on card' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Card tools' })).toBeEnabled();
});

test('a genuine GPIO conflict still points back to wiring', async ({ page }) => {
  const project = createDefaultProject();
  project.devices.standaloneController.controls.encoder.a = 5;

  await page.addInitScript((savedProject) => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(savedProject));
  }, project);
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });

  const warning = page.getByTestId('hardware-configuration-warning');
  await expect(warning).toContainText('GPIO 5');
  await expect(warning.getByRole('button', { name: 'Fix automatically' })).toHaveCount(0);
  await warning.getByRole('button', { name: 'Fix wiring' }).click();
  await expect(page).toHaveURL(/#screen=layout&mode=wire$/);
});

test('first load reads warm (Lava Lamp) on a fresh, untitled project', async ({ page }) => {
  await gotoFreshPatterns(page);

  // The factory default look is aurora (green); on a fresh untitled project with
  // no saved looks the screen prefers the warm default for the INITIAL preview,
  // matching the mockup's Lava Lamp opening. Saved state is not mutated.
  await expect(page.getByTestId('pattern-preview-meta')).toContainText('Lava Lamp');
  await expect(page.locator('.pm-cards .pmcard[data-pattern-id="lava"]')).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('pattern-preview-meta')).not.toContainText('Aurora');
});

test('card-to-Studio return hydrates the selected pattern and preserves bridge correlation', async ({ page }) => {
  await page.goto('/?cardBridge=1&cardHost=192.168.18.70&editPattern=fire#screen=patterns', {
    waitUntil: 'domcontentloaded',
  });

  await expect(page.getByTestId('pattern-preview-meta')).toContainText('Fire');
  await expect(page.locator('.pm-cards .pmcard[data-pattern-id="fire"]')).toHaveClass(/\bon\b/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_chip_card_host'))).toBe('192.168.18.70');
  await expect.poll(() => new URL(page.url()).searchParams.get('editPattern')).toBeNull();
  const returned = new URL(page.url());
  expect(returned.searchParams.get('cardBridge')).toBe('1');
  expect(returned.searchParams.get('cardHost')).toBe('192.168.18.70');
  expect(new URLSearchParams(returned.hash.slice(1)).get('screen')).toBe('pattern');
});

test('search filters the browse grid', async ({ page }) => {
  await gotoFreshPatterns(page);

  await page.getByPlaceholder('Search chip patterns').fill('ocean');

  await expect(page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]')).toBeVisible();
  const shown = await page.locator('.pm-cards .pmcard').count();
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(REAL_PATTERNS.length);
  // Every visible card label matches the query.
  for (const name of await page.locator('.pm-cards .pmcard .pmcard-nm').allTextContents()) {
    expect(name.toLowerCase()).toContain('ocean');
  }
});

test('clicking a card updates the preview', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-click-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/control', async route => {
    const request = JSON.parse(route.request().postData() || '{}');
    controlRequests.push(request);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, cardId: 'lw-click-test', patternId: request.patternId, revision: request.revision }) });
  });

  await gotoFreshPatterns(page);
  await page.evaluate(() => localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-click-test' })));

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();

  // Selected card is marked, and the preview/labels reflect Ocean.
  await expect(page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]')).toHaveClass(/\bon\b/);
  await expect(page.getByTestId('pattern-preview-meta')).toContainText('Ocean');
  await expect(page.locator('.pm-preview-pane')).toContainText('Ocean');
  // Live preview pushes the selected pattern to the card.
  await expect.poll(() => controlRequests.some(r => r.patternId === 'ocean')).toBe(true);
});

test('Studio preview changes immediately while runtime application waits for the paired-card acknowledgement', async ({ page }) => {
  let releaseControl: (() => void) | null = null;
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-preview-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/control', async route => {
    const request = JSON.parse(route.request().postData() || '{}');
    await new Promise<void>(resolve => { releaseControl = resolve; });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        cardId: 'lw-preview-test',
        patternId: request.patternId,
        revision: request.revision,
      }),
    });
  });
  await gotoFreshPatterns(page);
  await page.evaluate(() => localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-preview-test' })));

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  await expect(page.getByTestId('pattern-preview-meta')).toContainText('Ocean');
  await expect(page.getByTestId('physical-preview-status')).toHaveText('Sending to Lightweaver');
  await expect.poll(() => Boolean(releaseControl)).toBe(true);
  releaseControl?.();
  await expect(page.getByTestId('physical-preview-status')).toHaveText('Applied by Lightweaver runtime');
});

test('an old card keeps the Studio selection and offers a card software update', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-preview-test' }));
  });
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-preview-test', firmwareVersion: '0.9.0' }),
  }));
  await page.route('**/api/control', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, patternId: 'ocean' }),
  }));
  await gotoFreshPatterns(page);

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  await expect(page.getByTestId('pattern-preview-meta')).toContainText('Ocean');
  const alert = page.getByRole('alert').filter({ hasText: 'This card is running old software and cannot report which preview command it applied.' });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Update card' })).toBeVisible();
  await expect(alert.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
});

test('an unknown preview failure stays bounded and does not render the card response', async ({ page }) => {
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-preview-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/control', route => route.fulfill({
    status: 200,
    contentType: 'text/plain',
    body: 'PRIVATE-CARD-RESPONSE <script>owned</script>',
  }));
  await gotoFreshPatterns(page);
  await page.evaluate(() => localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-preview-test' })));

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  const alert = page.getByRole('alert').filter({ hasText: 'The preview command could not be verified. Check the card connection and try again.' });
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText('PRIVATE-CARD-RESPONSE');
  await expect(alert.getByRole('button')).toHaveCount(0);
});

test('missing runtime state proof recovers the card before asking for visible confirmation', async ({ page }) => {
  let recoveryCount = 0;
  await page.addInitScript(() => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-output-test' }));
  });
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-output-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/control', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, cardId: 'lw-output-test' }),
  }));
  await page.route('**/api/wiring/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, state: 'known-good', currentOutputs: [] }),
  }));
  await page.route('**/api/recover-lights', route => {
    recoveryCount += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        accepted: true,
        diagnostics: { nonBlackPixels: 44, brightnessByte: 180 },
      }),
    });
  });
  await page.route('**/api/reboot', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));
  await gotoFreshPatterns(page);

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  const alert = page.getByRole('alert').filter({ hasText: 'The preview reached the card, but its runtime did not report which pattern or revision it applied.' });
  await expect(alert.getByRole('button', { name: 'Recover lights' })).toBeVisible();
  await alert.getByRole('button', { name: 'Recover lights' }).click();

  await expect(alert).toHaveCount(0);
  await expect.poll(() => recoveryCount).toBe(2);
  await expect(page.getByText('Recovery frame sent. Do you see warm white on the real LEDs?')).toBeVisible();
  await expect(page.getByRole('alert').getByRole('button', { name: 'Recover lights' })).toHaveCount(0);
});

test('production bridge transport sends only the newest selection to the source-bound popup', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('**/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.addInitScript(() => {
    (window as any).__bridgeOpenCalls = [];
    (window as any).__bridgeMessages = [];
    const originalOpen = window.open.bind(window);
    window.open = ((url?: string | URL, name?: string) => {
      (window as any).__bridgeOpenCalls.push({ url: String(url || ''), name });
      const popup = originalOpen('about:blank', name);
      (window as any).__bridgePopup = popup;
      if (popup) {
        Object.defineProperty(popup, 'postMessage', {
          configurable: true,
          value(message: any, targetOrigin: string) {
            (window as any).__bridgeMessages.push({ message, targetOrigin });
            queueMicrotask(() => {
              window.dispatchEvent(new MessageEvent('message', {
                origin: targetOrigin,
                source: popup,
                data: {
                  app: 'LightweaverCardBridge',
                  id: message.id,
                  ok: true,
                  version: 1,
                  response: message.type === 'firmware-info'
                    ? { cardId: 'lw-bridge-test', firmwareVersion: '1.0.0', buildId: 'bridge-test-build' }
                    : message.type === 'status'
                      ? {
                          app: 'Lightweaver', provisioningContractVersion: 1,
                          cardId: 'lw-bridge-test', firmwareVersion: '1.0.0', buildId: 'bridge-test-build',
                          bootId: 'bridge-test-boot', runtimePhase: 'ready', knownGoodProject: true,
                          commandReady: true, outputReady: true,
                        }
                      : { ok: true, cardId: 'lw-bridge-test', patternId: message.payload?.patternId, revision: message.payload?.revision },
                },
              }));
            });
          },
        });
      }
      return popup;
    }) as typeof window.open;
  });
  await mockDefaultCardZones(page);
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_local_chip_default', '1');
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1, id: 'lw-bridge-test', firmwareVersion: '1.0.0', buildId: 'bridge-test-build',
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  await page.locator('.pm-cards .pmcard[data-pattern-id="plasma"]').click();
  await expect(page.getByTestId('pattern-preview-meta')).toContainText('Plasma');
  expect(await page.evaluate(() => (window as any).__bridgeOpenCalls)).toHaveLength(1);
  await page.waitForTimeout(150);
  expect(controlRequests).toHaveLength(0);

  await page.evaluate(() => {
    const popup = (window as any).__bridgePopup;
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://lightweaver.local',
      source: popup,
      data: {
        app: 'LightweaverCardBridge',
        type: 'ready',
        host: 'lightweaver.local',
        version: 1,
      },
    }));
  });

  await expect.poll(() => page.evaluate(() => (window as any).__bridgeMessages.some((entry: any) => entry.message.type === 'control'))).toBe(true);
  const bridgeRequest = await page.evaluate(() => (window as any).__bridgeMessages.find((entry: any) => entry.message.type === 'control'));
  const bridgeMessageTypes = await page.evaluate(() => (window as any).__bridgeMessages.map((entry: any) => entry.message.type));
  expect(bridgeMessageTypes.indexOf('status')).toBeGreaterThanOrEqual(0);
  expect(bridgeMessageTypes.indexOf('status')).toBeLessThan(bridgeMessageTypes.indexOf('control'));
  expect(bridgeRequest.targetOrigin).toBe('http://lightweaver.local');
  expect(bridgeRequest.message.app).toBe('LightweaverStudioBridge');
  expect(bridgeRequest.message.type).toBe('control');
  expect(bridgeRequest.message.payload.patternId).toBe('plasma');
  expect(controlRequests).toHaveLength(0);
  await page.waitForTimeout(2400);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).__bridgeMessages)).filter((entry: any) => entry.message.type === 'control')).toHaveLength(1);
});

test('latest pattern waits through bridge identity verification instead of being dropped', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__identityBridgeMessages = [];
    (window as any).__heldFirmwareInfo = null;
    const originalOpen = window.open.bind(window);
    window.open = ((url?: string | URL, name?: string) => {
      const popup = originalOpen('about:blank', name);
      (window as any).__identityBridgePopup = popup;
      if (popup) {
        Object.defineProperty(popup, 'postMessage', {
          configurable: true,
          value(message: any, targetOrigin: string) {
            (window as any).__identityBridgeMessages.push({ message, targetOrigin });
            if (message.type === 'firmware-info') {
              (window as any).__heldFirmwareInfo = { message, targetOrigin };
              return;
            }
            const response = message.type === 'status'
              ? {
                  app: 'Lightweaver', provisioningContractVersion: 1,
                  cardId: 'lw-identity-race', firmwareVersion: '1.0.0', buildId: 'identity-race-build',
                  bootId: 'identity-race-boot', runtimePhase: 'ready', knownGoodProject: true,
                  commandReady: true, outputReady: true,
                }
              : { ok: true, cardId: 'lw-identity-race', patternId: message.payload?.patternId, revision: message.payload?.revision };
            queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
              origin: targetOrigin,
              source: popup,
              data: { app: 'LightweaverCardBridge', id: message.id, ok: true, version: 1, response },
            })));
          },
        });
      }
      return popup;
    }) as typeof window.open;
  });
  await mockDefaultCardZones(page);
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_local_chip_default', '1');
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1, id: 'lw-identity-race', firmwareVersion: '1.0.0', buildId: 'identity-race-build',
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.pm-cards .pmcard[data-pattern-id="fire"]').click();
  await page.evaluate(() => {
    const popup = (window as any).__identityBridgePopup;
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://lightweaver.local',
      source: popup,
      data: { app: 'LightweaverCardBridge', type: 'ready', host: 'lightweaver.local', version: 1 },
    }));
  });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__heldFirmwareInfo))).toBe(true);

  await page.locator('.pm-cards .pmcard[data-pattern-id="plasma"]').click();
  await page.evaluate(() => {
    const popup = (window as any).__identityBridgePopup;
    const held = (window as any).__heldFirmwareInfo;
    window.dispatchEvent(new MessageEvent('message', {
      origin: held.targetOrigin,
      source: popup,
      data: {
        app: 'LightweaverCardBridge', id: held.message.id, ok: true, version: 1,
        response: { cardId: 'lw-identity-race', firmwareVersion: '1.0.0', buildId: 'identity-race-build' },
      },
    }));
  });

  await expect.poll(() => page.evaluate(() => (
    (window as any).__identityBridgeMessages
      .filter((entry: any) => entry.message.type === 'control')
      .map((entry: any) => entry.message.payload.patternId)
  ))).toEqual(['plasma']);
  await expect(page.getByTestId('physical-preview-status')).toHaveText('Applied by Lightweaver runtime');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('disabling live preview invalidates a pending bridge selection', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('**/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.addInitScript(() => {
    (window as any).__bridgeMessages = [];
    const bridge = {
      closed: false,
      postMessage(message: unknown, targetOrigin: string) {
        (window as any).__bridgeMessages.push({ message, targetOrigin });
      },
    };
    window.open = (() => bridge as any) as typeof window.open;
  });
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_local_chip_default', '1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  await page.getByLabel('Preview taps on the LED card').uncheck();
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://lightweaver.local',
      data: { app: 'LightweaverCardBridge', type: 'ready', host: 'lightweaver.local', version: 1 },
    }));
  });

  await page.waitForTimeout(200);
  expect(controlRequests).toHaveLength(0);
  expect((await page.evaluate(() => (window as any).__bridgeMessages)).filter((entry: any) => entry.message.type === 'control')).toHaveLength(0);
});

test('leaving Patterns invalidates a pending bridge selection', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('**/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.addInitScript(() => {
    (window as any).__bridgeMessages = [];
    const bridge = {
      closed: false,
      postMessage(message: unknown, targetOrigin: string) {
        (window as any).__bridgeMessages.push({ message, targetOrigin });
      },
    };
    window.open = (() => bridge as any) as typeof window.open;
  });
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_local_chip_default', '1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  await page.evaluate(() => { window.location.hash = '#screen=layout'; });
  await expect(page.locator('.pm')).toHaveCount(0);
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://lightweaver.local',
      data: { app: 'LightweaverCardBridge', type: 'ready', host: 'lightweaver.local', version: 1 },
    }));
  });

  await page.waitForTimeout(200);
  expect(controlRequests).toHaveLength(0);
  expect((await page.evaluate(() => (window as any).__bridgeMessages)).filter((entry: any) => entry.message.type === 'control')).toHaveLength(0);
});

test('blocked automatic card window gives one concrete recovery action', async ({ page }) => {
  await page.addInitScript(() => {
    window.open = (() => null) as typeof window.open;
  });
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_local_chip_default', '1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();

  await expect(page.getByRole('alert')).toContainText(
    'Allow the Lightweaver card window, then try the pattern again.',
  );
});

test('an older card bridge points to the single Flash recovery action', async ({ page }) => {
  await page.addInitScript(() => {
    const bridge = { closed: false, postMessage: () => {} };
    window.open = (() => bridge as any) as typeof window.open;
  });
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_local_chip_default', '1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://lightweaver.local',
      data: {
        app: 'LightweaverCardBridge',
        type: 'ready',
        host: 'lightweaver.local',
      },
    }));
  });

  await expect(page.getByRole('alert')).toContainText(
    "This card is running older firmware that can't do this yet. Open Flash to update the card, then try again.",
  );
});

test('an already-verified legacy bridge is gated before sending a pattern', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('**/api/control', async route => {
    controlRequests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.addInitScript(() => {
    (window as any).__legacyBridgeMessages = [];
    (window as any).__legacyReplyVersion = 1;
    const bridge = {
      closed: false,
      postMessage(message: any, targetOrigin: string) {
        (window as any).__legacyBridgeMessages.push({ message, targetOrigin });
        queueMicrotask(() => {
          window.dispatchEvent(new MessageEvent('message', {
            origin: targetOrigin,
            data: {
              app: 'LightweaverCardBridge',
              id: message.id,
              ok: true,
              ...((window as any).__legacyReplyVersion ? { version: 1 } : {}),
              response: message.type === 'firmware-info'
                ? { cardId: 'lw-legacy-test', firmwareVersion: '1.0.0', buildId: 'legacy-test-build' }
                : message.type === 'status'
                  ? {
                      app: 'Lightweaver', provisioningContractVersion: 1,
                      cardId: 'lw-legacy-test', firmwareVersion: '1.0.0', buildId: 'legacy-test-build',
                      bootId: 'legacy-test-boot', runtimePhase: 'ready', knownGoodProject: true,
                      commandReady: true, outputReady: true,
                    }
                  : { ok: true, cardId: 'lw-legacy-test', patternId: message.payload?.patternId, revision: message.payload?.revision },
            },
          }));
        });
      },
    };
    window.open = (() => bridge as any) as typeof window.open;
  });
  await mockDefaultCardZones(page);
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('lw_local_chip_default', '1');
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1, id: 'lw-legacy-test', firmwareVersion: '1.0.0', buildId: 'legacy-test-build',
    }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.locator('.pm-cards .pmcard[data-pattern-id="plasma"]').click();
  await page.evaluate(() => {
    (window as any).__legacyReplyVersion = 0;
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://lightweaver.local',
      data: {
        app: 'LightweaverCardBridge',
        type: 'ready',
        host: 'lightweaver.local',
        version: 1,
      },
    }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).__legacyBridgeMessages.some((entry: any) => entry.message.type === 'control'))).toBe(true);
  const legacyMessageTypes = await page.evaluate(() => (window as any).__legacyBridgeMessages.map((entry: any) => entry.message.type));
  expect(legacyMessageTypes.indexOf('status')).toBeGreaterThanOrEqual(0);
  expect(legacyMessageTypes.indexOf('status')).toBeLessThan(legacyMessageTypes.indexOf('control'));
  await page.evaluate(() => { (window as any).__legacyBridgeMessages.length = 0; });

  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'http://lightweaver.local',
      data: {
        app: 'LightweaverCardBridge',
        type: 'ready',
        host: 'lightweaver.local',
      },
    }));
  });
  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();

  await expect(page.getByRole('alert')).toContainText(
    "This card is running older firmware that can't do this yet. Open Flash to update the card, then try again.",
  );
  await page.waitForTimeout(150);
  expect(controlRequests).toHaveLength(0);
  expect((await page.evaluate(() => (window as any).__legacyBridgeMessages)).filter((entry: any) => entry.message.type === 'control')).toHaveLength(0);
  const flashAction = page.getByRole('button', { name: 'Open Flash' });
  await expect(flashAction).toBeVisible();
  await flashAction.click();
  await expect(page).toHaveURL(/#screen=flash$/);
});

test('setup JSON copy and download use the same compact card payload', async ({ page }) => {
  const project = createDefaultProject();
  project.id = 'setup-json-fixture';
  project.name = 'Setup JSON fixture';
  project.layout.strips[0].kaleidoscope = createDefaultKaleidoscope(project.layout.strips[0].pixelCount);
  const expected = prepareCardStoragePayload(buildCardRuntimePackageFromProject({
    projectId: project.id,
    projectName: project.name,
    strips: project.layout.strips,
    patchBoard: project.layout.patchBoard,
    wiring: project.layout.wiring,
    standaloneController: project.devices.standaloneController,
  })).json;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => { (window as any).__copiedSetup = text; },
      },
    });
  });
  await gotoSavedProjectPatterns(page, project);

  await page.getByRole('button', { name: /Card tools/ }).click();
  await page.getByRole('menuitem', { name: /Copy setup/ }).click();
  const copied = await page.evaluate(() => (window as any).__copiedSetup || '');

  await page.getByRole('button', { name: /Card tools/ }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Download setup/ }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const downloaded = Buffer.concat(chunks).toString('utf8');

  expect(copied).toBe(downloaded);
  expect(copied).toBe(expected);
  expect(copied).not.toContain('\n');
  const config = JSON.parse(copied);
  expect(config.kaleidoscopeMappings).toHaveLength(1);
  expect(config.kaleidoscopeMappings[0].id).toBe(project.layout.strips[0].id);
  expect(config.patterns).toBeUndefined();
  expect(config.controls?.encoder?.patternCycleIds).toBeUndefined();
});

test('oversized setup JSON stops copy and download before browser side effects', async ({ page }) => {
  const project = createDefaultProject();
  project.id = 'oversized-setup-fixture';
  project.name = 'Oversized setup fixture';
  const patterns = CARD_PATTERN_BANK.slice(0, 32);
  project.devices.standaloneController.playlist = patterns.map((pattern, order) => ({
    id: pattern.id,
    label: `${pattern.label} ${'oversized-label-'.repeat(24)}`,
    type: 'pattern',
    patternId: pattern.id,
    enabled: true,
    order,
  }));
  project.devices.standaloneController.controls.encoder.patternCycleIds = patterns.map(pattern => pattern.id);
  const runtimePackage = buildCardRuntimePackageFromProject({
    projectId: project.id,
    projectName: project.name,
    strips: project.layout.strips,
    patchBoard: project.layout.patchBoard,
    compiledWiring: compileProjectWiring(project),
    standaloneController: project.devices.standaloneController,
  });
  let capacityError: any = null;
  try {
    prepareCardStoragePayload(runtimePackage);
  } catch (error) {
    capacityError = error;
  }
  expect(capacityError?.reason).toBe('config-too-large');

  await page.addInitScript(() => {
    (window as any).__setupSideEffects = { clipboard: 0, objectUrl: 0, anchorClick: 0 };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => { (window as any).__setupSideEffects.clipboard += 1; },
      },
    });
    URL.createObjectURL = () => {
      (window as any).__setupSideEffects.objectUrl += 1;
      return 'blob:unexpected';
    };
    HTMLAnchorElement.prototype.click = function click() {
      (window as any).__setupSideEffects.anchorClick += 1;
    };
  });
  await gotoSavedProjectPatterns(page, project);

  await page.getByRole('button', { name: /Card tools/ }).click();
  await page.getByRole('menuitem', { name: /Copy setup/ }).click();
  await expect(page.getByText(capacityError.message, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__setupSideEffects)).toEqual({
    clipboard: 0,
    objectUrl: 0,
    anchorClick: 0,
  });

  await page.getByRole('button', { name: /Card tools/ }).click();
  await page.getByRole('menuitem', { name: /Download setup/ }).click();
  await expect(page.getByText(capacityError.message, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__setupSideEffects)).toEqual({
    clipboard: 0,
    objectUrl: 0,
    anchorClick: 0,
  });
});

test('Recover lights asks for physical confirmation and offers wire discovery when still dark', async ({ page }) => {
  const recoveries: Record<string, unknown>[] = [];
  let rebootCount = 0;
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-recovery-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      app: 'Lightweaver', provisioningContractVersion: 1,
      cardId: 'lw-recovery-test', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
      bootId: 'boot-recovery-test', runtimePhase: 'ready', knownGoodProject: true,
      commandReady: true, outputReady: true, led: { pixels: 44 },
    }),
  }));
  await page.route('**/api/wiring/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, state: 'known-good', currentOutputs: [] }),
  }));
  await page.route('**/api/recover-lights', async route => {
    recoveries.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        accepted: true,
        diagnostics: { nonBlackPixels: 44, brightnessByte: 180 },
      }),
    });
  });
  await page.route('**/api/reboot', async route => {
    rebootCount += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await gotoFreshPatterns(page);
  await page.evaluate(() => localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-recovery-test' })));
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByTestId('recover-lights').click();
  await expect.poll(() => recoveries.length).toBe(2);
  await page.waitForTimeout(150);
  expect(recoveries).toHaveLength(2);
  expect(recoveries[0]).toMatchObject({ patternId: 'warm-white', brightness: 1, syncZones: true });
  expect(recoveries[1]).toMatchObject({ patternId: 'warm-white', brightness: 1, syncZones: true });
  expect(rebootCount).toBe(1);
  await expect(page.getByText('Recovery frame sent. Do you see warm white on the real LEDs?')).toBeVisible();
  await page.getByRole('button', { name: 'No, lights are still dark' }).click();
  await expect(page.getByText('The card responded, but physical light is not confirmed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find my LED wire' })).toBeVisible();
});

test('category chips filter the grid', async ({ page }) => {
  await gotoFreshPatterns(page);

  // Let the full grid settle before measuring (auto-retrying assertion).
  await expect(page.locator('.pm-cards .pmcard')).toHaveCount(24);
  const allCount = await page.locator('.pm-cards .pmcard').count();

  // Pick the Water category chip in the browse tools.
  await page.locator('.pt-tools .chips .chip', { hasText: 'Water' }).click();

  // The grid shrinks to just the Water-category patterns.
  await expect.poll(() => page.locator('.pm-cards .pmcard').count()).toBeLessThan(allCount);
  const waterCount = await page.locator('.pm-cards .pmcard').count();
  expect(waterCount).toBeGreaterThan(0);
  await expect(page.locator('.pt-tools .chips .chip.on')).toHaveText('Water');
});

test('a slider changes its readout and sends a tuned color modifier', async ({ page }) => {
  const controlRequests: Record<string, unknown>[] = [];
  await page.route('**/api/firmware-info', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cardId: 'lw-slider-test', firmwareVersion: '1.0.0' }),
  }));
  await page.route('**/api/control', async route => {
    const request = JSON.parse(route.request().postData() || '{}');
    controlRequests.push(request);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, cardId: 'lw-slider-test', patternId: request.patternId, revision: request.revision }) });
  });

  await gotoFreshPatterns(page);
  await page.evaluate(() => localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-slider-test' })));

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();

  // Brightness slider readout follows the input value.
  await setRangeValue(page.getByTestId('look-brightness-slider'), '0.42');
  await expect(page.getByTestId('look-brightness-readout')).toHaveText('42%');

  // Speed slider readout follows the input value.
  await setRangeValue(page.getByTestId('look-speed-slider'), '1.75');
  await expect(page.getByTestId('look-speed-readout')).toHaveText('1.75×');

  // The hue spectrum slider readout updates too.
  await setRangeValue(page.getByTestId('look-hue-slider'), '160');
  await expect(page.getByTestId('look-hue-readout')).toContainText('°');

  // The tuned look is pushed to the card.
  await expect.poll(() => controlRequests.some(r => (
    r.patternId === 'ocean' && r.brightness === 0.42 && r.speed === 1.75
  ))).toBe(true);
});

test('the advanced hue-shift slider exposes its testids', async ({ page }) => {
  await gotoFreshPatterns(page);

  await page.locator('.pmx-advanced summary').click();
  await setRangeValue(page.getByTestId('look-hue-shift-slider'), '-24');
  await expect(page.getByTestId('look-hue-shift-readout')).toHaveText('-24');
});

test('saving the current look as a mix adds a mix card to the grid', async ({ page }) => {
  await page.route('**/api/control', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await gotoFreshPatterns(page);

  await page.locator('.pm-cards .pmcard[data-pattern-id="ocean"]').click();
  const before = await page.locator('.pm-cards .pmcard').count();

  await page.getByTestId('save-current-combo').click();

  // A new mix card (tagged 'mix') appears in the grid.
  await expect(page.locator('.pm-cards .pmcard .mixtag')).toHaveCount(1);
  await expect(page.locator('.pm-cards .pmcard')).toHaveCount(before);
});

test('the mirror geometry control switches the active geometry', async ({ page }) => {
  await gotoFreshPatterns(page);

  await page.locator('.geo-seg').getByRole('button', { name: 'Mirror' }).click();

  await expect(page.locator('.geo-seg button.on')).toHaveText(/Mirror/);
});
