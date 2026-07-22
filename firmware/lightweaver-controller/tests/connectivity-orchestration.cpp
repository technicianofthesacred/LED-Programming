#include <cassert>
#include <cstdint>
#include <string>
#include <vector>

#include "../src/LightweaverConnectivityOrchestrator.h"

using namespace lightweaver;

namespace {

struct FakeHardware {
  std::uint32_t now = 0;
  std::vector<std::uint32_t> stationAttempts;
  std::vector<std::uint32_t> bindingAttempts;
  std::vector<std::uint32_t> recoveryApAttempts;
  std::vector<std::uint32_t> setupApAttempts;
  std::vector<std::string> actions;
  std::string project = "gallery-project-v4";
  std::string output = "aurora:brightness=.62:rgb";
  bool nextWledBind = true;
  bool nextArtnetBind = true;
  std::vector<ConnectivityApResult> setupApResults;
  std::vector<ConnectivityApResult> recoveryApResults;
  std::size_t setupApResultIndex = 0;
  std::size_t recoveryApResultIndex = 0;

  void stationLost(bool preAck) {
    actions.push_back(preAck ? "preack-station-lost" : "station-lost");
  }

  void stationAssociated() {
    actions.push_back("station-associated");
  }

  ConnectivityBindingResult refreshNetworkBindings(bool force) {
    actions.push_back(force ? "force-bindings" : "retry-bindings");
    bindingAttempts.push_back(now);
    return {nextWledBind, nextArtnetBind};
  }

  void initialJoinTimedOut() {
    actions.push_back("initial-join-timeout");
  }

  ConnectivityApResult ensureSetupAp() {
    actions.push_back("ensure-setup-ap");
    setupApAttempts.push_back(now);
    assert(setupApResultIndex < setupApResults.size());
    return setupApResults[setupApResultIndex++];
  }

  ConnectivityApResult ensureRecoveryAp() {
    actions.push_back("ensure-recovery-ap");
    recoveryApAttempts.push_back(now);
    assert(recoveryApResultIndex < recoveryApResults.size());
    return recoveryApResults[recoveryApResultIndex++];
  }

  void retireSetupAp(bool recovery) {
    actions.push_back(recovery ? "retire-recovery-ap" : "retire-setup-ap");
  }

  bool issueStationAttempt(ConnectivityStationAttempt attempt) {
    assert(attempt != ConnectivityStationAttempt::None);
    actions.push_back(
        attempt == ConnectivityStationAttempt::Begin
            ? "station-begin"
            : "station-reconnect");
    stationAttempts.push_back(now);
    return true;
  }

  void setReadinessPending(bool pending) {
    actions.push_back(pending ? "readiness-pending" : "readiness-ready");
  }
};

ConnectivityObservation observation(std::uint32_t now,
                                    bool stationReady,
                                    bool stationAddressChanged = false,
                                    bool apReady = false) {
  return {now, stationReady, stationAddressChanged, apReady};
}

ConnectivityState run(FakeHardware& hardware,
                      const ConnectivityState& state,
                      const ConnectivityObservation& observed) {
  hardware.now = observed.nowMs;
  return runConnectivityOrchestrator(state, observed, hardware);
}

}  // namespace

int main() {
  FakeHardware hardware;
  ConnectivityState state{};
  state.phase = ConnectivityPhase::Station;
  state.apActive = false;
  state.stationAssociated = true;
  state.wledListenerReady = true;
  state.artnetListenerReady = true;
  state.lastAttemptMs = 100;

  const std::string savedProject = hardware.project;
  const std::string savedOutput = hardware.output;

  state = run(hardware, state, observation(1000, false));
  assert(state.phase == ConnectivityPhase::Reconnecting);
  assert((hardware.stationAttempts == std::vector<std::uint32_t>{1000}));
  assert((hardware.actions == std::vector<std::string>{
      "station-lost", "readiness-pending", "station-reconnect"}));
  assert(connectivityTransitionPending(state));

  for (std::uint32_t now : {1001u, 10999u}) {
    hardware.actions.clear();
    state = run(hardware, state, observation(now, false));
    assert(hardware.actions ==
           std::vector<std::string>{"readiness-pending"});
  }
  assert(hardware.stationAttempts.size() == 1);

  for (std::uint32_t now : {11000u, 21000u, 31000u, 41000u, 51000u}) {
    hardware.actions.clear();
    state = run(hardware, state, observation(now, false));
    assert(hardware.stationAttempts.back() == now);
    assert((hardware.actions == std::vector<std::string>{
        "readiness-pending", "station-reconnect"}));
  }
  hardware.actions.clear();
  state = run(hardware, state, observation(60999, false));
  assert(state.phase == ConnectivityPhase::Reconnecting);
  assert(hardware.stationAttempts.back() == 51000);

  hardware.recoveryApResults = {
      {false, false},
      {true, false},
      {true, true},
  };
  hardware.actions.clear();
  state = run(hardware, state, observation(61000, false, false, false));
  assert(state.phase == ConnectivityPhase::RecoveryAp);
  assert(!state.apActive);
  assert(hardware.stationAttempts.back() == 61000);
  assert((hardware.actions == std::vector<std::string>{
      "ensure-recovery-ap", "readiness-pending", "station-reconnect"}));

  hardware.actions.clear();
  state = run(hardware, state, observation(61250, false, false, false));
  assert(state.phase == ConnectivityPhase::RecoveryAp);
  assert(state.apActive);
  assert((hardware.actions == std::vector<std::string>{
      "ensure-recovery-ap", "readiness-pending"}));
  hardware.actions.clear();
  state = run(hardware, state, observation(61500, false, false, false));
  assert(state.apActive);
  assert((hardware.recoveryApAttempts ==
          std::vector<std::uint32_t>{61000, 61250, 61500}));

  hardware.nextWledBind = true;
  hardware.nextArtnetBind = false;
  hardware.actions.clear();
  state = run(hardware, state, observation(62000, true, false, true));
  assert(state.phase == ConnectivityPhase::Station);
  assert(!state.apActive);
  assert(state.networkBindingsPending);
  assert(connectivityTransitionPending(state));
  assert((hardware.actions == std::vector<std::string>{
      "station-associated", "force-bindings", "retire-recovery-ap",
      "readiness-pending"}));

  hardware.actions.clear();
  state = run(hardware, state, observation(63999, true));
  assert(hardware.bindingAttempts.back() == 62000);
  assert((hardware.actions ==
          std::vector<std::string>{"readiness-pending"}));
  hardware.nextArtnetBind = true;
  hardware.actions.clear();
  state = run(hardware, state, observation(64000, true));
  assert(hardware.bindingAttempts.back() == 64000);
  assert(!state.networkBindingsPending);
  assert(!connectivityTransitionPending(state));
  assert((hardware.actions == std::vector<std::string>{
      "retry-bindings", "readiness-ready"}));

  hardware.actions.clear();
  state = run(hardware, state, observation(70000, false));
  state = run(hardware, state, observation(70500, true));
  assert(state.phase == ConnectivityPhase::Station);
  assert(hardware.project == savedProject);
  assert(hardware.output == savedOutput);
  assert(hardware.stationAttempts.back() == 70000);
  assert(hardware.bindingAttempts.back() == 70500);

  ConnectivityState preAck{};
  preAck.phase = ConnectivityPhase::HandoffReady;
  preAck.apActive = true;
  preAck.stationAssociated = true;
  preAck.wledListenerReady = true;
  preAck.artnetListenerReady = true;
  preAck.generation = 44;
  preAck.phaseStartedMs = 1000;
  hardware.actions.clear();
  preAck = run(hardware, preAck, observation(200000, true, false, true));
  assert(preAck.phase == ConnectivityPhase::HandoffReady);
  assert(preAck.apActive);
  assert((hardware.actions == std::vector<std::string>{"readiness-pending"}));
  hardware.actions.clear();
  preAck = run(hardware, preAck, observation(200250, false, false, true));
  assert(preAck.phase == ConnectivityPhase::Joining);
  assert(preAck.apActive);
  assert(hardware.stationAttempts.back() == 200250);
  assert((hardware.actions == std::vector<std::string>{
      "preack-station-lost", "readiness-pending", "station-begin"}));

  ConnectivityState joining{};
  joining.phase = ConnectivityPhase::Joining;
  joining.apActive = false;
  joining.generation = 12;
  joining.phaseStartedMs = 90000;
  joining.lastAttemptMs = 90000;
  hardware.setupApResults = {
      {false, false},
      {true, false},
      {true, true},
  };
  hardware.actions.clear();
  joining = run(hardware, joining, observation(105000, false, false, false));
  assert(joining.phase == ConnectivityPhase::SetupAp);
  assert(!joining.apActive);
  assert((hardware.actions == std::vector<std::string>{
      "initial-join-timeout", "ensure-setup-ap", "readiness-ready"}));
  hardware.actions.clear();
  joining = run(hardware, joining, observation(105250, false, false, false));
  assert(joining.apActive);
  hardware.actions.clear();
  joining = run(hardware, joining, observation(105500, false, false, false));
  assert((hardware.setupApAttempts ==
          std::vector<std::uint32_t>{105000, 105250, 105500}));

  hardware.actions.clear();
  joining = run(hardware, joining, observation(114999, false, false, true));
  assert(joining.phase == ConnectivityPhase::SetupAp);
  assert((hardware.actions == std::vector<std::string>{"readiness-ready"}));
  hardware.actions.clear();
  joining = run(hardware, joining, observation(115000, false, false, true));
  assert(joining.phase == ConnectivityPhase::Joining);
  assert(hardware.stationAttempts.back() == 115000);
  assert((hardware.actions == std::vector<std::string>{
      "readiness-pending", "station-begin"}));
  hardware.actions.clear();
  joining = run(hardware, joining, observation(115250, true, false, true));
  assert(joining.phase == ConnectivityPhase::HandoffReady);
  assert(joining.apActive);
  assert((hardware.actions == std::vector<std::string>{
      "station-associated", "force-bindings", "readiness-pending"}));

  return 0;
}
