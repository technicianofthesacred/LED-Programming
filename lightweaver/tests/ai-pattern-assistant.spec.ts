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

  await page.getByTitle('Next pattern').click();

  await expect(assistant.getByText('Pattern Switch Draft')).toHaveCount(0);
  await expect(assistant.getByText(/Describe a new direction/)).toBeVisible();
});
