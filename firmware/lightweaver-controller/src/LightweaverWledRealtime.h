#pragma once

#include <Arduino.h>
#include <FastLED.h>

// Listens on UDP port 21324 (WLED realtime default) for DRGB-format frames
// and writes them directly into the global leds[] buffer. Only the DRGB
// mode (protocol byte = 2) is supported in this firmware; other realtime
// modes (DNRGB, WARLS, DDP, etc.) are logged and dropped.
//
// Call setupWledRealtime() once from setup() after WiFi has joined.
// Call handleWledRealtime() every loop() iteration. The listener will
// mark the frame source as FRAME_WLED_REALTIME whenever it accepts a
// packet, scale pixels by the customer's manualBrightness so the
// downstream FastLED.setBrightness() compositing still feels right, and
// otherwise stay silent.

void setupWledRealtime(CRGB* leds, uint16_t totalPixels);
void handleWledRealtime();
