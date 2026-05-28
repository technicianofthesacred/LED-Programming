#include "LightweaverWledRealtime.h"

#include <WiFi.h>
#include <WiFiUdp.h>

#include "LightweaverFrameSource.h"

// WLED realtime UDP listens on port 21324 by default.
static constexpr uint16_t WLED_REALTIME_PORT = 21324;

// DRGB packet layout (the simplest WLED realtime mode):
//   byte 0     : protocol id, 2 = DRGB
//   byte 1     : timeout in seconds (we ignore; our own watchdog covers it)
//   bytes 2..N : repeating RGB triplets, one per pixel starting at pixel 0
static constexpr uint8_t WLED_PROTO_DRGB = 2;

// Customer brightness lives in main.cpp; we scale incoming pixels by it so
// the user's brightness knob still works during streaming.
extern float manualBrightness;

namespace {
WiFiUDP g_udp;
CRGB* g_leds = nullptr;
uint16_t g_totalPixels = 0;
bool g_started = false;
// Heuristic for "we've already warned about this unsupported protocol id
// recently" — avoids spamming the serial log when a designer points a non-
// DRGB stream at us. Reset on every new protocol id we see.
uint8_t g_lastUnsupportedProto = 0xFF;
uint32_t g_lastUnsupportedWarnAt = 0;
}

void setupWledRealtime(CRGB* leds, uint16_t totalPixels) {
  g_leds = leds;
  g_totalPixels = totalPixels;
  if (WiFi.status() != WL_CONNECTED) {
    // Still safe to begin() — WiFiUDP will bind once the interface is up.
    // We log a hint so it's obvious in serial if streaming never starts.
    Serial.println("WLED realtime: WiFi not connected yet at setup; will bind anyway");
  }
  if (g_udp.begin(WLED_REALTIME_PORT)) {
    g_started = true;
    Serial.print("WLED realtime listening on UDP ");
    Serial.println(WLED_REALTIME_PORT);
  } else {
    Serial.println("WLED realtime: udp.begin() failed");
  }
}

void handleWledRealtime() {
  if (!g_started || g_leds == nullptr || g_totalPixels == 0) return;

  // Drain every queued packet; we always want the freshest frame, not the
  // oldest. If a sender outpaces us we'd rather drop intermediate frames
  // than fall behind. The loop bound is defensive — at typical 30-60 FPS
  // streaming there's at most a handful queued at once.
  for (int safety = 0; safety < 8; safety++) {
    int packetSize = g_udp.parsePacket();
    if (packetSize <= 0) return;

    // Hard cap: drop oversized packets before reading them into RAM.
    // We accept up to totalPixels worth of RGB plus the 2-byte header.
    int maxAccepted = int(g_totalPixels) * 3 + 2;
    if (packetSize > maxAccepted) {
      // Flush the packet without keeping it; reading 0 bytes still
      // advances the queue once parsePacket() has selected the packet.
      uint8_t dump[64];
      int remaining = packetSize;
      while (remaining > 0) {
        int chunk = remaining > (int)sizeof(dump) ? (int)sizeof(dump) : remaining;
        int got = g_udp.read(dump, chunk);
        if (got <= 0) break;
        remaining -= got;
      }
      Serial.print("WLED realtime: dropped oversize packet ");
      Serial.println(packetSize);
      continue;
    }

    // Smallest legal DRGB frame is the 2-byte header plus one RGB triplet.
    if (packetSize < 5) {
      // Drain and ignore.
      uint8_t dump[8];
      g_udp.read(dump, packetSize);
      continue;
    }

    // Stack buffer sized to the worst-case payload (header + every pixel).
    // LW_MAX_PIXELS is 1024 by default → 3074 bytes worst case, fine on S3.
    static uint8_t buf[LW_MAX_PIXELS * 3 + 2];
    int got = g_udp.read(buf, packetSize);
    if (got <= 2) continue;

    uint8_t proto = buf[0];
    // buf[1] is timeout-seconds per spec; we don't honor it. Our own
    // frameSourceTick() watchdog handles fallback to internal rendering.

    if (proto != WLED_PROTO_DRGB) {
      uint32_t now = millis();
      if (proto != g_lastUnsupportedProto || now - g_lastUnsupportedWarnAt > 5000) {
        Serial.print("WLED realtime: unsupported protocol id ");
        Serial.print(proto);
        Serial.println(" (only DRGB=2 implemented)");
        g_lastUnsupportedProto = proto;
        g_lastUnsupportedWarnAt = now;
      }
      continue;
    }

    // Decode RGB triplets starting at pixel 0. If the sender sent fewer
    // pixels than the strip, leave the tail untouched (designer may be
    // targeting a subset). If they sent more, we already rejected as
    // oversize above.
    int payload = got - 2;
    int pixels = payload / 3;
    if (pixels > g_totalPixels) pixels = g_totalPixels;

    // Apply customer brightness to the incoming frame. The downstream
    // FastLED.setBrightness(computeBrightnessByte()) still composes the
    // master/profile/fade ceiling on top, but applying manualBrightness
    // here keeps the streaming preview perceptually matched to where the
    // dimmer knob is set.
    uint8_t brightScale = uint8_t(constrain(int(manualBrightness * 255.0f), 0, 255));

    const uint8_t* p = buf + 2;
    for (int i = 0; i < pixels; i++) {
      g_leds[i].r = p[0];
      g_leds[i].g = p[1];
      g_leds[i].b = p[2];
      p += 3;
      if (brightScale < 255) g_leds[i].nscale8(brightScale);
    }

    frameSourceMarkExternal(FRAME_WLED_REALTIME);
  }
}
