#include <cassert>
#include <cstdint>
#include <limits>

#include "../src/LightweaverConnectivityPolicy.h"

using lightweaver::ConnectivityEvent;
using lightweaver::ConnectivityInput;
using lightweaver::ConnectivityPhase;
using lightweaver::ConnectivityState;
using lightweaver::advanceConnectivity;
using lightweaver::connectivityPhaseIsPending;
using lightweaver::connectivityTransitionPending;
using lightweaver::kInitialJoinTimeoutMs;
using lightweaver::kHandoffMaxMs;
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
static_assert(kHandoffMaxMs == 300000,
              "abandoned handoff AP maximum must remain five minutes");
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

  // An untouched factory setup AP has no saved credentials to retry. Time
  // alone must never trigger a blind hardware station attempt or disturb the
  // usable setup hotspot.
  ConnectivityState factorySetup = advanceConnectivity(
      state, input(ConnectivityEvent::Tick, kReconnectCadenceMs + 1));
  assert(factorySetup.phase == ConnectivityPhase::SetupAp);
  assert(factorySetup.generation == 0);
  assert(factorySetup.handoffRequired);
  assert(!factorySetup.reconnectDue);
  assert(factorySetup.apActive == state.apActive);

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
      input(ConnectivityEvent::Tick, 1500 + 120000));
  assert(interruptedHandoff.phase == ConnectivityPhase::HandoffReady);
  assert(interruptedHandoff.apActive);

  ConnectivityState acknowledgedRejoin = advanceConnectivity(
      interruptedHandoff,
      input(ConnectivityEvent::StationOriginAck,
            1500 + 120001,
            8));
  assert(acknowledgedRejoin.phase == ConnectivityPhase::Station);
  assert(!acknowledgedRejoin.apActive);

  interruptedHandoff = advanceConnectivity(
      interruptedHandoff,
      input(ConnectivityEvent::Tick, 2500 + 120000));
  assert(interruptedHandoff.phase == ConnectivityPhase::HandoffReady);
  assert(interruptedHandoff.apActive);

  ConnectivityState unacknowledged{};
  unacknowledged = advanceConnectivity(
      unacknowledged, input(ConnectivityEvent::CredentialsAccepted, 1000, 9));
  unacknowledged = advanceConnectivity(
      unacknowledged, input(ConnectivityEvent::StationAssociated, 1100, 9));
  unacknowledged = advanceConnectivity(
      unacknowledged, input(ConnectivityEvent::Tick,
                            1100 + kHandoffMaxMs - 1));
  assert(unacknowledged.phase == ConnectivityPhase::HandoffReady);
  assert(unacknowledged.apActive);
  assert(unacknowledged.stationAssociated);
  // An expired handoff on a card that IS associated is a finished join whose
  // acknowledgement never arrived, not a broken one. It settles into Station so
  // local playback stops being refused; leaving it pending stranded working
  // cards forever whenever the worker never came back to the Studio tab.
  unacknowledged = advanceConnectivity(
      unacknowledged, input(ConnectivityEvent::Tick,
                            1100 + kHandoffMaxMs));
  assert(unacknowledged.phase == ConnectivityPhase::Station);
  assert(!unacknowledged.apActive);
  assert(unacknowledged.stationAssociated);
  assert(!connectivityPhaseIsPending(unacknowledged.phase));
  unacknowledged = recordNetworkBindingAttempt(
      unacknowledged, 1100 + kHandoffMaxMs, true, true);
  assert(!connectivityTransitionPending(unacknowledged));

  // A late acknowledgement for the settled join is harmless and idempotent.
  ConnectivityState acknowledged = advanceConnectivity(
      unacknowledged,
      input(ConnectivityEvent::StationOriginAck, 1100 + 120001, 9));
  assert(acknowledged.phase == ConnectivityPhase::Station);
  assert(!acknowledged.apActive);

  // The handoff window only abandons when the station never came up at all.
  ConnectivityState strandedHandoff{};
  strandedHandoff = advanceConnectivity(
      strandedHandoff, input(ConnectivityEvent::CredentialsAccepted, 1000, 9));
  strandedHandoff.phase = ConnectivityPhase::HandoffReady;
  strandedHandoff.stationAssociated = false;
  strandedHandoff.phaseStartedMs = 1000;
  strandedHandoff = advanceConnectivity(
      strandedHandoff, input(ConnectivityEvent::Tick, 1000 + kHandoffMaxMs));
  assert(strandedHandoff.phase == ConnectivityPhase::HandoffAbandoned);
  assert(!strandedHandoff.apActive);
  assert(connectivityTransitionPending(strandedHandoff));
  // A stale generation still cannot close someone else's lifecycle.
  ConnectivityState wrongGeneration = advanceConnectivity(
      strandedHandoff,
      input(ConnectivityEvent::StationOriginAck, 1000 + kHandoffMaxMs + 1, 8));
  assert(wrongGeneration.phase == ConnectivityPhase::HandoffAbandoned);

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
  assert(timedOut.lastAttemptMs == 2000 + kInitialJoinTimeoutMs);
  timedOut = advanceConnectivity(
      timedOut, input(ConnectivityEvent::Tick,
                      2000 + kInitialJoinTimeoutMs + kReconnectCadenceMs - 1));
  assert(timedOut.phase == ConnectivityPhase::SetupAp);
  assert(!timedOut.reconnectDue);
  timedOut = advanceConnectivity(
      timedOut, input(ConnectivityEvent::Tick,
                      2000 + kInitialJoinTimeoutMs + kReconnectCadenceMs));
  assert(timedOut.phase == ConnectivityPhase::Joining);
  assert(timedOut.apActive);
  assert(timedOut.reconnectDue);

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
            nearWrap + 100 + kHandoffMaxMs - 1));
  assert(wrappedHandoff.phase == ConnectivityPhase::HandoffReady);
  wrappedHandoff = advanceConnectivity(
      wrappedHandoff,
      input(ConnectivityEvent::Tick,
            nearWrap + 100 + kHandoffMaxMs));
  // The wraparound arithmetic is what this case guards; the associated card
  // now settles into Station rather than a permanently pending phase.
  assert(wrappedHandoff.phase == ConnectivityPhase::Station);
  assert(!wrappedHandoff.apActive);
  wrappedHandoff = advanceConnectivity(
      wrappedHandoff,
      input(ConnectivityEvent::StationOriginAck,
            nearWrap + 100 + kHandoffMaxMs + 1, 14));
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

  // --- Resumed boot join -------------------------------------------------
  // A card rebooting onto credentials that already reached Station has no
  // browser waiting to acknowledge anything. Association alone must complete
  // the join. Previously this re-entered the commissioning handoff and left
  // the card refusing every command until an unrelated WiFi drop rescued it.
  ConnectivityState resumed{};
  resumed = advanceConnectivity(
      resumed, input(ConnectivityEvent::CredentialsResumed, 100, 0));
  assert(resumed.phase == ConnectivityPhase::Joining);
  assert(resumed.apActive);
  assert(!resumed.handoffRequired);
  assert(resumed.generation == 0);
  assert(connectivityTransitionPending(resumed));

  // If the proven network is offline during boot, the setup AP remains usable
  // while the card keeps retrying those saved credentials on the normal
  // cadence. Generation zero identifies this as a resumed join, not a factory
  // setup AP that should blindly attempt station association.
  ConnectivityState resumedOffline{};
  resumedOffline = advanceConnectivity(
      resumedOffline,
      input(ConnectivityEvent::CredentialsResumed, 3000, 0));
  resumedOffline = recordStationAttempt(resumedOffline, 3000);
  resumedOffline = advanceConnectivity(
      resumedOffline,
      input(ConnectivityEvent::Tick, 3000 + kInitialJoinTimeoutMs));
  assert(resumedOffline.phase == ConnectivityPhase::SetupAp);
  assert(resumedOffline.apActive);
  assert(!resumedOffline.handoffRequired);
  assert(resumedOffline.generation == 0);
  assert(!resumedOffline.reconnectDue);
  resumedOffline = advanceConnectivity(
      resumedOffline,
      input(ConnectivityEvent::Tick,
            3000 + kInitialJoinTimeoutMs + kReconnectCadenceMs - 1));
  assert(resumedOffline.phase == ConnectivityPhase::SetupAp);
  assert(!resumedOffline.reconnectDue);
  resumedOffline = advanceConnectivity(
      resumedOffline,
      input(ConnectivityEvent::Tick,
            3000 + kInitialJoinTimeoutMs + kReconnectCadenceMs));
  assert(resumedOffline.phase == ConnectivityPhase::Joining);
  assert(resumedOffline.apActive);
  assert(resumedOffline.reconnectDue);

  resumed = recordStationAttempt(resumed, 100);
  resumed = advanceConnectivity(
      resumed, input(ConnectivityEvent::StationAssociated, 900, 0));
  assert(resumed.phase == ConnectivityPhase::Station);
  assert(!resumed.apActive);
  assert(resumed.stationAssociated);
  // Listeners still have to bind before the card is fully settled, but the
  // phase itself no longer parks in a pending handoff.
  resumed = recordNetworkBindingAttempt(resumed, 900, true, true);
  assert(!connectivityTransitionPending(resumed));

  // A resumed join mints no generation, so no acknowledgement — stale or
  // otherwise — can act on it.
  ConnectivityState resumedAck = advanceConnectivity(
      resumed, input(ConnectivityEvent::StationOriginAck, 1000, 1));
  assert(resumedAck.phase == ConnectivityPhase::Station);

  // Losing the network still routes through the normal recovery path.
  ConnectivityState resumedLost = advanceConnectivity(
      resumed, input(ConnectivityEvent::StationLost, 2000, 0));
  assert(resumedLost.phase == ConnectivityPhase::Reconnecting);
  resumedLost = recordStationAttempt(resumedLost, 2000);
  resumedLost = advanceConnectivity(
      resumedLost, input(ConnectivityEvent::Tick, 2000 + kRecoveryApThresholdMs));
  assert(resumedLost.phase == ConnectivityPhase::RecoveryAp);
  assert(resumedLost.apActive);

  // A first-time join is untouched: it still owes an acknowledgement and still
  // holds the setup AP open until it arrives.
  ConnectivityState firstJoin{};
  firstJoin = advanceConnectivity(
      firstJoin, input(ConnectivityEvent::CredentialsAccepted, 100, 3));
  assert(firstJoin.handoffRequired);
  firstJoin = advanceConnectivity(
      firstJoin, input(ConnectivityEvent::StationAssociated, 900, 3));
  assert(firstJoin.phase == ConnectivityPhase::HandoffReady);
  assert(firstJoin.apActive);

  return 0;
}
