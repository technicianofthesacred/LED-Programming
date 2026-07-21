#include <cassert>
#include <cstdint>
#include <string>
#include <vector>

#include "../src/LightweaverConnectivityPolicy.h"

using namespace lightweaver;

namespace {

struct ProductionStyleAdapter {
  ConnectivityState connectivity{};
  std::vector<std::uint32_t> stationAttempts;
  std::vector<std::uint32_t> bindingAttempts;
  std::string project = "gallery-project-v4";
  std::string output = "aurora:brightness=.62:rgb";
  bool nextWledBind = true;
  bool nextArtnetBind = true;

  void dispatch(ConnectivityEvent event,
                std::uint32_t now,
                std::uint32_t generation = 0) {
    connectivity = advanceConnectivity(
        connectivity, {event, now, generation});
    runActions(now);
  }

  void tick(std::uint32_t now) {
    dispatch(ConnectivityEvent::Tick, now);
  }

  void runActions(std::uint32_t now) {
    if (connectivity.reconnectDue) {
      stationAttempts.push_back(now);
      connectivity = recordStationAttempt(connectivity, now);
    }
    if (connectivity.networkBindingsRetryDue) {
      bindingAttempts.push_back(now);
      connectivity = recordNetworkBindingAttempt(
          connectivity, now, nextWledBind, nextArtnetBind);
    }
  }
};

}  // namespace

int main() {
  ProductionStyleAdapter adapter;

  adapter.dispatch(ConnectivityEvent::CredentialsAccepted, 100, 31);
  assert((adapter.stationAttempts == std::vector<std::uint32_t>{100}));
  adapter.dispatch(ConnectivityEvent::StationAssociated, 500, 31);
  assert(!adapter.connectivity.networkBindingsPending);
  adapter.dispatch(ConnectivityEvent::StationOriginAck, 700, 31);
  assert(adapter.connectivity.phase == ConnectivityPhase::Station);
  assert(!connectivityTransitionPending(adapter.connectivity));

  const std::string savedProject = adapter.project;
  const std::string savedOutput = adapter.output;
  adapter.dispatch(ConnectivityEvent::StationLost, 1000);
  assert((adapter.stationAttempts ==
          std::vector<std::uint32_t>{100, 1000}));
  assert(connectivityTransitionPending(adapter.connectivity));

  for (std::uint32_t now : {1001u, 10999u}) adapter.tick(now);
  assert(adapter.stationAttempts.size() == 2);
  adapter.tick(11000);
  assert(adapter.stationAttempts.back() == 11000);
  adapter.tick(11001);
  adapter.tick(20999);
  assert(adapter.stationAttempts.back() == 11000);
  for (std::uint32_t now : {21000u, 31000u, 41000u, 51000u}) {
    adapter.tick(now);
    assert(adapter.stationAttempts.back() == now);
  }
  adapter.tick(60999);
  assert(adapter.connectivity.phase == ConnectivityPhase::Reconnecting);
  assert(!adapter.connectivity.apActive);
  assert(adapter.stationAttempts.back() == 51000);
  adapter.tick(61000);
  assert(adapter.connectivity.phase == ConnectivityPhase::RecoveryAp);
  assert(adapter.connectivity.apActive);
  assert(adapter.stationAttempts.back() == 61000);

  adapter.nextWledBind = true;
  adapter.nextArtnetBind = false;
  adapter.dispatch(ConnectivityEvent::StationAssociated, 61500);
  assert(adapter.connectivity.phase == ConnectivityPhase::Station);
  assert(!adapter.connectivity.apActive);
  assert(adapter.connectivity.networkBindingsPending);
  assert(connectivityTransitionPending(adapter.connectivity));
  assert(adapter.bindingAttempts.back() == 61500);

  adapter.tick(63499);
  assert(adapter.bindingAttempts.back() == 61500);
  assert(connectivityTransitionPending(adapter.connectivity));
  adapter.nextArtnetBind = true;
  adapter.tick(63500);
  assert(adapter.bindingAttempts.back() == 63500);
  assert(!adapter.connectivity.networkBindingsPending);
  assert(!connectivityTransitionPending(adapter.connectivity));

  adapter.dispatch(ConnectivityEvent::StationLost, 70000);
  adapter.dispatch(ConnectivityEvent::StationAssociated, 70500);
  assert(adapter.connectivity.phase == ConnectivityPhase::Station);
  assert(adapter.project == savedProject);
  assert(adapter.output == savedOutput);
  assert(adapter.stationAttempts.back() == 70000);
  assert(adapter.bindingAttempts.back() == 70500);

  return 0;
}
