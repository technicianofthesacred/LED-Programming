#pragma once

#include <stddef.h>
#include <stdint.h>

// Apply one validated .lwseq RGB frame to the logical LED canvas. Sequence
// bytes are already rendered pixels, so this seam intentionally performs no
// procedural coordinate mapping (including Kaleidoscope folding).
template <typename Pixel>
inline bool applySequenceRgbFrame(Pixel* leds,
                                  uint16_t totalPixels,
                                  const uint8_t* rgb,
                                  size_t frameBytes) {
  const size_t requiredBytes = size_t(totalPixels) * 3U;
  if (leds == nullptr || rgb == nullptr || frameBytes != requiredBytes) {
    return false;
  }
  for (uint16_t index = 0; index < totalPixels; index++) {
    leds[index].r = *rgb++;
    leds[index].g = *rgb++;
    leds[index].b = *rgb++;
  }
  return true;
}
