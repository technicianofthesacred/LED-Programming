#pragma once

#include <Arduino.h>
#include <FastLED.h>
#include "LightweaverTypes.h"

bool renderProceduralPattern(const String& preset, CRGB* leds, uint16_t totalPixels, uint32_t now);
bool renderPresetPattern(const String& preset, CRGB* leds, uint16_t totalPixels);
