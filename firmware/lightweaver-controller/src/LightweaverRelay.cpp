#include "LightweaverRelay.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverTypes.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

extern RuntimeConfig runtimeConfig;
extern uint16_t totalPixels;
extern uint8_t currentLookIndex;
extern uint8_t lookCount;
extern LookConfig looks[];

namespace {

constexpr const char* RELAY_HOST = "led.mandalacodes.com";
constexpr const char* NVS_NS = "lwrelay";
constexpr const char* NVS_CARD_ID = "id";
constexpr const char* NVS_TOKEN = "token";

constexpr uint32_t REGISTER_RETRY_MS = 30 * 1000;
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 15 * 1000;
constexpr uint32_t POLL_INTERVAL_MS = 1000;
constexpr uint32_t CONNECTED_THRESHOLD_MS = 60 * 1000;

String cardId;
String ownerToken;
String pairCode;
uint32_t pairCodeIssuedAt = 0;
uint32_t pairCodeExpiresInSec = 0;
String cardLabel;
bool registered = false;
uint32_t lastRegisterAttempt = 0;
uint32_t lastHeartbeat = 0;
uint32_t lastPoll = 0;
uint32_t lastSuccessfulCall = 0;

String generateUuid() {
  // Time + random bytes; not cryptographically perfect but plenty unique for
  // a fleet of <thousand cards. Format: 32 hex characters.
  uint8_t buf[16];
  for (uint8_t i = 0; i < 16; i++) buf[i] = uint8_t(esp_random() & 0xff);
  uint32_t now = millis();
  buf[0] ^= uint8_t(now);
  buf[1] ^= uint8_t(now >> 8);
  buf[2] ^= uint8_t(now >> 16);
  buf[3] ^= uint8_t(now >> 24);
  String out;
  out.reserve(32);
  for (uint8_t i = 0; i < 16; i++) {
    char hex[3];
    snprintf(hex, sizeof(hex), "%02x", buf[i]);
    out += hex;
  }
  return out;
}

void loadOrCreateIdentity() {
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  cardId = p.getString(NVS_CARD_ID, "");
  ownerToken = p.getString(NVS_TOKEN, "");
  if (cardId.length() == 0) {
    cardId = generateUuid();
    p.putString(NVS_CARD_ID, cardId);
  }
  p.end();
}

void saveOwnerToken(const String& token) {
  Preferences p;
  if (!p.begin(NVS_NS, false)) return;
  p.putString(NVS_TOKEN, token);
  p.end();
}

bool httpJson(const String& method, const String& path, const String& body, String& outResponse) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure();  // we accept Cloudflare's cert without pinning for now
  HTTPClient http;
  String url = String("https://") + RELAY_HOST + path;
  if (!http.begin(client, url)) return false;
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  if (ownerToken.length()) http.addHeader("X-LW-Token", ownerToken);

  int code;
  if (method == "POST") {
    code = http.POST(body);
  } else {
    code = http.GET();
  }
  if (code < 200 || code >= 300) {
    Serial.print("[relay] http ");
    Serial.print(method);
    Serial.print(" ");
    Serial.print(path);
    Serial.print(" -> ");
    Serial.println(code);
    http.end();
    return false;
  }
  outResponse = http.getString();
  http.end();
  lastSuccessfulCall = millis();
  return true;
}

bool doRegister() {
  JsonDocument req;
  req["cardId"] = cardId;
  req["label"] = cardLabel.length() ? cardLabel : runtimeConfig.pieceName;
  req["fw"] = __DATE__ " " __TIME__;
  String body;
  serializeJson(req, body);

  String response;
  if (!httpJson("POST", "/api/lw/register", body, response)) return false;

  JsonDocument resp;
  if (deserializeJson(resp, response)) return false;
  if (!resp["ok"].as<bool>()) return false;

  ownerToken = String(resp["ownerToken"] | "");
  if (ownerToken.length()) saveOwnerToken(ownerToken);
  pairCode = String(resp["pairCode"] | "");
  pairCodeIssuedAt = millis();
  pairCodeExpiresInSec = resp["pairExpiresInSec"] | 600;
  registered = true;
  Serial.print("Relay registered. Pair code: ");
  Serial.println(pairCode);
  return true;
}

bool doHeartbeat() {
  JsonDocument req;
  req["id"] = cardId;
  req["pixels"] = totalPixels;
  if (lookCount && currentLookIndex < lookCount) {
    req["currentPatternId"] = looks[currentLookIndex].id;
  }
  req["brightness"] = runtimeGetBrightness();
  req["hue"] = runtimeGetCustomHue();
  req["saturation"] = runtimeGetCustomSaturation();
  req["breathe"] = runtimeGetCustomBreathe();
  req["drift"] = runtimeGetCustomDrift();
  req["blackout"] = runtimeIsBlackedOut();
  String body;
  serializeJson(req, body);

  String response;
  return httpJson("POST", "/api/lw/heartbeat", body, response);
}

void applyPending(JsonObject pending) {
  if (!pending["brightness"].isNull()) {
    runtimeSetBrightness(pending["brightness"].as<float>());
  }
  if (!pending["hue"].isNull()) runtimeSetCustomHue(uint8_t(pending["hue"].as<int>() & 0xff));
  if (!pending["saturation"].isNull()) runtimeSetCustomSaturation(uint8_t(pending["saturation"].as<int>() & 0xff));
  if (!pending["breathe"].isNull()) runtimeSetCustomBreathe(pending["breathe"].as<bool>());
  if (!pending["drift"].isNull()) runtimeSetCustomDrift(pending["drift"].as<bool>());
  if (!pending["blackout"].isNull()) runtimeSetBlackout(pending["blackout"].as<bool>());
  if (!pending["patternId"].isNull()) {
    String id = String(pending["patternId"].as<const char*>());
    if (id.length()) runtimeSelectPatternById(id);
  }
  if (!pending["speed"].isNull()) runtimeSetSpeed(pending["speed"].as<float>());
  if (!pending["hueShift"].isNull()) runtimeSetHueShift(int16_t(pending["hueShift"].as<int>()));
}

bool doPoll() {
  String response;
  if (!httpJson("GET", String("/api/lw/poll/") + cardId, "", response)) {
    Serial.println("[relay] poll httpJson failed");
    return false;
  }
  JsonDocument resp;
  if (deserializeJson(resp, response)) {
    Serial.print("[relay] poll JSON parse failed, body=");
    Serial.println(response);
    return false;
  }
  if (!resp["ok"].as<bool>()) {
    Serial.print("[relay] poll ok=false, body=");
    Serial.println(response);
    return false;
  }
  if (resp["pending"].isNull()) return true;
  Serial.print("[relay] poll got pending: ");
  Serial.println(response);
  String commandId = String(resp["pending"]["commandId"] | "");
  applyPending(resp["pending"].as<JsonObject>());
  if (commandId.length()) {
    JsonDocument req;
    req["commandId"] = commandId;
    String body;
    serializeJson(req, body);
    String ackResponse;
    if (!httpJson("POST", String("/api/lw/poll/") + cardId, body, ackResponse)) {
      Serial.println("[relay] poll ack failed");
      return false;
    }
  }
  return true;
}

}  // namespace

void setupRelay(const String& label) {
  cardLabel = label;
  loadOrCreateIdentity();
  Serial.print("Relay card id: ");
  Serial.println(cardId);
}

void handleRelay() {
  if (WiFi.status() != WL_CONNECTED) return;

  uint32_t now = millis();

  // Register: only after WiFi and only when we don't have a token yet.
  if (!registered) {
    if (now - lastRegisterAttempt > REGISTER_RETRY_MS || lastRegisterAttempt == 0) {
      lastRegisterAttempt = now;
      doRegister();
    }
    return;
  }

  if (now - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    doHeartbeat();
  }

  if (now - lastPoll > POLL_INTERVAL_MS) {
    lastPoll = now;
    doPoll();
  }
}

String relayPairCode() {
  if (pairCode.length() == 0) return "";
  if (pairCodeExpiresInSec == 0) return pairCode;
  uint32_t expiresAt = pairCodeIssuedAt + pairCodeExpiresInSec * 1000;
  if (millis() > expiresAt) return "";
  return pairCode;
}

uint32_t relayPairExpiresAt() {
  if (pairCode.length() == 0) return 0;
  return pairCodeIssuedAt + pairCodeExpiresInSec * 1000;
}

bool relayConnected() {
  return lastSuccessfulCall > 0 && (millis() - lastSuccessfulCall) < CONNECTED_THRESHOLD_MS;
}

String relayCardId() { return cardId; }
