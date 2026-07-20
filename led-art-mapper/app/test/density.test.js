import test from 'node:test';
import assert from 'node:assert/strict';

import { calculateStripLengthMeters, getStripDensity } from '../src/density.js';

test('calculates physical tape length from LED count and density', () => {
  assert.equal(calculateStripLengthMeters(120, 60), 2);
  assert.equal(calculateStripLengthMeters(120, 144), 120 / 144);
});

test('defaults legacy strips to 60 LEDs per metre', () => {
  assert.equal(getStripDensity({}), 60);
  assert.equal(getStripDensity({ ledsPerMeter: 96 }), 96);
});

test('rejects non-positive density values', () => {
  assert.equal(calculateStripLengthMeters(120, 0), null);
  assert.equal(calculateStripLengthMeters(120, -30), null);
});
