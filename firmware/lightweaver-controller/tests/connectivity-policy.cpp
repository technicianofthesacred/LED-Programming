#include <cassert>
#include <cstdint>
#include <limits>

#include "../src/LightweaverConnectivityPolicy.h"

using lightweaver::ConnectivityEvent;
using lightweaver::ConnectivityInput;
using lightweaver::ConnectivityPhase;
using lightweaver::ConnectivityState;
using lightweaver::advanceConnectivity;
using lightweaver::connectivityTransitionPending;
using lightweaver::kHandoffGraceMs;
using lightweaver::kInitialJoinTimeoutMs;
using lightweaver::kNetworkBindingRetryMs;
using lightweaver::kReconnectCadenceMs;
using lightweaver::kRecoveryApThresholdMs;
using lightweaver::recordNetworkBindingAttempt;
using lightweaver::recordStationAttempt;

static_assert(kInitialJoinTimeoutMs == 15000,
              "initial join timeout must remain 15 seconds");
static_assert(kReconnectCadenceMs == 10000,
              "reconnect cadence must remain 10 seconds");
static_assert(kRecoveryApThresholdMs == 60000,
              "recovery AP threshold must remain 60 seconds");
static_assert(kHandoffGraceMs == 120000,
              "handoff grace must remain 120 seconds");
static_assert(kNetworkBindingRetryMs == 2000,
              "listener retry cadence must remain 2 seconds");

ConnectivityInput input(ConnectivityEvent event,
                        std::uint32_t nowMs,
                        std::uint32_t generation = 0) {
  ConnectivityInput value{};
  value.event = event;
  value.nowMs = nowMs;
  value.generation = generation;
  return value;
}

int main() {
  ConnectivityState state{};
  assert(state.phase == ConnectivityPhase::SetupAp);
  assert(state.apActive);
  assert(!state.stationAssociated);
  assert(!state.reconnectDue);
  assert(state.phaseStartedMs == 0);
  assert(state.lastAttemptMs == 0);
  assert(state.generation == 0);

  state = advanceConnectivity(
      state, input(ConnectivityEvent::CredentialsAccepted, 100, 7));
  assert(state.phase == ConnectivityPhase::Joining);
  assert(state.apActive);
  assert(!state.stationAssociated);
  assert(state.reconnectDue);
  assert(state.phaseStartedMs == 100);
  assert(state.lastAttemptMs == 0);
  assert(state.generation == 7);
  state = recordStationAttempt(state, 100);
  assert(state.lastAttemptMs == 100);
  assert(!state.reconnectDue);

  state = advanceConnectivity(
      state, input(ConnectivityEvent::StationAssociated, 500, 7));
  assert(state.phase == ConnectivityPhase::HandoffReady);
  assert(state.apActive);
  assert(state.stationAssociated);
  assert(state.networkBindingsPending);
  assert(state.networkBindingsRetryDue);
  assert(connectivityTransitionPending(state));
  assert(state.phaseStartedMs == 500);
  assert(state.generation == 7);
  state = recordNetworkBindingAttempt(state, 500, true, true);
  assert(!state.networkBindingsPending);
  assert(!state.networkBindingsRetryDue);

  ConnectivityState mismatch = advanceConnectivity(
      state, input(ConnectivityEvent::StationOriginAck, 700, 6));
  assert(mismatch.phase == ConnectivityPhase::HandoffReady);
  assert(mismatch.apActive);
  assert(mismatch.stationAssociated);

  mismatch = advanceConnectivity(
      state, input(ConnectivityEvent::StationOriginAck, 700, 0));
  assert(mismatch.phase == ConnectivityPhase::HandoffReady);
  assert(mismatch.apActive);

  state = advanceConnectivity(
      state, input(ConnectivityEvent::StationOriginAck, 800, 7));
  assert(state.phase == ConnectivityPhase::Station);
  assert(!state.apActive);
  assert(state.stationAssociated);
  assert(state.phaseStartedMs == 800);

  ConnectivityState interruptedHandoff{};
  interruptedHandoff = advanceConnectivity(
      interruptedHandoff,
      input(ConnectivityEvent::CredentialsAccepted, 1000, 8));
  interruptedHandoff = advanceConnectivity(
      interruptedHandoff,
      input(ConnectivityEvent::StationAssociated, 1500, 8));
  interruptedHandoff = advanceConnectivity(
      interruptedHandoff, input(ConnectivityEvent::StationLost, 2000));
  assert(interruptedHandoff.apActive);
  assert(!interruptedHandoff.stationAssociated);
  interruptedHandoff = advanceConnectivity(
      interruptedHandoff,
      input(ConnectivityEvent::StationAssociated, 2500, 8));
  assert(interruptedHandoff.phase == ConnectivityPhase::HandoffReady);
  assert(interruptedHandoff.apActive);
  assert(interruptedHandoff.stationAssociated);
  interruptedHandoff = advanceConnectivity(
      interruptedHandoff,
      input(ConnectivityEvent::Tick, 1500 + kHandoffGraceMs));
  assert(interruptedHandoff.phase == ConnectivityPhase::HandoffReady);
  assert(interruptedHandoff.apActive);

  ConnectivityState acknowledgedRejoin = advanceConnectivity(
      interruptedHandoff,
      input(ConnectivityEvent::StationOriginAck,
            1500 + kHandoffGraceMs + 1,
            8));
  assert(acknowledgedRejoin.phase == ConnectivityPhase::Station);
  assert(!acknowledgedRejoin.apActive);

  interruptedHandoff = advanceConnectivity(
      interruptedHandoff,
      input(ConnectivityEvent::Tick, 2500 + kHandoffGraceMs));
  assert(interruptedHandoff.phase == ConnectivityPhase::Station);
  assert(!interruptedHandoff.apActive);

  ConnectivityState grace{};
  grace = advanceConnectivity(
      grace, input(ConnectivityEvent::CredentialsAccepted, 1000, 9));
  grace = advanceConnectivity(
      grace, input(ConnectivityEvent::StationAssociated, 1100, 9));
  grace = advanceConnectivity(
      grace, input(ConnectivityEvent::Tick, 1100 + kHandoffGraceMs - 1));
  assert(grace.phase == ConnectivityPhase::HandoffReady);
  assert(grace.apActive);
  grace = advanceConnectivity(
      grace, input(ConnectivityEvent::Tick, 1100 + kHandoffGraceMs));
  assert(grace.phase == ConnectivityPhase::Station);
  assert(!grace.apActive);
  assert(grace.stationAssociated);

  ConnectivityState timedOut{};
  timedOut = advanceConnectivity(
      timedOut, input(ConnectivityEvent::CredentialsAccepted, 2000, 11));
  timedOut = advanceConnectivity(
      timedOut, input(ConnectivityEvent::Tick,
                      2000 + kInitialJoinTimeoutMs - 1));
  assert(timedOut.phase == ConnectivityPhase::Joining);
  assert(timedOut.apActive);
  timedOut = advanceConnectivity(
      timedOut, input(ConnectivityEvent::Tick,
                      2000 + kInitialJoinTimeoutMs));
  assert(timedOut.phase == ConnectivityPhase::SetupAp);
  assert(timedOut.apActive);
  assert(!timedOut.stationAssociated);
  assert(!timedOut.reconnectDue);
  assert(timedOut.generation == 11);

  state = advanceConnectivity(
      state, input(ConnectivityEvent::StationLost, 5000));
  assert(state.phase == ConnectivityPhase::Reconnecting);
  assert(!state.apActive);
  assert(!state.stationAssociated);
  assert(state.reconnectDue);
  assert(state.phaseStartedMs == 5000);
  assert(state.lastAttemptMs == 100);
  state = recordStationAttempt(state, 5000);
  assert(state.lastAttemptMs == 5000);

  state = advanceConnectivity(
      state, input(ConnectivityEvent::Tick, 5000 + kReconnectCadenceMs - 1));
  assert(state.phase == ConnectivityPhase::Reconnecting);
  assert(!state.reconnectDue);
  assert(state.lastAttemptMs == 5000);
  state = advanceConnectivity(
      state, input(ConnectivityEvent::Tick, 5000 + kReconnectCadenceMs));
  assert(state.phase == ConnectivityPhase::Reconnecting);
  assert(state.reconnectDue);
  assert(state.lastAttemptMs == 5000);
  state = recordStationAttempt(state, 5000 + kReconnectCadenceMs);
  assert(state.lastAttemptMs == 5000 + kReconnectCadenceMs);
  state = advanceConnectivity(
      state, input(ConnectivityEvent::Tick,
                   5000 + kReconnectCadenceMs + 1));
  assert(!state.reconnectDue);

  state = advanceConnectivity(
      state, input(ConnectivityEvent::Tick,
                   5000 + kRecoveryApThresholdMs));
  assert(state.phase == ConnectivityPhase::RecoveryAp);
  assert(state.apActive);
  assert(!state.stationAssociated);
  assert(state.reconnectDue);

  const std::uint32_t recoveryAttempt = state.lastAttemptMs;
  state = advanceConnectivity(
      state, input(ConnectivityEvent::Tick,
                   recoveryAttempt + kReconnectCadenceMs - 1));
  assert(state.phase == ConnectivityPhase::RecoveryAp);
  assert(state.apActive);
  assert(!state.reconnectDue);
  state = advanceConnectivity(
      state, input(ConnectivityEvent::Tick,
                   recoveryAttempt + kReconnectCadenceMs));
  assert(state.reconnectDue);
  assert(state.lastAttemptMs == recoveryAttempt);
  state = recordStationAttempt(
      state, recoveryAttempt + kReconnectCadenceMs);
  assert(state.lastAttemptMs == recoveryAttempt + kReconnectCadenceMs);

  state = advanceConnectivity(
      state, input(ConnectivityEvent::StationAssociated,
                   state.lastAttemptMs + 500));
  assert(state.phase == ConnectivityPhase::Station);
  assert(!state.apActive);
  assert(state.stationAssociated);
  assert(!state.reconnectDue);

  const std::uint32_t nearWrap =
      std::numeric_limits<std::uint32_t>::max() - 1000;
  ConnectivityState wrapped{};
  wrapped = advanceConnectivity(
      wrapped,
      input(ConnectivityEvent::CredentialsAccepted, nearWrap, 13));
  wrapped = recordStationAttempt(wrapped, nearWrap);
  wrapped = advanceConnectivity(
      wrapped,
      input(ConnectivityEvent::Tick, nearWrap + kInitialJoinTimeoutMs - 1));
  assert(wrapped.phase == ConnectivityPhase::Joining);
  wrapped = advanceConnectivity(
      wrapped,
      input(ConnectivityEvent::Tick, nearWrap + kInitialJoinTimeoutMs));
  assert(wrapped.phase == ConnectivityPhase::SetupAp);
  assert(wrapped.apActive);

  ConnectivityState wrappedReconnect{};
  wrappedReconnect.phase = ConnectivityPhase::Station;
  wrappedReconnect.apActive = false;
  wrappedReconnect.stationAssociated = true;
  wrappedReconnect = advanceConnectivity(
      wrappedReconnect,
      input(ConnectivityEvent::StationLost, nearWrap));
  wrappedReconnect = recordStationAttempt(wrappedReconnect, nearWrap);
  wrappedReconnect = advanceConnectivity(
      wrappedReconnect,
      input(ConnectivityEvent::Tick, nearWrap + kReconnectCadenceMs - 1));
  assert(!wrappedReconnect.reconnectDue);
  wrappedReconnect = advanceConnectivity(
      wrappedReconnect,
      input(ConnectivityEvent::Tick, nearWrap + kReconnectCadenceMs));
  assert(wrappedReconnect.reconnectDue);
  wrappedReconnect = recordStationAttempt(
      wrappedReconnect, nearWrap + kReconnectCadenceMs);
  wrappedReconnect = advanceConnectivity(
      wrappedReconnect,
      input(ConnectivityEvent::Tick, nearWrap + kRecoveryApThresholdMs - 1));
  assert(wrappedReconnect.phase == ConnectivityPhase::Reconnecting);
  wrappedReconnect = advanceConnectivity(
      wrappedReconnect,
      input(ConnectivityEvent::Tick, nearWrap + kRecoveryApThresholdMs));
  assert(wrappedReconnect.phase == ConnectivityPhase::RecoveryAp);
  assert(wrappedReconnect.apActive);

  ConnectivityState wrappedHandoff{};
  wrappedHandoff = advanceConnectivity(
      wrappedHandoff,
      input(ConnectivityEvent::CredentialsAccepted, nearWrap, 14));
  wrappedHandoff = recordStationAttempt(wrappedHandoff, nearWrap);
  wrappedHandoff = advanceConnectivity(
      wrappedHandoff,
      input(ConnectivityEvent::StationAssociated, nearWrap + 100, 14));
  wrappedHandoff = recordNetworkBindingAttempt(
      wrappedHandoff, nearWrap + 100, true, true);
  wrappedHandoff = advanceConnectivity(
      wrappedHandoff,
      input(ConnectivityEvent::Tick,
            nearWrap + 100 + kHandoffGraceMs - 1));
  assert(wrappedHandoff.phase == ConnectivityPhase::HandoffReady);
  wrappedHandoff = advanceConnectivity(
      wrappedHandoff,
      input(ConnectivityEvent::Tick, nearWrap + 100 + kHandoffGraceMs));
  assert(wrappedHandoff.phase == ConnectivityPhase::Station);

  ConnectivityState wrappedBindings = wrappedHandoff;
  wrappedBindings = advanceConnectivity(
      wrappedBindings,
      input(ConnectivityEvent::StationAssociated, nearWrap + 200, 14));
  wrappedBindings = recordNetworkBindingAttempt(
      wrappedBindings, nearWrap + 200, true, false);
  wrappedBindings = advanceConnectivity(
      wrappedBindings,
      input(ConnectivityEvent::Tick,
            nearWrap + 200 + kNetworkBindingRetryMs - 1));
  assert(!wrappedBindings.networkBindingsRetryDue);
  wrappedBindings = advanceConnectivity(
      wrappedBindings,
      input(ConnectivityEvent::Tick,
            nearWrap + 200 + kNetworkBindingRetryMs));
  assert(wrappedBindings.networkBindingsRetryDue);

  return 0;
}
