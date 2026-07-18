#include <cassert>
#include <limits>

#include "../src/LightweaverOutputPolicy.h"

int main() {
  OutputBrightnessInputs input{};
  input.brightnessLimit = 0.45f;
  input.lookBrightness = 0.35f;
  input.fadeScale = 1.0f;
  input.knob = 1.0f;
  input.manualBrightness = 1.0f;

  assert(composeOutputBrightness(input, OUTPUT_LOCAL) == 40);
  assert(composeOutputBrightness(input, OUTPUT_EXTERNAL) == 115);

  input.manualBrightness = 0.5f;
  assert(composeOutputBrightness(input, OUTPUT_EXTERNAL) == 57);

  input.lookBrightness = 0.1f;
  input.fadeScale = 0.1f;
  assert(composeOutputBrightness(input, OUTPUT_EXTERNAL) == 57);

  input.blackedOut = true;
  assert(composeOutputBrightness(input, OUTPUT_LOCAL) == 0);
  assert(composeOutputBrightness(input, OUTPUT_EXTERNAL) == 0);

  assert(clampOutputUnit(std::numeric_limits<float>::quiet_NaN()) == 0.0f);
  assert(clampOutputUnit(-0.1f) == 0.0f);
  assert(clampOutputUnit(0.0f) == 0.0f);
  assert(clampOutputUnit(1.0f) == 1.0f);
  assert(clampOutputUnit(1.1f) == 1.0f);

  return 0;
}
