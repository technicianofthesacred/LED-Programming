#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>

#include "../src/LightweaverProvisioningPolicy.h"

int main() {
  static_assert(LW_PROVISIONING_CONTRACT_VERSION == 1, "contract version must remain 1");
  // This used to pin the literal four-GPIO list {16,17,18,21}. The pin menu was
  // widened to 15 and these assertions went stale without anyone noticing,
  // because nothing runs this file — it is compiled by hand (see
  // docs/superpowers/plans/2026-07-20-lightweaver-repeatable-card-provisioning.md).
  // Pinning the exact list here duplicated the generated header anyway; the
  // header IS generated from packages/lightweaver-contract/card-hardware.json,
  // and hardware-capability-contract.mjs already checks the two agree. So assert
  // the PROPERTIES the beacon and discovery depend on instead, which stay true
  // however the menu is edited.
  static_assert(LW_APPROVED_OUTPUT_GPIO_COUNT > 0,
                "at least one output GPIO must be approved or a blank card can show nothing");
  static_assert(LW_APPROVED_OUTPUT_GPIO_COUNT <= 32,
                "the beacon indexes steps as uint8_t and allocates one slice per approved GPIO");
  for (size_t i = 1; i < LW_APPROVED_OUTPUT_GPIO_COUNT; i++) {
    // Ascending and duplicate-free: factoryBeaconPinForStep maps step -> pin by
    // index, so a repeated pin would silently make two beacon steps drive the
    // same port and an owner would count a port that is not there.
    assert(LW_APPROVED_OUTPUT_GPIOS[i] > LW_APPROVED_OUTPUT_GPIOS[i - 1]);
  }

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

  // 38 used to be asserted as REJECTED, back when it was discovery-only. The
  // widened pin menu approves it deliberately, so that assertion was stale.
  // What replaces it is the set that must never become approved, because these
  // are not policy choices — the chip stops working:
  //
  //  26-32  SPI flash. Driving one bricks the running image.
  //  33-37  Octal PSRAM. This build ENABLED PSRAM (qio_opi) and the pixel
  //         buffers now live there, so these went from merely unwise to fatal
  //         in the same change that widened the menu. This is the assertion
  //         that earns its keep.
  //  19-20  Native USB D-/D+; the flash and serial path Studio depends on.
  //  0, 45, 46  Strapping pins latched at reset; an LED pulling one changes
  //         boot mode or flash voltage on the NEXT power cycle, which presents
  //         as a card that dies when the gallery switches the lights off.
  for (uint8_t gpio = 26; gpio <= 37; gpio++) {
    assert(!isApprovedProvisioningOutputGpio(gpio));
  }
  assert(!isApprovedProvisioningOutputGpio(19));
  assert(!isApprovedProvisioningOutputGpio(20));
  assert(!isApprovedProvisioningOutputGpio(0));
  assert(!isApprovedProvisioningOutputGpio(45));
  assert(!isApprovedProvisioningOutputGpio(46));

  static_assert(LW_FACTORY_BEACON_PIXEL_LIMIT == 8,
                "factory beacon must remain bounded to eight pixels");
  static_assert(LW_FACTORY_BEACON_BRIGHTNESS_LIMIT == 24,
                "factory beacon must use the brightest approved bench-safe level");
  static_assert(LW_FACTORY_BEACON_MAX_MILLIAMPS <= 100,
                "factory beacon must retain a conservative current ceiling");
  // Halved from 3000 when the pin menu grew to 15 GPIOs: at the old step an
  // owner waited 33s for their port to come round and read the card as dead.
  // 1500 is the floor for a readable double-blink — below it the two pulses
  // merge into a flicker and the beacon stops looking deliberate.
  static_assert(LW_FACTORY_BEACON_STEP_MS == 1500,
                "each output must remain selected long enough to inspect on a bench");
  static_assert(LW_FACTORY_BEACON_SECOND_ON_END_MS < LW_FACTORY_BEACON_STEP_MS,
                "the second pulse must finish inside its own step or ports bleed together");
  static_assert(LW_FACTORY_BEACON_STEADY_ON_MS < LW_FACTORY_BEACON_SECOND_ON_START_MS,
                "the two pulses must be separated by a visible gap");
  for (size_t step = 0; step < LW_APPROVED_OUTPUT_GPIO_COUNT; step++) {
    assert(factoryBeaconPinForStep(step) == LW_APPROVED_OUTPUT_GPIOS[step]);
  }
  assert(factoryBeaconPinForStep(LW_APPROVED_OUTPUT_GPIO_COUNT) ==
         LW_APPROVED_OUTPUT_GPIOS[0]);

  FactoryBeaconOwnershipInputs beacon{};
  beacon.phase = ProvisioningPhase::Factory;
  beacon.outputReady = true;
  assert(factoryBeaconMayOwnOutput(beacon));
  beacon.commandActivity = true;
  assert(!factoryBeaconMayOwnOutput(beacon));
  beacon.commandActivity = false;
  beacon.wifiTransition = true;
  assert(!factoryBeaconMayOwnOutput(beacon));
  beacon.wifiTransition = false;
  beacon.candidateActive = true;
  assert(!factoryBeaconMayOwnOutput(beacon));
  beacon.candidateActive = false;
  beacon.discoveryActive = true;
  assert(!factoryBeaconMayOwnOutput(beacon));
  beacon.discoveryActive = false;
  beacon.recoveryActive = true;
  assert(!factoryBeaconMayOwnOutput(beacon));
  beacon.recoveryActive = false;
  beacon.phase = ProvisioningPhase::Recovering;
  assert(factoryBeaconMayOwnOutput(beacon));
  beacon.phase = ProvisioningPhase::Ready;
  assert(!factoryBeaconMayOwnOutput(beacon));

  assert(!provisioningOutputReady(false, 0));
  assert(!provisioningOutputReady(true, 0));
  assert(!provisioningOutputReady(false, 1));
  assert(provisioningOutputReady(true, 1));

  assert(provisioningUsesFactoryBeacon(ProvisioningPhase::Factory, 0));
  assert(provisioningUsesFactoryBeacon(ProvisioningPhase::Factory, 1));
  assert(provisioningUsesFactoryBeacon(ProvisioningPhase::Recovering, 0));
  assert(!provisioningUsesFactoryBeacon(ProvisioningPhase::Recovering, 1));
  assert(!provisioningUsesFactoryBeacon(ProvisioningPhase::Ready, 0));
  assert(!provisioningUsesFactoryBeacon(ProvisioningPhase::Ready, 1));

  // A long initial hold is conspicuous even when the operator looks up late,
  // followed by a second long pulse that distinguishes discovery from a
  // continuously powered strip. The final dark interval makes pin changes
  // electrically and visually unambiguous.
  // Written against the constants, not literals. These were 0/1199/1200/1599/…
  // and every one of them went stale the moment the rhythm was rescaled, which
  // is exactly the trap this file already fell into with the GPIO list above.
  assert(factoryBeaconPulseOn(0));
  assert(factoryBeaconPulseOn(LW_FACTORY_BEACON_STEADY_ON_MS - 1));
  assert(!factoryBeaconPulseOn(LW_FACTORY_BEACON_STEADY_ON_MS));
  assert(!factoryBeaconPulseOn(LW_FACTORY_BEACON_SECOND_ON_START_MS - 1));
  assert(factoryBeaconPulseOn(LW_FACTORY_BEACON_SECOND_ON_START_MS));
  assert(factoryBeaconPulseOn(LW_FACTORY_BEACON_SECOND_ON_END_MS - 1));
  assert(!factoryBeaconPulseOn(LW_FACTORY_BEACON_SECOND_ON_END_MS));
  assert(!factoryBeaconPulseOn(LW_FACTORY_BEACON_STEP_MS - 1));
  // Wraps into the next step, so the pattern restarts rather than drifting.
  assert(factoryBeaconPulseOn(LW_FACTORY_BEACON_STEP_MS));

  assert(provisioningFactoryResetMayComplete(true, true));
  assert(!provisioningFactoryResetMayComplete(true, false));
  assert(!provisioningFactoryResetMayComplete(false, true));

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
