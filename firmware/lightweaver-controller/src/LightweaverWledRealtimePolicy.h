#pragma once

#include <stdint.h>

inline bool wledRealtimeShouldClearTail(uint8_t priorSource,
                                       uint8_t wledSource,
                                       bool priorSourceStreaming) {
  return priorSource != wledSource || !priorSourceStreaming;
}

// DRGB packets are subset updates only when WLED already owns the canvas. A
// different prior owner means the untouched tail must be cleared before the
// first WLED frame becomes visible.
template <typename Pixel>
inline void applyWledRealtimeDrgb(Pixel* leds,
                                  uint16_t totalPixels,
                                  const uint8_t* rgb,
                                  uint16_t pixels,
                                  bool clearTail) {
  for (uint16_t index = 0; index < pixels; index++) {
    leds[index].r = rgb[0];
    leds[index].g = rgb[1];
    leds[index].b = rgb[2];
    rgb += 3;
  }
  if (clearTail) {
    for (uint16_t index = pixels; index < totalPixels; index++) {
      leds[index].r = 0;
      leds[index].g = 0;
      leds[index].b = 0;
    }
  }
}
