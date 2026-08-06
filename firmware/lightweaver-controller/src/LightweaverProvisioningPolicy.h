#pragma once

#include <cstddef>
#include <cstdint>

#include "LightweaverHardwareContract.h"

constexpr uint8_t LW_PROVISIONING_CONTRACT_VERSION = LW_CARD_HARDWARE_CONTRACT_VERSION;
static constexpr const uint8_t (&LW_APPROVED_OUTPUT_GPIOS)[LW_CARD_HARDWARE_OUTPUT_GPIO_COUNT] =
    LW_CARD_HARDWARE_OUTPUT_GPIOS;
constexpr size_t LW_APPROVED_OUTPUT_GPIO_COUNT = LW_CARD_HARDWARE_OUTPUT_GPIO_COUNT;
constexpr uint16_t LW_FACTORY_BEACON_PIXEL_LIMIT = 8;
constexpr uint8_t LW_FACTORY_BEACON_BRIGHTNESS_LIMIT = 24;
constexpr uint32_t LW_FACTORY_BEACON_MAX_MILLIAMPS = 100;
// These four are one rhythm, not four numbers: hold, gap, second pulse, pause.
// Change them together or the flash-twice-then-pause signature stops reading as
// deliberate and starts reading as a fault.
//
// The step was 3000ms back when four approved GPIOs meant a 12-second sweep. The
// pin menu is now 15 (11 after the default controls claim theirs), and at the old
// step that is 33 seconds before an owner watching a freshly flashed card sees
// their port come round — long enough to conclude the card is dead, which is the
// exact misdiagnosis this beacon exists to prevent. Halving the whole rhythm
// restores a ~16-second sweep while keeping two clearly separate pulses per port.
// The tradeoff is real and was made deliberately: each port now holds for 1.5s
// rather than 3s. That is still an unmistakable double-blink at arm's length, but
// it is the floor — going shorter turns the pair into a flicker and the beacon
// stops being readable as "this port, twice, on purpose".
constexpr uint32_t LW_FACTORY_BEACON_STEP_MS = 1500;
constexpr uint32_t LW_FACTORY_BEACON_STEADY_ON_MS = 600;
constexpr uint32_t LW_FACTORY_BEACON_SECOND_ON_START_MS = 800;
constexpr uint32_t LW_FACTORY_BEACON_SECOND_ON_END_MS = 1200;
constexpr uint32_t LW_FACTORY_BEACON_SAFETY_POLL_MS = 100;

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

constexpr bool provisioningOutputReady(bool controllerReady,
                                       size_t outputCount) {
  return controllerReady && outputCount > 0;
}

constexpr bool provisioningUsesFactoryBeacon(ProvisioningPhase phase,
                                              size_t outputCount) {
  return phase == ProvisioningPhase::Factory ||
         (phase == ProvisioningPhase::Recovering && outputCount == 0);
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
  return elapsedInStepMs % LW_FACTORY_BEACON_STEP_MS <
             LW_FACTORY_BEACON_STEADY_ON_MS ||
         (elapsedInStepMs % LW_FACTORY_BEACON_STEP_MS >=
              LW_FACTORY_BEACON_SECOND_ON_START_MS &&
          elapsedInStepMs % LW_FACTORY_BEACON_STEP_MS <
              LW_FACTORY_BEACON_SECOND_ON_END_MS);
}

constexpr bool factoryBeaconMayOwnOutput(
    const FactoryBeaconOwnershipInputs& input) {
  return (input.phase == ProvisioningPhase::Factory ||
          input.phase == ProvisioningPhase::Recovering) &&
         input.outputReady &&
         !input.commandActivity &&
         !input.wifiTransition &&
         !input.candidateActive &&
         !input.discoveryActive &&
         !input.recoveryActive;
}

constexpr bool provisioningFactoryResetMayComplete(bool nvsCleared,
                                                   bool sdCleanupComplete) {
  return nvsCleared && sdCleanupComplete;
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
