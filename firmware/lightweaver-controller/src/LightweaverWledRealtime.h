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
// packet and copy its RGB values unchanged; the shared output policy applies
// brightness once when the frame is shown. Otherwise the listener stays silent.

void setupWledRealtime(CRGB* leds, uint16_t totalPixels);
void handleWledRealtime();

// Re-open the UDP socket after a WiFi reconnect. The socket bound at setup can
// go stale when the STA interface drops and re-associates; call this from the
// connectivity maintenance path so realtime streaming recovers. Art-Net has a
// matching explicit rebind plus its own lazy retry fallback.
void wledRealtimeRebind();
