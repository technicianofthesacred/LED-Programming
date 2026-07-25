import { test, expect, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
  await expect(choose.getByLabel('Base pattern')).toBeVisible();
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

test('shows six direct controls in exact order with no Energy', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');

  const labels = await page.locator('.plab-macros input[type="range"]')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  expect(labels).toEqual(['Color', 'Brightness', 'Movement', 'Speed', 'Shape', 'Texture']);
  await expect(page.getByLabel('Energy', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Energy', { exact: true })).toHaveCount(0);
});

test('exports Brightness and Speed as independent playback controls', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByRole('slider', { name: 'Movement', exact: true }).fill('88');
  await page.getByRole('slider', { name: 'Brightness', exact: true }).fill('25');
  await page.getByRole('slider', { name: 'Speed', exact: true }).fill('175');

  await expect(page.getByLabel('Brightness value')).toHaveText('25%');
  await expect(page.getByLabel('Speed value')).toHaveText('1.75×');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recipe' }).click();
  const downloadedPath = await (await downloadPromise).path();
  expect(downloadedPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadedPath!, 'utf8'));

  expect(exported.macros.movement).toBe(0.88);
  expect(exported.macros.energy).toBeUndefined();
  expect(exported.playback).toEqual({ brightness: 0.25, speed: 1.75 });
});

test('announces continuous Movement through its nearest semantic anchor', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  const movement = page.getByRole('slider', { name: 'Movement', exact: true });

  await movement.fill('0');
  await expect(movement).toHaveAttribute('aria-valuetext', 'Drift, 0%');
  await movement.fill('33');
  await expect(movement).toHaveAttribute('aria-valuetext', 'Flow, 33%');
  await movement.fill('67');
  await expect(movement).toHaveAttribute('aria-valuetext', 'Pulse, 67%');
  await movement.fill('100');
  await expect(movement).toHaveAttribute('aria-valuetext', 'Surge, 100%');
  await movement.fill('42');
  await expect(movement).toHaveAttribute('aria-valuetext', 'Flow, 42%');
  await expect(page.getByText('Drift 0% · Flow 33% · Pulse 67% · Surge 100%')).toBeVisible();
});

test('keeps the active Inspector band synchronized with direct focus and workflow actions', async ({ page }) => {
  const workflow = page.getByRole('navigation', { name: 'Pattern Lab workflow' });
  const choose = page.getByTestId('pattern-lab-step-choose');
  const sculpt = page.getByTestId('pattern-lab-step-sculpt');
  const evolve = page.getByTestId('pattern-lab-step-evolve');

  await expect(choose).toHaveAttribute('data-active', 'true');
  await expect(workflow.getByRole('button', { name: 'Choose' })).toHaveAttribute('aria-current', 'step');

  await page.getByLabel('Base pattern').selectOption('aurora');
  await expect(choose).toHaveAttribute('data-active', 'true');
  await expect(workflow.getByRole('button', { name: 'Choose' })).toHaveAttribute('aria-current', 'step');

  await page.getByRole('slider', { name: 'Color', exact: true }).focus();
  await expect(sculpt).toHaveAttribute('data-active', 'true');
  await expect(workflow.getByRole('button', { name: 'Sculpt' })).toHaveAttribute('aria-current', 'step');

  await workflow.getByRole('button', { name: 'Evolve' }).click();
  await expect(evolve).toHaveAttribute('data-active', 'true');
  await expect(workflow.getByRole('button', { name: 'Evolve' })).toHaveAttribute('aria-current', 'step');

  await page.getByLabel('Base pattern').focus();
  await expect(choose).toHaveAttribute('data-active', 'true');
  await expect(workflow.getByRole('button', { name: 'Choose' })).toHaveAttribute('aria-current', 'step');
});

test('gives pattern and control changes one bounded preview response with local acknowledgment', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');

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
  await page.getByLabel('Base pattern').selectOption('aurora');
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
  await page.getByLabel('Base pattern').selectOption('aurora');
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
  await page.getByLabel('Base pattern').selectOption('aurora');
  await expect(page.getByTestId('pattern-lab-mapped-preview').locator('canvas')).toBeVisible();
  await expect(page.getByText('Mapped to current artwork')).toBeVisible();

  await page.getByRole('slider', { name: 'Color', exact: true }).fill('72');
  await expect(page.getByLabel('Color value')).toHaveText('72%');
  await expect(page.getByText('Advanced controls')).not.toHaveAttribute('open', '');

  await page.getByRole('checkbox', { name: /Long Evolution/ }).check();
  await page.getByLabel('Evolution character').selectOption('tidal');
  await page.getByLabel('Duration (minutes)').fill('10');
  await page.getByLabel('Change amount').fill('48');

  await page.getByRole('button', { name: 'Beginning' }).click();
  await expect(page.getByLabel('Preview time')).toHaveValue('0');
  await page.getByRole('button', { name: 'Middle' }).click();
  await expect(page.getByLabel('Preview time')).toHaveValue('300');
  await expect(page.getByTestId('pattern-lab-time')).toHaveText('5:00 / 10:00');
  await page.getByRole('button', { name: 'End' }).click();
  await expect(page.getByLabel('Preview time')).toHaveValue('600');

  const seedBefore = await page.getByTestId('pattern-lab-seed').textContent();
  await page.getByRole('button', { name: 'Variation 3' }).click();
  await expect(page.getByTestId('pattern-lab-seed')).not.toHaveText(seedBefore || '');

  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Source', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Draft', exact: true })).toHaveAttribute('aria-pressed', 'true');

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
  await page.getByLabel('Base pattern').selectOption('aurora');
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

test('edits and rotates the palette with simple color controls', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('gradient');
  const tools = page.getByTestId('pattern-lab-runtime-tools');
  const originalSource = JSON.parse(await tools.getAttribute('data-source-recipe-snapshot') || 'null');
  const first = page.getByLabel('Palette color 1');
  await first.fill('#ff0000');
  await expect(first).toHaveValue('#ff0000');
  const secondBefore = await page.getByLabel('Palette color 2').inputValue();
  await page.getByRole('button', { name: 'Rotate palette' }).click();
  await expect(page.getByLabel('Palette color 1')).not.toHaveValue('#ff0000');
  await expect(page.getByLabel('Palette color 1')).toHaveValue(secondBefore);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recipe' }).click();
  const exportedPath = await (await pending).path();
  const exported = JSON.parse(await readFile(exportedPath!, 'utf8'));
  expect(exported.palette.at(-1)).toBe('#ff0000');

  await page.getByRole('button', { name: 'Save private draft' }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Open Gradient/ }).click();
  const reopenedSource = JSON.parse(await tools.getAttribute('data-source-recipe-snapshot') || 'null');
  expect(reopenedSource.palette).toEqual(originalSource.palette);
  expect(reopenedSource.palette).not.toEqual(exported.palette);
});

test('Play advances one bounded journey clock and Pause preserves it', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByRole('checkbox', { name: /Long Evolution/ }).check();
  await page.getByLabel('Duration (minutes)').fill('5');
  await page.getByRole('button', { name: 'Middle' }).click();
  const before = Number(await page.getByLabel('Preview time').inputValue());
  const canvasBefore = await page.getByTestId('pattern-lab-mapped-preview').locator('canvas').evaluate(canvas => canvas.toDataURL());

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Preview time').inputValue())).toBeGreaterThan(before + 0.2);
  await expect(page.getByTestId('pattern-lab-time')).not.toHaveText('2:30 / 5:00');
  const canvasAfter = await page.getByTestId('pattern-lab-mapped-preview').locator('canvas').evaluate(canvas => canvas.toDataURL());
  expect(canvasAfter).not.toBe(canvasBefore);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = Number(await page.getByLabel('Preview time').inputValue());
  await page.waitForTimeout(350);
  expect(Number(await page.getByLabel('Preview time').inputValue())).toBeCloseTo(paused, 3);

  await page.getByRole('button', { name: 'End' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Preview time').inputValue())).toBeLessThan(5);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
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

  await page.getByLabel('Base pattern').selectOption('fire');
  const fireSignature = await signature();
  await page.getByLabel('Base pattern').selectOption('gradient');
  const gradientSignature = await signature();
  expect(gradientSignature).not.toBe(fireSignature);
});

test('exports canonical recipes and rejects invalid imports without mutating the draft', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByRole('slider', { name: 'Movement', exact: true }).fill('64');
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
  expect(exported.macros.movement).toBe(0.64);

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
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');

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
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'null-layer.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...exported, layers: [null] })),
  });
  await expect(alert.locator('li')).toHaveCount(1);
  await expect(alert).toContainText('$.layers[0]');
  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText(nameBefore || 'Aurora');
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');

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
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');

  await page.getByLabel('Import recipe').setInputFiles({
    name: 'too-large.lwrecipe.json',
    mimeType: 'application/json',
    buffer: Buffer.alloc(300 * 1024, 32),
  });
  await expect(alert).toContainText('file: must be smaller');
  await expect(alert.locator('li')).toHaveCount(1);
  await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('64');
});

test('uses an accessible lower controls drawer on a phone while keeping preview first', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const trigger = page.getByRole('button', { name: 'Pattern controls', exact: true });
  const preview = page.locator('.plab-preview');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(preview).toHaveAttribute('inert', '');
  await page.getByLabel('Base pattern').selectOption('aurora');
  await expect(page.getByTestId('pattern-lab-variation-preview')).toHaveCount(4);
  await page.getByRole('button', { name: 'Close pattern controls' }).click();

  const previewBox = await page.getByTestId('pattern-lab-mapped-preview').boundingBox();
  expect(previewBox).not.toBeNull();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Pattern Lab controls')).toHaveAttribute('aria-hidden', 'true');
  await expect(preview).not.toHaveAttribute('inert', '');
  await expect(page.getByTestId('pattern-lab-variation-preview')).toHaveCount(0);
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
  const playHeight = await page.getByRole('button', { name: 'Play', exact: true }).evaluate(element => {
    return Number.parseFloat(getComputedStyle(element).height);
  });
  expect(playHeight).toBeGreaterThanOrEqual(44);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Advanced controls')).not.toHaveAttribute('open', '');
});

test('keeps all six controls reachable with 44px slider hit areas in the phone drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Pattern controls', exact: true }).click();
  await page.getByLabel('Base pattern').selectOption('aurora');

  const controls = page.locator('.plab-macros input[type="range"]');
  await expect(controls).toHaveCount(6);
  for (const label of ['Color', 'Brightness', 'Movement', 'Speed', 'Shape', 'Texture']) {
    const control = page.getByRole('slider', { name: label, exact: true });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeVisible();
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  const movement = page.getByRole('slider', { name: 'Movement', exact: true });
  await movement.focus();
  await page.keyboard.press('Home');
  await expect(movement).toHaveAttribute('aria-valuetext', 'Drift, 0%');
  await page.keyboard.press('End');
  await expect(movement).toHaveAttribute('aria-valuetext', 'Surge, 100%');
});

test('seed selection explicitly enables and persists the real Long Evolution workflow', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  const variants = page.getByTestId('pattern-lab-variants');
  const evolutionToggle = page.getByRole('checkbox', { name: /Long Evolution/ });
  await expect(variants.getByTestId('pattern-lab-variation-preview')).toHaveCount(4);
  await expect(variants.locator('canvas')).toHaveCount(4);
  await expect(variants).toContainText('journey midpoint');
  await expect(evolutionToggle).not.toBeChecked();
  const mainCanvas = page.getByTestId('pattern-lab-mapped-preview').locator('canvas');
  await page.waitForTimeout(350);
  await expect.poll(async () => {
    const signatures = await variants.locator('canvas').evaluateAll(canvases => canvases.map(canvas => canvas.toDataURL()));
    return new Set(signatures).size;
  }).toBe(4);
  const seedBefore = await page.getByTestId('pattern-lab-seed').textContent();
  const optionsBefore = await variants.locator('[data-seed]').evaluateAll(elements => elements.map(element => element.getAttribute('data-seed')));

  await page.getByRole('button', { name: 'New variation' }).click();
  const optionsAfter = await variants.locator('[data-seed]').evaluateAll(elements => elements.map(element => element.getAttribute('data-seed')));
  expect(optionsAfter).not.toEqual(optionsBefore);
  await expect(page.getByTestId('pattern-lab-seed')).toHaveText(seedBefore || '1');

  await page.getByRole('button', { name: 'Select variation 2' }).click();
  await expect(page.getByTestId('pattern-lab-seed')).not.toHaveText(seedBefore || '1');
  const selectedSeed = await page.getByTestId('pattern-lab-seed').textContent();
  await expect(evolutionToggle).toBeChecked();
  await expect(page.getByRole('button', { name: 'Export recipe' })).toBeEnabled();

  await page.getByRole('button', { name: 'Beginning' }).click();
  await page.waitForTimeout(350);
  const beginningFrame = await mainCanvas.evaluate(canvas => canvas.toDataURL());
  await page.getByRole('button', { name: 'End' }).click();
  await expect.poll(() => mainCanvas.evaluate(canvas => canvas.toDataURL())).not.toBe(beginningFrame);

  await page.getByRole('button', { name: 'Beginning' }).click();
  await page.waitForTimeout(350);
  const beforePlay = await mainCanvas.evaluate(canvas => canvas.toDataURL());
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('Preview time').inputValue())).toBeGreaterThan(0.2);
  await expect.poll(() => mainCanvas.evaluate(canvas => canvas.toDataURL())).not.toBe(beforePlay);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recipe' }).click();
  const download = await downloadPromise;
  const exportedPath = await download.path();
  expect(exportedPath).not.toBeNull();
  const exported = JSON.parse(await readFile(exportedPath!, 'utf8'));
  expect(exported.evolution.enabled).toBe(true);
  expect(exported.seed).toBe(Number(selectedSeed));

  await page.getByRole('button', { name: 'Save private draft' }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Open Aurora/ }).click();
  await expect(page.getByRole('checkbox', { name: /Long Evolution/ })).toBeChecked();
  await expect(page.getByTestId('pattern-lab-seed')).toHaveText(selectedSeed || '');
  await page.getByRole('checkbox', { name: 'Lock seed choices' }).check();
  await expect(page.getByRole('button', { name: 'New variation' })).toBeDisabled();
});

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
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect(page.getByTestId('pattern-lab-save-status')).toContainText('Private write blocked');
  await expect(page.getByTestId('pattern-lab-save-status')).not.toContainText('Saved privately');
});

test('Advanced and optional Layers are collapsed safely', async ({ page }) => {
  await expect(page.locator('details.plab-advanced')).toHaveCount(0);
  const inertAdvanced = page.getByText('Advanced controls');
  await expect(inertAdvanced).toHaveAttribute('aria-disabled', 'true');

  await page.getByLabel('Base pattern').selectOption('aurora');
  const advanced = page.locator('details.plab-advanced').filter({ hasText: 'Advanced controls' });
  await expect(advanced).not.toHaveAttribute('open', '');
  expect(await advanced.locator('summary').evaluate(element => Number.parseFloat(getComputedStyle(element).height))).toBeGreaterThanOrEqual(44);
  const layers = page.getByTestId('pattern-lab-layers');
  await expect(layers).toBeVisible();
  await expect(layers).not.toHaveAttribute('open', '');
});

test('PatternPreview exposes a controlled renderer clock without a per-pixel wrapper', () => {
  expect(PREVIEW_SOURCE).toContain('controlledTime = null');
  expect(PREVIEW_SOURCE).toContain('renderTime');
  expect(LAB_PREVIEW_SOURCE).not.toContain('return (...args)');
  expect(LAB_PREVIEW_SOURCE).not.toContain('const shifted = [...args]');
});
