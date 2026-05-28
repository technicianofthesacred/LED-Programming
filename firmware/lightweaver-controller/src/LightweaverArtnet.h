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
// Customer master brightness (`manualBrightness` in main.cpp) is applied
// per pixel using FastLED's nscale8 — Art-Net streams arrive at full level
// and we attenuate to match the dimmer state. This mirrors the WLED-realtime
// pattern Agent A documents in LightweaverFrameSource.
//
// Every successful packet write calls frameSourceMarkExternal(FRAME_ARTNET)
// so Agent A's priority system can yield the render loop to the stream.

constexpr uint16_t LW_ARTNET_PORT = 6454;
constexpr uint16_t LW_ARTNET_PIXELS_PER_UNIVERSE = 170;

void setupArtnet(CRGB* leds, uint16_t totalPixels);
void handleArtnet();
bool artnetIsConfigured();
void artnetConfigure(const ArtnetUniverseConfig* configs, uint8_t count);
String artnetStatusJson();
