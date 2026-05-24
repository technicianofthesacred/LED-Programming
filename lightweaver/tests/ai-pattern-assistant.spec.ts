import { test, expect } from '@playwright/test';

function makeProject() {
  return {
    version: 3,
    name: 'AI assistant regression',
    layout: {
      strips: [
        {
          id: 'visible-strip',
          color: '#88aaff',
          pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
        },
        {
          id: 'hidden-strip',
          color: '#ff8844',
          pixels: [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
        },
      ],
      viewBox: '0 0 3 2',
      svgText: null,
      hidden: { 'hidden-strip': true },
      layers: [],
      density: 60,
      pxPerMm: 3.7795,
      editCounts: {},
      layerGroups: [],
      layerOrder: [],
    },
    pattern: {
      activePatternId: 'aurora',
      palette: ['#102a2b', '#57e7c1', '#7aa7ff'],
      masterSpeed: 1,
      masterBrightness: 1,
      masterSaturation: 1,
      masterHueShift: 0,
      gammaEnabled: false,
      gammaValue: 2.2,
      patternParams: {},
      bpm: 120,
      motionSmoothing: 'soft',
      symSettings: { enabled: false, type: 'none', count: 8, slices: 6, phase: 0, twist: 0, seam: 0.1 },
    },
    show: { clips: [], transitions: [], cues: [], autoLanes: [], duration: 600 },
    live: { quantize: 'beat', recording: false },
    devices: { wledIp: '', segmentMap: {} },
  };
}

function makeDraft(name = 'Soft Assistant Draft') {
  return {
    name,
    description: 'A gentle generated draft for regression testing.',
    changeSummary: ['Created a slower, smoother drift'],
    palette: ['#102a2b', '#57e7c1', '#7aa7ff'],
    code: 'return rgb(0.7, 0.4, 0.2);',
    suggestedParams: {},
    notes: '',
  };
}

function makeColorDraft(name: string, code: string) {
  return {
    name,
    description: `A generated ${name} test draft.`,
    changeSummary: ['Changed solid color'],
    palette: ['#000000', '#ffffff'],
    code,
    suggestedParams: {},
    notes: '',
  };
}

async function openPatternAssistant(page) {
  await page.addInitScript(project => {
    localStorage.clear();
    localStorage.setItem('lw_autosave_v3', JSON.stringify(project));
  }, makeProject());
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  const assistant = page.locator('.lw-ai-assistant');
  await assistant.locator('.lw-ai-toggle').click();
  await expect(assistant.locator('.lw-ai-body')).toBeVisible();
  return assistant;
}

async function getCanvasColorStats(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return { red: 0, green: 0, blue: 0, lit: 0 };
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    let green = 0;
    let blue = 0;
    let lit = 0;
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      if (Math.max(r, g, b) < 20) continue;
      red += r;
      green += g;
      blue += b;
      lit += 1;
    }
    return { red, green, blue, lit };
  });
}

async function waitForDominantCanvasColor(page, channel: 'red' | 'green') {
  const other = channel === 'red' ? 'green' : 'red';
  let stats = await getCanvasColorStats(page);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    stats = await getCanvasColorStats(page);
    if (stats.lit > 20 && stats[channel] > stats[other] * 1.6) return stats;
    await page.waitForTimeout(200);
  }
  expect(stats.lit).toBeGreaterThan(20);
  expect(stats[channel]).toBeGreaterThan(stats[other] * 1.6);
  return stats;
}

test('sends visible strip counts in AI project context', async ({ page }) => {
  let payload: any = null;
  await page.route('**/api/ai/pattern', async route => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ draft: makeDraft('Hidden Context Draft') }),
    });
  });

  const assistant = await openPatternAssistant(page);
  await assistant.locator('textarea').fill('make this slower and smoother');
  await assistant.getByRole('button', { name: 'Generate' }).click();

  await expect(assistant.getByText('Hidden Context Draft')).toBeVisible();
  expect(payload.projectContext).toMatchObject({
    ledCount: 2,
    stripCount: 1,
    hasMappedXY: true,
  });
});

test('lets the user save AI provider keys and choose the generation provider', async ({ page }) => {
  let payload: any = null;
  let settingsPayload: any = null;
  await page.route('**/api/ai/settings', async route => {
    if (route.request().method() === 'PUT') {
      settingsPayload = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provider: settingsPayload.provider,
          providers: [
            { id: 'openai', label: 'ChatGPT', detail: 'OpenAI', keyEnv: 'OPENAI_API_KEY', configured: false },
            { id: 'anthropic', label: 'Claude', detail: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY', configured: true },
            { id: 'openrouter', label: 'OpenRouter', detail: 'model router', keyEnv: 'OPENROUTER_API_KEY', configured: false },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'openai',
        providers: [
          { id: 'openai', label: 'ChatGPT', detail: 'OpenAI', keyEnv: 'OPENAI_API_KEY', configured: false },
          { id: 'anthropic', label: 'Claude', detail: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY', configured: false },
          { id: 'openrouter', label: 'OpenRouter', detail: 'model router', keyEnv: 'OPENROUTER_API_KEY', configured: false },
        ],
      }),
    });
  });
  await page.route('**/api/ai/pattern', async route => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ draft: makeDraft('Claude Routed Draft') }),
    });
  });

  const assistant = await openPatternAssistant(page);
  await expect(assistant.getByText('ChatGPT')).toBeVisible();
  await assistant.getByRole('button', { name: 'AI setup' }).click();
  await expect(assistant.getByRole('heading', { name: 'AI provider setup' })).toBeVisible();
  await assistant.getByLabel('Default AI provider').selectOption('anthropic');
  await assistant.getByLabel('Claude key').fill('anthropic-secret-test-key');
  await assistant.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(assistant.getByText('Saved. Claude is active.')).toBeVisible();
  await assistant.locator('textarea').fill('make this slower and smoother');
  await assistant.getByRole('button', { name: 'Generate' }).click();

  await expect(assistant.getByText('Claude Routed Draft')).toBeVisible();
  expect(settingsPayload.provider).toBe('anthropic');
  expect(settingsPayload.keys.anthropic).toBe('anthropic-secret-test-key');
  expect(payload.provider).toBe('anthropic');
});

test('clears the AI draft when the selected pattern changes', async ({ page }) => {
  await page.route('**/api/ai/pattern', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ draft: makeDraft('Pattern Switch Draft') }),
    });
  });

  const assistant = await openPatternAssistant(page);
  await assistant.locator('textarea').fill('make this warmer');
  await assistant.getByRole('button', { name: 'Generate' }).click();
  await expect(assistant.getByText('Pattern Switch Draft')).toBeVisible();

  await page.getByRole('button', { name: 'Browse' }).click();
  await page.getByTitle('Next pattern').click();

  await expect(assistant.getByText('Pattern Switch Draft')).toHaveCount(0);
  await expect(assistant.getByText(/Describe a new direction/)).toBeVisible();
});

test('generates an AI draft and accepts it as a custom pattern', async ({ page }) => {
  await page.route('**/api/ai/pattern', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        draft: {
          name: 'Aurora Glass Drift',
          description: 'A slower aurora with softened motion and gold center light.',
          changeSummary: ['Reduced speed', 'Softened contrast', 'Added warm center glow'],
          palette: ['#102a2b', '#57e7c1', '#9476ff', '#d6b56c'],
          code: '// @param speed float 0.06 0.01 0.4\nconst drift = fbm(x * 1.8 + t * params.speed, y * 1.2, 4);\nconst gold = smoothstep(0.42, 0.0, distance(x, y, 0.5, 0.5));\nreturn samplePalette(drift + gold * 0.12);',
          suggestedParams: { speed: 0.06 },
        },
      }),
    });
  });

  const assistant = await openPatternAssistant(page);
  await assistant.locator('textarea').fill('slower and smoother with gold near the center');
  await assistant.getByRole('button', { name: 'Generate' }).click();

  await expect(assistant.getByText('Aurora Glass Drift')).toBeVisible();
  await expect(assistant.getByText('Preview only', { exact: true })).toBeVisible();
  const acceptedNotice = page.evaluate(() => new Promise(resolve => {
    const text = 'Accepted Aurora Glass Drift.';
    const observer = new MutationObserver(() => {
      if (document.body.innerText.includes(text)) {
        observer.disconnect();
        resolve(true);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }));
  await assistant.getByRole('button', { name: 'Accept and use pattern' }).click();
  await expect(acceptedNotice).resolves.toBe(true);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_custom_patterns') || '[]'));
  expect(saved).toHaveLength(1);
  expect(saved[0].id).toBe('custom_aurora_glass_drift');
  expect(saved[0].palette).toEqual(['#102a2b', '#57e7c1', '#9476ff', '#d6b56c']);
});

test('shows setup message when server has no AI key', async ({ page }) => {
  await page.route('**/api/ai/pattern', async route => {
    await route.fulfill({
      status: 501,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'missing_api_key',
          message: 'Set OPENAI_API_KEY on the Lightweaver server to enable AI pattern creation.',
        },
      }),
    });
  });

  const assistant = await openPatternAssistant(page);
  await assistant.locator('textarea').fill('make a calm reef pattern');
  await assistant.getByRole('button', { name: 'Generate' }).click();

  await expect(assistant.locator('.lw-ai-error span')).toHaveText('Set OPENAI_API_KEY on the Lightweaver server to enable AI pattern creation.');
});

test('serves the AI pattern API from the Vite dev server', async ({ page }) => {
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async () => {
    const response = await fetch('/api/ai/pattern', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      body: await response.json().catch(() => null),
    };
  });

  expect(result.status).toBe(400);
  expect(result.contentType).toContain('application/json');
  expect(result.body?.error?.code).toBe('invalid_request');
});

test('labels the empty-project pattern fixture as concentric rings', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Symmetry' }).click();

  await expect(page.getByText('Inner Ring')).toBeVisible();
  await expect(page.getByText('Middle Ring')).toBeVisible();
  await expect(page.getByText('Outer Ring')).toBeVisible();
  await expect(page.getByText('Inner petals')).toHaveCount(0);
  await expect(page.getByText('Base + dia.')).toHaveCount(0);
});

test('explains symmetry as one active coordinate transform', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Symmetry' }).click();

  await expect(page.getByText('Coordinate flow')).toBeVisible();
  await expect(page.getByText('One active transform')).toBeVisible();
  await expect(page.getByText('Mirror H+V')).toBeVisible();
  await expect(page.getByText('Kaleidoscope')).toBeVisible();
  await expect(page.getByText('Fractal')).toHaveCount(0);

  await page.getByRole('button', { name: 'Radial' }).click();
  await expect(page.getByText('Fold angle into repeated wedges.')).toBeVisible();
  await expect(page.getByText('Wedges', { exact: true })).toBeVisible();
});

test('keeps the pattern panel scrollable when symmetry controls overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Symmetry' }).click();
  await page.getByRole('button', { name: 'Mirror H+V' }).click();

  const metrics = await page.evaluate(() => {
    const panel = document.querySelector('.lw-panel')!;
    const body = document.querySelector('.lw-panel-body')!;
    const panelRect = panel.getBoundingClientRect();
    return {
      panelBottom: panelRect.bottom,
      viewportHeight: window.innerHeight,
      bodyClient: body.clientHeight,
      bodyScroll: body.scrollHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
    };
  });

  expect(metrics.panelBottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.bodyOverflowY).toBe('auto');
  expect(metrics.bodyScroll).toBeGreaterThan(metrics.bodyClient);
});

test('presents graph mode as an actionable pattern builder', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Tune' }).click();

  await expect(page.getByText('Tune Pattern')).toBeVisible();
  await expect(page.getByText('Pattern journey')).toBeVisible();
  await expect(page.getByText('Duration')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Color' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Palette editor')).toBeVisible();
  await expect(page.getByText('Color journey')).toBeVisible();
  await expect(page.getByRole('button', { name: /Input signal/ })).toHaveCount(0);
  await expect(page.getByText('What this stage changes')).toHaveCount(0);
  await expect(page.getByText('Compiled from current pattern chain')).toHaveCount(0);

  const controlPosition = await page.locator('.lw-palette-editor').evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, viewportHeight: window.innerHeight };
  });
  expect(controlPosition.top).toBeLessThan(controlPosition.viewportHeight - 160);
});

test('replaces graph stage cards with real color, motion, and output controls', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Tune' }).click();

  await expect(page.getByText('Palette editor')).toBeVisible();
  await expect(page.getByLabel('Selected palette color')).toBeVisible();
  await expect(page.getByLabel('Selected palette hex')).toBeVisible();
  await expect(page.getByText('Color journey')).toBeVisible();
  await expect(page.getByText('Color influence')).toBeVisible();
  await expect(page.getByText('Steers journey colors without replacing the pattern underneath.')).toBeVisible();
  await expect(page.locator('.lw-master').getByText('Gamma')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Motion' }).click();
  await expect(page.getByText('Live speed')).toBeVisible();
  await expect(page.getByText('Motion journey')).toBeVisible();

  await page.getByRole('tab', { name: 'Output' }).click();
  await expect(page.getByText('Brightness', { exact: true })).toBeVisible();
  await expect(page.getByText('Saturation', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Symmetry' })).toBeVisible();

  await page.getByRole('tab', { name: 'Color' }).click();
  const firstSwatch = page.locator('.lw-palette-editor .lw-color-swatch').first();
  await expect(firstSwatch).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Selected palette color').fill('#ffcc00');
  await expect(page.getByLabel('Selected palette hex')).toHaveValue('#ffcc00');
});

test('lets color journey loop, grow, reorder, and accept palette drops', async ({ page }) => {
  await page.addInitScript(project => {
    localStorage.clear();
    localStorage.setItem('lw_autosave_v3', JSON.stringify(project));
  }, makeProject());
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Tune' }).click();

  await expect(page.getByText('Loops back to first')).toBeVisible();
  const journeyStops = page.locator('.lw-journey-stop');
  await expect(journeyStops).toHaveCount(3);

  await page.getByRole('button', { name: 'Add color stop' }).click();
  await expect(journeyStops).toHaveCount(4);

  const stopInputs = page.locator('.lw-journey-stop input[type="color"]');
  const beforeReorder = await stopInputs.evaluateAll(inputs =>
    inputs.map(input => (input as HTMLInputElement).value),
  );
  await journeyStops.nth(0).dragTo(journeyStops.nth(2));
  const afterReorder = await stopInputs.evaluateAll(inputs =>
    inputs.map(input => (input as HTMLInputElement).value),
  );
  expect(afterReorder[2]).toBe(beforeReorder[0]);

  await page.locator('.lw-palette-editor .lw-color-swatch').first().dragTo(journeyStops.first());
  await expect(stopInputs.first()).toHaveValue('#102a2b');
});

test('starts beginners in a guided tune workflow with plain-language feedback', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('button', { name: 'Tune' })).toHaveClass(/active/);
  await expect(page.getByText('Tune Pattern')).toBeVisible();
  await expect(page.getByText('Now editing')).toBeVisible();
  await expect(page.getByText('Pattern recipe')).toBeVisible();
  await expect(page.getByText('Effect stack')).toBeVisible();
  await expect(page.getByText('Base pattern')).toBeVisible();
  await expect(page.getByText('keeps its own motion, flashes, and spatial structure')).toBeVisible();
  await expect(page.getByText('Journey layer')).toBeVisible();
  await expect(page.getByText('influences color and speed over time')).toBeVisible();
  await expect(page.getByText('AI drafts')).toBeVisible();
  await expect(page.getByText('not applied until accepted')).toBeVisible();
  await expect(page.getByText('Live output')).toBeVisible();
  await expect(page.getByText(/color journey/i)).toBeVisible();
  await expect(page.getByText('Undo tuning')).toBeVisible();

  await page.getByRole('button', { name: 'Reverse color order' }).click();
  await expect(page.getByText('Last change')).toBeVisible();
  await expect(page.getByText(/Reversed the color journey/)).toBeVisible();
  const reversedStops = await page.locator('.lw-journey-stop input[type="color"]').evaluateAll(inputs =>
    inputs.map(input => (input as HTMLInputElement).value),
  );
  await page.getByRole('button', { name: 'Undo tuning' }).click();
  const restoredStops = await page.locator('.lw-journey-stop input[type="color"]').evaluateAll(inputs =>
    inputs.map(input => (input as HTMLInputElement).value),
  );
  expect(restoredStops).toEqual([...reversedStops].reverse());

  await page.getByRole('tab', { name: 'Motion' }).click();
  await expect(page.getByText('Speed story')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset Motion' })).toBeVisible();

  await page.getByRole('tab', { name: 'Output' }).click();
  await expect(page.getByText('What is live right now')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset Output' })).toBeVisible();
});

test('keeps browse mode beginner sized before showing the full library', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Browse' }).click();

  await expect(page.getByText('Recommended starting points')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show all patterns' })).toBeVisible();
  await expect(page.locator('.lw-pattern-card')).toHaveCount(12);

  await page.getByRole('button', { name: 'Show all patterns' }).click();
  await expect.poll(async () => page.locator('.lw-pattern-card').count()).toBeGreaterThan(30);
});

test('offers AI prompt chips and targeted pattern edits', async ({ page }) => {
  const assistant = await openPatternAssistant(page);

  await expect(assistant.getByText('Draft first, accept later')).toBeVisible();
  await expect(assistant.getByText('Generate creates a preview draft. Your live pattern changes only when you accept it.')).toBeVisible();
  await expect(assistant.getByRole('button', { name: 'Slower' })).toBeVisible();
  await expect(assistant.getByRole('button', { name: 'Warmer' })).toBeVisible();
  await expect(assistant.getByRole('button', { name: 'Only color' })).toBeVisible();

  await assistant.getByRole('button', { name: 'Warmer' }).click();
  await expect(assistant.locator('textarea')).toHaveValue(/warmer/);
  await assistant.getByRole('button', { name: 'Only motion' }).click();
  await expect(assistant.locator('textarea')).toHaveValue(/only motion/i);
});

test('makes AI drafts clearly preview-only until accepted', async ({ page }) => {
  await page.route('**/api/ai/pattern', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ draft: makeDraft('Preview Only Draft') }),
    });
  });

  const assistant = await openPatternAssistant(page);
  await assistant.locator('textarea').fill('make a slow warm version');
  await assistant.getByRole('button', { name: 'Generate' }).click();

  await expect(assistant.locator('.lw-ai-draft-head .title')).toHaveText('Preview Only Draft');
  await expect(assistant.getByText('Preview only', { exact: true })).toBeVisible();
  await expect(assistant.getByText('Accept creates a custom pattern and switches the preview to it.')).toBeVisible();
  await expect(assistant.getByRole('button', { name: 'Accept and use pattern' })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_custom_patterns') || '[]');
    return saved.length;
  })).toBe(0);
});

test('prevents accidental selection in UI chrome while keeping text inputs selectable', async ({ page }) => {
  await page.goto('/#screen=pattern', { waitUntil: 'domcontentloaded' });

  const styles = await page.evaluate(() => ({
    bodySelect: getComputedStyle(document.body).userSelect,
    buttonSelect: getComputedStyle(document.querySelector('button')!).userSelect,
    inputSelect: getComputedStyle(document.querySelector('input')!).userSelect,
  }));

  expect(styles.bodySelect).toBe('none');
  expect(styles.buttonSelect).toBe('none');
  expect(styles.inputSelect).toBe('auto');
});

test('accepting over the selected custom pattern updates the live preview code', async ({ page }) => {
  const drafts = [
    makeColorDraft('Solid Red Draft', 'return rgb(1, 0, 0);'),
    makeColorDraft('Solid Green Draft', 'return rgb(0, 1, 0);'),
  ];
  let requestCount = 0;
  await page.route('**/api/ai/pattern', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ draft: drafts[requestCount++] || drafts[drafts.length - 1] }),
    });
  });

  const assistant = await openPatternAssistant(page);
  await assistant.locator('textarea').fill('make a solid red test');
  await assistant.getByRole('button', { name: 'Generate' }).click();
  await expect(assistant.locator('.lw-ai-draft-head .title')).toHaveText('Solid Red Draft');
  await assistant.getByRole('button', { name: 'Accept' }).click();
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_custom_patterns') || '[]');
    return saved[0]?.id || '';
  })).toBe('custom_solid_red_draft');
  await waitForDominantCanvasColor(page, 'red');

  await assistant.locator('textarea').fill('make the selected custom pattern green');
  await assistant.getByRole('button', { name: 'Generate' }).click();
  await expect(assistant.locator('.lw-ai-draft-head .title')).toHaveText('Solid Green Draft');
  await assistant.getByRole('button', { name: 'Accept' }).click();
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('lw_custom_patterns') || '[]');
    return saved[0]?.code || '';
  })).toBe('return rgb(0, 1, 0);');
  await waitForDominantCanvasColor(page, 'green');
});
