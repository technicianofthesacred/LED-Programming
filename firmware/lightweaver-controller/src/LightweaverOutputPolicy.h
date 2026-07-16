#pragma once

#include <cmath>
#include <cstdint>

enum OutputSourceClass : uint8_t {
  OUTPUT_LOCAL = 0,
  OUTPUT_EXTERNAL = 1,
};

struct OutputBrightnessInputs {
  float brightnessLimit = 1.0f;
  float lookBrightness = 1.0f;
  float fadeScale = 1.0f;
  float knob = 1.0f;
  float manualBrightness = 1.0f;
  bool blackedOut = false;
};

inline float clampOutputUnit(float value) {
  if (!std::isfinite(value) || value <= 0.0f) return 0.0f;
  return value >= 1.0f ? 1.0f : value;
}

inline uint8_t composeOutputBrightness(
    const OutputBrightnessInputs& input,
    OutputSourceClass source) {
  if (input.blackedOut) return 0;

  float scale = clampOutputUnit(input.brightnessLimit) *
                clampOutputUnit(input.knob) *
                clampOutputUnit(input.manualBrightness);
  if (source == OUTPUT_LOCAL) {
    scale *= clampOutputUnit(input.lookBrightness) *
             clampOutputUnit(input.fadeScale);
  }

  return static_cast<uint8_t>(std::lround(clampOutputUnit(scale) * 255.0f));
}
