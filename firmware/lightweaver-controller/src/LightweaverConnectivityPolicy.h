#pragma once

#include <cstdint>

namespace lightweaver {

constexpr std::uint32_t kInitialJoinTimeoutMs = 15000;
constexpr std::uint32_t kReconnectCadenceMs = 10000;
constexpr std::uint32_t kRecoveryApThresholdMs = 60000;
constexpr std::uint32_t kNetworkBindingRetryMs = 2000;
constexpr std::uint32_t kHandoffMaxMs = 300000;

enum class ConnectivityPhase {
  SetupAp,
  Joining,
  HandoffReady,
  HandoffAbandoned,
  Station,
  Reconnecting,
  RecoveryAp,
};

enum class ConnectivityEvent {
  Tick,
  // A live POST /api/wifi minted a new handoff generation: the browser that
  // submitted the credentials must still prove it can reach the card on the
  // station network before the setup AP is retired.
  CredentialsAccepted,
  // Boot with credentials that have already reached Station at least once.
  // There is no browser waiting to acknowledge anything, so association alone
  // completes the join. Without this, every power cycle re-entered the
  // commissioning handoff and left the card refusing commands indefinitely.
  CredentialsResumed,
  StationAssociated,
  StationLost,
  StationOriginAck,
};

struct ConnectivityInput {
  ConnectivityEvent event;
  std::uint32_t nowMs;
  std::uint32_t generation;

  constexpr ConnectivityInput(
      ConnectivityEvent eventValue = ConnectivityEvent::Tick,
      std::uint32_t nowValue = 0,
      std::uint32_t generationValue = 0)
      : event(eventValue), nowMs(nowValue), generation(generationValue) {}
};

struct ConnectivityState {
  ConnectivityPhase phase = ConnectivityPhase::SetupAp;
  bool apActive = true;
  bool stationAssociated = false;
  bool reconnectDue = false;
  bool networkBindingsPending = false;
  bool networkBindingsRetryDue = false;
  bool wledListenerReady = false;
  bool artnetListenerReady = false;
  // True while this join still owes a station-origin acknowledgement before the
  // setup AP may retire. Resumed joins clear it: nobody is waiting to ack.
  bool handoffRequired = true;
  std::uint32_t phaseStartedMs = 0;
  std::uint32_t lastAttemptMs = 0;
  std::uint32_t lastBindingAttemptMs = 0;
  std::uint32_t generation = 0;
};

constexpr bool elapsed(std::uint32_t nowMs,
                       std::uint32_t startedMs,
                       std::uint32_t durationMs) {
  return static_cast<std::uint32_t>(nowMs - startedMs) >= durationMs;
}

constexpr bool connectivityPhaseIsPending(ConnectivityPhase phase) {
  return phase == ConnectivityPhase::Joining ||
         phase == ConnectivityPhase::HandoffReady ||
         phase == ConnectivityPhase::HandoffAbandoned ||
         phase == ConnectivityPhase::Reconnecting ||
         phase == ConnectivityPhase::RecoveryAp;
}

constexpr bool connectivityTransitionPending(const ConnectivityState& state) {
  return connectivityPhaseIsPending(state.phase) ||
         state.networkBindingsPending;
}

// Action receipts keep policy timestamps truthful: due decisions never claim
// hardware work happened until the production adapter actually issues it.
inline ConnectivityState recordStationAttempt(
    const ConnectivityState& current,
    std::uint32_t nowMs) {
  ConnectivityState next = current;
  next.reconnectDue = false;
  next.lastAttemptMs = nowMs;
  return next;
}

inline ConnectivityState recordNetworkBindingAttempt(
    const ConnectivityState& current,
    std::uint32_t nowMs,
    bool wledReady,
    bool artnetReady) {
  ConnectivityState next = current;
  next.networkBindingsRetryDue = false;
  next.wledListenerReady = wledReady;
  next.artnetListenerReady = artnetReady;
  next.networkBindingsPending = !(wledReady && artnetReady);
  next.lastBindingAttemptMs = nowMs;
  return next;
}

inline ConnectivityState advanceConnectivity(
    const ConnectivityState& current,
    const ConnectivityInput& input) {
  ConnectivityState next = current;
  next.reconnectDue = false;
  next.networkBindingsRetryDue = false;

  switch (input.event) {
    case ConnectivityEvent::CredentialsAccepted:
    case ConnectivityEvent::CredentialsResumed:
      next.phase = ConnectivityPhase::Joining;
      next.apActive = true;
      next.stationAssociated = false;
      next.reconnectDue = true;
      next.networkBindingsPending = false;
      next.wledListenerReady = false;
      next.artnetListenerReady = false;
      next.phaseStartedMs = input.nowMs;
      next.handoffRequired =
          input.event == ConnectivityEvent::CredentialsAccepted;
      // A resumed join mints no generation: there is no acknowledgement to
      // correlate, and a non-zero generation would let a stale browser ack
      // from a previous boot close this lifecycle.
      next.generation = next.handoffRequired ? input.generation : 0;
      return next;

    case ConnectivityEvent::StationAssociated:
      if (current.phase == ConnectivityPhase::Joining) {
        if (current.handoffRequired) {
          next.phase = ConnectivityPhase::HandoffReady;
          next.apActive = true;
        } else {
          next.phase = ConnectivityPhase::Station;
          next.apActive = false;
        }
      } else if (current.phase == ConnectivityPhase::Reconnecting ||
                 current.phase == ConnectivityPhase::RecoveryAp) {
        next.phase = ConnectivityPhase::Station;
        next.apActive = false;
      } else if (current.phase == ConnectivityPhase::Station) {
        next.phase = ConnectivityPhase::Station;
      } else if (current.phase == ConnectivityPhase::HandoffAbandoned) {
        next.phase = ConnectivityPhase::HandoffAbandoned;
        next.apActive = false;
      } else {
        return next;
      }
      next.stationAssociated = true;
      next.networkBindingsPending = true;
      next.networkBindingsRetryDue = true;
      next.wledListenerReady = false;
      next.artnetListenerReady = false;
      next.phaseStartedMs = input.nowMs;
      return next;

    case ConnectivityEvent::StationLost:
      if (!current.stationAssociated) return next;
      next.phase = current.phase == ConnectivityPhase::HandoffReady
          ? ConnectivityPhase::Joining
          : ConnectivityPhase::Reconnecting;
      next.stationAssociated = false;
      next.reconnectDue = true;
      next.networkBindingsPending = false;
      next.wledListenerReady = false;
      next.artnetListenerReady = false;
      next.phaseStartedMs = input.nowMs;
      return next;

    case ConnectivityEvent::StationOriginAck:
      if ((current.phase != ConnectivityPhase::HandoffReady &&
           current.phase != ConnectivityPhase::HandoffAbandoned) ||
          current.generation == 0 ||
          input.generation != current.generation) {
        return next;
      }
      next.phase = ConnectivityPhase::Station;
      next.apActive = false;
      next.phaseStartedMs = input.nowMs;
      return next;

    case ConnectivityEvent::Tick:
      break;
  }

  if (current.phase == ConnectivityPhase::Joining &&
      elapsed(input.nowMs, current.phaseStartedMs, kInitialJoinTimeoutMs)) {
    next.phase = ConnectivityPhase::SetupAp;
    next.apActive = true;
    next.stationAssociated = false;
    next.networkBindingsPending = false;
    next.wledListenerReady = false;
    next.artnetListenerReady = false;
    next.phaseStartedMs = input.nowMs;
    next.lastAttemptMs = input.nowMs;
    return next;
  }

  if (current.phase == ConnectivityPhase::SetupAp &&
      (current.generation != 0 || !current.handoffRequired) &&
      elapsed(input.nowMs, current.lastAttemptMs, kReconnectCadenceMs)) {
    next.phase = ConnectivityPhase::Joining;
    next.reconnectDue = true;
    next.phaseStartedMs = input.nowMs;
    return next;
  }

  if (current.phase == ConnectivityPhase::HandoffReady &&
      elapsed(input.nowMs, current.phaseStartedMs, kHandoffMaxMs)) {
    // The acknowledgement never arrived. If the card is nonetheless associated
    // to the station network, that is a finished join with an unwitnessed
    // handoff — settle into Station so local playback stops being refused.
    // Leaving it in a pending phase stranded a fully-working card forever
    // whenever the worker never returned to the Studio tab.
    next.phase = current.stationAssociated
        ? ConnectivityPhase::Station
        : ConnectivityPhase::HandoffAbandoned;
    next.apActive = false;
    next.phaseStartedMs = input.nowMs;
    return next;
  }

  if (current.phase == ConnectivityPhase::Reconnecting &&
      elapsed(input.nowMs, current.phaseStartedMs, kRecoveryApThresholdMs)) {
    next.phase = ConnectivityPhase::RecoveryAp;
    next.apActive = true;
    next.phaseStartedMs = input.nowMs;
  }

  if ((next.phase == ConnectivityPhase::Reconnecting ||
       next.phase == ConnectivityPhase::RecoveryAp) &&
      elapsed(input.nowMs, current.lastAttemptMs, kReconnectCadenceMs)) {
    next.reconnectDue = true;
  }

  if (next.stationAssociated && next.networkBindingsPending &&
      elapsed(input.nowMs,
              current.lastBindingAttemptMs,
              kNetworkBindingRetryMs)) {
    next.networkBindingsRetryDue = true;
  }

  return next;
}

// How often the card re-announces its name on the network. The responder is
// bound to one WiFi association and goes quiet after a reconnect; without this
// the card is only reachable by an address its router is free to change, which
// is what makes Studio mistake a working card for a brand-new one.
constexpr uint32_t LW_MDNS_REANNOUNCE_MS = 120000;

}  // namespace lightweaver
