#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>

#include "../src/LightweaverProvisioningPolicy.h"

int main() {
  static_assert(LW_PROVISIONING_CONTRACT_VERSION == 1, "contract version must remain 1");
  static_assert(LW_APPROVED_OUTPUT_GPIO_COUNT == 4, "exactly four output GPIOs are approved");
  static_assert(LW_APPROVED_OUTPUT_GPIOS[0] == 16, "GPIO order starts at 16");
  static_assert(LW_APPROVED_OUTPUT_GPIOS[1] == 17, "GPIO order continues at 17");
  static_assert(LW_APPROVED_OUTPUT_GPIOS[2] == 18, "GPIO order continues at 18");
  static_assert(LW_APPROVED_OUTPUT_GPIOS[3] == 21, "GPIO order ends at 21");

  assert(provisioningPhaseForLoad(false, false, false) == ProvisioningPhase::Factory);
  assert(provisioningPhaseForLoad(true, true, false) == ProvisioningPhase::Ready);
  assert(provisioningPhaseForLoad(false, false, true) == ProvisioningPhase::Recovering);
  assert(provisioningPhaseForLoad(true, false, false) == ProvisioningPhase::Recovering);

  assert(std::strcmp(provisioningPhaseLabel(ProvisioningPhase::Factory), "factory") == 0);
  assert(std::strcmp(provisioningPhaseLabel(ProvisioningPhase::Ready), "ready") == 0);
  assert(std::strcmp(provisioningPhaseLabel(ProvisioningPhase::Recovering), "recovering") == 0);

  ProvisioningReadinessInputs readiness{};
  readiness.phase = ProvisioningPhase::Ready;
  readiness.configValid = true;
  readiness.knownGoodProject = true;
  readiness.webServing = true;
  readiness.outputReady = true;
  assert(provisioningCommandReady(readiness));

  readiness.outputReady = false;
  assert(!provisioningCommandReady(readiness));
  readiness.outputReady = true;
  readiness.transitionPending = true;
  assert(!provisioningCommandReady(readiness));
  readiness.transitionPending = false;
  readiness.phase = ProvisioningPhase::Factory;
  assert(!provisioningCommandReady(readiness));
  readiness.phase = ProvisioningPhase::Recovering;
  assert(!provisioningCommandReady(readiness));

  assert(isApprovedProvisioningOutputGpio(16));
  assert(isApprovedProvisioningOutputGpio(21));
  assert(!isApprovedProvisioningOutputGpio(38));
  return 0;
}
