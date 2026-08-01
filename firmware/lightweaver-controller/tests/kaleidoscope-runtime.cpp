#include <cassert>
#include <cmath>
#include <cstdint>

#include "LightweaverKaleidoscope.h"

static void expectNear(float actual, float expected) {
  assert(std::fabs(actual - expected) < 0.00001f);
}

struct HostRange {
  uint16_t start;
  uint16_t count;
};

struct HostMapping {
  KaleidoscopeSpan spans[2];
  uint8_t spanCount;
};

static void expectPoints(uint16_t pixelCount, uint16_t pointCount, uint16_t startLed,
                         const int16_t* offsets, const uint16_t* expected) {
  uint16_t points[8] = {};
  assert(deriveKaleidoscopePoints(pixelCount, pointCount, startLed, offsets, points));
  for (uint16_t index = 0; index < pointCount; index++) assert(points[index] == expected[index]);
}

int main() {
  const int16_t offsets4[] = {0, 0, 0, 0};
  const int16_t offsets6[] = {0, 0, 0, 0, 0, 0};
  const int16_t offsets8[] = {0, 0, 0, 0, 0, 0, 0, 0};
  const uint16_t expected4[] = {0, 100, 200, 300};
  const uint16_t expected6[] = {0, 67, 133, 200, 267, 333};
  const uint16_t expected8[] = {0, 50, 100, 150, 200, 250, 300, 350};
  expectPoints(400, 4, 0, offsets4, expected4);
  expectPoints(400, 6, 0, offsets6, expected6);
  expectPoints(400, 8, 0, offsets8, expected8);

  const uint16_t wrapped[] = {300, 0, 100, 200};
  expectPoints(400, 4, 300, offsets4, wrapped);
  const int16_t tunedOffsets[] = {0, -1, 2, 0};
  const uint16_t tuned[] = {0, 99, 202, 300};
  expectPoints(400, 4, 0, tunedOffsets, tuned);
  const int16_t collision[] = {0, -100, 0, 0};
  uint16_t rejected[4] = {};
  assert(!deriveKaleidoscopePoints(400, 4, 0, collision, rejected));

  uint16_t points[4] = {};
  assert(deriveKaleidoscopePoints(400, 4, 0, offsets4, points));
  KaleidoscopeSample exact = sampleKaleidoscope(400, points, 4, 100);
  assert(exact.isReflectionPoint && exact.reflectionSegment == 1 && exact.reflectionPoint == 1);
  expectNear(exact.reflectionProgress, 0.0f);
  expectNear(exact.kaleidoscopeProgress, 1.0f);
  expectNear(exact.reflectionDistance, 0.0f);

  KaleidoscopeSample left = sampleKaleidoscope(400, points, 4, 99);
  assert(!left.isReflectionPoint && left.reflectionSegment == 0 && left.reflectionPoint == 1);
  expectNear(left.reflectionProgress, 0.99f);
  expectNear(left.kaleidoscopeProgress, 0.99f);
  expectNear(left.reflectionDistance, 0.02f);

  KaleidoscopeSample right = sampleKaleidoscope(400, points, 4, 101);
  assert(!right.isReflectionPoint && right.reflectionSegment == 1 && right.reflectionPoint == 1);
  expectNear(right.reflectionProgress, 0.01f);
  expectNear(right.kaleidoscopeProgress, 0.99f);
  expectNear(right.reflectionDistance, 0.02f);

  KaleidoscopeSample mirroredLeft = sampleKaleidoscope(400, points, 4, 25);
  KaleidoscopeSample mirroredRight = sampleKaleidoscope(400, points, 4, 175);
  expectNear(mirroredLeft.kaleidoscopeProgress, mirroredRight.kaleidoscopeProgress);

  uint16_t unevenPoints[6] = {};
  assert(deriveKaleidoscopePoints(400, 6, 0, offsets6, unevenPoints));
  KaleidoscopeSample unevenLeft = sampleKaleidoscope(400, unevenPoints, 6, 20);
  KaleidoscopeSample unevenRight = sampleKaleidoscope(400, unevenPoints, 6, 114);
  expectNear(unevenLeft.kaleidoscopeProgress, 20.0f / 67.0f);
  expectNear(unevenRight.kaleidoscopeProgress, 1.0f - 47.0f / 66.0f);

  uint16_t tunedPoints[4] = {};
  assert(deriveKaleidoscopePoints(400, 4, 0, tunedOffsets, tunedPoints));
  assert(sampleKaleidoscope(400, tunedPoints, 4, 202).isReflectionPoint);
  uint16_t wrappedPoints[4] = {};
  assert(deriveKaleidoscopePoints(400, 4, 300, offsets4, wrappedPoints));
  assert(sampleKaleidoscope(400, wrappedPoints, 4, 0).reflectionPoint == 1);

  KaleidoscopeSpan seamTail{0, 100, 300, 1};
  KaleidoscopeSpan seamHead{100, 300, 0, 1};
  uint16_t sourceLed = 0;
  assert(kaleidoscopeSpanSourceLed(seamTail, 99, 400, sourceLed) && sourceLed == 399);
  assert(kaleidoscopeSpanSourceLed(seamHead, 0, 400, sourceLed) && sourceLed == 0);
  assert(!kaleidoscopeSpanSourceLed(seamTail, 100, 400, sourceLed));

  const KaleidoscopeSpan canonicalSpans[] = {
    {0, 2, 2, 1},
    {2, 2, 0, 1},
  };
  assert(validateKaleidoscopeSpans(canonicalSpans, 2, 4, 4));
  const KaleidoscopeSpan sourceWrap[] = {{0, 4, 2, 1}};
  assert(!validateKaleidoscopeSpans(sourceWrap, 1, 4, 4));
  const KaleidoscopeSpan overlappingGlobal[] = {
    {0, 2, 0, 1},
    {1, 2, 2, 1},
  };
  assert(!validateKaleidoscopeSpans(overlappingGlobal, 2, 4, 4));
  const KaleidoscopeSpan firstMapping[] = {{0, 2, 0, 1}};
  const KaleidoscopeSpan secondMapping[] = {{1, 2, 0, 1}};
  assert(kaleidoscopeSpansOverlapGlobal(firstMapping, 1, secondMapping, 1));

  const HostRange splitZone[] = {{0, 2}, {4, 2}};
  assert(kaleidoscopeSpanWithinRanges(canonicalSpans[0], splitZone, 2));
  const KaleidoscopeSpan splitTail{4, 2, 2, 1};
  assert(kaleidoscopeSpanWithinRanges(splitTail, splitZone, 2));
  const KaleidoscopeSpan crossesZone{2, 2, 0, 1};
  assert(!kaleidoscopeSpanWithinRanges(crossesZone, splitZone, 2));

  KaleidoscopePixelLookup lookup[8];
  clearKaleidoscopePixelLookup(lookup, 8);
  assert(applyKaleidoscopeSpanToLookup(lookup, 8, 3, canonicalSpans[0]));
  assert(applyKaleidoscopeSpanToLookup(lookup, 8, 3, splitTail));
  assert(lookup[0].mappingIndex == 3 && lookup[0].sourceLed == 2 && lookup[0].sourceStep == 1);
  assert(lookup[1].mappingIndex == 3 && lookup[1].sourceLed == 3);
  assert(lookup[2].mappingIndex == -1 && lookup[3].mappingIndex == -1);
  assert(lookup[4].mappingIndex == 3 && lookup[4].sourceLed == 2);
  assert(!applyKaleidoscopeSpanToLookup(lookup, 8, 4, canonicalSpans[0]));

  // A same-wiring config save becomes the live RuntimeConfig before any
  // browser-requested reboot. Replacing its mappings in a continued loop must
  // clear every prior lookup entry rather than leaving stale ownership behind.
  HostMapping initialMappings[1] = {};
  initialMappings[0].spans[0] = KaleidoscopeSpan{0, 2, 0, 1};
  initialMappings[0].spans[1] = KaleidoscopeSpan{4, 2, 2, 1};
  initialMappings[0].spanCount = 2;
  assert(replaceKaleidoscopePixelLookup(lookup, 8, initialMappings, 1));
  assert(lookup[0].mappingIndex == 0 && lookup[1].mappingIndex == 0);
  assert(lookup[4].mappingIndex == 0 && lookup[5].mappingIndex == 0);

  HostMapping savedMappings[1] = {};
  savedMappings[0].spans[0] = KaleidoscopeSpan{2, 2, 0, 1};
  savedMappings[0].spanCount = 1;
  assert(replaceKaleidoscopePixelLookup(lookup, 8, savedMappings, 1));
  assert(lookup[0].mappingIndex == -1 && lookup[1].mappingIndex == -1);
  assert(lookup[2].mappingIndex == 0 && lookup[2].sourceLed == 0);
  assert(lookup[3].mappingIndex == 0 && lookup[3].sourceLed == 1);
  assert(lookup[4].mappingIndex == -1 && lookup[5].mappingIndex == -1);

  return 0;
}
