#pragma once

#include <Arduino.h>
#include <FastLED.h>
#include "LightweaverTypes.h"

struct PatternModifiers {
  float speed = 1.0f;     // 0.25 .. 4.0
  int16_t hueShift = 0;   // -128 .. 128 (added to CHSV hues)
};

bool renderProceduralPattern(const String& preset, CRGB* leds, uint16_t totalPixels, uint32_t now, const PatternModifiers& mods);
bool renderPresetPattern(const String& preset, CRGB* leds, uint16_t totalPixels, const PatternModifiers& mods);
