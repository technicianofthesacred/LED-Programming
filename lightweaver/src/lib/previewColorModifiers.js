/**
 * previewColorModifiers.js — faithful JS port of the firmware's
 * `applyGlobalColorModifiers` (firmware/lightweaver-controller/src/
 * LightweaverPatterns.cpp), so the Studio preview recolors a pattern exactly
 * the way the card does.
 *
 * The card treats the look controls as a POST-PASS over the rendered pixels:
 *   - customHue      → a hue *shift* relative to the default hue (32), NOT an
 *                      absolute recolor. Set a green hue and every color rotates
 *                      toward green (fire's reds become greens), matching the card.
 *   - customSaturation → a saturation *multiplier* relative to the default (230).
 *   - hueShift (advanced) → an extra static hue rotation, folded into the shift.
 *   - customDrift    → slowly sweeps the hue across the wheel over time.
 *   - customBreathe  → modulates brightness with a breathing sine.
 *
 * Operates in place on an array of { r, g, b } (0–255) pixels, at time `tMs`.
 *
 * Hue/saturation are applied through an EXACT RGB<->HSV pair, so leaving both at
 * their defaults is a true no-op and the first notch off default does a notch's
 * worth of work. See `hsv2rgbSpectrum` below for what this replaced and why.
 */

import { resolveBreatheScale } from './breatheEnvelope.js';

export const LW_DEFAULT_CUSTOM_HUE = 32;
export const LW_DEFAULT_CUSTOM_SATURATION = 230;

// FastLED hue is a 0–255 wheel; shiftHue wraps mod 256 (see firmware shiftHue()).
function wrapHue(v) {
  v %= 256;
  if (v < 0) v += 256;
  return v;
}

// FastLED scale8 (SCALE8_FIXED=1, the firmware default): (i * (1 + sc)) >> 8.
function scale8(value, scale) {
  return (value * (1 + scale)) >> 8;
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Mirror of the firmware resolveDriftHue triangle-wave sweep. Drift range is not
// exposed in the Patterns UI, so it uses the firmware default full wheel (0–255).
export function resolveDriftHue(tMs, lo = 0, hi = 255) {
  const span = hi >= lo ? hi - lo : 255 - lo + hi + 1;
  if (span === 0) return lo;
  const period = Math.max(2000, span * 80);
  const phase = tMs % (period * 2);
  const step = phase < period
    ? Math.floor((phase * span) / period)
    : span - Math.floor(((phase - period) * span) / period);
  if (hi >= lo) return lo + step;
  return (lo + step) & 0xff;
}

// Standard RGB(0–255) → HSV with hue expressed in 0–255 (FastLED wheel units).
function rgbToHsv255(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return {
    h: Math.round((h / 360) * 255) & 0xff,
    s: max === 0 ? 0 : Math.round((d / max) * 255),
    v: Math.round(max),
  };
}

// HSV(0-255) -> RGB, the exact inverse of `rgbToHsv255` above.
//
// Was: a port of FastLED's `hsv2rgb_rainbow`, chosen so the preview matched the
// card's `leds[i] = CHSV(...)` assignment. The problem is that the rainbow ramp
// is a DIFFERENT set of colors than the pattern produced, so the round trip is
// not the identity: measured across aurora/rainbow/fire/ocean it recolors every
// pixel by 30-54 units (0-255 scale) all on its own. Because the post-pass is
// skipped entirely at the default hue/saturation, that whole recolor landed the
// instant either control moved one notch off default — a 44-unit snap on the
// first notch, then ~1 unit over the next thirty. The control read as broken:
// it lurched, then stopped responding.
//
// An exact inverse makes zero shift a true no-op (measured residue 0.1-0.5
// units, invisible) so the first notch does a notch's worth of work, and a
// nonzero shift rotates the pattern's OWN colors instead of re-quantizing them
// onto the rainbow ramp. The firmware post-pass is changed to match.
function hsv2rgbSpectrum(h, s, v) {
  const sat = (s & 0xff) / 255;
  const val = (v & 0xff) / 255;
  const sector = ((h & 0xff) / 255) * 6;
  const index = Math.floor(sector) % 6;
  const fraction = sector - Math.floor(sector);
  const p = val * (1 - sat);
  const q = val * (1 - sat * fraction);
  const t = val * (1 - sat * (1 - fraction));
  let r;
  let g;
  let b;
  switch (index) {
    case 0: r = val; g = t; b = p; break;
    case 1: r = q; g = val; b = p; break;
    case 2: r = p; g = val; b = t; break;
    case 3: r = p; g = q; b = val; break;
    case 4: r = t; g = p; b = val; break;
    default: r = val; g = p; b = q; break;
  }
  return {
    r: clamp8(Math.round(r * 255)),
    g: clamp8(Math.round(g * 255)),
    b: clamp8(Math.round(b * 255)),
  };
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Recolor `pixels` in place to match how the card applies a look's color
 * controls. Brightness/speed are handled by the frame engine (masterBrightness/
 * masterSpeed) and are intentionally NOT re-applied here.
 */
export function applyLookColorModifiers(pixels, tMs, look = {}) {
  const customHue = clampInt(look.customHue, LW_DEFAULT_CUSTOM_HUE, 0, 255);
  const customSaturation = clampInt(look.customSaturation, LW_DEFAULT_CUSTOM_SATURATION, 0, 255);
  const advHueShift = clampInt(look.hueShift, 0, -128, 128);

  let hueShift = (customHue - LW_DEFAULT_CUSTOM_HUE) + advHueShift;
  if (look.customDrift) {
    const rawSpeed = Number(look.speed);
    const speed = Number.isFinite(rawSpeed) ? Math.max(0.05, Math.min(3, rawSpeed)) : 1;
    hueShift += resolveDriftHue(tMs * speed) - customHue;
  }

  const shiftsHue = hueShift !== 0;
  const changesSaturation = customSaturation !== LW_DEFAULT_CUSTOM_SATURATION;
  const breatheScale = resolveBreatheScale(tMs, look);

  if (!shiftsHue && !changesSaturation && breatheScale >= 255) return pixels;

  for (const px of pixels) {
    if (!(px.r || px.g || px.b)) continue;
    if (shiftsHue || changesSaturation) {
      const hsv = rgbToHsv255(px.r, px.g, px.b);
      if (shiftsHue) hsv.h = wrapHue(hsv.h + hueShift);
      if (changesSaturation) {
        const sat = Math.floor(
          (hsv.s * customSaturation + LW_DEFAULT_CUSTOM_SATURATION / 2) / LW_DEFAULT_CUSTOM_SATURATION,
        );
        hsv.s = sat > 255 ? 255 : sat;
      }
      const rgb = hsv2rgbSpectrum(hsv.h, hsv.s, hsv.v);
      px.r = rgb.r; px.g = rgb.g; px.b = rgb.b;
    }
    if (breatheScale < 255) {
      px.r = scale8(px.r, breatheScale);
      px.g = scale8(px.g, breatheScale);
      px.b = scale8(px.b, breatheScale);
    }
  }
  return pixels;
}
