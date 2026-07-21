#pragma once

#include <Arduino.h>
#include <FastLED.h>
#include "LightweaverTypes.h"

struct PatternModifiers {
  float speed = 1.0f;     // 0.25 .. 4.0
  int16_t hueShift = 0;   // -128 .. 128 (added to CHSV hues)
  uint8_t customHue = 32;
  uint8_t customSaturation = 230;
  bool customBreathe = false;
  bool customDrift = false;
  uint8_t driftHueMin = 0;
  uint8_t driftHueMax = 255;
};

bool isSupportedProceduralPattern(const String& patternId);
bool isSupportedPresetPattern(const String& patternId);
bool isSupportedCompiledPattern(const String& patternId);
bool renderNativeRecipe(const lightweaver::NativeRecipe& recipe, CRGB* leds,
                        uint16_t totalPixels, uint32_t now,
                        const PatternModifiers& mods);
bool renderProceduralPattern(const String& preset, CRGB* leds, uint16_t totalPixels, uint32_t now, const PatternModifiers& mods);
bool renderPresetPattern(const String& preset, CRGB* leds, uint16_t totalPixels, const PatternModifiers& mods);
