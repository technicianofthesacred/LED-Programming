#include "LightweaverWledWebSocket.h"
#include "LightweaverFrameSource.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverTypes.h"
#include "LightweaverWeb.h"

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
// to append `:81/ws` instead of `/ws`. The constructor's origin arg is left
// "*" because it only accepts a single literal origin; per-connection Origin
// validation against the shared allowlist is enforced via the handshake
// validation callback wired up in setupWledWebSocket() instead.
WebSocketsServer ws(81, "*", "");
bool started = false;

// Cap concurrent WebSocket clients. Live preview is normally a single designer
// session; this guards against a reconnect storm or a room full of tabs
// exhausting the server's client slots and wedging the socket.
constexpr uint8_t LW_WS_MAX_CLIENTS = 3;

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
        // Only write if no other live source (e.g. Art-Net) owns the canvas.
        bool frameAllowed = frameSourceClaim(FRAME_WLED_REALTIME);
        int writeIdx = s["start"] | 0;
        if (writeIdx < 0) writeIdx = 0;
        uint8_t scale = uint8_t(manualBrightness * 255.0f);
        for (JsonVariant v : pixels) {
          if (!frameAllowed || writeIdx >= int(totalPixels)) break;
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

  // Frame writes already claimed the canvas above; only apply plain state
  // controls when this wasn't a frame push.
  if (!framePushed) {
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

// Handshake-time Origin gate. The WLED-realtime socket drives live pixel
// writes, so a malicious page must not be able to open it from a homeowner's
// browser. Browsers always send an Origin header on a cross-document WS
// connect; we accept it only if it matches the shared HTTP CORS allowlist
// (Studio + local dev) OR is the card's own page (same host as this server).
bool validateWsOrigin(String headerName, String headerValue) {
  // arduinoWebSockets invokes this callback for every non-core HTTP header,
  // not only the mandatory header named below. Ordinary handshake headers
  // such as Host must not be interpreted as Origin values.
  if (!headerName.equalsIgnoreCase("origin")) return true;
  if (corsOriginAllowed(headerValue)) return true;
  // Same-origin: the card's own page served over http on the LAN. Match the
  // active hostname (lightweaver.local) and the AP/STA IP.
  String host = runtimeConfig.activeHostname;
  String ip = runtimeConfig.activeIp;
  if (host.length()) {
    if (headerValue == String("http://") + host) return true;
    if (headerValue == String("http://") + host + ".local") return true;
  }
  if (ip.length() && headerValue == String("http://") + ip) return true;
  return false;
}

void onEvent(uint8_t clientId, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      // Reject the connection if we're already at the client cap (the just-
      // connected client is included in the count).
      if (ws.connectedClients() > LW_WS_MAX_CLIENTS) {
        ws.disconnect(clientId);
        break;
      }
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
  // Reject the handshake when a browser presents a disallowed Origin. "origin"
  // is mandatory, so browser and native clients must identify their origin.
  static const char* kWsMandatoryHeaders[] = {"origin"};
  ws.onValidateHttpHeader(validateWsOrigin, kWsMandatoryHeaders, 1);
  started = true;
}

void handleWledWebSocket() {
  if (started) ws.loop();
}

bool wledWebSocketHasClients() {
  return started && ws.connectedClients() > 0;
}
