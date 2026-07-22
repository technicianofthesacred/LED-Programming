#pragma once

#include <cstdint>

#include "LightweaverConnectivityPolicy.h"

namespace lightweaver {

enum class ConnectivityStationAttempt {
  None,
  Begin,
  Reconnect,
};

struct ConnectivityObservation {
  std::uint32_t nowMs;
  bool stationReady;
  bool stationAddressChanged;
  bool apReady;

  constexpr ConnectivityObservation(
      std::uint32_t now = 0,
      bool stationIsReady = false,
      bool addressChanged = false,
      bool accessPointReady = false)
      : nowMs(now),
        stationReady(stationIsReady),
        stationAddressChanged(addressChanged),
        apReady(accessPointReady) {}
};

struct ConnectivityBindingResult {
  bool wledReady;
  bool artnetReady;

  constexpr ConnectivityBindingResult(
      bool wledIsReady = false,
      bool artnetIsReady = false)
      : wledReady(wledIsReady), artnetReady(artnetIsReady) {}
};

struct ConnectivityApResult {
  bool apActive;
  bool dnsActive;

  constexpr ConnectivityApResult(
      bool apIsActive = false,
      bool dnsIsActive = false)
      : apActive(apIsActive), dnsActive(dnsIsActive) {}

  constexpr bool ready() const {
    return apActive && dnsActive;
  }
};

struct ConnectivityActionPlan {
  ConnectivityState nextState{};
  bool stationLost = false;
  bool preAckStationLoss = false;
  bool stationAssociated = false;
  bool forceNetworkBindingRefresh = false;
  bool retryNetworkBindings = false;
  bool initialJoinTimedOut = false;
  bool ensureSetupAp = false;
  bool ensureRecoveryAp = false;
  bool retireSetupAp = false;
  bool retireRecoveryAp = false;
  ConnectivityStationAttempt stationAttempt =
      ConnectivityStationAttempt::None;
};

constexpr bool phaseUsesSetupAp(ConnectivityPhase phase) {
  return phase == ConnectivityPhase::SetupAp ||
         phase == ConnectivityPhase::Joining ||
         phase == ConnectivityPhase::HandoffReady;
}

inline ConnectivityActionPlan planConnectivityActions(
    const ConnectivityState& current,
    const ConnectivityObservation& observed) {
  ConnectivityActionPlan plan;
  plan.nextState = current;
  ConnectivityPhase previousPhase = current.phase;

  if (current.phase == ConnectivityPhase::Station ||
      current.phase == ConnectivityPhase::HandoffAbandoned) {
    if (!observed.stationReady) {
      plan.nextState = advanceConnectivity(
          current, {ConnectivityEvent::StationLost, observed.nowMs, 0});
      plan.stationLost = true;
      plan.stationAttempt = ConnectivityStationAttempt::Reconnect;
    } else if (observed.stationAddressChanged) {
      plan.nextState = advanceConnectivity(
          current, {ConnectivityEvent::StationAssociated, observed.nowMs, 0});
      plan.stationAssociated = true;
      plan.forceNetworkBindingRefresh = true;
    } else {
      plan.nextState = advanceConnectivity(
          current, {ConnectivityEvent::Tick, observed.nowMs, 0});
    }
  } else if (observed.stationReady && !current.stationAssociated &&
             (current.phase == ConnectivityPhase::Joining ||
              current.phase == ConnectivityPhase::Reconnecting ||
              current.phase == ConnectivityPhase::RecoveryAp)) {
    plan.nextState = advanceConnectivity(
        current, {ConnectivityEvent::StationAssociated, observed.nowMs, 0});
    plan.stationAssociated = true;
    plan.forceNetworkBindingRefresh = true;
    plan.retireRecoveryAp =
        previousPhase == ConnectivityPhase::RecoveryAp;
  } else if (!observed.stationReady && current.stationAssociated &&
             current.phase == ConnectivityPhase::HandoffReady) {
    plan.nextState = advanceConnectivity(
        current, {ConnectivityEvent::StationLost, observed.nowMs, 0});
    plan.stationLost = true;
    plan.preAckStationLoss = true;
    plan.stationAttempt = ConnectivityStationAttempt::Begin;
  } else {
    plan.nextState = advanceConnectivity(
        current, {ConnectivityEvent::Tick, observed.nowMs, 0});
  }

  if (previousPhase == ConnectivityPhase::Joining &&
      plan.nextState.phase == ConnectivityPhase::SetupAp) {
    plan.initialJoinTimedOut = true;
  }

  if (previousPhase == ConnectivityPhase::HandoffReady &&
      (plan.nextState.phase == ConnectivityPhase::Station ||
       plan.nextState.phase == ConnectivityPhase::HandoffAbandoned) &&
      observed.stationReady) {
    plan.retireSetupAp = true;
  }

  if (plan.nextState.networkBindingsRetryDue && observed.stationReady) {
    plan.retryNetworkBindings = !plan.forceNetworkBindingRefresh;
  }

  if (phaseUsesSetupAp(plan.nextState.phase) && !observed.apReady) {
    plan.ensureSetupAp = true;
  } else if (plan.nextState.phase == ConnectivityPhase::RecoveryAp &&
             !observed.apReady) {
    plan.ensureRecoveryAp = true;
  }

  if (plan.stationAttempt == ConnectivityStationAttempt::None &&
      plan.nextState.reconnectDue) {
    if (plan.nextState.phase == ConnectivityPhase::Joining) {
      plan.stationAttempt = ConnectivityStationAttempt::Begin;
    } else if (plan.nextState.phase == ConnectivityPhase::Reconnecting ||
               plan.nextState.phase == ConnectivityPhase::RecoveryAp) {
      plan.stationAttempt = ConnectivityStationAttempt::Reconnect;
    }
  }

  return plan;
}

// Adapter methods are the only hardware boundary. Production and native tests
// execute this exact ordering, while the state machine remains Arduino-free.
template <typename HardwareAdapter>
ConnectivityState runConnectivityOrchestrator(
    const ConnectivityState& current,
    const ConnectivityObservation& observed,
    HardwareAdapter& hardware) {
  const ConnectivityActionPlan plan =
      planConnectivityActions(current, observed);
  ConnectivityState state = plan.nextState;

  if (plan.stationLost) {
    hardware.stationLost(plan.preAckStationLoss);
  }
  if (plan.initialJoinTimedOut) {
    hardware.initialJoinTimedOut();
  }
  if (plan.stationAssociated) {
    hardware.stationAssociated();
  }

  if (plan.forceNetworkBindingRefresh || plan.retryNetworkBindings) {
    const ConnectivityBindingResult result =
        hardware.refreshNetworkBindings(plan.forceNetworkBindingRefresh);
    state = recordNetworkBindingAttempt(
        state, observed.nowMs, result.wledReady, result.artnetReady);
  }

  // A recovery AP retires only after station truth and a binding refresh have
  // both been attempted. Binding failure remains a readiness interlock and
  // never causes the recovery AP to reopen.
  if (plan.retireRecoveryAp) {
    hardware.retireSetupAp(true);
    state.apActive = false;
  } else if (plan.retireSetupAp) {
    hardware.retireSetupAp(false);
    state.apActive = false;
  }

  if (plan.ensureSetupAp) {
    const ConnectivityApResult result = hardware.ensureSetupAp();
    state.apActive = result.apActive;
  } else if (plan.ensureRecoveryAp) {
    const ConnectivityApResult result = hardware.ensureRecoveryAp();
    state.apActive = result.apActive;
  }

  const bool readinessPending = connectivityTransitionPending(state);
  hardware.setReadinessPending(readinessPending);

  if (plan.stationAttempt != ConnectivityStationAttempt::None &&
      hardware.issueStationAttempt(plan.stationAttempt)) {
    state = recordStationAttempt(state, observed.nowMs);
  }

  return state;
}

}  // namespace lightweaver
