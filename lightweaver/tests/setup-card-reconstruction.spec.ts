import { expect, test } from '@playwright/test';

test('card reconstruction preserves installed playlist and startup look', async ({ page }) => {
  await page.goto('/#screen=card&section=setup', { waitUntil: 'domcontentloaded' });

  const reconstructed = await page.evaluate(async () => {
    const setup = await import('/src/v3/lw-setup.jsx');
    return setup.reconstructInstalledCardState({
      skeleton: {
        outputs: [{ id: 'out1', name: 'Output 1', pin: 18, pixels: 41 }],
        led: { type: 'WS2815', colorOrder: 'RGB' },
        strips: [{ id: 'strip-1', name: 'Output 1', pixelCount: 41 }],
        portRoles: [{ portId: '18', role: 'strip', pixelCount: 41 }],
      },
      patterns: {
        currentId: 'fire',
        currentIndex: 1,
        patterns: [
          { id: 'aurora', label: 'Aurora', mode: 'procedural', zones: [{ id: 'strip-1', label: 'Output 1', patternId: 'aurora' }] },
          { id: 'fire', label: 'Fire', mode: 'procedural', zones: [{ id: 'strip-1', label: 'Output 1', patternId: 'fire' }] },
          { id: 'ocean', label: 'Ocean', mode: 'procedural', zones: [{ id: 'strip-1', label: 'Output 1', patternId: 'ocean' }] },
        ],
      },
      zones: {
        startupPatternId: 'aurora',
        zones: [{
          id: 'strip-1', label: 'Output 1', patternId: 'aurora',
          brightness: 0.72, speed: 1.15, hueShift: 12,
          customHue: 34, customSaturation: 210,
          customBreathe: true, breatheLowerPct: 30,
          breatheUpperPct: 90, breatheCycleSeconds: 6,
          customDrift: false,
        }],
      },
    });
  });

  expect(reconstructed.devices.standaloneController.looks).toHaveLength(3);
  expect(reconstructed.devices.standaloneController.looks).toEqual([
    expect.objectContaining({ id: 'aurora', label: 'Aurora', defaultLook: expect.objectContaining({ patternId: 'aurora' }) }),
    expect.objectContaining({ id: 'fire', label: 'Fire', defaultLook: expect.objectContaining({ patternId: 'fire' }) }),
    expect.objectContaining({ id: 'ocean', label: 'Ocean', defaultLook: expect.objectContaining({ patternId: 'ocean' }) }),
  ]);
  expect(reconstructed.devices.standaloneController.playlist).toEqual([
    expect.objectContaining({ id: 'aurora', type: 'combo', lookId: 'aurora', label: 'Aurora', enabled: true }),
    expect.objectContaining({ id: 'fire', type: 'combo', lookId: 'fire', label: 'Fire', enabled: true }),
    expect.objectContaining({ id: 'ocean', type: 'combo', lookId: 'ocean', label: 'Ocean', enabled: true }),
  ]);
  expect(reconstructed.devices.standaloneController.defaultLook).toEqual(expect.objectContaining({
    patternId: 'aurora', brightness: 0.72, speed: 1.15, hueShift: 12,
    customHue: 34, customSaturation: 210, customBreathe: true,
    breatheLowerPct: 30, breatheUpperPct: 90, breatheCycleSeconds: 6,
    customDrift: false,
  }));
  expect(reconstructed.devices.standaloneController.activeLookId).toBe('fire');
});
