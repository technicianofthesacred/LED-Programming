#include <cassert>
#include <cstdint>

#include "../src/LightweaverWledRealtimePolicy.h"

struct TestPixel {
  uint8_t r;
  uint8_t g;
  uint8_t b;
};

static void assertPixel(const TestPixel& pixel, uint8_t r, uint8_t g, uint8_t b) {
  assert(pixel.r == r);
  assert(pixel.g == g);
  assert(pixel.b == b);
}

int main() {
  const uint8_t incoming[] = {1, 2, 3, 4, 5, 6};

  assert(wledRealtimeShouldClearTail(1, 1, false));
  assert(!wledRealtimeShouldClearTail(1, 1, true));
  assert(wledRealtimeShouldClearTail(0, 1, false));
  assert(wledRealtimeShouldClearTail(2, 1, true));

  TestPixel newEpoch[] = {{90, 91, 92}, {80, 81, 82}, {70, 71, 72}, {60, 61, 62}};
  applyWledRealtimeDrgb(newEpoch, 4, incoming, 2, true);
  assertPixel(newEpoch[0], 1, 2, 3);
  assertPixel(newEpoch[1], 4, 5, 6);
  assertPixel(newEpoch[2], 0, 0, 0);
  assertPixel(newEpoch[3], 0, 0, 0);

  TestPixel sameSource[] = {{90, 91, 92}, {80, 81, 82}, {70, 71, 72}, {60, 61, 62}};
  applyWledRealtimeDrgb(sameSource, 4, incoming, 2, false);
  assertPixel(sameSource[0], 1, 2, 3);
  assertPixel(sameSource[1], 4, 5, 6);
  assertPixel(sameSource[2], 70, 71, 72);
  assertPixel(sameSource[3], 60, 61, 62);

  return 0;
}
