#pragma once

#include <cstdint>

namespace lightweaver {

constexpr std::uint32_t kConfigRestartFallbackMs = 5000;

struct RestartFallbackState {
  bool armed;
  std::uint32_t armedAtMs;

  constexpr RestartFallbackState(bool armedValue = false,
                                 std::uint32_t armedAtValue = 0)
      : armed(armedValue), armedAtMs(armedAtValue) {}
};

constexpr RestartFallbackState armConfigRestartFallback(std::uint32_t nowMs) {
  return {true, nowMs};
}

constexpr bool configRestartFallbackDue(
    const RestartFallbackState& state,
    std::uint32_t nowMs) {
  return state.armed &&
      static_cast<std::uint32_t>(nowMs - state.armedAtMs) >=
          kConfigRestartFallbackMs;
}

}  // namespace lightweaver
