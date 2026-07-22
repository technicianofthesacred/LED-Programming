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
  CredentialsAccepted,
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
      next.phase = ConnectivityPhase::Joining;
      next.apActive = true;
      next.stationAssociated = false;
      next.reconnectDue = true;
      next.networkBindingsPending = false;
      next.wledListenerReady = false;
      next.artnetListenerReady = false;
      next.phaseStartedMs = input.nowMs;
      next.generation = input.generation;
      return next;

    case ConnectivityEvent::StationAssociated:
      if (current.phase == ConnectivityPhase::Joining) {
        next.phase = ConnectivityPhase::HandoffReady;
        next.apActive = true;
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
      current.generation != 0 &&
      elapsed(input.nowMs, current.lastAttemptMs, kReconnectCadenceMs)) {
    next.phase = ConnectivityPhase::Joining;
    next.reconnectDue = true;
    next.phaseStartedMs = input.nowMs;
    return next;
  }

  if (current.phase == ConnectivityPhase::HandoffReady &&
      elapsed(input.nowMs, current.phaseStartedMs, kHandoffMaxMs)) {
    next.phase = ConnectivityPhase::HandoffAbandoned;
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

}  // namespace lightweaver
