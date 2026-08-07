import { test, expect } from '@playwright/test';

// A development card is allowed to be smaller than the piece being designed.
//
// The whole point of these tests: a 400-light mandala being designed against a
// 41-light bench strip must stay a 400-light mandala, and the Wire panel must
// say plainly which lights are not wired up yet — instead of leaving a mostly
// dark strip looking like a fault.
const PATH = 'M 10 10 L 200 10';

function project({ designPixels, outputPin, countedPin, countedPixels }: {
  designPixels: number; outputPin: number; countedPin: number; countedPixels: number;
}) {
  const half = Math.floor(designPixels / 2);
  const strips = [
    { id: 'outer', name: 'Outer circle', pathData: PATH, pixelCount: designPixels - half, color: '#f0a', x: 0, y: 0 },
    { id: 'inner', name: 'Inner circle', pathData: PATH, pixelCount: half, color: '#0af', x: 0, y: 0 },
  ];
  return {
    version: 3,
    id: 'capacity-fixture',
    name: 'Capacity fixture',
    // What was counted on the card that happens to be plugged in.
    portRoles: [
      { pin: 16, role: 'unused', pixelCount: 0, controlKind: '' },
      { pin: 17, role: 'unused', pixelCount: 0, controlKind: '' },
      { pin: countedPin, role: 'strip', pixelCount: countedPixels, controlKind: '' },
      { pin: 21, role: 'unused', pixelCount: 0, controlKind: '' },
    ].filter((entry, index, all) => all.findIndex(item => item.pin === entry.pin) === index),
    layout: {
      strips,
      // The owner has drawn this. Nothing may reshape it on their behalf.
      starterPending: false,
      svgText: '',
      viewBox: '0 0 400 400',
      wiring: {
        version: 1,
        locked: false,
        verified: false,
        outputs: [{ id: 'out1', name: 'Output 1', pin: outputPin, runIds: ['run-outer', 'run-inner'] }],
        runs: [
          { id: 'run-outer', type: 'strip', source: { stripId: 'outer', from: 0, to: designPixels - half - 1 }, verified: false },
          { id: 'run-inner', type: 'strip', source: { stripId: 'inner', from: 0, to: half - 1 }, verified: false },
        ],
      },
    },
  };
}

async function openWire(page: any, fixture: object) {
  await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
  await page.evaluate((data) => {
    localStorage.clear();
    localStorage.setItem('lw_autosave_v3', JSON.stringify(data));
  }, fixture);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('layout-mode-wire').click();
  await expect(page.getByTestId('layout-wire-panel')).toBeVisible();
}

test('a small card against a large design is stated as a fact, and the design is untouched', async ({ page }) => {
  await openWire(page, project({ designPixels: 400, outputPin: 18, countedPin: 18, countedPixels: 41 }));

  await expect(page.getByTestId('wire-capacity'))
    .toHaveText('Plugged in right now: 41 lights. This design uses 400 — the other 359 are not wired up yet.');
  // Same GPIO, different length: normal while developing, so no fix is offered.
  await expect(page.getByTestId('wire-mismatch-18')).toHaveCount(0);
  await expect(page.getByTestId('wire-adopt-18')).toHaveCount(0);
  // The design still says 400. Counting a bench strip must never shrink it.
  await expect(page.locator('.lww-plan-head .meta')).toContainText('400 LEDs in this design');
  const total = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}')
    .layout.strips.reduce((sum: number, strip: any) => sum + strip.pixelCount, 0));
  expect(total).toBe(400);
});

test('a card matching the design says so', async ({ page }) => {
  await openWire(page, project({ designPixels: 41, outputPin: 18, countedPin: 18, countedPixels: 41 }));
  await expect(page.getByTestId('wire-capacity'))
    .toHaveText('Plugged in right now: 41 lights — everything this design uses.');
});

test('a wrong GPIO is still a fault, because nothing lights at all', async ({ page }) => {
  await openWire(page, project({ designPixels: 400, outputPin: 16, countedPin: 18, countedPixels: 41 }));
  await expect(page.getByTestId('wire-mismatch-18'))
    .toContainText('This design sends its lights to GPIO 16, but your strip is plugged into GPIO 18.');
  await page.getByTestId('wire-adopt-18').click();
  await expect(page.getByTestId('wire-mismatch-18')).toHaveCount(0);
});

test('counting what is plugged in is reachable from Wire, not only from a blank card', async ({ page }) => {
  await openWire(page, project({ designPixels: 400, outputPin: 18, countedPin: 18, countedPixels: 41 }));
  await expect(page.getByTestId('wire-recount')).toBeVisible();
});
