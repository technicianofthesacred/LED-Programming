import { type Route } from '@playwright/test';
import { test, expect } from './studioTest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { choosePattern, patternSearchInput } from './helpers/pattern-lab.ts';

const AUTOSAVE_KEY = 'lw_autosave_v3';
const PREVIEW_SOURCE = await readFile(fileURLToPath(new URL('../src/v3/PatternPreview.jsx', import.meta.url)), 'utf8');
const LAB_PREVIEW_SOURCE = await readFile(fileURLToPath(new URL('../src/pattern-lab/PatternLabPreview.jsx', import.meta.url)), 'utf8');
let cardMutationRequests: string[];

function wavBuffer({ durationSeconds = 0.12, sampleRate = 8000 } = {}) {
  const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(index * Math.PI / 8) * 12000), 44 + index * 2);
  }
  return buffer;
}

async function projectBytes(page) {
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).not.toBeNull();
  return page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY);
}

test.beforeEach(async ({ page }) => {
  cardMutationRequests = [];
  const blockCard = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'GET') cardMutationRequests.push(`${request.method()} ${request.url()}`);
    await route.abort();
  };
  await page.route('http://lightweaver.local/**', blockCard);
  await page.route('http://192.168.4.1/**', blockCard);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
});

test('Pattern Inspector presents Choose, Sculpt, and Evolve as compact attached step groups', async ({ page }) => {
  const choose = page.getByTestId('pattern-lab-step-choose');
  const sculpt = page.getByTestId('pattern-lab-step-sculpt');
  const evolve = page.getByTestId('pattern-lab-step-evolve');

  await expect(choose.getByRole('heading', { name: 'Choose', exact: true })).toHaveAttribute('id', 'plab-source-heading');
  await expect(choose.getByLabel('Search patterns')).toBeVisible();
  await expect(choose.getByText('Base pattern', { exact: true })).toHaveCount(0);
  await expect(choose.getByText(/Start with a built-in Lightweaver look/i)).toHaveCount(0);

  await expect(sculpt.getByRole('heading', { name: 'Sculpt', exact: true })).toHaveAttribute('id', 'plab-sculpt-heading');
  await expect(sculpt.getByText(/Five creative controls, with no code required/i)).toHaveCount(0);

  const evolveHeading = evolve.locator('.plab-compact-step-heading');
  await expect(evolveHeading.getByRole('heading', { name: 'Evolve', exact: true })).toHaveAttribute('id', 'plab-evolution-heading');
  await expect(evolveHeading.getByRole('checkbox', { name: /Long Evolution/i })).toBeVisible();
  await expect(evolveHeading.getByText('5–15 min')).toBeVisible();
  await expect(evolve.getByText(/Let several slow clocks unfold/i)).toHaveCount(0);

  for (const group of [choose, sculpt, evolve]) {
    const heading = group.locator('.plab-compact-step-heading');
    expect(await heading.evaluate(element => {
      const styles = getComputedStyle(element);
      return {
        borderBottomWidth: styles.borderBottomWidth,
        height: Number.parseFloat(styles.height),
      };
    })).toMatchObject({ borderBottomWidth: '1px' });
    expect(Number.parseFloat(await heading.evaluate(element => getComputedStyle(element).height)))
      .toBeLessThanOrEqual(54);
  }

  const sectionSurfaces = await Promise.all([choose, sculpt, evolve].map(group => group.evaluate(element => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas context unavailable');
    context.fillStyle = getComputedStyle(element).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
  })));
  const surfaceDistance = (left: number[], right: number[]) => Math.sqrt(
    left.reduce((sum, channel, index) => sum + ((channel - right[index]) ** 2), 0),
  );
  expect(surfaceDistance(sectionSurfaces[0], sectionSurfaces[1])).toBeGreaterThanOrEqual(8);
  expect(surfaceDistance(sectionSurfaces[1], sectionSurfaces[2])).toBeGreaterThanOrEqual(8);
});

test('shows Color, Movement, Brightness, and Speed for a built-in pattern, with no Energy, Shape, or Texture', async ({ page }) => {
  await choosePattern(page, 'aurora');

  // Movement, Shape, and Texture are context-dependent (see
  // controlsForContext in PatternLabControls.jsx): Movement drives
  // applyPatternLabMotionToStrips, which only the built-in library patterns
  // render through, while Shape/Texture drive artistic.scale/density, which
  // only the five procedural generators consume. A built-in pattern like
  // Aurora shows Movement but not Shape/Texture.
  const labels = await page.locator('.plab-macros input[type="range"]')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  expect(labels).toEqual(['Color', 'Movement', 'Brightness', 'Speed']);
  await expect(page.getByLabel('Energy', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Energy', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Shape', exact: true })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Texture', exact: true })).toHaveCount(0);
});

test('shows Color, Shape, Texture, Brightness, and Speed for a procedural generator, with no Movement', async ({ page }) => {
  await choosePattern(page, 'generator:particles');

  const labels = await page.locator('.plab-macros input[type="range"]')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  expect(labels).toEqual(['Color', 'Shape', 'Texture', 'Brightness', 'Speed']);
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveCount(0);
});

test('exports Brightness and Speed as independent playback controls', async ({ page }) => {
  await choosePattern(page, 'aurora');
  await page.getByRole('slider', { name: 'Brightness', exact: true }).fill('25');
  await page.getByRole('slider', { name: 'Speed', exact: true }).fill('175');

  await expect(page.getByLabel('Brightness value')).toHaveText('25%');
  await expect(page.getByLabel('Speed value')).toHaveText('1.75×');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recipe' }).click();
  const downloadedPath = await (await downloadPromise).path();
  expect(downloadedPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadedPath!, 'utf8'));

  expect(exported.macros.energy).toBeUndefined();
  expect(exported.playback).toEqual({ brightness: 0.25, speed: 1.75 });
});

test('offers one accessible Import recipe control and imports through its file chooser', async ({ page }) => {
  await choosePattern(page, 'aurora');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recipe' }).click();
  const downloadedPath = await (await downloadPromise).path();
  expect(downloadedPath).not.toBeNull();
  const recipe = JSON.parse(await readFile(downloadedPath!, 'utf8'));
  recipe.name = 'Accessible import';

  const importControl = page.getByRole('button', { name: 'Import recipe', exact: true });
  await expect(importControl).toHaveCount(1);
  await importControl.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.plab-file-input')).not.toBeFocused();
  const chooserPromise = page.waitForEvent('filechooser');
  await importControl.click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'accessible-import.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(recipe)),
  });

  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText('Accessible import');
  await expect(page.getByTestId('pattern-lab-save-status')).toContainText('Imported Accessible import.');
});

// The Movement slider itself is back (PatternLabControls.jsx now shows it
// for built-in patterns via controlsForContext — Movement genuinely drives
// renderOptions.motionWeights through patternLabMotion.js, unlike Shape and
// Texture which were confirmed preview-only placebos for built-in patterns;
// see PatternLabPreview.jsx). What did NOT come back is the semantic-anchor
// aria-valuetext this test checked ("Drift, 0%" / "Flow, 33%" / …) and the
// "Drift 0% · Flow 33% · Pulse 67% · Surge 100%" legend — the slider now
// renders through the same generic aria-valuetext={`${value}%`} path as
// every other macro, with no anchor naming. The underlying anchor math is
// still covered at the unit level in src/lib/patternLabControls.test.js
// ('movement resolves exact Drift, Flow, Pulse, and Surge anchors'); only
// its UI-level exposure is gone, and there is no dead-slider UI left here to
// test against.
test('keeps the active Inspector band synchronized with direct focus and workflow actions', async ({ page }) => {
  const workflow = page.getByRole('navigation', { name: 'Pattern Lab workflow' });
  const choose = page.getByTestId('pattern-lab-step-choose');
  const sculpt = page.getByTestId('pattern-lab-step-sculpt');
  const evolve = page.getByTestId('pattern-lab-step-evolve');

  await expect(choose).toHaveAttribute('data-active', 'true');
  await expect(workflow.getByRole('button', { name: 'Choose' })).toHaveAttribute('aria-current', 'step');

  await choosePattern(page, 'aurora');
  await expect(choose).toHaveAttribute('data-active', 'true');
  await expect(workflow.getByRole('button', { name: 'Choose' })).toHaveAttribute('aria-current', 'step');

  await page.getByRole('slider', { name: 'Color', exact: true }).focus();
  await expect(sculpt).toHaveAttribute('data-active', 'true');
  await expect(workflow.getByRole('button', { name: 'Sculpt' })).toHaveAttribute('aria-current', 'step');

  await workflow.getByRole('button', { name: 'Evolve' }).click();
  await expect(evolve).toHaveAttribute('data-active', 'true');
  await expect(workflow.getByRole('button', { name: 'Evolve' })).toHaveAttribute('aria-current', 'step');

  await patternSearchInput(page).focus();
  await expect(choose).toHaveAttribute('data-active', 'true');
  await expect(workflow.getByRole('button', { name: 'Choose' })).toHaveAttribute('aria-current', 'step');
});

test('gives pattern and control changes one bounded preview response with local acknowledgment', async ({ page }) => {
  await choosePattern(page, 'aurora');

  const previewResponse = page.getByTestId('pattern-lab-preview-response');
  const previewContent = page.getByTestId('pattern-lab-preview-content');
  await expect(previewResponse).toHaveAttribute('data-response-kind', 'pattern');
  await expect(previewContent).toHaveAttribute('data-pattern-transition', 'true');
  expect(await previewContent.evaluate(element => getComputedStyle(element).animationName))
    .toContain('plab-preview-crossfade');

  const firstSequence = await previewResponse.getAttribute('data-response-sequence');
  await page.getByRole('slider', { name: 'Color', exact: true }).fill('72');
  await expect(previewResponse).toHaveAttribute('data-response-kind', 'control');
  await expect(previewResponse).not.toHaveAttribute('data-response-sequence', firstSequence || '');
  const responseMotion = await previewResponse.evaluate(element => {
    const styles = getComputedStyle(element);
    return {
      animationName: styles.animationName,
      duration: Number.parseFloat(styles.animationDuration),
      timing: styles.animationTimingFunction,
    };
  });
  expect(responseMotion.animationName).toContain('plab-preview-bloom');
  expect(responseMotion.duration).toBeGreaterThanOrEqual(.15);
  expect(responseMotion.duration).toBeLessThanOrEqual(.25);
  expect(responseMotion.timing).toContain('cubic-bezier');

  const sculptAcknowledgment = page.getByTestId('pattern-lab-step-sculpt').getByTestId('pattern-lab-step-ack');
  await expect(sculptAcknowledgment).toHaveAttribute('data-response-sequence', /\d+/);
  expect(await sculptAcknowledgment.evaluate(element => getComputedStyle(element).animationName))
    .toContain('plab-local-ack');
});

test('reveals Long Evolution controls with transform and opacity, then removes motion when requested', async ({ page }) => {
  await choosePattern(page, 'aurora');
  const evolutionFields = page.getByTestId('pattern-lab-evolution-fields');
  const evolutionToggle = page.getByRole('checkbox', { name: /Long Evolution/ });

  await expect(evolutionFields).toHaveAttribute('data-enabled', 'false');
  const disabledMotion = await evolutionFields.evaluate(element => {
    const styles = getComputedStyle(element);
    return {
      transform: styles.transform,
      transitionProperty: styles.transitionProperty,
      transitionDuration: styles.transitionDuration,
    };
  });
  expect(disabledMotion.transform).not.toBe('none');
  expect(disabledMotion.transitionProperty).toContain('opacity');
  expect(disabledMotion.transitionProperty).toContain('transform');
  expect(disabledMotion.transitionDuration).toContain('0.2');

  await evolutionToggle.check();
  await expect(evolutionFields).toHaveAttribute('data-enabled', 'true');
  await expect(evolutionFields).toHaveAttribute('aria-disabled', 'false');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await choosePattern(page, 'aurora');
  const reducedFields = page.getByTestId('pattern-lab-evolution-fields');
  const reducedResponse = page.getByTestId('pattern-lab-preview-response');
  const reducedStyles = await reducedFields.evaluate(element => {
    const styles = getComputedStyle(element);
    return {
      transform: styles.transform,
      transitionDuration: styles.transitionDuration,
    };
  });
  expect(reducedStyles.transform).toBe('none');
  expect(reducedStyles.transitionDuration.split(',').every(value => value.trim() === '0s')).toBe(true);
  expect(await reducedResponse.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('checkbox', { name: /Long Evolution/ }).check();
  await expect(reducedFields).toHaveAttribute('data-enabled', 'true');
  expect(await reducedFields.evaluate(element => getComputedStyle(element).transform)).toBe('none');
});

test('creates, compares, and reopens a long private pattern without changing the project', async ({ page }) => {
  const projectBefore = await projectBytes(page);

  await expect(page.getByText('No source selected')).toBeVisible();
  await choosePattern(page, 'aurora');
  await expect(page.getByTestId('pattern-lab-mapped-preview').locator('canvas')).toBeVisible();
  await expect(page.getByText('Mapped to current artwork')).toBeVisible();

  // Pattern Lab opens already playing (patternlab-rebuild.md Phase 1), and
  // Beginning/Middle/End only set the preview clock -- they don't touch
  // playback. Pause first so the exact-value reads below aren't racing a
  // clock that's still ticking.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  await page.getByRole('slider', { name: 'Color', exact: true }).fill('72');
  await expect(page.getByLabel('Color value', { exact: true })).toHaveText('72%');

  await page.getByRole('checkbox', { name: /Long Evolution/ }).check();
  await page.getByLabel('Evolution character').selectOption('tidal');
  await page.getByLabel('Duration (minutes)').fill('10');
  await page.getByLabel('Change amount').fill('48');

  await page.getByRole('button', { name: 'Beginning', exact: true }).click();
  await expect(page.getByLabel('Preview time')).toHaveValue('0');
  await page.getByRole('button', { name: 'Middle', exact: true }).click();
  await expect(page.getByLabel('Preview time')).toHaveValue('300');
  await expect(page.getByTestId('pattern-lab-time')).toHaveText('5:00 / 10:00');
  await page.getByRole('button', { name: 'End', exact: true }).click();
  await expect(page.getByLabel('Preview time')).toHaveValue('600');

  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect(page.getByTestId('pattern-lab-save-status')).toContainText('Saved privately');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Open Aurora/ }).click();
  await expect(page.getByLabel('Evolution character')).toHaveValue('tidal');
  await expect(page.getByLabel('Duration (minutes)')).toHaveValue('10');
  await expect(page.getByRole('slider', { name: 'Color', exact: true })).toHaveValue('72');

  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).toBe(projectBefore);
  expect(cardMutationRequests).toEqual([]);
});

test('derives offline audio lanes locally and marks the recipe as bake-only', async ({ page }) => {
  await choosePattern(page, 'aurora');
  await page.getByText('Offline audio lanes').click();
  await page.getByLabel('WAV audio file').setInputFiles({
    name: 'private-song.wav',
    mimeType: 'audio/wav',
    buffer: wavBuffer(),
  });

  await expect(page.locator('[data-audio-state="ready"]')).toContainText('audio file not stored');
  const tools = page.getByTestId('pattern-lab-runtime-tools');
  await page.getByText('Card compatibility & diagnostics').click();
  await expect(tools.getByRole('listitem').filter({ hasText: 'Bake to card' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('pattern-lab-export')).toContainText('Offline audio lanes included · Bake only');

  const recipeDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recipe' }).click();
  const recipePath = await (await recipeDownload).path();
  const recipe = JSON.parse(await readFile(recipePath!, 'utf8'));
  expect(recipe.offlineAudio.version).toBe(1);
  expect(recipe.offlineAudio.audioFingerprint.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(recipe.requirements).toContainEqual(expect.objectContaining({
    capability: 'offline-analysis',
    delivery: 'bake-only',
    audioSha256: recipe.offlineAudio.audioFingerprint.sha256,
  }));
  expect(JSON.stringify(recipe)).not.toContain('private-song.wav');

  await page.getByRole('button', { name: 'Remove audio lanes' }).click();
  const cleanedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recipe' }).click();
  const cleanedPath = await (await cleanedDownload).path();
  const cleaned = JSON.parse(await readFile(cleanedPath!, 'utf8'));
  expect(cleaned.offlineAudio).toBeUndefined();
  expect(cleaned.requirements).not.toContainEqual(expect.objectContaining({ capability: 'offline-analysis' }));
});

// The 6-swatch palette editor and "Rotate palette" button were deleted in
// this rebuild — they only reached 2 of 130 patterns (see
// todo/plans/patternlab-rebuild.md §4). The surviving Color slider covers
// palette warmth/travel for every pattern; there is no remaining per-swatch
// UI to test.

test('Play advances one bounded journey clock and Pause preserves it', async ({ page }) => {
  await choosePattern(page, 'aurora');
  await page.getByRole('checkbox', { name: /Long Evolution/ }).check();
  await page.getByLabel('Duration (minutes)').fill('5');
  await page.getByRole('button', { name: 'Middle', exact: true }).click();
  const before = Number(await page.getByLabel('Preview time').inputValue());
  const canvasBefore = await page.getByTestId('pattern-lab-mapped-preview').locator('canvas').evaluate(canvas => canvas.toDataURL());

  // Pattern Lab opens already playing (patternlab-rebuild.md Phase 1) and
  // nothing above paused it, so the clock is already advancing -- no Play
  // click needed to prove it.
  await expect.poll(async () => Number(await page.getByLabel('Preview time').inputValue())).toBeGreaterThan(before + 0.2);
  await expect(page.getByTestId('pattern-lab-time')).not.toHaveText('2:30 / 5:00');
  const canvasAfter = await page.getByTestId('pattern-lab-mapped-preview').locator('canvas').evaluate(canvas => canvas.toDataURL());
  expect(canvasAfter).not.toBe(canvasBefore);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = Number(await page.getByLabel('Preview time').inputValue());
  await page.waitForTimeout(350);
  expect(Number(await page.getByLabel('Preview time').inputValue())).toBeCloseTo(paused, 3);

  await page.getByRole('button', { name: 'End', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Preview time').inputValue())).toBeLessThan(5);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});

// Regression guard for patternlab-rebuild.md Phase 1's headline requirement:
// "The screen opens already playing... The preview never pauses itself."
// Picking a pattern must never leave the owner staring at a still image --
// it has to be moving the instant there is something to show, with zero
// clicks. This asserts on the playing STATE (button label + aria-pressed)
// and on the preview clock advancing on its own, not on canvas pixels,
// because requestAnimationFrame does not tick in a backgrounded harness tab
// (see tests/pattern-lab-authoring.spec.ts canvas assertions above for the
// pixel-level check, which runs in a foregrounded/focused test page).
test('choosing a pattern starts the preview playing with no user interaction', async ({ page }) => {
  const playButton = page.getByRole('button', { name: 'Pause', exact: true });
  await choosePattern(page, 'aurora');

  // No click of any kind happened between choosePattern and this assertion.
  await expect(playButton).toBeVisible();
  await expect(playButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);

  const time = page.getByLabel('Preview time');
  const before = Number(await time.inputValue());
  await expect.poll(async () => Number(await time.inputValue())).toBeGreaterThan(before);
});

test('selected recipe owns strips that entered the Lab with inherited pattern overrides', async ({ page }) => {
  await projectBytes(page);
  await page.evaluate(key => {
    const project = JSON.parse(localStorage.getItem(key)!);
    project.layout.strips = project.layout.strips.map(strip => ({ ...strip, patternId: 'fire' }));
    localStorage.setItem(key, JSON.stringify(project));
  }, AUTOSAVE_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });

  const signature = async () => {
    await page.waitForTimeout(650);
    return page.getByTestId('pattern-lab-mapped-preview').locator('canvas').evaluate(canvas => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (let index = 0; index < data.length; index += 97) hash = Math.imul(hash ^ data[index], 16777619);
      return hash >>> 0;
    });
  };

  await choosePattern(page, 'fire');
  const fireSignature = await signature();
  await choosePattern(page, 'gradient');
  const gradientSignature = await signature();
  expect(gradientSignature).not.toBe(fireSignature);
});

test('exports canonical recipes and rejects invalid imports without mutating the draft', async ({ page }) => {
  await choosePattern(page, 'aurora');
  await page.getByRole('slider', { name: 'Color', exact: true }).fill('64');
  const nameBefore = await page.getByTestId('pattern-lab-draft-name').textContent();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recipe' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.lwrecipe\.json$/);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadedPath!, 'utf8'));
  expect(exported.version).toBe(2);
  expect(exported.base.patternId).toBe('aurora');
  expect(exported.macros.color).toBe(0.64);

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'broken.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 99, id: 'bad', name: 'Wrong recipe' })),
  });
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Could not import recipe');
  expect(await alert.locator('li').count()).toBeLessThanOrEqual(4);
  await expect(alert).toContainText('$.version');
  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText(nameBefore || 'Aurora');
  await expect(page.getByRole('slider', { name: 'Color', exact: true })).toHaveValue('64');

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'invalid-fields.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      ...exported,
      base: { ...exported.base, patternId: 'not-a-built-in' },
      evolution: { ...exported.evolution, character: 'unknown-character' },
      layers: Array.from({ length: 4 }, (_, index) => ({ id: `layer-${index}` })),
      targets: Array.from({ length: 80 }, (_, index) => ({ id: `target-${index}` })),
    })),
  });
  await expect(alert.locator('li')).toHaveCount(4);
  await expect(alert).toContainText('$.base.patternId');
  await expect(alert).toContainText('$.evolution.character');
  await expect(alert).toContainText('$.layers');
  await expect(alert).toContainText('$.targets');
  await expect(page.getByRole('slider', { name: 'Color', exact: true })).toHaveValue('64');

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'null-layer.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...exported, layers: [null] })),
  });
  await expect(alert.locator('li')).toHaveCount(1);
  await expect(alert).toContainText('$.layers[0]');
  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText(nameBefore || 'Aurora');
  await expect(page.getByRole('slider', { name: 'Color', exact: true })).toHaveValue('64');

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'malformed-layer.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      ...exported,
      layers: [{ id: '', name: 42, blendMode: 'overlay', opacity: 2 }],
    })),
  });
  await expect(alert.locator('li')).toHaveCount(4);
  await expect(alert).toContainText('$.layers[0].id');
  await expect(alert).toContainText('$.layers[0].name');
  await expect(alert).toContainText('$.layers[0].blendMode');
  await expect(alert).toContainText('$.layers[0].opacity');
  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText(nameBefore || 'Aurora');
  await expect(page.getByRole('slider', { name: 'Color', exact: true })).toHaveValue('64');

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'too-large.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(300 * 1024, 32),
  });
  await expect(alert).toContainText('file: must be smaller');
  await expect(alert.locator('li')).toHaveCount(1);
  await expect(page.getByRole('slider', { name: 'Color', exact: true })).toHaveValue('64');
});

test('uses an accessible lower controls drawer on a phone while keeping preview first', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const trigger = page.getByRole('button', { name: 'Pattern controls', exact: true });
  const preview = page.locator('.plab-preview');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(preview).toHaveAttribute('inert', '');
  await choosePattern(page, 'aurora');
  await page.getByRole('button', { name: 'Close pattern controls' }).click();

  const previewBox = await page.getByTestId('pattern-lab-mapped-preview').boundingBox();
  expect(previewBox).not.toBeNull();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Pattern Lab controls')).toHaveAttribute('aria-hidden', 'true');
  await expect(preview).not.toHaveAttribute('inert', '');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Pattern Lab controls')).not.toHaveAttribute('aria-hidden', 'true');
  await expect(page.getByLabel('Pattern Lab controls')).toHaveAttribute('role', 'dialog');

  const backdropBox = await page.getByRole('button', { name: 'Dismiss pattern controls' }).boundingBox();
  expect(backdropBox).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  const drawerBox = await page.getByLabel('Pattern Lab controls').boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox?.x).toBe(0);
  expect(drawerBox?.width).toBe(390);
  expect(Math.round((drawerBox?.y || 0) + (drawerBox?.height || 0))).toBe(844);

  const saveHeight = await page.getByRole('button', { name: 'Save private draft' }).evaluate(element => {
    return Number.parseFloat(getComputedStyle(element).height);
  });
  expect(saveHeight).toBeGreaterThanOrEqual(44);
  await page.getByRole('button', { name: 'Close pattern controls' }).click();
  // Pattern Lab opens already playing (patternlab-rebuild.md Phase 1) and
  // choosePattern above never paused it, so the button reads "Pause" here --
  // this assertion is about the touch-target height, not playback state.
  const playHeight = await page.getByRole('button', { name: 'Pause', exact: true }).evaluate(element => {
    return Number.parseFloat(getComputedStyle(element).height);
  });
  expect(playHeight).toBeGreaterThanOrEqual(44);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('keeps all four controls reachable with 44px slider hit areas in the phone drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Pattern controls', exact: true }).click();
  await choosePattern(page, 'aurora');

  const controls = page.locator('.plab-macros input[type="range"]');
  await expect(controls).toHaveCount(4);
  for (const label of ['Color', 'Movement', 'Brightness', 'Speed']) {
    const control = page.getByRole('slider', { name: label, exact: true });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
});

// PatternLabVariants.jsx (the seed/variations panel this test drove — the
// four variation thumbnails, "New variation", "Select variation N", the
// pattern-lab-seed readout, and "Lock seed choices") was deleted wholesale
// in this rebuild (see todo/plans/patternlab-rebuild.md §7 Phase 1). There
// is no replacement seed-picking UI; a recipe's seed is now fixed at
// creation. The Play/Pause/Beginning/End journey-clock coverage this test
// also carried is preserved by 'Play advances one bounded journey clock and
// Pause preserves it' above.

test('shows storage read and write failures without claiming a private save', async ({ page }) => {
  await page.addInitScript(() => {
    const originalGet = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (String(key).startsWith('lw_pattern_lab_drafts')) throw new DOMException('Private reads blocked', 'SecurityError');
      return originalGet.call(this, key);
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/Private draft storage.*unavailable/i)).toBeVisible();
});

test('does not announce success when a private draft write fails', async ({ page }) => {
  await page.addInitScript(() => {
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith('lw_pattern_lab_drafts')) throw new DOMException('Private write blocked', 'QuotaExceededError');
      return originalSet.call(this, key, value);
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await choosePattern(page, 'aurora');
  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect(page.getByTestId('pattern-lab-save-status')).toContainText('Private write blocked');
  await expect(page.getByTestId('pattern-lab-save-status')).not.toContainText('Saved privately');
});

// This test covered two things this rebuild deleted outright: the
// "Advanced controls" macro readout (a disabled placeholder shown before a
// pattern was chosen) and PatternLabLayers.jsx (the optional-layers panel,
// pattern-lab-layers testid). Neither exists any more — there is no
// replacement disabled-state or layers affordance to assert on.

test('PatternPreview exposes a controlled renderer clock without a per-pixel wrapper', () => {
  expect(PREVIEW_SOURCE).toContain('controlledTime = null');
  expect(PREVIEW_SOURCE).toContain('renderTime');
  expect(LAB_PREVIEW_SOURCE).not.toContain('return (...args)');
  expect(LAB_PREVIEW_SOURCE).not.toContain('const shifted = [...args]');
});
