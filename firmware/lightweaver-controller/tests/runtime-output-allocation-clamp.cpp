// Host harness proving no write in copyLogicalToPhysicalLeds can leave the
// pixel buffers this boot actually allocated.
//
// main.cpp cannot be compiled here (Arduino core, FastLED RMT, WebServer, SD),
// so the runner slices the SHIPPED text of the three functions under test out
// of main.cpp and writes it to the include below. Everything those functions
// reach for is declared here with the same names and types as the firmware
// globals, so the code being exercised is the code that ships.
//
// The buffers are deliberately allocated far larger than allocatedPixels and
// the surplus is poisoned with a sentinel. Any index past allocatedPixels
// therefore lands in a slot the test can check instead of in whatever the real
// heap happens to hold — a genuine overflow on hardware, a caught assertion
// here.

#include <cassert>
#include <cstdint>
#include <cstdio>

#include "LightweaverTypes.h"

namespace {
constexpr uint16_t HOST_BUFFER_PIXELS = 8192;
constexpr uint8_t SENTINEL = 0xA5;
}  // namespace

// Firmware globals the sliced functions read and write, same names and types.
CRGB hostLeds[HOST_BUFFER_PIXELS];
CRGB hostPhysicalLeds[HOST_BUFFER_PIXELS];
CRGB* leds = hostLeds;
CRGB* physicalLeds = hostPhysicalLeds;
OutputConfig outputs[LW_MAX_OUTPUTS];
uint8_t outputCount = 0;
uint16_t totalPixels = 0;
uint16_t allocatedPixels = 0;
String ledColorOrder = "GRB";
uint8_t ledColorOrderCode = 1;

bool pixelBuffersReady() { return leds != nullptr && physicalLeds != nullptr; }

// The real pipeline needs FastLED's scale8_video / applyGamma_video, which the
// host stub does not carry. Colour is not what is under test here; the indices
// are, so a pass-through stand-in keeps the harness honest and small.
struct HostColorPipeline {
  CRGB transform(const CRGB& logical, uint8_t) const { return logical; }
};
HostColorPipeline outputColorPipeline;

#include "extracted-output-clamp.inc"

namespace {

void poisonBuffers() {
  for (uint16_t index = 0; index < HOST_BUFFER_PIXELS; index++) {
    hostLeds[index] = CRGB(index & 0xFF, (index >> 8) & 0xFF, 0x11);
    hostPhysicalLeds[index] = CRGB(SENTINEL, SENTINEL, SENTINEL);
  }
}

// Everything past the allocation must still be untouched.
void expectNoWriteBeyondAllocation() {
  for (uint16_t index = allocatedPixels; index < HOST_BUFFER_PIXELS; index++) {
    if (hostPhysicalLeds[index] != CRGB(SENTINEL, SENTINEL, SENTINEL)) {
      std::printf("wrote physicalLeds[%u] with allocatedPixels=%u\n", index, allocatedPixels);
      assert(false && "copyLogicalToPhysicalLeds wrote past the boot allocation");
    }
  }
}

// The invariant the clamp establishes, checked directly rather than inferred.
void expectGeometryInsideAllocation() {
  assert(totalPixels <= allocatedPixels);
  uint16_t expectedStart = 0;
  for (uint8_t outputIndex = 0; outputIndex < outputCount; outputIndex++) {
    const OutputConfig& output = outputs[outputIndex];
    assert(output.start == expectedStart);
    assert(uint32_t(output.start) + output.pixels <= allocatedPixels);
    uint32_t segmentUsed = 0;
    for (uint8_t segmentIndex = 0; segmentIndex < output.segmentCount; segmentIndex++) {
      segmentUsed += output.segments[segmentIndex].count;
      assert(uint32_t(output.start) + segmentUsed <= allocatedPixels);
    }
    expectedStart = static_cast<uint16_t>(expectedStart + output.pixels);
  }
}

OutputConfig makeOutput(const char* id, uint8_t pin, uint16_t pixels, uint8_t segmentCount,
                        const uint16_t* segmentCounts, bool reversed) {
  OutputConfig output;
  output.id = String(id);
  output.pin = pin;
  output.pixels = pixels;
  output.segmentCount = segmentCount;
  for (uint8_t index = 0; index < segmentCount; index++) {
    output.segments[index].id = String(id);
    output.segments[index].count = segmentCounts[index];
    output.segments[index].reversed = reversed;
  }
  output.enabled = true;
  return output;
}

// Stand in for the part of applyRuntimeConfig() under test: copy the config's
// outputs in, then fit them to this boot's allocation.
void applyOutputs(uint16_t allocation, uint8_t count, const OutputConfig* source) {
  allocatedPixels = allocation;
  outputCount = count;
  for (uint8_t index = 0; index < count; index++) outputs[index] = source[index];
  clampRuntimeOutputsToAllocation();
}

void runFrame() {
  poisonBuffers();
  copyLogicalToPhysicalLeds();
  // Buffer first, geometry second: the overflow is the defect, the invariant
  // is only how it is prevented, and a failure should name the overflow.
  expectNoWriteBeyondAllocation();
  expectGeometryInsideAllocation();
}

}  // namespace

int main() {
  // ── the reported overflow: a bigger config applied before the reboot ──────
  // The card booted small, then a POST applied a 1000 px reversed strip. The
  // old code clamped totalPixels to 300 and left start / segment counts alone,
  // so the reversed write aimed at physicalLeds[999] out of a 300 px buffer.
  {
    const uint16_t segments[] = {1000};
    OutputConfig config[] = {makeOutput("out-1", 16, 1000, 1, segments, true)};
    applyOutputs(300, 1, config);
    runFrame();
    assert(totalPixels == 300);
    assert(outputs[0].pixels == 300);
    assert(outputs[0].segments[0].count == 300);
  }

  // Same shape forward — the logical bound alone already covered this one, so
  // it is here to prove the clamp did not break the case that used to work.
  {
    const uint16_t segments[] = {1000};
    OutputConfig config[] = {makeOutput("out-1", 16, 1000, 1, segments, false)};
    applyOutputs(300, 1, config);
    runFrame();
  }

  // A later output starting past the allocation must not write at all, and a
  // straddling one must be trimmed rather than truncated only on its loop.
  {
    const uint16_t first[] = {400};
    const uint16_t second[] = {400};
    const uint16_t third[] = {400};
    OutputConfig config[] = {
        makeOutput("out-1", 16, 400, 1, first, false),
        makeOutput("out-2", 17, 400, 1, second, true),
        makeOutput("out-3", 18, 400, 1, third, true),
    };
    applyOutputs(500, 3, config);
    runFrame();
    assert(outputs[0].pixels == 400);
    assert(outputs[1].pixels == 100);
    assert(outputs[1].segments[0].count == 100);
    assert(outputs[2].pixels == 0);
    assert(outputs[2].segments[0].count == 0);
    assert(totalPixels == 500);
  }

  // Multi-segment output that straddles the ceiling: earlier segments keep
  // their length, the straddling one is trimmed, later ones go to zero.
  {
    const uint16_t segments[] = {100, 100, 100, 100};
    OutputConfig config[] = {makeOutput("out-1", 16, 400, 4, segments, true)};
    applyOutputs(250, 1, config);
    runFrame();
    assert(outputs[0].pixels == 250);
    assert(outputs[0].segments[0].count == 100);
    assert(outputs[0].segments[1].count == 100);
    assert(outputs[0].segments[2].count == 50);
    assert(outputs[0].segments[3].count == 0);
  }

  // Segments that already sum past their own output are trimmed too — the
  // reversed write reads the SEGMENT length, so an over-long segment inside a
  // correctly sized output is the same overflow by another route.
  {
    const uint16_t segments[] = {600};
    OutputConfig config[] = {makeOutput("out-1", 16, 200, 1, segments, true)};
    applyOutputs(4096, 1, config);
    runFrame();
    assert(outputs[0].pixels == 200);
    assert(outputs[0].segments[0].count == 200);
  }

  // A blank card: no outputs, nothing written, no crash.
  {
    applyOutputs(512, 0, nullptr);
    runFrame();
    assert(totalPixels == 0);
  }

  // A zero allocation (buffers not claimed yet) must trim everything to zero
  // rather than trusting the config.
  {
    const uint16_t segments[] = {120};
    OutputConfig config[] = {makeOutput("out-1", 16, 120, 1, segments, true)};
    applyOutputs(0, 1, config);
    runFrame();
    assert(totalPixels == 0);
    assert(outputs[0].pixels == 0);
  }

  // The ordinary case — a config that fits — must be left exactly alone, and
  // the reversed segment must still mirror correctly.
  {
    const uint16_t segments[] = {60, 60};
    OutputConfig config[] = {makeOutput("out-1", 16, 120, 2, segments, true)};
    applyOutputs(512, 1, config);
    runFrame();
    assert(totalPixels == 120);
    assert(outputs[0].pixels == 120);
    assert(outputs[0].segments[0].count == 60);
    assert(outputs[0].segments[1].count == 60);
    // Reversed segment 0 covers 0..59 mirrored: logical 0 lands at physical 59.
    assert(hostPhysicalLeds[59] == hostLeds[0]);
    assert(hostPhysicalLeds[0] == hostLeds[59]);
    // Reversed segment 1 covers 60..119 mirrored.
    assert(hostPhysicalLeds[119] == hostLeds[60]);
    assert(hostPhysicalLeds[60] == hostLeds[119]);
  }

  // Four maximum-width outputs: the request overflows uint16_t if summed
  // naively, and must still land entirely inside the allocation.
  {
    const uint16_t segments[] = {65535};
    OutputConfig config[] = {
        makeOutput("out-1", 16, 65535, 1, segments, true),
        makeOutput("out-2", 17, 65535, 1, segments, true),
        makeOutput("out-3", 18, 65535, 1, segments, true),
        makeOutput("out-4", 21, 65535, 1, segments, true),
    };
    applyOutputs(4096, 4, config);
    runFrame();
    assert(totalPixels == 4096);
    assert(outputs[0].pixels == 4096);
    assert(outputs[1].pixels == 0);
  }

  return 0;
}
