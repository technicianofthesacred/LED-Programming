import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeLedCoreAlpha,
  ledIntensity,
  restingLedAlpha,
  restingLedColor,
} from './previewVisuals.js';

test('unlit preview LEDs render as dim hardware instead of active white pixels', () => {
  const off = { r: 0, g: 0, b: 0 };
  const lit = { r: 255, g: 180, b: 90 };

  assert.equal(ledIntensity(off), 0);
  assert.equal(activeLedCoreAlpha(off), 0);
  assert.ok(restingLedAlpha(off) < 0.16);
  assert.match(restingLedColor(off), /^rgba\(70, 90, 118,/);

  assert.ok(ledIntensity(lit) > 0.9);
  assert.ok(activeLedCoreAlpha(lit) > 0.5);
  assert.ok(restingLedAlpha(lit) < activeLedCoreAlpha(lit));
});
