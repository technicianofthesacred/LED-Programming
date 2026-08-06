// Host harness for the blank-card factory beacon sweep.
//
// main.cpp cannot be compiled here (WiFi, Preferences, esp_system, FastLED
// proper), so the runner slices the SHIPPED text of setupFactoryBeaconOutputs()
// and showFactoryBeaconFrame() out of main.cpp and writes it to the include
// below. Everything those two functions touch is supplied here, including a
// controllable clock, so this test watches the real animation run rather than
// pattern-matching its source.
//
// What it proves: over a full sweep, the set of buffer slices the beacon lights
// is exactly the set of slices that were handed to a FastLED controller. When
// the two disagreed, the pin menu's first four entries (GPIO 4/5/6/7 — the
// DEFAULT control pins, skipped at registration) still got beacon steps, so a
// freshly flashed card sat dark for 12 seconds of every sweep and read as dead.
//
// argv is the list of GPIOs claimed by controls for this run, so the runner can
// exercise the stock control assignment and a card whose controls were moved.

#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <set>
#include <vector>

#include "LightweaverTypes.h"
#include "LightweaverOutputPolicy.h"

// The sliced frame function reads millis(); the host Arduino stub returns a
// constant, which would freeze the sweep on a single step. Shadow it with a
// variable the test drives.
static uint32_t hostNowMs = 0;
#define millis() hostNowMs

constexpr uint16_t LW_BEACON_BUFFER_PIXELS =
    LW_APPROVED_OUTPUT_GPIO_COUNT * LW_FACTORY_BEACON_PIXEL_LIMIT;

// ---- state the sliced firmware reads and writes ----
CRGB physicalLeds[LW_BEACON_BUFFER_PIXELS];
bool ledOutputsReady = false;
uint8_t factoryBeaconSteps[LW_APPROVED_OUTPUT_GPIO_COUNT] = {};
uint8_t factoryBeaconStepCount = 0;
uint8_t factoryBeaconPinnedStep = UINT8_MAX;
uint32_t factoryBeaconPinExpiresAtMs = 0;
// The probe refuses unless the card is genuinely in beacon mode, so the harness
// has to stand in for that. A configured card drives its real outputs and must
// not be steerable through this path.
bool factoryBeaconMode = true;
RuntimeConfig runtimeConfig;
bool restartTransitionPending = false;
bool identifyActive = false;
uint32_t recoveryHoldUntilMs = 0;

namespace {

struct HostController {
  uint8_t pin = 0;
  uint16_t sliceStart = 0;
};

std::vector<HostController> hostRegistered;
std::set<uint8_t> hostClaimedControlPins;

}  // namespace

// ---- stubs for the platform surface the two sliced functions call ----
struct HostFastLED {
  void setDither(bool) {}
  void setCorrection(int) {}
  void setMaxPowerInVoltsAndMilliamps(int, uint32_t) {}
  void clear(bool) {}
};
static HostFastLED FastLED;
static constexpr int TypicalLEDStrip = 0;

bool pixelBuffersReady() { return true; }

// Mirrors the shipped rule: an approved output GPIO is unavailable while a
// control claims it.
bool discoveryPinAvailable(uint8_t pin) {
  return hostClaimedControlPins.count(pin) == 0;
}

bool addLedsForPin(uint8_t pin, CRGB* start, uint16_t count) {
  assert(count == LW_FACTORY_BEACON_PIXEL_LIMIT);
  hostRegistered.push_back({pin, uint16_t(start - physicalLeds)});
  return true;
}

void transmitPhysicalLeds(uint8_t, OutputSourceClass) {}

void clearPhysicalLeds() {
  fill_solid(physicalLeds, LW_BEACON_BUFFER_PIXELS, CRGB::Black);
  transmitPhysicalLeds(0, OUTPUT_LOCAL);
}

bool frameSourceIsStreaming() { return false; }

WiringSafetyStatus getRuntimeWiringSafetyStatus() { return WiringSafetyStatus(); }

#include "extracted-factory-beacon.inc"

namespace {

// Which approved-GPIO slice, if any, carries non-black pixels right now.
// Returns -1 for an entirely dark buffer and fails on a split frame: the beacon
// identifies ONE port at a time, and lighting two would misname the port the
// owner is looking at.
int litSlice() {
  int lit = -1;
  for (uint16_t slice = 0; slice < LW_APPROVED_OUTPUT_GPIO_COUNT; slice++) {
    bool sliceLit = false;
    for (uint16_t offset = 0; offset < LW_FACTORY_BEACON_PIXEL_LIMIT; offset++) {
      if (physicalLeds[slice * LW_FACTORY_BEACON_PIXEL_LIMIT + offset] != CRGB::Black) {
        sliceLit = true;
        break;
      }
    }
    if (!sliceLit) continue;
    assert(lit == -1 && "the beacon must light exactly one approved output slice");
    lit = int(slice);
  }
  return lit;
}

const HostController* controllerForSlice(int slice) {
  for (const HostController& controller : hostRegistered) {
    if (controller.sliceStart == uint16_t(slice) * LW_FACTORY_BEACON_PIXEL_LIMIT) {
      return &controller;
    }
  }
  return nullptr;
}

}  // namespace

int main(int argc, char** argv) {
  for (int arg = 1; arg < argc; arg++) {
    hostClaimedControlPins.insert(uint8_t(std::atoi(argv[arg])));
  }

  // A blank card: factory phase, no project, beacon owns the output.
  runtimeConfig.runtimePhase = ProvisioningPhase::Factory;

  assert(setupFactoryBeaconOutputs());
  assert(ledOutputsReady);
  assert(!hostRegistered.empty());

  std::set<uint8_t> registeredPins;
  for (const HostController& controller : hostRegistered) {
    registeredPins.insert(controller.pin);
  }

  // Walk a full menu's worth of steps. That is at least one complete sweep for
  // any step-list length, so every registered port must have pulsed by the end.
  std::set<uint8_t> litPins;
  uint16_t darkSteps = 0;
  for (uint16_t step = 0; step < LW_APPROVED_OUTPUT_GPIO_COUNT; step++) {
    // Sample inside the steady-on window, where a working step is lit.
    hostNowMs = LW_FACTORY_BEACON_STEP_MS * (step + 1) + 200;
    showFactoryBeaconFrame();
    int slice = litSlice();
    if (slice < 0) {
      darkSteps++;
      continue;
    }
    const HostController* controller = controllerForSlice(slice);
    // The failure this test exists for: a step addressing a buffer slice that
    // no FastLED controller was ever given transmits nothing at all.
    assert(controller != nullptr &&
           "the beacon lit a buffer slice no registered output drives");
    litPins.insert(controller->pin);
  }

  assert(darkSteps == 0 && "every beacon step must drive a registered output");
  assert(litPins == registeredPins &&
         "the beacon step set and the registered-output set must be identical");

  // The registered set is itself the available set — no control-claimed GPIO
  // may be registered, and no available one may be left out.
  std::set<uint8_t> expected;
  for (size_t index = 0; index < LW_APPROVED_OUTPUT_GPIO_COUNT; index++) {
    uint8_t pin = LW_APPROVED_OUTPUT_GPIOS[index];
    if (discoveryPinAvailable(pin)) expected.insert(pin);
  }
  assert(registeredPins == expected);

  // The whole sweep is the worst-case wait before an owner decides the card is
  // dead, so it has to stay inside the ceiling main.cpp static_asserts.
  assert(uint32_t(factoryBeaconStepCount) * LW_FACTORY_BEACON_STEP_MS <= 45000U);

  // ── The owner-facing port probe ────────────────────────────────────────────
  // "Click port 18, and if something is plugged into 18 it lights." The whole
  // value is that the port the owner NAMED is the port that lights; pinning the
  // wrong slice would tell them a strip is somewhere it is not, which is worse
  // than the sweep it replaces.
  uint8_t reported[LW_APPROVED_OUTPUT_GPIO_COUNT] = {};
  uint8_t reportedCount = 0;
  assert(runtimeBeaconPortsAvailable(reported, sizeof(reported), reportedCount));
  std::set<uint8_t> reportedPins(reported, reported + reportedCount);
  assert(reportedPins == registeredPins &&
         "the grid Studio renders must be exactly the ports the card can light");

  for (uint8_t pin : registeredPins) {
    uint16_t litPixels = 0;
    assert(runtimeBeaconPinPort(pin, litPixels) &&
           "every port the card reports available must be pinnable");
    assert(litPixels == LW_FACTORY_BEACON_PIXEL_LIMIT);

    // Hold across several steps' worth of clock. A pinned port must stay put:
    // if the sweep bled through, the owner would see a DIFFERENT port light and
    // conclude their strip is on the wrong one.
    for (uint16_t tick = 1; tick <= 4; tick++) {
      hostNowMs = LW_FACTORY_BEACON_STEP_MS * tick + 200;
      showFactoryBeaconFrame();
      int slice = litSlice();
      assert(slice >= 0 && "a pinned port must actually light");
      const HostController* controller = controllerForSlice(slice);
      assert(controller != nullptr && controller->pin == pin &&
             "a pinned port must light the port the owner asked for, and only it");
    }
  }

  // A control-claimed GPIO has no controller, so the card must say so rather
  // than accept the click and light nothing — Studio greys the button out.
  for (size_t index = 0; index < LW_APPROVED_OUTPUT_GPIO_COUNT; index++) {
    uint8_t pin = LW_APPROVED_OUTPUT_GPIOS[index];
    if (discoveryPinAvailable(pin)) continue;
    uint16_t litPixels = 0;
    assert(!runtimeBeaconPinPort(pin, litPixels) &&
           "a control-claimed port must be refused, not silently accepted");
    assert(litPixels == 0);
  }
  uint16_t offMenuPixels = 0;
  assert(!runtimeBeaconPinPort(99, offMenuPixels) &&
         "a GPIO outside the approved menu must be refused");

  // Releasing hands the card straight back to advertising itself, rather than
  // leaving it parked on one port looking like a fault.
  {
    uint8_t firstPin = *registeredPins.begin();
    uint16_t litPixels = 0;
    assert(runtimeBeaconPinPort(firstPin, litPixels));
    runtimeBeaconReleasePort();
    std::set<uint8_t> afterRelease;
    for (uint16_t step = 0; step < LW_APPROVED_OUTPUT_GPIO_COUNT; step++) {
      hostNowMs = LW_FACTORY_BEACON_STEP_MS * (step + 1) + 200;
      showFactoryBeaconFrame();
      int slice = litSlice();
      assert(slice >= 0);
      afterRelease.insert(controllerForSlice(slice)->pin);
    }
    assert(afterRelease == registeredPins &&
           "releasing the pin must resume the full sweep");
  }

  // A pin that is never renewed must lapse on its own. Studio re-asserts while
  // its grid is open; a closed tab or a walked-away owner must not leave the
  // card pinned forever.
  {
    uint8_t firstPin = *registeredPins.begin();
    uint16_t litPixels = 0;
    hostNowMs = LW_FACTORY_BEACON_STEP_MS;
    assert(runtimeBeaconPinPort(firstPin, litPixels));
    // Sample points must land inside the steady-on window, so walk whole steps
    // from a step-aligned base past the expiry. Adding the hold directly shifts
    // the phase into the gap between the two pulses and reads as dark.
    const uint32_t lapsedBase =
        ((hostNowMs + LW_FACTORY_BEACON_PIN_HOLD_MS) / LW_FACTORY_BEACON_STEP_MS + 1) *
        LW_FACTORY_BEACON_STEP_MS;
    std::set<uint8_t> afterLapse;
    for (uint16_t step = 0; step < LW_APPROVED_OUTPUT_GPIO_COUNT; step++) {
      hostNowMs = lapsedBase + LW_FACTORY_BEACON_STEP_MS * step + 200;
      showFactoryBeaconFrame();
      int slice = litSlice();
      assert(slice >= 0);
      afterLapse.insert(controllerForSlice(slice)->pin);
    }
    assert(afterLapse == registeredPins &&
           "an un-renewed pin must lapse back to the sweep");
  }

  printf("factory-beacon-sweep: %u registered ports, %u beacon steps, sweep %ums, "
         "%u pinnable\n",
         unsigned(registeredPins.size()), unsigned(factoryBeaconStepCount),
         unsigned(uint32_t(factoryBeaconStepCount) * LW_FACTORY_BEACON_STEP_MS),
         unsigned(reportedCount));
  return 0;
}
