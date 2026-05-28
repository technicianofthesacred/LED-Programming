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
    } else {
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
