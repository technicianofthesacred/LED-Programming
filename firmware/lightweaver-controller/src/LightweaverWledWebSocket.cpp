#include "LightweaverWledWebSocket.h"
#include "LightweaverFrameSource.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverTypes.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <WebSocketsServer.h>

extern CRGB leds[];
extern uint16_t totalPixels;
extern RuntimeConfig runtimeConfig;
extern float manualBrightness;
extern uint8_t lookCount;
extern LookConfig looks[];

namespace {

// WebSocket server on port 81 — running it on 80 alongside the Arduino
// WebServer would collide on the listener. Designer's URL builder is told
// to append `:81/ws` instead of `/ws`.
WebSocketsServer ws(81, "*", "");
bool started = false;

// Decode an uppercase or lowercase 6-char hex string into RGB.
bool hexToRgb(const char* s, uint8_t& r, uint8_t& g, uint8_t& b) {
  if (!s || strlen(s) < 6) return false;
  auto h = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  int rh = h(s[0]), rl = h(s[1]), gh = h(s[2]), gl = h(s[3]), bh = h(s[4]), bl = h(s[5]);
  if (rh < 0 || rl < 0 || gh < 0 || gl < 0 || bh < 0 || bl < 0) return false;
  r = uint8_t((rh << 4) | rl);
  g = uint8_t((gh << 4) | gl);
  b = uint8_t((bh << 4) | bl);
  return true;
}

// Translate a WLED-shaped JSON state message into a frame write (live preview
// path) or a state mutation. Mirrors the HTTP POST /json/state handler.
void applyState(uint8_t* payload, size_t length) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload, length);
  if (err) return;

  bool framePushed = false;
  JsonArray segs = doc["seg"].as<JsonArray>();
  if (!segs.isNull()) {
    for (JsonObject s : segs) {
      JsonArray pixels = s["i"].as<JsonArray>();
      if (!pixels.isNull() && pixels.size() > 0) {
        framePushed = true;
        int writeIdx = s["start"] | 0;
        if (writeIdx < 0) writeIdx = 0;
        uint8_t scale = uint8_t(manualBrightness * 255.0f);
        for (JsonVariant v : pixels) {
          if (writeIdx >= int(totalPixels)) break;
          if (v.is<const char*>()) {
            uint8_t r, g, b;
            if (hexToRgb(v.as<const char*>(), r, g, b)) {
              CRGB px(r, g, b);
              px.nscale8(scale);
              leds[writeIdx++] = px;
            } else {
              writeIdx++;
            }
          } else if (v.is<JsonArray>()) {
            JsonArray t = v.as<JsonArray>();
            if (t.size() >= 3) {
              CRGB px(t[0].as<int>() & 0xff, t[1].as<int>() & 0xff, t[2].as<int>() & 0xff);
              px.nscale8(scale);
              leds[writeIdx++] = px;
            }
          }
        }
      }
      if (!s["fx"].isNull()) {
        int fx = s["fx"].as<int>();
        if (fx >= 0 && fx < lookCount) {
          runtimeSelectPatternById(looks[fx].id);
        }
      }
    }
  }

  if (framePushed) {
    frameSourceMarkExternal(FRAME_WLED_REALTIME);
  } else {
    if (!doc["bri"].isNull()) {
      runtimeSetBrightness(float(doc["bri"].as<int>()) / 255.0f);
    }
    if (!doc["on"].isNull()) {
      runtimeSetBlackout(!doc["on"].as<bool>());
    }
    if (!doc["ps"].isNull()) {
      int ps = doc["ps"].as<int>();
      if (ps >= 0 && ps < lookCount) {
        runtimeSelectPatternById(looks[ps].id);
      }
    }
  }
}

void onEvent(uint8_t clientId, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      // Stock WLED sends a {"success":true} or info dump on connect; the
      // designer doesn't strictly require one but a small ack is friendly.
      ws.sendTXT(clientId, "{\"success\":true}");
      break;
    case WStype_TEXT:
      applyState(payload, length);
      break;
    case WStype_BIN:
      // Designer doesn't send binary frames; stock WLED does for some real-
      // time protocols. Ignore for now.
      break;
    default:
      break;
  }
}

}  // namespace

void setupWledWebSocket() {
  if (started) return;
  // The WebSocketsServer has its own listener on port 81 (see the ws(81,...)
  // constructor above), kept separate from the HTTP WebServer on port 80 so
  // the two listeners don't collide. ws.begin() binds and starts accepting.
  ws.begin();
  ws.onEvent(onEvent);
  started = true;
}

void handleWledWebSocket() {
  if (started) ws.loop();
}

bool wledWebSocketHasClients() {
  return started && ws.connectedClients() > 0;
}
