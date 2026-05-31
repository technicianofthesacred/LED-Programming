#include "LightweaverArtnet.h"
#include "LightweaverFrameSource.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <WiFiUdp.h>

// Master brightness lives in main.cpp; the customer dimmer must apply during
// Art-Net streaming. We read it via a forward extern instead of pulling the
// whole main.cpp header tree in here.
extern float manualBrightness;

namespace {

CRGB* gLeds = nullptr;
uint16_t gTotalPixels = 0;
WiFiUDP gUdp;
bool gListening = false;

ArtnetUniverseConfig gUniverses[LW_MAX_ARTNET_UNIVERSES];
uint32_t gUniverseFramesRx[LW_MAX_ARTNET_UNIVERSES] = {0};
uint8_t gUniverseCount = 0;
uint32_t gTotalFramesRx = 0;

// Single packet scratch buffer. Art-Net DMX max payload is 18-byte header +
// 512 channels. Allocate a hair over for safety; rejected if larger.
constexpr size_t LW_ARTNET_MAX_PACKET = 18 + 512;
uint8_t gPacketBuffer[LW_ARTNET_MAX_PACKET];

// "Art-Net" + NUL — 8 bytes the spec mandates at the start of every packet.
const uint8_t ARTNET_MAGIC[8] = {'A', 'r', 't', '-', 'N', 'e', 't', 0};

constexpr uint16_t OPCODE_ARTDMX = 0x5000;

void installDefaults() {
  // Default mapping: universes 0..7 each cover 170 pixels back-to-back.
  // Madrix's "Universe 1" in human-counting maps to universe index 0 here.
  gUniverseCount = 0;
  uint16_t cursor = 0;
  for (uint8_t i = 0; i < LW_MAX_ARTNET_UNIVERSES; i++) {
    if (cursor >= gTotalPixels) break;
    uint16_t remaining = gTotalPixels - cursor;
    uint16_t count = remaining < LW_ARTNET_PIXELS_PER_UNIVERSE
                       ? remaining
                       : LW_ARTNET_PIXELS_PER_UNIVERSE;
    gUniverses[i].universe = i;
    gUniverses[i].pixelStart = cursor;
    gUniverses[i].pixelCount = count;
    gUniverseFramesRx[i] = 0;
    cursor += count;
    gUniverseCount++;
  }
}

const ArtnetUniverseConfig* findUniverse(uint16_t universe, uint8_t* outIndex) {
  for (uint8_t i = 0; i < gUniverseCount; i++) {
    if (gUniverses[i].universe == universe && gUniverses[i].pixelCount > 0) {
      if (outIndex) *outIndex = i;
      return &gUniverses[i];
    }
  }
  return nullptr;
}

void decodePacket(const uint8_t* buffer, size_t length) {
  if (length < 18) return;
  if (memcmp(buffer, ARTNET_MAGIC, 8) != 0) return;

  // OpCode is little-endian per Art-Net spec.
  uint16_t opcode = uint16_t(buffer[8]) | (uint16_t(buffer[9]) << 8);
  if (opcode != OPCODE_ARTDMX) return;

  // Bytes 10-11: ProtVer (big-endian). We accept anything; many sources
  // omit a sane value and most controllers ignore it.
  // Byte 12: Sequence. Byte 13: Physical. Both ignored here.

  uint16_t universe = uint16_t(buffer[14]) | (uint16_t(buffer[15] & 0x0F) << 8);
  // Net is buffer[15] >> 4 — we assume net=0 per task scope.

  // Length is big-endian.
  uint16_t dataLength = (uint16_t(buffer[16]) << 8) | uint16_t(buffer[17]);
  if (dataLength == 0) return;
  if (length < size_t(18) + dataLength) return;       // truncated
  if (dataLength > 512) return;                       // oversized — drop

  uint8_t cfgIndex = 0;
  const ArtnetUniverseConfig* cfg = findUniverse(universe, &cfgIndex);
  if (!cfg) return;
  if (gLeds == nullptr || gTotalPixels == 0) return;

  uint16_t pixelsInPacket = dataLength / 3;
  if (pixelsInPacket > cfg->pixelCount) pixelsInPacket = cfg->pixelCount;
  if (cfg->pixelStart + pixelsInPacket > gTotalPixels) {
    pixelsInPacket = (cfg->pixelStart < gTotalPixels)
                       ? (gTotalPixels - cfg->pixelStart)
                       : 0;
  }
  if (pixelsInPacket == 0) return;

  const uint8_t* dmx = buffer + 18;
  CRGB* dst = gLeds + cfg->pixelStart;

  // Per-pixel customer brightness scale, mirroring the WLED realtime path.
  float brightness = manualBrightness;
  if (brightness < 0.0f) brightness = 0.0f;
  if (brightness > 1.0f) brightness = 1.0f;
  uint8_t scale = uint8_t(brightness * 255.0f + 0.5f);

  for (uint16_t i = 0; i < pixelsInPacket; i++) {
    uint16_t base = i * 3;
    CRGB pixel(dmx[base], dmx[base + 1], dmx[base + 2]);
    if (scale < 255) pixel.nscale8(scale);
    dst[i] = pixel;
  }

  gUniverseFramesRx[cfgIndex]++;
  gTotalFramesRx++;
  frameSourceMarkExternal(FRAME_ARTNET);
}

}  // namespace

void setupArtnet(CRGB* leds, uint16_t totalPixels) {
  gLeds = leds;
  gTotalPixels = totalPixels;
  if (gUniverseCount == 0) installDefaults();

  // Bind even if WiFi isn't connected yet — WiFiUDP.begin returns 1 once the
  // socket is created. Once STA associates, packets start arriving.
  if (gUdp.begin(LW_ARTNET_PORT)) {
    gListening = true;
    if (Serial) {
      Serial.print("Art-Net listening on UDP ");
      Serial.print(LW_ARTNET_PORT);
      Serial.print(" / ");
      Serial.print(gUniverseCount);
      Serial.println(" universes");
    }
  } else {
    gListening = false;
    if (Serial) Serial.println("Art-Net UDP bind failed");
  }
}

void handleArtnet() {
  if (!gListening) {
    // Lazy retry — useful when WiFi associates after setup() returns.
    static uint32_t nextRetry = 0;
    uint32_t now = millis();
    if (now >= nextRetry) {
      if (gUdp.begin(LW_ARTNET_PORT)) gListening = true;
      nextRetry = now + 2000;
    }
    if (!gListening) return;
  }

  // Drain everything pending; Madrix at 44 fps × 8 universes is ~350 pkt/s,
  // so we need to clear the queue every loop or we accumulate lag.
  // Cap iterations as a safety net against hostile floods.
  for (uint8_t guard = 0; guard < 32; guard++) {
    int packetSize = gUdp.parsePacket();
    if (packetSize <= 0) break;
    if (size_t(packetSize) > LW_ARTNET_MAX_PACKET) {
      // Oversized — flush and skip.
      gUdp.flush();
      continue;
    }
    int read = gUdp.read(gPacketBuffer, packetSize);
    if (read <= 0) break;
    decodePacket(gPacketBuffer, size_t(read));
  }
}

bool artnetIsConfigured() {
  return gUniverseCount > 0;
}

void artnetConfigure(const ArtnetUniverseConfig* configs, uint8_t count) {
  if (count > LW_MAX_ARTNET_UNIVERSES) count = LW_MAX_ARTNET_UNIVERSES;
  gUniverseCount = 0;
  for (uint8_t i = 0; i < count; i++) {
    if (configs[i].pixelCount == 0) continue;
    gUniverses[gUniverseCount] = configs[i];
    if (gUniverses[gUniverseCount].pixelCount > LW_ARTNET_PIXELS_PER_UNIVERSE) {
      gUniverses[gUniverseCount].pixelCount = LW_ARTNET_PIXELS_PER_UNIVERSE;
    }
    gUniverseFramesRx[gUniverseCount] = 0;
    gUniverseCount++;
  }
  if (gUniverseCount == 0) installDefaults();
}

String artnetStatusJson() {
  JsonDocument doc;
  doc["port"] = LW_ARTNET_PORT;
  doc["listening"] = gListening;
  doc["totalFramesRx"] = gTotalFramesRx;
  JsonArray arr = doc["universes"].to<JsonArray>();
  for (uint8_t i = 0; i < gUniverseCount; i++) {
    JsonObject obj = arr.add<JsonObject>();
    obj["universe"] = gUniverses[i].universe;
    obj["pixelStart"] = gUniverses[i].pixelStart;
    obj["pixelCount"] = gUniverses[i].pixelCount;
    obj["framesRx"] = gUniverseFramesRx[i];
  }
  String out;
  serializeJson(doc, out);
  return out;
}
