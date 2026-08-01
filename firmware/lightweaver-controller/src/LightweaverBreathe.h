#pragma once
#include <cmath>
#include <cstdint>

inline uint8_t resolveBreatheScale(uint32_t nowMs, uint8_t lowerPct, uint8_t upperPct, uint8_t cycleSeconds) {
  const uint32_t periodMs = uint32_t(cycleSeconds) * 1000U;
  const float phase = float(nowMs % periodMs) / float(periodMs);
  const float eased = 0.5f - 0.5f * std::cos(phase * 6.28318530717958647692f);
  const float pct = float(lowerPct) + float(upperPct - lowerPct) * eased;
  return static_cast<uint8_t>(std::lround(pct * 255.0f / 100.0f));
}
