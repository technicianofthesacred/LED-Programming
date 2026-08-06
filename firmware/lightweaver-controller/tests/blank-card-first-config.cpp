// Host harness for runtimeConfigJsonChangesWiring().
//
// The real translation unit (LightweaverStorage.cpp) pulls in Preferences,
// mbedtls and esp_system, so it cannot be compiled here. The runner slices the
// SHIPPED text of runtimeConfigJsonChangesWiring out of LightweaverStorage.cpp
// and writes it to the include below, so this test exercises the actual
// function body rather than a paraphrase of it — the whole reason the previous
// blank-card work shipped broken was a test that agreed with itself instead of
// with the firmware.
//
// Everything the sliced function touches is supplied here: RuntimeConfig comes
// from the real header, and validateRuntimeConfigJsonStrict is stubbed so the
// test can hand it an exact parsed config (and make it fail on demand).

#include <cassert>
#include <cstdint>
#include <cstring>
#include <new>

#include "LightweaverTypes.h"

// The host String stub only compares against const char*; the sliced function
// compares String to String.
static bool sameString(const String& a, const String& b) {
  return std::strcmp(a.c_str(), b.c_str()) == 0;
}
inline bool operator==(const String& a, const String& b) { return sameString(a, b); }
inline bool operator!=(const String& a, const String& b) { return !sameString(a, b); }

// What the stubbed strict validator will produce for the next call.
static RuntimeConfig hostParsed;
static bool hostParseSucceeds = true;

bool validateRuntimeConfigJsonStrict(const String& json, RuntimeConfig& config, String& message);
bool validateRuntimeConfigJsonStrict(const String&, RuntimeConfig& config, String& message) {
  if (!hostParseSucceeds) {
    message = "invalid runtime config";
    return false;
  }
  config = hostParsed;
  message = "";
  return true;
}

#include "extracted-changes-wiring.inc"

namespace {

// One output, one forward segment covering it — the shape a bench config and a
// real single-strip project both take.
RuntimeConfig singleOutput(uint16_t pixels, uint8_t pin, bool reversed = false) {
  RuntimeConfig config;
  config.outputCount = 1;
  config.wiringRevision = 1;
  config.wiringDigest = String("digest-a");
  config.ledType = String("WS2812B");
  config.maxMilliamps = 1500;
  config.outputs[0].id = String("out-1");
  config.outputs[0].pin = pin;
  config.outputs[0].pixels = pixels;
  config.outputs[0].segmentCount = 1;
  config.outputs[0].segments[0].id = String("out-1-full");
  config.outputs[0].segments[0].count = pixels;
  config.outputs[0].segments[0].reversed = reversed;
  config.outputs[0].enabled = true;
  return config;
}

bool changesWiring(const RuntimeConfig& next, const RuntimeConfig& current, bool& ok) {
  hostParsed = next;
  hostParseSucceeds = true;
  bool changes = true;  // poisoned: the function must write it on every path
  String message;
  ok = runtimeConfigJsonChangesWiring(String("{}"), current, changes, message);
  return changes;
}

}  // namespace

int main() {
  bool ok = false;

  // A blank card has no known-good layout to protect, so a first config must
  // land directly. Staging it would strand the card: activation needs
  // commandReady and a zero-output card never gets there.
  RuntimeConfig blank;
  assert(blank.outputCount == 0);
  assert(!changesWiring(singleOutput(60, 16), blank, ok));
  assert(ok);

  // Even four outputs and a reversed run are still a FIRST config.
  RuntimeConfig fourOutputs = singleOutput(120, 16, true);
  fourOutputs.outputCount = 4;
  for (uint8_t i = 1; i < 4; i++) {
    fourOutputs.outputs[i] = fourOutputs.outputs[0];
    fourOutputs.outputs[i].pin = static_cast<uint8_t>(17 + i);
  }
  assert(!changesWiring(fourOutputs, blank, ok));
  assert(ok);

  // The exemption sits AFTER validation: a blank card must still reject a
  // config the strict parser refuses, rather than answering "no change" to
  // something it never managed to read.
  hostParseSucceeds = false;
  {
    bool changes = true;
    String message;
    assert(!runtimeConfigJsonChangesWiring(String("{"), blank, changes, message));
    assert(!changes);
    assert(message == String("invalid runtime config"));
  }
  hostParseSucceeds = true;

  // ── a card that ALREADY has outputs keeps the full protection ────────────
  const RuntimeConfig installed = singleOutput(60, 16);

  // Identical wiring is not a wiring change.
  assert(!changesWiring(singleOutput(60, 16), installed, ok));
  assert(ok);

  // Every dimension that used to stage must still stage.
  assert(changesWiring(singleOutput(120, 16), installed, ok));   // pixel count
  assert(changesWiring(singleOutput(60, 17), installed, ok));    // GPIO
  assert(changesWiring(singleOutput(60, 16, true), installed, ok));  // direction

  RuntimeConfig added = singleOutput(60, 16);
  added.outputCount = 2;
  added.outputs[1] = added.outputs[0];
  added.outputs[1].id = String("out-2");
  added.outputs[1].pin = 17;
  assert(changesWiring(added, installed, ok));  // output count

  RuntimeConfig revised = singleOutput(60, 16);
  revised.wiringRevision = 2;
  assert(changesWiring(revised, installed, ok));  // wiring revision

  RuntimeConfig redigested = singleOutput(60, 16);
  redigested.wiringDigest = String("digest-b");
  assert(changesWiring(redigested, installed, ok));  // wiring digest

  RuntimeConfig rechipped = singleOutput(60, 16);
  rechipped.ledType = String("WS2815");
  assert(changesWiring(rechipped, installed, ok));  // chipset

  RuntimeConfig recurrent = singleOutput(60, 16);
  recurrent.maxMilliamps = 6000;
  assert(changesWiring(recurrent, installed, ok));  // current ceiling

  RuntimeConfig resegmented = singleOutput(60, 16);
  resegmented.outputs[0].segmentCount = 2;
  resegmented.outputs[0].segments[0].count = 30;
  resegmented.outputs[0].segments[1].id = String("out-1-b");
  resegmented.outputs[0].segments[1].count = 30;
  assert(changesWiring(resegmented, installed, ok));  // segmentation

  // An installed card that later loses every output (a wipe) is blank again,
  // and the next config is once more a first config.
  RuntimeConfig wiped;
  assert(!changesWiring(singleOutput(60, 16), wiped, ok));
  assert(ok);

  return 0;
}
