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
 */

export const LW_DEFAULT_CUSTOM_HUE = 32;
export const LW_DEFAULT_CUSTOM_SATURATION = 230;

// FastLED hue is a 0–255 wheel; shiftHue wraps mod 256 (see firmware shiftHue()).
function wrapHue(v) {
  v %= 256;
  if (v < 0) v += 256;
  return v;
}

// FastLED sin8: 0–255 input across one full period, output 0–255 centered ~128.
function sin8(x) {
  return Math.round(128 + 127 * Math.sin((wrapHue(x) / 256) * Math.PI * 2));
}

// FastLED scale8 (SCALE8_FIXED=1, the firmware default): (i * (1 + sc)) >> 8.
function scale8(value, scale) {
  return (value * (1 + scale)) >> 8;
}

// FastLED scale8_video: never fully dims a lit channel to 0.
function scale8Video(value, scale) {
  return ((value * scale) >> 8) + (value && scale ? 1 : 0);
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

// Faithful port of FastLED's hsv2rgb_rainbow — the exact HSV→RGB mapping the
// card uses when it recolors (firmware assigns `leds[i] = CHSV(...)`). This is
// what gives the strip its color character (its yellows/greens sit differently
// than a textbook HSV wheel), so matching it here is what makes the preview's
// recolored output correspond to the hardware. Hue/sat/val are 0–255.
function hsv2rgbRainbow(h, s, v) {
  const hue = h & 0xff;
  const sat = s & 0xff;
  const val = v & 0xff;
  const offset = hue & 0x1f;          // 0..31 within the current 1/8 of the wheel
  const offset8 = (offset << 3) & 0xff; // 0..248
  const third = scale8(offset8, 85);   // = offset8 / 3

  let r;
  let g;
  let b;
  if (!(hue & 0x80)) {
    if (!(hue & 0x40)) {
      if (!(hue & 0x20)) { r = 255 - third; g = third; b = 0; }                 // red → orange
      else { r = 171; g = 85 + third; b = 0; }                                   // orange → yellow
    } else if (!(hue & 0x20)) {
      const twothirds = scale8(offset8, 170); r = 171 - twothirds; g = 170 + third; b = 0; // yellow → green
    } else { r = 0; g = 255 - third; b = third; }                                // green → aqua
  } else if (!(hue & 0x40)) {
    if (!(hue & 0x20)) {
      const twothirds = scale8(offset8, 170); r = 0; g = 171 - twothirds; b = 85 + twothirds; // aqua → blue
    } else { r = third; g = 0; b = 255 - third; }                                // blue → purple
  } else if (!(hue & 0x20)) {
    r = 85 + third; g = 0; b = 171 - third;                                       // purple → pink
  } else {
    r = 171 + third; g = 0; b = 85 - third;                                       // pink → red
  }

  if (sat !== 255) {
    if (sat === 0) {
      r = 255; g = 255; b = 255;
    } else {
      const desat = scale8Video(255 - sat, 255 - sat);
      const satscale = 255 - desat;
      if (r) r = scale8(r, satscale) + 1;
      if (g) g = scale8(g, satscale) + 1;
      if (b) b = scale8(b, satscale) + 1;
      r += desat; g += desat; b += desat;
    }
  }

  if (val !== 255) {
    const vs = scale8Video(val, val);
    if (vs === 0) {
      r = 0; g = 0; b = 0;
    } else {
      if (r) r = scale8(r, vs) + 1;
      if (g) g = scale8(g, vs) + 1;
      if (b) b = scale8(b, vs) + 1;
    }
  }

  return { r: clamp8(r), g: clamp8(g), b: clamp8(b) };
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
  if (look.customDrift) hueShift += resolveDriftHue(tMs) - customHue;

  const shiftsHue = hueShift !== 0;
  const changesSaturation = customSaturation !== LW_DEFAULT_CUSTOM_SATURATION;
  const breatheScale = look.customBreathe
    ? 86 + scale8(sin8(Math.floor(tMs / 14) & 0xff), 169)
    : 255;

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
      const rgb = hsv2rgbRainbow(hsv.h, hsv.s, hsv.v);
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
