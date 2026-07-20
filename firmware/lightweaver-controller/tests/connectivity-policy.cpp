#include <cassert>
#include <cstdint>
#include <limits>

#include "../src/LightweaverConnectivityPolicy.h"

using lightweaver::ConnectivityEvent;
using lightweaver::ConnectivityInput;
using lightweaver::ConnectivityPhase;
using lightweaver::ConnectivityState;
using lightweaver::advanceConnectivity;
using lightweaver::kHandoffGraceMs;
using lightweaver::kInitialJoinTimeoutMs;
using lightweaver::kReconnectCadenceMs;
using lightweaver::kRecoveryApThresholdMs;

ConnectivityInput input(ConnectivityEvent event,
                        uint32_t nowMs,
                        uint32_t generation = 0) {
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
  assert(state.lastAttemptMs == 100);
  assert(state.generation == 7);

  state = advanceConnectivity(
      state, input(ConnectivityEvent::StationAssociated, 500, 7));
  assert(state.phase == ConnectivityPhase::HandoffReady);
  assert(state.apActive);
  assert(state.stationAssociated);
  assert(!state.reconnectDue);
  assert(state.phaseStartedMs == 500);
  assert(state.generation == 7);

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

  const uint32_t recoveryAttempt = state.lastAttemptMs;
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
  assert(state.lastAttemptMs == recoveryAttempt + kReconnectCadenceMs);

  state = advanceConnectivity(
      state, input(ConnectivityEvent::StationAssociated,
                   state.lastAttemptMs + 500));
  assert(state.phase == ConnectivityPhase::Station);
  assert(!state.apActive);
  assert(state.stationAssociated);
  assert(!state.reconnectDue);

  const uint32_t nearWrap = std::numeric_limits<uint32_t>::max() - 1000;
  ConnectivityState wrapped{};
  wrapped = advanceConnectivity(
      wrapped,
      input(ConnectivityEvent::CredentialsAccepted, nearWrap, 13));
  wrapped = advanceConnectivity(
      wrapped,
      input(ConnectivityEvent::Tick, nearWrap + kInitialJoinTimeoutMs - 1));
  assert(wrapped.phase == ConnectivityPhase::Joining);
  wrapped = advanceConnectivity(
      wrapped,
      input(ConnectivityEvent::Tick, nearWrap + kInitialJoinTimeoutMs));
  assert(wrapped.phase == ConnectivityPhase::SetupAp);
  assert(wrapped.apActive);

  return 0;
}
