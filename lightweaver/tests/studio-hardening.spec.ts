import { test, expect } from '@playwright/test';
import { createDefaultProject, migrateProject } from '../src/lib/projectModel.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';

const DEFAULT_PROJECT = migrateProject(createDefaultProject());
const DEFAULT_RUNTIME = buildCardRuntimePackageFromProject({
  projectId: DEFAULT_PROJECT.id,
  projectName: DEFAULT_PROJECT.name,
  strips: DEFAULT_PROJECT.layout.strips,
  patchBoard: DEFAULT_PROJECT.layout.patchBoard,
  standaloneController: DEFAULT_PROJECT.devices.standaloneController,
}).config;

async function mockConnectedCard(page: any, cardId = 'lw-studio-hardening') {
  await page.route('**/api/firmware-info', route => route.fulfill({
    json: { cardId, firmwareVersion: '1.0.0', outputs: DEFAULT_RUNTIME.led.outputs },
  }));
  await page.route('**/api/status', route => route.fulfill({
    json: { ok: true, cardId, firmwareVersion: '1.0.0', led: { pixels: DEFAULT_RUNTIME.led.pixels } },
  }));
  await page.route('**/api/zones', route => route.fulfill({
    json: { ok: true, zones: DEFAULT_RUNTIME.zones },
  }));
  await page.route('**/api/config', route => route.fulfill({
    json: { ok: true, requiresReboot: false },
  }));
  await page.route('**/api/control', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ json: { ok: true, cardId, patternId: body.patternId, revision: body.revision } });
  });
  await page.evaluate((id) => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id }));
  }, cardId);
  await page.reload({ waitUntil: 'domcontentloaded' });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
});

test('pattern cards are native selected buttons and load in exact batches of 24', async ({ page }) => {
  const cards = page.locator('.pm-cards .pmcard');
  await expect(cards).toHaveCount(24);
  await expect(cards.first()).toHaveJSProperty('tagName', 'BUTTON');
  await expect(cards.first().locator('button, [role="button"], a, input, select, textarea')).toHaveCount(0);
  await cards.nth(1).click();
  await expect(cards.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('patterns-show-more').click();
  await expect(cards).toHaveCount(48);
});

test('search uses the full catalog, resets the batch, and the 600px sentinel loads 24 more', async ({ page }) => {
  const cards = page.locator('.pm-cards .pmcard');
  await page.getByPlaceholder('Search chip patterns').fill('ocean');
  await expect(page.locator('[data-pattern-id="ocean"]')).toBeVisible();
  await page.getByPlaceholder('Search chip patterns').fill('');
  await expect(cards).toHaveCount(24);
  await page.getByTestId('patterns-sentinel').scrollIntoViewIfNeeded();
  await expect(cards).toHaveCount(48);
});

test('pattern preview uses project LED geometry and active symmetry', async ({ page }) => {
  const preview = page.getByTestId('pattern-project-preview');
  await expect(preview).toHaveAttribute('data-preview-led-count', '44');
  await expect(preview).toHaveAttribute('data-preview-order', /default-(outer|inner)-circle/);
  await expect(preview).toHaveAttribute('data-preview-symmetry', 'none');
  await page.locator('.geo-seg').getByRole('button', { name: 'Mirror' }).click();
  await expect(preview).toHaveAttribute('data-preview-symmetry', 'mirror-hv');
});

test('pattern preview follows canonical reordered and reversed physical addresses', async ({ page }) => {
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_autosave_v3'))).not.toBeNull();
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}');
    const [outer, inner] = project.layout.strips;
    outer.pixels = outer.pixels.slice(0, 3); outer.pixelCount = 3;
    inner.pixels = inner.pixels.slice(0, 2); inner.pixelCount = 2;
    project.layout.wiring = {
      version: 1, locked: false, verified: false, controllerAnchor: null,
      outputs: [{ id: 'out1', name: 'Output 1', pin: 16, runIds: ['inner-reverse', 'inactive-gap', 'outer-reverse'] }],
      runs: [
        { id: 'inner-reverse', type: 'strip', source: { stripId: inner.id, from: 0, to: 1 }, directionPolicy: 'flexible', physicalDirection: 'source-reverse', seamLed: null, verified: false },
        { id: 'inactive-gap', type: 'inactive', count: 1, verified: false },
        { id: 'outer-reverse', type: 'strip', source: { stripId: outer.id, from: 0, to: 2 }, directionPolicy: 'flexible', physicalDirection: 'source-reverse', seamLed: null, verified: false },
      ], migrationWarnings: [],
    };
    localStorage.setItem('lw_autosave_v3', JSON.stringify(project));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const preview = page.getByTestId('pattern-project-preview');
  await expect(preview).toHaveAttribute('data-preview-led-count', '6');
  await expect(preview).toHaveAttribute('data-preview-order', 'default-inner-circle:1,default-inner-circle:0,inactive,default-outer-circle:2,default-outer-circle:1,default-outer-circle:0');
});

test('Settings installs the exact requested revision when an edit happens during the write', async ({ page }) => {
  await mockConnectedCard(page);
  await page.route('**/api/config', async route => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fulfill({ json: { ok: true, requiresReboot: false } });
  });
  await page.locator('.rail-item', { hasText: 'Settings' }).click();
  const name = page.locator('.set-row', { hasText: 'Project name' }).locator('input');
  await name.fill('Revision one');
  await expect(page.locator('.savechip')).toContainText('Unsaved changes');
  const save = page.locator('.set-row', { hasText: 'Write to card' }).getByRole('button').first();
  await save.click();
  await expect(save).toBeDisabled();
  await name.fill('Revision two');
  await expect(page.getByTestId('settings-card-status')).toContainText('Saved on card');
  await expect(page.locator('.savechip')).toContainText('Unsaved changes');
});

test('Pattern card write is pending, disables conflicts, and exposes retry after failure', async ({ page }) => {
  await mockConnectedCard(page);
  await page.route('**/api/config', async route => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fulfill({ status: 503, json: { ok: false } });
  });
  const save = page.getByTitle('Save the current look to the card');
  await save.click();
  await expect(save).toBeDisabled();
  await expect(page.getByRole('button', { name: /Card tools/ })).toBeDisabled();
  await expect(save).toHaveText(/Retry save/);
  await expect(page.getByRole('alert')).toContainText(/could not|not on the lights/i);
});

test('Pattern confirms the exact draft revision installed on the card', async ({ page }) => {
  await mockConnectedCard(page);
  await page.route('**/api/config', route => route.fulfill({ json: { ok: true, requiresReboot: false } }));
  await page.getByPlaceholder('Search chip patterns').fill('ocean');
  await page.locator('[data-pattern-id="ocean"]').click();
  await expect(page.locator('.savechip')).toContainText('Unsaved changes');
  await page.getByTitle('Save the current look to the card').click();
  await expect(page.locator('.savechip')).toContainText('Installed on card');
});

test('Pattern acknowledgement does not install an unrelated edit made while pending', async ({ page }) => {
  await mockConnectedCard(page);
  await page.route('**/api/config', async route => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fulfill({ json: { ok: true, requiresReboot: false } });
  });
  await page.getByPlaceholder('Search chip patterns').fill('ocean');
  await page.locator('[data-pattern-id="ocean"]').click();
  const acknowledged = page.waitForResponse(response => response.url().endsWith('/api/config'));
  await page.getByTitle('Save the current look to the card').click();
  await page.evaluate(() => { window.location.hash = 'screen=settings'; });
  const name = page.locator('.set-row', { hasText: 'Project name' }).locator('input');
  await name.fill('Edited during card write');
  await acknowledged;
  await expect(page.locator('.savechip')).toContainText('Unsaved changes');
});

test('bench chase restores the last Studio-confirmed look after transport failure', async ({ page }) => {
  const controls: any[] = [];
  const cardId = 'lw-bench-hardening';
  await mockConnectedCard(page, cardId);
  await page.route('**/api/config', route => route.fulfill({ json: { ok: true, requiresReboot: false } }));
  await page.route('**/api/control', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    controls.push(body);
    await route.fulfill({ json: { ok: true, cardId, patternId: body.patternId, revision: body.revision } });
  });

  await page.getByPlaceholder('Search chip patterns').fill('ocean');
  await page.locator('[data-pattern-id="ocean"]').click();
  await page.getByTitle('Save the current look to the card').click();
  await expect(page.locator('.savechip')).toContainText('Installed on card');
  await expect.poll(() => controls.length).toBeGreaterThan(0);
  controls.length = 0;

  await page.evaluate(() => {
    class FailedSocket {
      static OPEN = 1;
      readyState = 0;
      bufferedAmount = 0;
      onopen = null;
      onclose = null;
      onerror = null;
      constructor() { setTimeout(() => { this.onerror?.(); this.onclose?.(); }, 0); }
      send() {}
      close() {}
    }
    window.WebSocket = FailedSocket as any;
    window.location.hash = 'screen=layout&mode=wire';
  });
  const bench = page.getByTestId('wiring-bench-test');
  await expect(bench).toBeVisible();
  await bench.getByRole('checkbox').check();
  await bench.getByRole('button', { name: 'Start wiring test' }).click();
  await expect(bench).toContainText(/Frame delivery failed/i);
  await expect.poll(() => controls.some(body => body.cancelStream === true && body.patternId === 'ocean')).toBe(true);
});

test('Playlist marks a row live only after the card acknowledges it', async ({ page }) => {
  const cardId = 'lw-playlist-hardening';
  await mockConnectedCard(page, cardId);
  await page.route('**/api/control', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ json: { ok: true, cardId, patternId: body.patternId, revision: body.revision } });
  });
  await page.locator('.rail-item', { hasText: 'Playlist' }).click();
  await page.locator('.pl-chip').first().click();
  const row = page.locator('.pl-row').first();
  await row.getByRole('button', { name: 'Live' }).click();
  await expect(row).not.toHaveClass(/is-live/);
  await expect(row).toHaveClass(/is-live/);
});

test('Show reports live only after the first frame acknowledgement', async ({ page }) => {
  await mockConnectedCard(page, 'lw-show-hardening');
  await page.addInitScript(() => {
    (window as any).__showFrames = [];
    class DelayedWebSocket {
      static OPEN = 1;
      readyState = 0;
      bufferedAmount = 0;
      onopen: null | (() => void) = null;
      onclose: null | (() => void) = null;
      constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 350); }
      send(payload: string) { (window as any).__showFrames.push(JSON.parse(payload)); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    window.WebSocket = DelayedWebSocket as any;
  });
  await page.goto('/?show-ack=1#screen=show', { waitUntil: 'domcontentloaded' });
  const play = page.getByRole('button', { name: 'Play on the lights' });
  await play.click();
  await expect(page.getByText(/LEDs ready/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__showFrames.length)).toBeGreaterThan(0);
  await expect(page.getByText(/playing on .* LEDs/)).toBeVisible();
});

test('Show delivery failure is visible and leaves playback retryable', async ({ page }) => {
  await page.addInitScript(() => {
    class FailedWebSocket {
      static OPEN = 1; readyState = 0; bufferedAmount = 0; onopen = null; onclose = null; onerror = null;
      constructor() { setTimeout(() => { this.onerror?.(); this.onclose?.(); }, 0); }
      send() {} close() {}
    }
    window.WebSocket = FailedWebSocket as any;
  });
  await page.goto('/?show-failure=1#screen=show', { waitUntil: 'domcontentloaded' });
  const play = page.getByRole('button', { name: 'Play on the lights' });
  await play.click();
  await expect(page.getByText(/lights aren't receiving|stopped receiving/i)).toBeVisible({ timeout: 6_000 });
  await expect(play).toBeEnabled();
});

test('lazy route shows its fallback while the screen module loads', async ({ page }) => {
  await page.route('**/src/v3/lw-show.jsx*', async route => {
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.continue();
  });
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.locator('.rail-item', { hasText: 'Show' }).click();
  await expect(page.locator('.route-loading')).toHaveText('Loading Studio screen…');
  await expect(page.getByTestId('show-stage')).toBeVisible();
});

test('initial Layout route excludes lazy Studio screen modules', async ({ page }) => {
  await page.goto('/?lazy-initial=1#screen=layout', { waitUntil: 'networkidle' });
  const initial = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
  for (const moduleName of ['lw-pattern.jsx', 'lw-show.jsx', 'lw-playlist.jsx', 'lw-settings.jsx', 'lw-flash.jsx', 'lw-installer.jsx']) {
    expect(initial.some(url => url.includes(moduleName))).toBe(false);
  }
  await page.locator('.rail-item', { hasText: 'Patterns' }).click();
  await expect(page.locator('.pm')).toBeVisible();
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('lw-pattern.jsx')))).toBe(true);
});

test('Studio stylesheet declares coarse targets and reduced motion', async ({ page }) => {
  const css = await page.evaluate(() => fetch('/src/v3/v3-styles.css').then(response => response.text()));
  expect(css).toContain('@media (pointer: coarse)');
  expect(css).toContain('min-height: 44px');
  expect(css).toContain('@media (prefers-reduced-motion: reduce)');
});

test('reduced motion disables status and preview animation names', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motion = await page.evaluate(() => {
    const stream = document.createElement('span');
    stream.className = 'sb-stream';
    const pulse = document.createElement('span');
    pulse.className = 'pulse';
    stream.appendChild(pulse);
    const wave = document.createElement('span');
    wave.className = 'led wave';
    const preview = document.createElement('span');
    preview.className = 'pm-led-stage';
    const sheen = document.createElement('span');
    sheen.className = 'sheen';
    preview.appendChild(sheen);
    document.body.appendChild(stream);
    document.body.appendChild(wave);
    document.body.appendChild(preview);
    const result = {
      pulse: getComputedStyle(pulse).animationName,
      wave: getComputedStyle(wave).animationName,
      sheen: getComputedStyle(sheen).animationName,
    };
    stream.remove();
    wave.remove();
    preview.remove();
    return result;
  });
  expect(motion).toEqual({ pulse: 'none', wave: 'none', sheen: 'none' });
});

test('installer signoff persists and exposes a ready state', async ({ page }) => {
  await page.locator('.rail-item', { hasText: 'Installer' }).click();
  const checks = page.locator('.inst-signoff input[type="checkbox"]');
  await expect(checks).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Reset bench signoff' })).toBeVisible();
  for (let index = 0; index < 6; index += 1) await checks.nth(index).check();
  await page.getByRole('button', { name: 'Mark ready' }).click();
  await expect(page.getByText('Ready to ship', { exact: true })).toBeVisible();
  await expect(page.getByTestId('installer-ready-summary')).toContainText(/firmware/i);
  await expect(page.getByTestId('installer-ready-summary')).toContainText(/project/i);
  await expect(page.getByTestId('installer-ready-summary')).toContainText(/card/i);
  await expect(page.getByTestId('installer-ready-summary')).toContainText(/physical/i);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.inst-signoff input[type="checkbox"]:checked')).toHaveCount(6);
  await expect(page.getByText('Ready to ship', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset bench signoff' }).click();
  await expect(page.locator('.inst-signoff input[type="checkbox"]:checked')).toHaveCount(0);
  await expect(page.getByText('Ready to ship', { exact: true })).toHaveCount(0);
});

test('Settings controls expose stable accessible names', async ({ page }) => {
  await page.locator('.rail-item', { hasText: 'Settings' }).click();
  await expect(page.getByRole('slider', { name: 'Master brightness' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gamma correction' })).toHaveAttribute('aria-pressed');
  await expect(page.getByRole('group', { name: 'Theme' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Remove palette color 1/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add palette color' })).toBeVisible();

  const unlabeledInputs = await page.locator('.set input, .set textarea').evaluateAll(elements => elements
    .filter(element => {
      const control = element as HTMLInputElement | HTMLTextAreaElement;
      return !control.getAttribute('aria-label') &&
        !control.getAttribute('aria-labelledby') &&
        !(control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`)) &&
        !control.closest('label');
    })
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`));
  expect(unlabeledInputs).toEqual([]);
});

test('Daylight is a complete supported theme', async ({ page }) => {
  await page.locator('.rail-item', { hasText: 'Settings' }).click();
  await page.getByRole('button', { name: 'Daylight', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
  const oklch = (value: string) => {
    const match = value.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
    if (!match) throw new Error(`Expected OKLCH token, received ${value}`);
    return { lightness: Number(match[1]), chroma: Number(match[2]), hue: Number(match[3]) };
  };
  const luminance = (value: string) => {
    const { lightness: l, chroma: c, hue } = oklch(value);
    const angle = hue * Math.PI / 180;
    const a = c * Math.cos(angle);
    const b = c * Math.sin(angle);
    const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
    const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
    const sPrime = l - 0.0894841775 * a - 1.291485548 * b;
    const ll = lPrime ** 3;
    const mm = mPrime ** 3;
    const ss = sPrime ** 3;
    const red = Math.max(0, Math.min(1, 4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss));
    const green = Math.max(0, Math.min(1, -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss));
    const blue = Math.max(0, Math.min(1, -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };

  for (const screen of ['Layout', 'Patterns', 'Show', 'Settings', 'Installer']) {
    await page.locator('.rail-item', { hasText: screen }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
    const tokens = await page.locator('.app').evaluate(node => {
      const style = getComputedStyle(node);
      return {
        app: style.getPropertyValue('--bg-app').trim(),
        canvas: style.getPropertyValue('--bg-canvas').trim(),
        panel: style.getPropertyValue('--bg-panel').trim(),
        text: style.getPropertyValue('--text-hi').trim(),
      };
    });
    for (const surface of [tokens.app, tokens.canvas, tokens.panel]) {
      expect(oklch(surface).hue, `${screen} ${surface}`).toBeGreaterThanOrEqual(55);
      expect(oklch(surface).hue, `${screen} ${surface}`).toBeLessThanOrEqual(90);
    }
    const light = luminance(tokens.text);
    const dark = luminance(tokens.panel);
    const contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
    expect(contrast, `${screen} text contrast`).toBeGreaterThanOrEqual(4.5);
  }
});

test('replacement guard names both projects and keeps editing until explicitly replaced', async ({ page }) => {
  await page.locator('.rail-item', { hasText: 'Settings' }).click();
  const projectName = page.locator('.set-row', { hasText: 'Project name' }).locator('input');
  await projectName.fill('Current Mandala');

  const incoming = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}'));
  incoming.name = 'Incoming Lotus';
  const projectFile = {
    name: 'incoming-lotus.lw.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(incoming)),
  };

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(projectFile);
  const dialog = page.getByRole('dialog', { name: 'Replace current project?' });
  await expect(dialog).toContainText('Current Mandala');
  await expect(dialog).toContainText('Incoming Lotus');
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(projectName).toHaveValue('Current Mandala');

  await fileInput.setInputFiles(projectFile);
  await expect(dialog.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(projectName).toHaveValue('Current Mandala');

  await fileInput.setInputFiles(projectFile);
  await dialog.getByRole('button', { name: 'Replace project' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(projectName).toHaveValue('Incoming Lotus');
});

test('flash erase requires a final confirmation before starting', async ({ page }) => {
  await page.locator('.rail-item', { hasText: 'Flash' }).click();
  await page.getByText('Technician diagnostics', { exact: true }).click();
  await page.getByRole('checkbox', { name: /Wipes the chip first/i }).check();
  await expect(page.getByText(/final confirmation/i)).toBeVisible();
});
