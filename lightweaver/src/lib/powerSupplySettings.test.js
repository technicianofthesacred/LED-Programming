import test from 'node:test';
import assert from 'node:assert/strict';

import { readPowerSupplySettings, withPowerSupplySettings } from './powerSupplySettings.js';

test('persists the supply estimate and exports an 80 percent aggregate current ceiling', () => {
  const next = withPowerSupplySettings({ led: { colorOrder: 'GRB' } }, {
    psuAmps: 5,
    milliampsPerPixel: 12,
  });

  assert.deepEqual(readPowerSupplySettings(next), {
    psuAmps: 5,
    milliampsPerPixel: 12,
  });
  assert.equal(next.led.maxMilliamps, 4000);
  assert.equal(next.led.colorOrder, 'GRB');
});

test('clamps the deployed current ceiling to firmware limits', () => {
  assert.equal(withPowerSupplySettings({}, { psuAmps: 0.05, milliampsPerPixel: 12 }).led.maxMilliamps, 100);
  assert.equal(withPowerSupplySettings({}, { psuAmps: 50, milliampsPerPixel: 12 }).led.maxMilliamps, 20000);
});
