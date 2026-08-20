import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLookColorModifiers,
  LW_DEFAULT_CUSTOM_HUE,
  LW_DEFAULT_CUSTOM_SATURATION,
} from './previewColorModifiers.js';
import { compilePattern, normalizePalette, renderPixelFrame } from './frameEngine.js';

const PIXEL_COUNT = 41;
const pts = Array.from({ length: PIXEL_COUNT }, (_, index) => ({
  x: index * 4,
  y: 0,
  i: index,
  p: index / (PIXEL_COUNT - 1),
  sourceProgress: index / (PIXEL_COUNT - 1),
}));

function patternPixels(patternId) {
  return renderPixelFrame({
    t: 12,
    strips: [{ id: 'strip', speed: 1, brightness: 1, pts, patternId }],
    patternId,
    activeFn: compilePattern(patternId),
    paletteNorm: normalizePalette(),
  }).pixels.map(pixel => ({ r: pixel.r, g: pixel.g, b: pixel.b }));
}

function look(source, customHue, customSaturation) {
  return applyLookColorModifiers(source.map(pixel => ({ ...pixel })), 0, {
    customHue,
    customSaturation,
  });
}

function drift(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i].r - b[i].r) + Math.abs(a[i].g - b[i].g) + Math.abs(a[i].b - b[i].b);
  }
  return sum / (a.length * 3);
}

const PATTERNS = ['aurora', 'rainbow', 'fire', 'ocean'];

// The post-pass is skipped entirely when hue and saturation sit on their
// defaults, so anything the RGB->HSV->RGB trip loses lands in one lump on the
// first notch either control moves. With FastLED's rainbow ramp as the inverse
// that lump measured 30-54 units out of 255 — the control lurched once and then
// looked dead, because the next thirty notches were worth about one unit.
test('a hue or saturation notch does a notch worth of work, not a lurch', () => {
  for (const patternId of PATTERNS) {
    const source = patternPixels(patternId);
    const neutral = look(source, LW_DEFAULT_CUSTOM_HUE, LW_DEFAULT_CUSTOM_SATURATION);

    const oneSaturationNotch = drift(neutral, look(source, LW_DEFAULT_CUSTOM_HUE, LW_DEFAULT_CUSTOM_SATURATION - 1));
    const thirtySaturationNotches = drift(neutral, look(source, LW_DEFAULT_CUSTOM_HUE, LW_DEFAULT_CUSTOM_SATURATION - 30));
    assert.ok(
      oneSaturationNotch < thirtySaturationNotches,
      `${patternId}: one saturation notch (${oneSaturationNotch}) must move less than thirty (${thirtySaturationNotches})`,
    );
    assert.ok(oneSaturationNotch < 5, `${patternId}: saturation snapped ${oneSaturationNotch} on the first notch`);

    const oneHueNotch = drift(neutral, look(source, LW_DEFAULT_CUSTOM_HUE + 1, LW_DEFAULT_CUSTOM_SATURATION));
    const thirtyHueNotches = drift(neutral, look(source, LW_DEFAULT_CUSTOM_HUE + 30, LW_DEFAULT_CUSTOM_SATURATION));
    assert.ok(
      oneHueNotch < thirtyHueNotches,
      `${patternId}: one hue notch (${oneHueNotch}) must move less than thirty (${thirtyHueNotches})`,
    );
    assert.ok(oneHueNotch < 5, `${patternId}: hue snapped ${oneHueNotch} on the first notch`);
  }
});

// Zero shift has to be the identity, or the "skipped at default" branch above is
// a cliff by construction no matter how the ramp is shaped.
test('an explicit zero shift leaves the pattern untouched', () => {
  for (const patternId of PATTERNS) {
    const source = patternPixels(patternId);
    const shifted = applyLookColorModifiers(source.map(pixel => ({ ...pixel })), 0, {
      customHue: LW_DEFAULT_CUSTOM_HUE,
      customSaturation: LW_DEFAULT_CUSTOM_SATURATION,
      hueShift: 1,
    });
    const back = applyLookColorModifiers(shifted, 0, {
      customHue: LW_DEFAULT_CUSTOM_HUE,
      customSaturation: LW_DEFAULT_CUSTOM_SATURATION,
      hueShift: -1,
    });
    assert.ok(drift(source, back) < 4, `${patternId}: a shift and its inverse must return the original colors`);
  }
});

test('turning saturation down keeps moving all the way to gray', () => {
  for (const patternId of PATTERNS) {
    const source = patternPixels(patternId);
    const neutral = look(source, LW_DEFAULT_CUSTOM_HUE, LW_DEFAULT_CUSTOM_SATURATION);
    let previous = 0;
    for (const saturation of [200, 150, 100, 50, 0]) {
      const moved = drift(neutral, look(source, LW_DEFAULT_CUSTOM_HUE, saturation));
      assert.ok(moved > previous, `${patternId}: saturation ${saturation} must be further from neutral than the step before`);
      previous = moved;
    }
  }
});
