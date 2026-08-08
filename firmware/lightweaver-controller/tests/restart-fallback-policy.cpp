#include <cassert>
#include <cstdint>
#include <limits>

#include "../src/LightweaverRestartPolicy.h"

using lightweaver::RestartFallbackState;
using lightweaver::armConfigRestartFallback;
using lightweaver::configRestartFallbackDue;
using lightweaver::kConfigRestartFallbackMs;

static_assert(kConfigRestartFallbackMs == 5000,
              "config restart fallback must remain five seconds");

int main() {
  RestartFallbackState idle{};
  assert(!configRestartFallbackDue(idle, 5000));

  const RestartFallbackState armed = armConfigRestartFallback(idle, 1000);
  assert(armed.armed);
  assert(armed.armedAtMs == 1000);
  const RestartFallbackState rearmed =
      armConfigRestartFallback(armed, 2000);
  assert(rearmed.armed);
  assert(rearmed.armedAtMs == 1000);
  assert(configRestartFallbackDue(
      rearmed, 1000 + kConfigRestartFallbackMs));
  assert(!configRestartFallbackDue(
      armed, 1000 + kConfigRestartFallbackMs - 1));
  assert(configRestartFallbackDue(
      armed, 1000 + kConfigRestartFallbackMs));
  assert(configRestartFallbackDue(
      armed, 1000 + kConfigRestartFallbackMs + 1));

  const std::uint32_t nearWrap =
      std::numeric_limits<std::uint32_t>::max() - 1000;
  const RestartFallbackState wrapped =
      armConfigRestartFallback(RestartFallbackState{}, nearWrap);
  assert(!configRestartFallbackDue(
      wrapped, static_cast<std::uint32_t>(nearWrap + kConfigRestartFallbackMs - 1)));
  assert(configRestartFallbackDue(
      wrapped, static_cast<std::uint32_t>(nearWrap + kConfigRestartFallbackMs)));

  return 0;
}
