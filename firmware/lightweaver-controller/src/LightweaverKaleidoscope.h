#pragma once

#include <cstdint>

constexpr uint8_t LW_MAX_KALEIDOSCOPE_MAPPINGS = 32;
constexpr uint8_t LW_MAX_KALEIDOSCOPE_SPANS = 4;
constexpr uint8_t LW_KALEIDOSCOPE_REFLECTION_POINTS_VERSION = 1;

struct KaleidoscopeSpan {
  uint16_t start = 0;
  uint16_t count = 0;
  uint16_t sourceStart = 0;
  int8_t sourceStep = 1;
};

struct KaleidoscopeSample {
  float reflectionProgress = 0.0f;
  float kaleidoscopeProgress = 0.0f;
  float reflectionDistance = 0.0f;
  uint16_t reflectionSegment = 0;
  int16_t reflectionPoint = -1;
  bool isReflectionPoint = false;
};

struct KaleidoscopePixelLookup {
  int8_t mappingIndex = -1;
  int8_t sourceStep = 1;
  uint16_t sourceLed = 0;
};
static_assert(sizeof(KaleidoscopePixelLookup) == 4,
              "bounded Kaleidoscope pixel lookup must remain four bytes per LED");

template <typename Range>
inline bool kaleidoscopeSpanWithinRanges(const KaleidoscopeSpan& span,
                                         const Range* ranges,
                                         uint8_t rangeCount) {
  if (!ranges || rangeCount == 0 || span.count == 0) return false;
  const uint32_t spanEnd = static_cast<uint32_t>(span.start) + span.count;
  for (uint32_t pixel = span.start; pixel < spanEnd; pixel++) {
    bool owned = false;
    for (uint8_t rangeIndex = 0; rangeIndex < rangeCount; rangeIndex++) {
      const uint32_t rangeEnd =
          static_cast<uint32_t>(ranges[rangeIndex].start) + ranges[rangeIndex].count;
      if (pixel >= ranges[rangeIndex].start && pixel < rangeEnd) {
        owned = true;
        break;
      }
    }
    if (!owned) return false;
  }
  return true;
}

inline void clearKaleidoscopePixelLookup(KaleidoscopePixelLookup* lookup,
                                         uint16_t pixelCount) {
  if (!lookup) return;
  for (uint16_t pixel = 0; pixel < pixelCount; pixel++) {
    lookup[pixel] = KaleidoscopePixelLookup{};
  }
}

inline bool applyKaleidoscopeSpanToLookup(KaleidoscopePixelLookup* lookup,
                                          uint16_t globalPixelCount,
                                          uint8_t mappingIndex,
                                          const KaleidoscopeSpan& span) {
  if (!lookup || mappingIndex > 127 || span.count == 0 ||
      static_cast<uint32_t>(span.start) + span.count > globalPixelCount ||
      (span.sourceStep != 1 && span.sourceStep != -1)) return false;
  for (uint16_t offset = 0; offset < span.count; offset++) {
    if (lookup[span.start + offset].mappingIndex >= 0) return false;
    const int32_t source = static_cast<int32_t>(span.sourceStart) +
        static_cast<int32_t>(offset) * span.sourceStep;
    if (source < 0 || source > UINT16_MAX) return false;
  }
  for (uint16_t offset = 0; offset < span.count; offset++) {
    KaleidoscopePixelLookup& entry = lookup[span.start + offset];
    entry.mappingIndex = static_cast<int8_t>(mappingIndex);
    entry.sourceStep = span.sourceStep;
    entry.sourceLed = static_cast<uint16_t>(
        static_cast<int32_t>(span.sourceStart) +
        static_cast<int32_t>(offset) * span.sourceStep);
  }
  return true;
}

template <typename Mapping>
inline bool replaceKaleidoscopePixelLookup(KaleidoscopePixelLookup* lookup,
                                            uint16_t globalPixelCount,
                                            const Mapping* mappings,
                                            uint8_t mappingCount) {
  if (!lookup || (mappingCount > 0 && !mappings)) return false;
  clearKaleidoscopePixelLookup(lookup, globalPixelCount);
  for (uint8_t mappingIndex = 0; mappingIndex < mappingCount; mappingIndex++) {
    if (mappings[mappingIndex].spanCount > LW_MAX_KALEIDOSCOPE_SPANS) {
      clearKaleidoscopePixelLookup(lookup, globalPixelCount);
      return false;
    }
    for (uint8_t spanIndex = 0;
         spanIndex < mappings[mappingIndex].spanCount; spanIndex++) {
      if (!applyKaleidoscopeSpanToLookup(
              lookup, globalPixelCount, mappingIndex,
              mappings[mappingIndex].spans[spanIndex])) {
        clearKaleidoscopePixelLookup(lookup, globalPixelCount);
        return false;
      }
    }
  }
  return true;
}

inline bool kaleidoscopeSpansOverlapGlobal(const KaleidoscopeSpan* left,
                                           uint8_t leftCount,
                                           const KaleidoscopeSpan* right,
                                           uint8_t rightCount) {
  if (!left || !right) return false;
  for (uint8_t leftIndex = 0; leftIndex < leftCount; leftIndex++) {
    const uint32_t leftEnd = static_cast<uint32_t>(left[leftIndex].start) + left[leftIndex].count;
    for (uint8_t rightIndex = 0; rightIndex < rightCount; rightIndex++) {
      const uint32_t rightEnd = static_cast<uint32_t>(right[rightIndex].start) + right[rightIndex].count;
      if (left[leftIndex].start < rightEnd && right[rightIndex].start < leftEnd) return true;
    }
  }
  return false;
}

inline bool validateKaleidoscopeSpans(const KaleidoscopeSpan* spans,
                                      uint8_t spanCount,
                                      uint16_t pixelCount,
                                      uint16_t globalPixelCount) {
  if (!spans || spanCount == 0 || spanCount > LW_MAX_KALEIDOSCOPE_SPANS ||
      pixelCount == 0 || globalPixelCount == 0) return false;
  uint32_t coveredSources = 0;
  for (uint8_t index = 0; index < spanCount; index++) {
    const KaleidoscopeSpan& span = spans[index];
    if (span.count == 0 || span.start >= globalPixelCount ||
        static_cast<uint32_t>(span.start) + span.count > globalPixelCount ||
        span.sourceStart >= pixelCount ||
        (span.sourceStep != 1 && span.sourceStep != -1)) return false;
    const int32_t sourceEnd = static_cast<int32_t>(span.sourceStart) +
        static_cast<int32_t>(span.count - 1U) * span.sourceStep;
    if (sourceEnd < 0 || sourceEnd >= pixelCount) return false;
    coveredSources += span.count;

    const uint16_t sourceLow = sourceEnd < span.sourceStart
        ? static_cast<uint16_t>(sourceEnd) : span.sourceStart;
    const uint16_t sourceHigh = sourceEnd > span.sourceStart
        ? static_cast<uint16_t>(sourceEnd) : span.sourceStart;
    for (uint8_t previous = 0; previous < index; previous++) {
      const KaleidoscopeSpan& other = spans[previous];
      if (kaleidoscopeSpansOverlapGlobal(&span, 1, &other, 1)) return false;
      const int32_t otherSourceEnd = static_cast<int32_t>(other.sourceStart) +
          static_cast<int32_t>(other.count - 1U) * other.sourceStep;
      const uint16_t otherLow = otherSourceEnd < other.sourceStart
          ? static_cast<uint16_t>(otherSourceEnd) : other.sourceStart;
      const uint16_t otherHigh = otherSourceEnd > other.sourceStart
          ? static_cast<uint16_t>(otherSourceEnd) : other.sourceStart;
      if (sourceLow <= otherHigh && otherLow <= sourceHigh) return false;
    }
  }
  return coveredSources == pixelCount;
}

inline uint16_t kaleidoscopeModulo(int32_t value, uint16_t modulus) {
  if (modulus == 0) return 0;
  int32_t result = value % static_cast<int32_t>(modulus);
  if (result < 0) result += modulus;
  return static_cast<uint16_t>(result);
}

inline uint16_t kaleidoscopeForwardDistance(uint16_t from, uint16_t to,
                                             uint16_t pixelCount) {
  return kaleidoscopeModulo(static_cast<int32_t>(to) - from, pixelCount);
}

inline bool deriveKaleidoscopePoints(uint16_t pixelCount, uint16_t pointCount,
                                     uint16_t startLed, const int16_t* offsets,
                                     uint16_t* orderedPoints) {
  if (!offsets || !orderedPoints || pixelCount < 2 || pointCount < 2 ||
      pointCount > pixelCount || startLed >= pixelCount) return false;
  for (uint16_t index = 0; index < pointCount; index++) {
    if (offsets[index] < -static_cast<int32_t>(pixelCount - 1) ||
        offsets[index] > static_cast<int32_t>(pixelCount - 1)) return false;
    const uint32_t rounded =
        (static_cast<uint32_t>(index) * pixelCount + pointCount / 2U) / pointCount;
    orderedPoints[index] = kaleidoscopeModulo(
        static_cast<int32_t>(startLed) + rounded + offsets[index], pixelCount);
  }
  uint32_t travelled = 0;
  for (uint16_t index = 0; index < pointCount; index++) {
    const uint16_t distance = kaleidoscopeForwardDistance(
        orderedPoints[index], orderedPoints[(index + 1U) % pointCount], pixelCount);
    if (distance == 0) return false;
    travelled += distance;
  }
  return travelled == pixelCount;
}

inline KaleidoscopeSample sampleKaleidoscope(uint16_t pixelCount,
                                             const uint16_t* orderedPoints,
                                             uint16_t pointCount,
                                             uint16_t sourceLed) {
  KaleidoscopeSample sample;
  if (!orderedPoints || pixelCount == 0 || pointCount == 0) return sample;
  const uint16_t led = sourceLed % pixelCount;
  const uint16_t origin = orderedPoints[0];
  const uint16_t targetDistance = kaleidoscopeForwardDistance(origin, led, pixelCount);

  uint16_t low = 0;
  uint16_t high = pointCount;
  while (low < high) {
    const uint16_t middle = static_cast<uint16_t>(low + (high - low) / 2U);
    const uint16_t pointDistance =
        kaleidoscopeForwardDistance(origin, orderedPoints[middle], pixelCount);
    if (pointDistance <= targetDistance) low = static_cast<uint16_t>(middle + 1U);
    else high = middle;
  }
  const uint16_t segment = low == 0 ? static_cast<uint16_t>(pointCount - 1U)
                                    : static_cast<uint16_t>(low - 1U);
  const uint16_t next = static_cast<uint16_t>((segment + 1U) % pointCount);
  const uint16_t start = orderedPoints[segment];
  const uint16_t length = kaleidoscopeForwardDistance(start, orderedPoints[next], pixelCount);
  if (length == 0) return sample;
  const bool exact = led == start;
  const uint16_t fromStart = exact ? 0 : kaleidoscopeForwardDistance(start, led, pixelCount);
  const uint16_t fromEnd = static_cast<uint16_t>(length - fromStart);

  sample.reflectionProgress = static_cast<float>(fromStart) / length;
  sample.kaleidoscopeProgress = segment % 2U == 0
      ? sample.reflectionProgress : 1.0f - sample.reflectionProgress;
  const float distance = 2.0f * static_cast<float>(fromStart < fromEnd ? fromStart : fromEnd) /
                         static_cast<float>(length);
  sample.reflectionDistance = distance > 1.0f ? 1.0f : distance;
  sample.reflectionSegment = segment;
  sample.isReflectionPoint = exact;
  sample.reflectionPoint = exact ? static_cast<int16_t>(segment)
      : fromStart == fromEnd ? -1
      : static_cast<int16_t>(fromStart < fromEnd ? segment : next);
  return sample;
}

inline bool kaleidoscopeSpanSourceLed(const KaleidoscopeSpan& span,
                                      uint16_t localIndex,
                                      uint16_t pixelCount,
                                      uint16_t& sourceLed) {
  if (pixelCount == 0 || localIndex >= span.count ||
      (span.sourceStep != 1 && span.sourceStep != -1)) return false;
  sourceLed = kaleidoscopeModulo(
      static_cast<int32_t>(span.sourceStart) +
          static_cast<int32_t>(localIndex) * span.sourceStep,
      pixelCount);
  return true;
}
