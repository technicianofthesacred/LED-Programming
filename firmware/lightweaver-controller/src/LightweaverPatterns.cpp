#include "LightweaverPatterns.h"

bool renderProceduralPattern(const String& preset, CRGB* leds, uint16_t totalPixels, uint32_t now) {
  for (uint16_t i = 0; i < totalPixels; i++) {
    if (preset == "ember") {
      uint8_t flicker = inoise8(i * 18, now / 7);
      CRGB color = CRGB(190, 48, 8);
      color.nscale8(120 + (flicker / 2));
      leds[i] = color;
    } else if (preset == "rainbow") {
      leds[i] = CHSV((i * 4 + now / 22) & 0xff, 190, 220);
    } else if (preset == "breathe") {
      uint8_t level = beatsin8(12, 45, 190);
      leds[i] = CHSV(32, 90, level);
    } else if (preset == "scanner") {
      uint16_t head = (now / 28) % max<uint16_t>(1, totalPixels);
      uint16_t distance = abs(int(i) - int(head));
      uint8_t level = distance > 8 ? 0 : 220 - (distance * 24);
      leds[i] = CRGB(level, level / 3, 12);
    } else {
      uint8_t wave = sin8(i * 6 + now / 18);
      uint8_t hue = 118 + (wave / 5);
      leds[i] = CHSV(hue, 135 + (wave / 5), 120 + (wave / 3));
    }
  }
  return true;
}

bool renderPresetPattern(const String& preset, CRGB* leds, uint16_t totalPixels) {
  CRGB color = CRGB(255, 170, 92);
  if (preset == "blackout" || preset == "off") color = CRGB::Black;
  else if (preset == "test-red" || preset == "red") color = CRGB::Red;
  else if (preset == "test-green" || preset == "green") color = CRGB::Green;
  else if (preset == "test-blue" || preset == "blue") color = CRGB::Blue;
  else if (preset == "cool-white") color = CRGB(190, 210, 255);
  else if (preset == "photo-white") color = CRGB(255, 238, 210);
  fill_solid(leds, totalPixels, color);
  return true;
}
