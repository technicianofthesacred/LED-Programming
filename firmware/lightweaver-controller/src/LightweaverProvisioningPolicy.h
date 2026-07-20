#pragma once

#include <cstddef>
#include <cstdint>

constexpr uint8_t LW_PROVISIONING_CONTRACT_VERSION = 1;
constexpr uint8_t LW_APPROVED_OUTPUT_GPIOS[] = {16, 17, 18, 21};
constexpr size_t LW_APPROVED_OUTPUT_GPIO_COUNT =
    sizeof(LW_APPROVED_OUTPUT_GPIOS) / sizeof(LW_APPROVED_OUTPUT_GPIOS[0]);

enum class ProvisioningPhase : uint8_t {
  Factory = 0,
  Ready = 1,
  Recovering = 2,
};

struct ProvisioningReadinessInputs {
  ProvisioningPhase phase = ProvisioningPhase::Factory;
  bool configValid = false;
  bool knownGoodProject = false;
  bool webServing = false;
  bool outputReady = false;
  bool transitionPending = false;
};

constexpr ProvisioningPhase provisioningPhaseForLoad(
    bool configValid,
    bool knownGoodProject,
    bool corruptionDetected) {
  return corruptionDetected || (configValid && !knownGoodProject)
      ? ProvisioningPhase::Recovering
      : configValid && knownGoodProject
          ? ProvisioningPhase::Ready
          : ProvisioningPhase::Factory;
}

constexpr const char* provisioningPhaseLabel(ProvisioningPhase phase) {
  return phase == ProvisioningPhase::Ready
      ? "ready"
      : phase == ProvisioningPhase::Recovering ? "recovering" : "factory";
}

constexpr bool provisioningCommandReady(const ProvisioningReadinessInputs& input) {
  return input.phase == ProvisioningPhase::Ready &&
         input.configValid &&
         input.knownGoodProject &&
         input.webServing &&
         input.outputReady &&
         !input.transitionPending;
}

inline bool isApprovedProvisioningOutputGpio(uint8_t gpio) {
  for (size_t index = 0; index < LW_APPROVED_OUTPUT_GPIO_COUNT; index++) {
    if (LW_APPROVED_OUTPUT_GPIOS[index] == gpio) return true;
  }
  return false;
}

constexpr bool provisioningZoneSelected(size_t zoneIndex,
                                        bool targetSpecified,
                                        size_t targetZoneIndex,
                                        bool syncZones) {
  return targetSpecified
      ? zoneIndex == targetZoneIndex
      : syncZones || zoneIndex == 0;
}
