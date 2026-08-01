import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BREATHE_SETTINGS, normalizeBreatheSettings, resolveBreatheScale } from './breatheEnvelope.js';
import { applyLookColorModifiers } from './previewColorModifiers.js';
import { normalizeCardVisualLook } from './cardVisualLook.js';

test('legacy breathe booleans receive gentle defaults', () => {
  assert.deepEqual(DEFAULT_BREATHE_SETTINGS, {
    breatheLowerPct: 85,
    breatheUpperPct: 100,
    breatheCycleSeconds: 9,
  });
  for (const customBreathe of [true, false]) {
    assert.deepEqual(normalizeCardVisualLook({ customBreathe }), {
      ...normalizeCardVisualLook({}),
      customBreathe,
    });
  }
});

test('breathe settings clamp ranges and never invert', () => {
  assert.deepEqual(normalizeBreatheSettings({ breatheLowerPct: -1, breatheUpperPct: 140, breatheCycleSeconds: 50 }), {
    breatheLowerPct: 0,
    breatheUpperPct: 100,
    breatheCycleSeconds: 30,
  });
  assert.deepEqual(normalizeBreatheSettings({ breatheLowerPct: 90, breatheUpperPct: 40, breatheCycleSeconds: 3 }), {
    breatheLowerPct: 40,
    breatheUpperPct: 40,
    breatheCycleSeconds: 4,
  });
});

test('gentle envelope is periodic, shallow, smooth, and independent of pattern speed', () => {
  const look = { customBreathe: true, breatheLowerPct: 85, breatheUpperPct: 100, breatheCycleSeconds: 9 };
  assert.equal(resolveBreatheScale(0, look), 217);
  assert.equal(resolveBreatheScale(4500, look), 255);
  assert.equal(resolveBreatheScale(9000, look), 217);
  assert.equal(resolveBreatheScale(4500, { ...look, speed: 0.05 }), 255);
  const values = Array.from({ length: 271 }, (_, frame) => resolveBreatheScale(frame * 1000 / 30, look));
  assert.ok(values.every(value => value >= 217 && value <= 255));
  assert.ok(Math.max(...values.slice(1).map((value, index) => Math.abs(value - values[index]))) <= 1);
});

test('equal bounds stay steady and disabled breathe stays full scale', () => {
  assert.equal(resolveBreatheScale(1234, { customBreathe: true, breatheLowerPct: 92, breatheUpperPct: 92 }), 235);
  assert.equal(resolveBreatheScale(1234, { customBreathe: false }), 255);
});

test('Studio white-preset Drift scales wall-clock time by look speed like firmware, without scaling Breathe', () => {
  const fast = [{ r: 240, g: 210, b: 180 }];
  const normal = [{ r: 240, g: 210, b: 180 }];
  applyLookColorModifiers(fast, 1200, { customDrift: true, speed: 2 });
  applyLookColorModifiers(normal, 2400, { customDrift: true, speed: 1 });
  assert.deepEqual(fast, normal);

  const breatheFast = resolveBreatheScale(1200, { customBreathe: true, speed: 3 });
  const breatheNormal = resolveBreatheScale(1200, { customBreathe: true, speed: 1 });
  assert.equal(breatheFast, breatheNormal);
});
