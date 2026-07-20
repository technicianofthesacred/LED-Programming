#pragma once

#include <cstddef>
#include <cstdint>

constexpr uint8_t LW_PROVISIONING_CONTRACT_VERSION = 1;
constexpr uint8_t LW_APPROVED_OUTPUT_GPIOS[] = {16, 17, 18, 21};
constexpr size_t LW_APPROVED_OUTPUT_GPIO_COUNT =
    sizeof(LW_APPROVED_OUTPUT_GPIOS) / sizeof(LW_APPROVED_OUTPUT_GPIOS[0]);
constexpr uint16_t LW_FACTORY_BEACON_PIXEL_LIMIT = 8;
constexpr uint8_t LW_FACTORY_BEACON_BRIGHTNESS_LIMIT = 20;
constexpr uint32_t LW_FACTORY_BEACON_MAX_MILLIAMPS = 100;
constexpr uint32_t LW_FACTORY_BEACON_STEP_MS = 1200;

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

enum class ProvisioningOutputScope : uint8_t {
  None = 0,
  SelectedZones = 1,
  AllOutputs = 2,
};

enum class ProvisioningStorageState : uint8_t {
  Absent = 0,
  Present = 1,
  Error = 2,
};

struct ProvisioningOperationScopeInputs {
  bool globalOutputs = false;
  bool selectedZones = false;
  bool syncStateChanged = false;
};

struct FactoryBeaconOwnershipInputs {
  ProvisioningPhase phase = ProvisioningPhase::Factory;
  bool outputReady = false;
  bool commandActivity = false;
  bool wifiTransition = false;
  bool candidateActive = false;
  bool discoveryActive = false;
  bool recoveryActive = false;
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

constexpr bool provisioningControlAdmitted(bool commandReady) {
  return commandReady;
}

constexpr bool provisioningStorageReadFailed(ProvisioningStorageState state) {
  return state == ProvisioningStorageState::Error;
}

constexpr bool provisioningMayFallBackToSd(ProvisioningStorageState migrationState,
                                           ProvisioningStorageState knownGoodState) {
  return migrationState == ProvisioningStorageState::Absent &&
         knownGoodState == ProvisioningStorageState::Absent;
}

constexpr bool provisioningSdProjectKnownGood(bool strictConfigValid,
                                              bool exactIdentityAccepted) {
  return strictConfigValid && exactIdentityAccepted;
}

constexpr bool provisioningCancelStreamEffective(bool cancelRequested,
                                                 bool streamActive) {
  return cancelRequested && streamActive;
}

constexpr bool provisioningControlAdvancesRevision(bool commandAdmitted,
                                                   ProvisioningOutputScope scope,
                                                   size_t affectedOutputCount) {
  return commandAdmitted &&
         scope != ProvisioningOutputScope::None &&
         affectedOutputCount > 0;
}

inline bool isApprovedProvisioningOutputGpio(uint8_t gpio) {
  for (size_t index = 0; index < LW_APPROVED_OUTPUT_GPIO_COUNT; index++) {
    if (LW_APPROVED_OUTPUT_GPIOS[index] == gpio) return true;
  }
  return false;
}

constexpr uint8_t factoryBeaconPinForStep(size_t step) {
  return LW_APPROVED_OUTPUT_GPIOS[step % LW_APPROVED_OUTPUT_GPIO_COUNT];
}

constexpr bool factoryBeaconPulseOn(uint32_t elapsedInStepMs) {
  return elapsedInStepMs % LW_FACTORY_BEACON_STEP_MS < 120 ||
         (elapsedInStepMs % LW_FACTORY_BEACON_STEP_MS >= 240 &&
          elapsedInStepMs % LW_FACTORY_BEACON_STEP_MS < 360);
}

constexpr bool factoryBeaconMayOwnOutput(
    const FactoryBeaconOwnershipInputs& input) {
  return input.phase == ProvisioningPhase::Factory &&
         input.outputReady &&
         !input.commandActivity &&
         !input.wifiTransition &&
         !input.candidateActive &&
         !input.discoveryActive &&
         !input.recoveryActive;
}

constexpr bool provisioningFactoryResetMayComplete(bool sdConfigExists,
                                                   bool sdConfigRemoved,
                                                   bool nvsCleared) {
  return (!sdConfigExists || sdConfigRemoved) && nvsCleared;
}

constexpr bool provisioningZoneSelected(size_t zoneIndex,
                                        bool targetSpecified,
                                        size_t targetZoneIndex,
                                        bool syncZones) {
  return targetSpecified
      ? zoneIndex == targetZoneIndex
      : syncZones || zoneIndex == 0;
}

// A sync-state change alters the command fan-out contract for every active
// output, even when it does not immediately write a pixel. Mixed commands use
// the union: any global/sync-state operation promotes the scope to all outputs.
constexpr ProvisioningOutputScope provisioningOperationScope(
    const ProvisioningOperationScopeInputs& input) {
  return input.globalOutputs || input.syncStateChanged
      ? ProvisioningOutputScope::AllOutputs
      : input.selectedZones
          ? ProvisioningOutputScope::SelectedZones
          : ProvisioningOutputScope::None;
}

constexpr bool provisioningLookStepChangesSelection(size_t lookCount,
                                                    size_t currentLookIndex,
                                                    int8_t direction) {
  return lookCount >= 2 &&
         currentLookIndex < lookCount &&
         direction != 0 &&
         (direction > 0
              ? (currentLookIndex + 1) % lookCount
              : (currentLookIndex + lookCount - 1) % lookCount) != currentLookIndex;
}
