#include "LightweaverPatterns.h"

static inline uint32_t scaleTime(uint32_t now, float speed) {
  if (speed <= 0.0f) return now;
  return static_cast<uint32_t>(static_cast<float>(now) * speed);
}

static inline uint8_t shiftHue(uint8_t base, int16_t shift) {
  int16_t v = int16_t(base) + shift;
  while (v < 0) v += 256;
  while (v > 255) v -= 256;
  return static_cast<uint8_t>(v);
}

static constexpr uint8_t LW_DEFAULT_CUSTOM_HUE = 32;
static constexpr uint8_t LW_DEFAULT_CUSTOM_SATURATION = 230;

static uint8_t resolveDriftHue(uint32_t t, const PatternModifiers& mods) {
  uint8_t lo = mods.driftHueMin;
  uint8_t hi = mods.driftHueMax;
  uint16_t span;
  if (hi >= lo) span = uint16_t(hi - lo);
  else span = uint16_t(255 - lo + hi + 1);
  if (span == 0) return lo;

  uint32_t period = max<uint32_t>(2000, span * 80);
  uint32_t phase = t % (period * 2);
  uint16_t step;
  if (phase < period) step = uint16_t((uint32_t(phase) * span) / period);
  else step = uint16_t(span - ((uint32_t(phase - period) * span) / period));
  if (hi >= lo) return lo + uint8_t(step);
  return uint8_t((uint16_t(lo) + step) & 0xff);
}

void applyGlobalColorModifiers(CRGB* leds, uint16_t totalPixels, uint32_t t, const PatternModifiers& mods) {
  int16_t hueShift = int16_t(mods.customHue) - int16_t(LW_DEFAULT_CUSTOM_HUE);
  if (mods.customDrift) {
    hueShift += int16_t(resolveDriftHue(t, mods)) - int16_t(mods.customHue);
  }
  const bool shiftsHue = hueShift != 0;
  const bool changesSaturation = mods.customSaturation != LW_DEFAULT_CUSTOM_SATURATION;
  const uint8_t breatheScale = mods.customBreathe
    ? uint8_t(86 + scale8(sin8(uint8_t(t / 14)), 169))
    : 255;
  if (!shiftsHue && !changesSaturation && breatheScale >= 255) return;

  for (uint16_t i = 0; i < totalPixels; i++) {
    if (!(leds[i].r || leds[i].g || leds[i].b)) continue;
    if (shiftsHue || changesSaturation) {
      CHSV hsv = rgb2hsv_approximate(leds[i]);
      if (shiftsHue) hsv.hue = shiftHue(hsv.hue, hueShift);
      if (changesSaturation) {
        uint16_t sat = (uint16_t(hsv.saturation) * mods.customSaturation + (LW_DEFAULT_CUSTOM_SATURATION / 2)) / LW_DEFAULT_CUSTOM_SATURATION;
        hsv.saturation = uint8_t(sat > 255 ? 255 : sat);
      }
      leds[i] = hsv;
    }
    if (breatheScale < 255) leds[i].nscale8(breatheScale);
  }
}

static inline uint8_t hash8(uint16_t value, uint16_t salt = 0) {
  uint16_t x = value;
  x ^= salt * 109u;
  x ^= x >> 7;
  x *= 251u;
  x ^= x >> 9;
  return uint8_t(x & 0xff);
}

bool renderProceduralPattern(const String& preset, CRGB* leds, uint16_t totalPixels, uint32_t now, const PatternModifiers& mods) {
  uint32_t t = scaleTime(now, mods.speed);
  if (preset == "custom-color") {
    uint8_t hue = mods.customHue;
    if (mods.customDrift) {
      // Drift through a palette window: walk a triangle wave between min/max
      // so the drift always stays inside the chosen colors. If min==max the
      // hue is fixed (effectively disables drift). If min>max we wrap around
      // the color wheel (e.g. min=240,max=20 covers magenta→red→orange).
      uint8_t lo = mods.driftHueMin;
      uint8_t hi = mods.driftHueMax;
      uint16_t span;
      if (hi >= lo) span = uint16_t(hi - lo);
      else span = uint16_t(255 - lo + hi + 1);
      if (span == 0) {
        hue = lo;
      } else {
        // Triangle wave 0..span..0 with period proportional to span.
        // Slow palette traversal: ~10 seconds end-to-end at speed=1.
        uint32_t period = max<uint32_t>(2000, span * 80);
        uint32_t phase = t % (period * 2);
        uint16_t step;
        if (phase < period) step = uint16_t((uint32_t(phase) * span) / period);
        else step = uint16_t(span - ((uint32_t(phase - period) * span) / period));
        if (hi >= lo) hue = lo + uint8_t(step);
        else hue = uint8_t((uint16_t(lo) + step) & 0xff);
      }
    }
    uint8_t value = 220;
    if (mods.customBreathe) {
      uint8_t b = beatsin8(uint8_t(8 * mods.speed > 0 ? 8 * mods.speed : 8), 60, 230);
      value = b;
    }
    CHSV color(hue, mods.customSaturation, value);
    fill_solid(leds, totalPixels, color);
    return true;
  }
  for (uint16_t i = 0; i < totalPixels; i++) {
    uint16_t count = max<uint16_t>(1, totalPixels);
    uint8_t pos = uint8_t((uint32_t(i) * 255u) / count);
    if (preset == "ember") {
      uint8_t flicker = inoise8(i * 18, t / 7);
      CHSV color(shiftHue(8, mods.hueShift), 220, 120 + (flicker / 2));
      leds[i] = color;
    } else if (preset == "plasma") {
      uint8_t a = sin8(i * 9 + t / 12);
      uint8_t b = sin8(i * 5 - t / 17);
      uint8_t hue = shiftHue(uint8_t((uint16_t(a) + b) / 2), mods.hueShift);
      leds[i] = CHSV(hue, 210, 165 + (sin8(a + b) / 4));
    } else if (preset == "fire") {
      uint8_t heat = qadd8(inoise8(i * 24, t / 5), sin8(pos + t / 10) / 5);
      uint8_t hue = shiftHue(uint8_t(2 + heat / 9), mods.hueShift);
      leds[i] = CHSV(hue, 245, uint8_t(70 + (uint16_t(heat) * 2) / 3));
    } else if (preset == "ocean") {
      uint8_t w1 = sin8(i * 6 + t / 18);
      uint8_t w2 = sin8(i * 3 - t / 25);
      uint8_t wave = uint8_t((uint16_t(w1) + w2) / 2);
      leds[i] = CHSV(shiftHue(135 + wave / 8, mods.hueShift), 190, 70 + wave / 2);
    } else if (preset == "ripple") {
      int mid = int(totalPixels) / 2;
      uint8_t dist = uint8_t(min(255, abs(int(i) - mid) * 510 / max<int>(1, totalPixels)));
      uint8_t ring = sin8(dist * 4 - t / 8);
      uint8_t level = ring > 150 ? uint8_t((ring - 150) * 2) : uint8_t(ring / 8);
      leds[i] = CHSV(shiftHue(145, mods.hueShift), 190, level);
    } else if (preset == "lava") {
      uint8_t blob = inoise8(i * 11 + sin8(t / 24), t / 18);
      uint8_t hue = shiftHue(250 + blob / 14, mods.hueShift);
      leds[i] = CHSV(hue, 235, 58 + blob / 2);
    } else if (preset == "rainbow") {
      leds[i] = CHSV(shiftHue((i * 4 + t / 22) & 0xff, mods.hueShift), 190, 220);
    } else if (preset == "sparkle") {
      uint16_t frame = uint16_t(t / 70);
      uint8_t spark = hash8(i * 19u, frame);
      if (spark > 242) leds[i] = CRGB::White;
      else leds[i] = CHSV(shiftHue(160, mods.hueShift), 150, 18 + inoise8(i * 12, t / 30) / 10);
    } else if (preset == "breathe") {
      uint8_t level = beatsin8(uint8_t(12 * mods.speed > 0 ? 12 * mods.speed : 12), 45, 190);
      leds[i] = CHSV(shiftHue(32, mods.hueShift), 90, level);
    } else if (preset == "meteor") {
      uint16_t head = (t / 18) % count;
      uint16_t forward = (i + count - head) % count;
      uint8_t tail = forward > 18 ? 0 : uint8_t(230 - forward * 12);
      leds[i] = CHSV(shiftHue(165, mods.hueShift), tail > 190 ? 40 : 150, tail);
    } else if (preset == "chase") {
      uint16_t head = (t / 16) % count;
      uint16_t distance = min<uint16_t>((i + count - head) % count, (head + count - i) % count);
      uint8_t level = distance > 6 ? 8 : uint8_t(230 - distance * 30);
      leds[i] = CHSV(shiftHue(uint8_t(t / 28), mods.hueShift), 230, level);
    } else if (preset == "scanner") {
      uint16_t head = (t / 28) % max<uint16_t>(1, totalPixels);
      uint16_t distance = abs(int(i) - int(head));
      uint8_t level = distance > 8 ? 0 : 220 - (distance * 24);
      CHSV color(shiftHue(16, mods.hueShift), 200, level);
      leds[i] = color;
    } else if (preset == "candle") {
      uint8_t flicker = qadd8(inoise8(i * 17, t / 4) / 2, inoise8(i * 31 + 80, t / 7) / 3);
      leds[i] = CHSV(shiftHue(22 + flicker / 24, mods.hueShift), 210, 70 + flicker / 2);
    } else if (preset == "lightning") {
      uint16_t frame = uint16_t(t / 110);
      bool strike = hash8(frame, 77) > 218;
      uint8_t bolt = hash8(i * 23u, frame);
      if (strike && bolt > 116) leds[i] = CHSV(shiftHue(164, mods.hueShift), bolt > 224 ? 20 : 80, bolt);
      else leds[i] = CRGB::Black;
    } else if (preset == "neon") {
      uint8_t seg = uint8_t((uint32_t(i) * 7u) / count);
      uint8_t flicker = hash8(seg * 31u, uint16_t(t / 90));
      uint8_t level = flicker > 18 ? 220 : 30;
      leds[i] = CHSV(shiftHue(seg * 36 + t / 80, mods.hueShift), 240, level);
    } else if (preset == "matrix") {
      uint8_t stream = uint8_t((i * 13 + t / 9) % 48);
      uint8_t level = stream < 8 ? uint8_t(230 - stream * 24) : 8;
      leds[i] = CHSV(shiftHue(96, mods.hueShift), stream < 2 ? 40 : 240, level);
    } else if (preset == "heartbeat") {
      uint8_t phase = uint8_t((t / 5) & 0xff);
      uint8_t p1 = phase < 26 ? uint8_t(230 - phase * 7) : 0;
      uint8_t p2 = phase > 42 && phase < 68 ? uint8_t(170 - (phase - 42) * 5) : 0;
      leds[i] = CHSV(shiftHue(252, mods.hueShift), 240, max<uint8_t>(18, max<uint8_t>(p1, p2)));
    } else if (preset == "stained") {
      uint8_t cell = inoise8(i * 42, 12);
      uint8_t vein = abs(int(cell) - 128) < 18 ? 24 : 180;
      leds[i] = CHSV(shiftHue(cell + t / 90, mods.hueShift), 220, vein);
    } else if (preset == "confetti") {
      uint16_t frame = uint16_t(t / 85);
      uint8_t seed = hash8(i * 29u, frame);
      if (seed > 232) leds[i] = CHSV(shiftHue(hash8(i * 9u, frame + 31), mods.hueShift), 230, 230);
      else leds[i] = CRGB::Black;
    } else if (preset == "warp") {
      int mid = int(totalPixels) / 2;
      uint8_t dist = uint8_t(min(255, abs(int(i) - mid) * 510 / max<int>(1, totalPixels)));
      uint8_t streak = sin8(dist * 5 - t / 5);
      uint8_t level = streak > 185 ? uint8_t((streak - 185) * 3) : uint8_t(streak / 12);
      leds[i] = CHSV(shiftHue(166, mods.hueShift), level > 180 ? 30 : 120, level);
    } else if (preset == "pulse-ring") {
      int mid = int(totalPixels) / 2;
      uint8_t dist = uint8_t(min(255, abs(int(i) - mid) * 510 / max<int>(1, totalPixels)));
      uint8_t pulse = sin8(dist * 3 - t / 7);
      uint8_t level = pulse > 145 ? uint8_t((pulse - 145) * 2) : 8;
      leds[i] = CHSV(shiftHue(218, mods.hueShift), 220, level);
    } else if (preset == "blocks") {
      uint8_t block = uint8_t((i / 6 + t / 360) % 6);
      leds[i] = CHSV(shiftHue(block * 42, mods.hueShift), 220, 180);
    } else if (preset == "bloom") {
      int mid = int(totalPixels) / 2;
      uint8_t dist = uint8_t(min(255, abs(int(i) - mid) * 510 / max<int>(1, totalPixels)));
      uint8_t bloom = qsub8(255, dist);
      uint8_t pulse = sin8(t / 16);
      leds[i] = CHSV(shiftHue(226 + bloom / 12, mods.hueShift), 155, 42 + scale8(bloom, pulse));
    } else if (preset == "calm") {
      uint8_t level = beatsin8(5, 38, 150);
      uint8_t wave = sin8(i * 5 + t / 32);
      leds[i] = CHSV(shiftHue(132 + wave / 10, mods.hueShift), 110, level);
    } else if (preset == "drift") {
      uint8_t hue = shiftHue(uint8_t(pos + t / 80), mods.hueShift);
      uint8_t level = 105 + sin8(i * 4 + t / 30) / 3;
      leds[i] = CHSV(hue, 105, level);
    } else if (preset == "sunset") {
      // Slow gradient that drifts through warm hues: deep magenta to
      // orange to gold. Position-dependent base, time-dependent drift.
      uint8_t drift = uint8_t(t / 60);
      uint8_t pos = uint8_t((i * 256 / max<uint16_t>(1, totalPixels)) + drift);
      // Map 0..255 onto 220..32 (magenta through red/orange to gold)
      uint8_t hue = 220 - uint8_t((uint16_t(pos) * 188) / 255);
      uint8_t sat = 210 + (sin8(pos * 2) / 16);
      uint8_t val = 140 + (sin8(pos) / 4);
      leds[i] = CHSV(shiftHue(hue, mods.hueShift), sat, val);
    } else if (preset == "twinkle") {
      // Dim warm base with random sparkles. Each pixel has a pseudo-random
      // time offset that periodically peaks. Reads like a fireplace.
      uint8_t baseHue = shiftHue(24, mods.hueShift);
      uint8_t base = 36 + (inoise8(i * 30, t / 12) / 8);
      uint8_t sparkPhase = uint8_t((t / 6) + (i * 47));
      uint8_t sparkle = sin8(sparkPhase);
      uint8_t boost = sparkle > 200 ? uint8_t((sparkle - 200) * 3) : 0;
      leds[i] = CHSV(baseHue, 220, qadd8(base, boost));
    } else if (preset == "wave") {
      // Structured sinusoidal motion: clean palette ride, no chaos.
      uint8_t phase = uint8_t(i * 8 + t / 14);
      uint8_t wave = sin8(phase);
      uint8_t hue = shiftHue(140 + (wave / 4), mods.hueShift);
      leds[i] = CHSV(hue, 180, 90 + (wave / 2));
    } else {
      // Default / aurora — teal wave.
      uint8_t wave = sin8(i * 6 + t / 18);
      uint8_t hue = shiftHue(118 + (wave / 5), mods.hueShift);
      leds[i] = CHSV(hue, 135 + (wave / 5), 120 + (wave / 3));
    }
  }
  applyGlobalColorModifiers(leds, totalPixels, t, mods);
  return true;
}

bool renderPresetPattern(const String& preset, CRGB* leds, uint16_t totalPixels, const PatternModifiers& mods) {
  if (preset == "blackout" || preset == "off") {
    fill_solid(leds, totalPixels, CRGB::Black);
    return true;
  }
  if (preset == "test-red" || preset == "red") {
    fill_solid(leds, totalPixels, CRGB::Red);
    return true;
  }
  if (preset == "test-green" || preset == "green") {
    fill_solid(leds, totalPixels, CRGB::Green);
    return true;
  }
  if (preset == "test-blue" || preset == "blue") {
    fill_solid(leds, totalPixels, CRGB::Blue);
    return true;
  }
  if (preset == "test-white" || preset == "white") {
    fill_solid(leds, totalPixels, CRGB::White);
    return true;
  }
  // Hue-shifted whites: warm-white at hue 32, cool-white at hue 160, photo-white at hue 28
  uint8_t baseHue = 32;
  uint8_t saturation = 80;
  uint8_t value = 220;
  if (preset == "cool-white") { baseHue = 160; saturation = 90; }
  else if (preset == "photo-white") { baseHue = 28; saturation = 60; }
  CHSV color(shiftHue(baseHue, mods.hueShift), saturation, value);
  fill_solid(leds, totalPixels, color);
  applyGlobalColorModifiers(leds, totalPixels, millis(), mods);
  return true;
}
