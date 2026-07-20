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

  assert(provisioningControlAdmitted(true));
  assert(!provisioningControlAdmitted(false));

  assert(provisioningStorageReadFailed(ProvisioningStorageState::Error));
  assert(!provisioningStorageReadFailed(ProvisioningStorageState::Absent));
  assert(!provisioningStorageReadFailed(ProvisioningStorageState::Present));
  assert(provisioningMayFallBackToSd(
      ProvisioningStorageState::Absent, ProvisioningStorageState::Absent));
  assert(!provisioningMayFallBackToSd(
      ProvisioningStorageState::Error, ProvisioningStorageState::Absent));
  assert(!provisioningMayFallBackToSd(
      ProvisioningStorageState::Absent, ProvisioningStorageState::Error));
  assert(!provisioningMayFallBackToSd(
      ProvisioningStorageState::Present, ProvisioningStorageState::Absent));
  assert(!provisioningSdProjectKnownGood(true, false));
  assert(!provisioningSdProjectKnownGood(false, true));
  assert(provisioningSdProjectKnownGood(true, true));
  assert(provisioningPhaseForLoad(true, false, false) == ProvisioningPhase::Recovering);

  assert(isApprovedProvisioningOutputGpio(16));
  assert(isApprovedProvisioningOutputGpio(17));
  assert(isApprovedProvisioningOutputGpio(18));
  assert(isApprovedProvisioningOutputGpio(21));
  assert(!isApprovedProvisioningOutputGpio(38));

  assert(provisioningZoneSelected(0, false, 0, false));
  assert(!provisioningZoneSelected(1, false, 0, false));
  assert(provisioningZoneSelected(0, false, 0, true));
  assert(provisioningZoneSelected(1, false, 0, true));
  assert(!provisioningZoneSelected(0, true, 1, true));
  assert(provisioningZoneSelected(1, true, 1, false));

  ProvisioningOperationScopeInputs scope{};
  assert(provisioningOperationScope(scope) == ProvisioningOutputScope::None);
  scope.selectedZones = true;
  assert(provisioningOperationScope(scope) == ProvisioningOutputScope::SelectedZones);
  scope.globalOutputs = true;
  assert(provisioningOperationScope(scope) == ProvisioningOutputScope::AllOutputs);
  scope.globalOutputs = false;
  scope.selectedZones = false;
  scope.syncStateChanged = true;
  assert(provisioningOperationScope(scope) == ProvisioningOutputScope::AllOutputs);
  scope.selectedZones = true;
  assert(provisioningOperationScope(scope) == ProvisioningOutputScope::AllOutputs);

  assert(!provisioningLookStepChangesSelection(0, 0, 1));
  assert(!provisioningLookStepChangesSelection(1, 0, 1));
  assert(!provisioningLookStepChangesSelection(1, 0, -1));
  assert(provisioningLookStepChangesSelection(2, 0, 1));
  assert(provisioningLookStepChangesSelection(2, 0, -1));
  assert(provisioningLookStepChangesSelection(3, 2, 1));
  assert(provisioningLookStepChangesSelection(3, 0, -1));
  assert(!provisioningLookStepChangesSelection(3, 3, 1));
  assert(!provisioningLookStepChangesSelection(3, 0, 0));

  assert(!provisioningCancelStreamEffective(false, false));
  assert(!provisioningCancelStreamEffective(true, false));
  assert(provisioningCancelStreamEffective(true, true));
  assert(!provisioningControlAdvancesRevision(
      false, ProvisioningOutputScope::AllOutputs, 1));
  assert(!provisioningControlAdvancesRevision(
      true, ProvisioningOutputScope::None, 1));
  assert(!provisioningControlAdvancesRevision(
      true, ProvisioningOutputScope::AllOutputs, 0));
  assert(provisioningControlAdvancesRevision(
      true, ProvisioningOutputScope::SelectedZones, 1));
  assert(provisioningControlAdvancesRevision(
      true, ProvisioningOutputScope::AllOutputs, 2));
  return 0;
}
