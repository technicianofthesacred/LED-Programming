#include "LightweaverWledJsonApi.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverFrameSource.h"
#include "LightweaverTypes.h"
#include "LightweaverWeb.h"  // corsOriginAllowed — shared CORS allowlist

#include <Arduino.h>
#include <ArduinoJson.h>
#include <FastLED.h>
#include <WiFi.h>

// Externs from main.cpp — needed for the pretend-info shape and the
// raw-pixel render path the designer's live preview depends on.
extern CRGB leds[];
extern uint16_t totalPixels;
extern RuntimeConfig runtimeConfig;
extern float manualBrightness;
extern uint8_t currentLookIndex;
extern uint8_t lookCount;
extern LookConfig looks[];

namespace lw_wled {

namespace {

WebServer* serverPtr = nullptr;

// Same allowlisted-origin policy as the Lightweaver API (see
// corsOriginAllowed in LightweaverWeb.cpp): these endpoints control the
// lights unauthenticated, so they must not echo "*" to arbitrary sites.
void sendCors() {
  String origin = serverPtr->header("Origin");
  if (corsOriginAllowed(origin)) {
    serverPtr->sendHeader("Access-Control-Allow-Origin", origin);
    serverPtr->sendHeader("Vary", "Origin");
    serverPtr->sendHeader("Access-Control-Allow-Headers", "Content-Type");
    serverPtr->sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    serverPtr->sendHeader("Access-Control-Allow-Private-Network", "true");
  }
  serverPtr->sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
}

void handleOptions() {
  sendCors();
  serverPtr->send(204, "text/plain", "");
}

// Build the /json/info payload. Designer reads: leds.count, leds.fps, mac,
// freeheap, wifi.signal, ver, name. We add a non-WLED "lwLive" field that
// surfaces the streaming-source state — designers that look at it can show
// the streaming indicator.
String buildInfoJson() {
  JsonDocument doc;
  doc["ver"] = "0.15.0";              // pretend to be a WLED version designers know
  doc["vid"] = 2410010;               // WLED's date-coded version
  doc["arch"] = "esp32s3";
  doc["core"] = "Arduino-2";
  doc["product"] = "Lightweaver";
  doc["brand"] = "Lightweaver";
  // WLED convention: 12 lowercase hex chars, no separators. Clients key
  // device identity on this exact shape.
  String mac = WiFi.macAddress();
  mac.replace(":", "");
  mac.toLowerCase();
  doc["mac"] = mac;
  doc["ip"] = runtimeConfig.activeIp;
  doc["name"] = runtimeConfig.pieceName;
  doc["udpport"] = 21324;
  doc["live"] = frameSourceIsStreaming();
  doc["lc"] = 1;                      // light capability bits — RGB only
  doc["leds"]["count"] = totalPixels;
  doc["leds"]["fps"] = 30;            // our renderer ceiling
  doc["leds"]["rgbw"] = false;
  doc["leds"]["wv"] = 0;
  doc["leds"]["pwr"] = 0;
  doc["leds"]["maxpwr"] = 0;
  doc["leds"]["maxseg"] = 1;
  JsonArray seglc = doc["leds"]["seglc"].to<JsonArray>();
  seglc.add(1);
  doc["wifi"]["bssid"] = WiFi.BSSIDstr();
  doc["wifi"]["rssi"] = WiFi.RSSI();
  doc["wifi"]["signal"] = WiFi.RSSI() > -50 ? 100
                        : WiFi.RSSI() > -60 ? 80
                        : WiFi.RSSI() > -70 ? 60
                        : WiFi.RSSI() > -80 ? 40 : 20;
  doc["wifi"]["channel"] = WiFi.channel();
  doc["freeheap"] = ESP.getFreeHeap();
  doc["uptime"] = millis() / 1000;
  doc["fxcount"] = lookCount;
  doc["palcount"] = 1;
  // Non-standard: surface the streaming source so a designer that knows about
  // it can show a "Art-Net live" / "WLED stream live" badge.
  uint8_t src = uint8_t(frameSourceActive());
  doc["lwLive"]["streaming"] = frameSourceIsStreaming();
  doc["lwLive"]["source"] = src == 1 ? "wled-realtime"
                          : src == 2 ? "artnet" : "self";
  String out;
  serializeJson(doc, out);
  return out;
}

// Build /json/state — current playback. Designer reads on, bri, seg[].id,
// seg[].fx for the headline. We map our zone[0] state to seg[0].
String buildStateJson() {
  JsonDocument doc;
  doc["on"] = !runtimeIsBlackedOut();
  doc["bri"] = uint8_t(runtimeGetBrightness() * 255.0f);
  doc["transition"] = 7;
  // Report the active look index so WLED-style clients (designer bar, visitor
  // UI) can reflect the current selection. Was hardcoded -1, which left the
  // active-scene highlight permanently blank after a refresh.
  doc["ps"] = lookCount ? int(currentLookIndex) : -1;
  doc["pl"] = -1;
  // Many WLED clients (including the WLED app) index seg[].col[0] and read
  // sx/ix/pal unguarded — emit the standard fields with neutral values so
  // they don't crash on us. Values are static; we don't expose pattern
  // params over this API yet (see FUTURE_WLED_COMPAT.md).
  auto addStandardSegFields = [](JsonObject& s) {
    JsonArray col = s["col"].to<JsonArray>();
    for (uint8_t c = 0; c < 3; c++) {
      JsonArray rgb = col.add<JsonArray>();
      rgb.add(0); rgb.add(0); rgb.add(0);
    }
    s["sx"] = 128;
    s["ix"] = 128;
    s["pal"] = 0;
    s["sel"] = true;
    s["rev"] = false;
    s["mi"] = false;
  };
  JsonArray segs = doc["seg"].to<JsonArray>();
  if (runtimeConfig.zoneCount == 0) {
    JsonObject s = segs.add<JsonObject>();
    s["id"] = 0;
    s["start"] = 0;
    s["stop"] = totalPixels;
    s["len"] = totalPixels;
    s["on"] = true;
    s["bri"] = 255;
    s["fx"] = 0;
    addStandardSegFields(s);
  } else {
    for (uint8_t i = 0; i < runtimeConfig.zoneCount; i++) {
      const ZoneConfig& z = runtimeConfig.zones[i];
      JsonObject s = segs.add<JsonObject>();
      s["id"] = i;
      s["start"] = z.rangeCount ? z.ranges[0].start : 0;
      s["len"] = z.rangeCount ? z.ranges[0].count : 0;
      s["stop"] = s["start"].as<int>() + s["len"].as<int>();
      s["on"] = !z.blackout;
      s["bri"] = uint8_t(z.brightness * 255.0f);
      // Look up the effect index in the pattern bank by patternId
      uint8_t fx = 0;
      for (uint8_t j = 0; j < lookCount; j++) {
        if (looks[j].id == z.patternId) { fx = j; break; }
      }
      s["fx"] = fx;
      addStandardSegFields(s);
    }
  }
  doc["lwLive"]["streaming"] = frameSourceIsStreaming();
  String out;
  serializeJson(doc, out);
  return out;
}

void handleInfo() {
  sendCors();
  serverPtr->send(200, "application/json", buildInfoJson());
}

void handleState() {
  sendCors();
  serverPtr->send(200, "application/json", buildStateJson());
}

void handleEffects() {
  sendCors();
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (uint8_t i = 0; i < lookCount; i++) {
    arr.add(looks[i].label);
  }
  String out;
  serializeJson(doc, out);
  serverPtr->send(200, "application/json", out);
}

void handlePalettes() {
  sendCors();
  // Small starter list — Default + a few that map roughly to our color-mode
  // drift palettes. Designer ignores most of these but expects an array.
  String out = F("[\"Default\",\"Warm\",\"Cool\",\"Rainbow\",\"Ocean\",\"Forest\"]");
  serverPtr->send(200, "application/json", out);
}

void handleJsonGet() {
  sendCors();
  // Combined endpoint — info + state + effects + palettes. Stock WLED's /json
  // returns this. Designer's bootstrap can avoid 3 round-trips by hitting it.
  JsonDocument doc;
  // We re-serialize the sub-payloads to avoid building a giant single
  // JsonDocument that might overflow the default stack budget.
  String state = buildStateJson();
  String info = buildInfoJson();
  String out = "{";
  out += "\"state\":" + state + ",";
  out += "\"info\":" + info + ",";
  out += "\"effects\":[";
  for (uint8_t i = 0; i < lookCount; i++) {
    if (i) out += ",";
    out += "\"";
    out += looks[i].label;
    out += "\"";
  }
  out += "],";
  out += "\"palettes\":[\"Default\",\"Warm\",\"Cool\",\"Rainbow\",\"Ocean\",\"Forest\"]";
  out += "}";
  serverPtr->send(200, "application/json", out);
}

// Decode "FF8800" → byte triplet. Returns true on success.
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

// Designer's live-preview push: POST /json/state with body
//   { v: true, seg: [{ i: ["FF0000", "00FF00", ...] }] }
// We treat that as a one-shot frame stream — same as a WLED realtime UDP
// frame — and mark FrameSource as WLED_REALTIME so the priority system
// yields the render loop. Customer brightness is applied per pixel.
//
// Plain on/bri/fx state changes (no seg.i present) get translated to the
// native runtime API.
void handleStatePost() {
  sendCors();
  if (!serverPtr->hasArg("plain")) {
    serverPtr->send(400, "application/json", "{\"success\":false,\"error\":\"missing body\"}");
    return;
  }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, serverPtr->arg("plain"));
  if (err) {
    serverPtr->send(400, "application/json", String("{\"success\":false,\"error\":\"") + err.c_str() + "\"}");
    return;
  }

  bool framePushed = false;
  JsonArray segs = doc["seg"].as<JsonArray>();
  if (!segs.isNull()) {
    for (JsonObject s : segs) {
      // Raw pixel array — the live frame stream path.
      JsonArray pixels = s["i"].as<JsonArray>();
      bool segFramePushed = !pixels.isNull() && pixels.size() > 0;
      if (segFramePushed) {
        framePushed = true;
        // Only write if no other live source (e.g. Art-Net) owns the canvas.
        bool frameAllowed = frameSourceClaim(FRAME_WLED_REALTIME);
        // Optional starting index — WLED accepts [i, "RRGGBB", ...] where the
        // first element is the start LED. Designer just sends color strings
        // so we default to start=segment start (or 0).
        int writeIdx = s["start"] | 0;
        if (writeIdx < 0) writeIdx = 0;
        uint8_t brightnessScale = uint8_t(manualBrightness * 255.0f);
        for (JsonVariant v : pixels) {
          if (!frameAllowed || writeIdx >= int(totalPixels)) break;
          if (v.is<const char*>()) {
            const char* hex = v.as<const char*>();
            uint8_t r, g, b;
            if (hexToRgb(hex, r, g, b)) {
              CRGB px(r, g, b);
              px.nscale8(brightnessScale);
              leds[writeIdx++] = px;
            } else {
              writeIdx++;
            }
          } else if (v.is<JsonArray>()) {
            // [r, g, b] triplet form
            JsonArray triplet = v.as<JsonArray>();
            if (triplet.size() >= 3) {
              CRGB px(triplet[0].as<int>() & 0xff,
                      triplet[1].as<int>() & 0xff,
                      triplet[2].as<int>() & 0xff);
              px.nscale8(brightnessScale);
              leds[writeIdx++] = px;
            }
          }
        }
      }
      // fx (pattern select) per segment
      if (!s["fx"].isNull()) {
        int fx = s["fx"].as<int>();
        if (fx >= 0 && fx < lookCount) {
          runtimeSelectPatternById(looks[fx].id);
        }
      }
      // Per-segment brightness — apply to the matching zone if id resolves.
      // Skip only when THIS segment carried a frame (framePushed is
      // loop-global and would wrongly mute bri on every later segment).
      if (!s["bri"].isNull() && !segFramePushed) {
        int segId = s["id"] | 0;
        float br = float(s["bri"].as<int>()) / 255.0f;
        if (segId >= 0 && segId < int(runtimeConfig.zoneCount)) {
          runtimeSetBrightnessZ(runtimeConfig.zones[segId].id, br);
        }
      }
    }
  }

  // Frame writes already claimed the canvas above; only apply plain state
  // controls when this wasn't a frame push.
  if (!framePushed) {
    // Plain state controls
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

  serverPtr->send(200, "application/json", "{\"success\":true}");
}

}  // namespace

void registerEndpoints(WebServer& server) {
  serverPtr = &server;
  server.on("/json/info", HTTP_OPTIONS, handleOptions);
  server.on("/json/info", HTTP_GET, handleInfo);
  server.on("/json/state", HTTP_OPTIONS, handleOptions);
  server.on("/json/state", HTTP_GET, handleState);
  server.on("/json/state", HTTP_POST, handleStatePost);
  server.on("/json/effects", HTTP_OPTIONS, handleOptions);
  server.on("/json/effects", HTTP_GET, handleEffects);
  server.on("/json/palettes", HTTP_OPTIONS, handleOptions);
  server.on("/json/palettes", HTTP_GET, handlePalettes);
  server.on("/json", HTTP_OPTIONS, handleOptions);
  server.on("/json", HTTP_GET, handleJsonGet);
}

}  // namespace lw_wled
