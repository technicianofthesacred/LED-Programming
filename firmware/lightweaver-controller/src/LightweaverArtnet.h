#pragma once

#include <Arduino.h>
#include <FastLED.h>
#include "LightweaverTypes.h"

// Multi-universe Art-Net (ArtDMX, opcode 0x5000) listener.
//
// Madrix and most lighting software stream up to 170 RGB pixels per universe
// (510 of the 512 DMX channels). The card listens on UDP port 6454, decodes
// any universe in `universes[]`, and writes the RGB triplets into the global
// leds[] buffer at the configured pixel offsets.
//
// Accepted Art-Net RGB values are copied into leds[] unchanged. The shared
// output policy applies brightness once when the completed frame is shown.
//
// Every successful packet write calls frameSourceMarkExternal(FRAME_ARTNET)
// so the priority system can yield the render loop to the stream.

constexpr uint16_t LW_ARTNET_PORT = 6454;
constexpr uint16_t LW_ARTNET_PIXELS_PER_UNIVERSE = 170;

void setupArtnet(CRGB* leds, uint16_t totalPixels);
// Discard stale UDP state and re-open port 6454 after station association.
// Safe to call on every association; handleArtnet retains its lazy fallback.
bool artnetRebind();
bool artnetIsListening();
void handleArtnet();
bool artnetIsConfigured();
void artnetConfigure(const ArtnetUniverseConfig* configs, uint8_t count);
String artnetStatusJson();
