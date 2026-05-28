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
    if (preset == "ember") {
      uint8_t flicker = inoise8(i * 18, t / 7);
      CHSV color(shiftHue(8, mods.hueShift), 220, 120 + (flicker / 2));
      leds[i] = color;
    } else if (preset == "rainbow") {
      leds[i] = CHSV(shiftHue((i * 4 + t / 22) & 0xff, mods.hueShift), 190, 220);
    } else if (preset == "breathe") {
      uint8_t level = beatsin8(uint8_t(12 * mods.speed > 0 ? 12 * mods.speed : 12), 45, 190);
      leds[i] = CHSV(shiftHue(32, mods.hueShift), 90, level);
    } else if (preset == "scanner") {
      uint16_t head = (t / 28) % max<uint16_t>(1, totalPixels);
      uint16_t distance = abs(int(i) - int(head));
      uint8_t level = distance > 8 ? 0 : 220 - (distance * 24);
      CHSV color(shiftHue(16, mods.hueShift), 200, level);
      leds[i] = color;
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
  // Hue-shifted whites: warm-white at hue 32, cool-white at hue 160, photo-white at hue 28
  uint8_t baseHue = 32;
  uint8_t saturation = 80;
  uint8_t value = 220;
  if (preset == "cool-white") { baseHue = 160; saturation = 90; }
  else if (preset == "photo-white") { baseHue = 28; saturation = 60; }
  CHSV color(shiftHue(baseHue, mods.hueShift), saturation, value);
  fill_solid(leds, totalPixels, color);
  return true;
}
