#include "LightweaverOwnerCapability.h"

namespace {
LightweaverOwnerCapability g_ownerCapability;

bool sameBinding(const LightweaverOwnerBinding& left,
                 const LightweaverOwnerBinding& right) {
  return left.cardId == right.cardId &&
      left.bootId == right.bootId &&
      left.allowedOrigin == right.allowedOrigin &&
      left.host == right.host &&
      left.networkIdentity == right.networkIdentity &&
      left.ownerSessionId == right.ownerSessionId &&
      left.operationGeneration == right.operationGeneration &&
      left.expectedProjectHead == right.expectedProjectHead;
}
}

bool constantTimeTokenEqual(const String& left, const String& right) {
  const size_t leftLength = left.length();
  const size_t rightLength = right.length();
  const size_t comparedLength = leftLength > rightLength ? leftLength : rightLength;
  uint8_t difference = static_cast<uint8_t>(leftLength ^ rightLength);
  for (size_t index = 0; index < comparedLength; index++) {
    const uint8_t leftByte = index < leftLength
        ? static_cast<uint8_t>(left.c_str()[index]) : 0;
    const uint8_t rightByte = index < rightLength
        ? static_cast<uint8_t>(right.c_str()[index]) : 0;
    difference |= leftByte ^ rightByte;
  }
  return difference == 0;
}

bool LightweaverOwnerCapability::issue(const LightweaverOwnerBinding& binding,
                                       const String& token,
                                       uint32_t nowMs) {
  if (!binding.cardId.length() || !binding.bootId.length() ||
      !binding.allowedOrigin.length() || !binding.host.length() ||
      !binding.networkIdentity.length() || !binding.ownerSessionId.length() ||
      binding.operationGeneration == 0 || !token.length()) {
    revoke();
    return false;
  }
  binding_ = binding;
  token_ = token;
  expiresAtMs_ = nowMs + LW_OWNER_CAPABILITY_TTL_MS;
  issued_ = true;
  return true;
}

LightweaverOwnerValidation LightweaverOwnerCapability::validate(
    const String& token, const LightweaverOwnerBinding& binding,
    uint32_t nowMs) {
  if (!issued_) return LightweaverOwnerValidation::Missing;
  if (static_cast<int32_t>(nowMs - expiresAtMs_) > 0) {
    revoke();
    return LightweaverOwnerValidation::Expired;
  }
  if (!constantTimeTokenEqual(token_, token)) {
    return LightweaverOwnerValidation::TokenMismatch;
  }
  if (!sameBinding(binding_, binding)) {
    // A card, boot, network, origin, host, session, generation, or project-head
    // mismatch is revocation, not merely a failed request. A stale page must
    // deliberately pair again before it can mutate anything.
    revoke();
    return LightweaverOwnerValidation::BindingMismatch;
  }
  return LightweaverOwnerValidation::Accepted;
}

bool LightweaverOwnerCapability::advanceExpectedProjectHead(
    const String& token, const LightweaverOwnerBinding& binding,
    const String& nextHead, uint32_t nowMs) {
  if (validate(token, binding, nowMs) != LightweaverOwnerValidation::Accepted) return false;
  binding_.expectedProjectHead = nextHead;
  return true;
}

void LightweaverOwnerCapability::revoke() {
  binding_ = LightweaverOwnerBinding{};
  token_ = String();
  expiresAtMs_ = 0;
  issued_ = false;
}

bool LightweaverOwnerCapability::active(uint32_t nowMs) {
  if (!issued_) return false;
  if (static_cast<int32_t>(nowMs - expiresAtMs_) > 0) {
    revoke();
    return false;
  }
  return true;
}

LightweaverOwnerCapability& lightweaverOwnerCapability() {
  return g_ownerCapability;
}

#if defined(ARDUINO_ARCH_ESP32)
#include <ArduinoJson.h>
#include <WebServer.h>
#include <esp_system.h>

#include "LightweaverProjectRepository.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverWeb.h"

namespace {
WebServer* g_ownerServer = nullptr;
uint8_t g_ownerBody[LW_OWNER_CAPABILITY_MAX_BODY_BYTES + 1] = {};
size_t g_ownerBodyLength = 0;
size_t g_ownerExpectedLength = 0;
bool g_ownerBodyReady = false;
bool g_ownerBodyRejected = false;

void sendOwnerCors() {
  String origin = g_ownerServer->header("Origin");
  if (corsOriginAllowed(origin)) {
    g_ownerServer->sendHeader("Access-Control-Allow-Origin", origin);
    g_ownerServer->sendHeader("Vary", "Origin");
    g_ownerServer->sendHeader("Access-Control-Allow-Headers", "Content-Type,X-Lightweaver-Card-Id,X-Lightweaver-Boot-Id,X-Lightweaver-Owner-Session,X-Lightweaver-Operation-Generation,X-Lightweaver-Expected-Head,X-Lightweaver-Capability");
    g_ownerServer->sendHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    g_ownerServer->sendHeader("Access-Control-Allow-Private-Network", "true");
  }
  g_ownerServer->sendHeader("Cache-Control", "no-store");
}

bool ownerOriginAllowed(const String& origin, const String& host) {
  if (corsOriginAllowed(origin)) return true;
  return origin == String("http://") + host;
}

String makeOwnerToken() {
  char token[65] = {};
  snprintf(token, sizeof(token), "%08lx%08lx%08lx%08lx%08lx%08lx%08lx%08lx",
           static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
           static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
           static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
           static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
  return String(token);
}

void handleOwnerOptions() {
  sendOwnerCors();
  g_ownerServer->send(204, "text/plain", "");
}

void handleOwnerIssue() {
  sendOwnerCors();
  if (!g_ownerBodyReady || g_ownerBodyRejected) {
    g_ownerServer->send(400, "application/json",
                        "{\"ok\":false,\"error\":\"owner request body unavailable\"}");
    return;
  }
  JsonDocument doc;
  DeserializationError parseError = deserializeJson(doc, g_ownerBody, g_ownerBodyLength);
  g_ownerBodyReady = false;
  g_ownerBodyLength = 0;
  if (parseError || !doc.is<JsonObject>()) {
    g_ownerServer->send(400, "application/json",
                        "{\"ok\":false,\"error\":\"owner request is not valid JSON\"}");
    return;
  }
  const String origin = g_ownerServer->header("Origin");
  const String host = g_ownerServer->hostHeader();
  const String expectedHead = doc["expectedProjectHead"] | "";
  LightweaverOwnerBinding binding;
  binding.cardId = doc["cardId"] | "";
  binding.bootId = doc["bootId"] | "";
  binding.allowedOrigin = origin;
  binding.host = host;
  binding.networkIdentity = runtimeNetworkIdentity();
  binding.ownerSessionId = doc["ownerSessionId"] | "";
  binding.operationGeneration = doc["operationGeneration"] | 0U;
  binding.expectedProjectHead = expectedHead;

  if (!ownerOriginAllowed(origin, host)) {
    lightweaverOwnerCapability().revoke();
    g_ownerServer->send(403, "application/json",
                        "{\"ok\":false,\"error\":\"origin is not allowed\"}");
    return;
  }
  if (!runtimeOwnerPairingAuthorized()) {
    // Same-origin reachability is deliberately insufficient. A configured
    // card requires a recent physical control action; an uncommissioned card
    // uses its existing commissioning authority.
    g_ownerServer->send(403, "application/json",
                        "{\"ok\":false,\"error\":\"touch a card control to pair\"}");
    return;
  }
  if (binding.cardId != runtimeCardId() || binding.bootId != runtimeBootId() ||
      expectedHead != lightweaverProjectRepository().currentHead()) {
    lightweaverOwnerCapability().revoke();
    g_ownerServer->send(409, "application/json",
                        "{\"ok\":false,\"error\":\"card, boot, or project head changed\"}");
    return;
  }
  String token = makeOwnerToken();
  if (!lightweaverOwnerCapability().issue(binding, token, millis())) {
    g_ownerServer->send(400, "application/json",
                        "{\"ok\":false,\"error\":\"owner binding is incomplete\"}");
    return;
  }
  JsonDocument response;
  response["ok"] = true;
  response["capability"] = token;
  response["expiresInMs"] = LW_OWNER_CAPABILITY_TTL_MS;
  response["cardId"] = runtimeCardId();
  response["bootId"] = runtimeBootId();
  response["projectHead"] = expectedHead;
  String body;
  serializeJson(response, body);
  g_ownerServer->send(200, "application/json", body);
}

void handleOwnerRaw(HTTPRaw& raw) {
  if (raw.status == RAW_START) {
    g_ownerBodyLength = 0;
    g_ownerBodyReady = false;
    g_ownerBodyRejected = false;
    g_ownerExpectedLength = g_ownerServer->clientContentLength();
    if (g_ownerExpectedLength == 0 ||
        g_ownerExpectedLength > LW_OWNER_CAPABILITY_MAX_BODY_BYTES) {
      g_ownerBodyRejected = true;
      sendOwnerCors();
      g_ownerServer->send(g_ownerExpectedLength == 0 ? 411 : 413,
          "application/json", "{\"ok\":false,\"error\":\"owner request size rejected\"}");
      g_ownerServer->client().stop();
    }
  } else if (raw.status == RAW_WRITE && !g_ownerBodyRejected) {
    if (g_ownerBodyLength + raw.currentSize > g_ownerExpectedLength ||
        g_ownerBodyLength + raw.currentSize > LW_OWNER_CAPABILITY_MAX_BODY_BYTES) {
      g_ownerBodyRejected = true;
      lightweaverOwnerCapability().revoke();
      g_ownerServer->client().stop();
    } else {
      memcpy(g_ownerBody + g_ownerBodyLength, raw.buf, raw.currentSize);
      g_ownerBodyLength += raw.currentSize;
    }
  } else if (raw.status == RAW_END && !g_ownerBodyRejected) {
    if (g_ownerBodyLength != g_ownerExpectedLength) {
      g_ownerBodyRejected = true;
      lightweaverOwnerCapability().revoke();
    } else {
      g_ownerBody[g_ownerBodyLength] = 0;
      g_ownerBodyReady = true;
    }
  } else if (raw.status == RAW_ABORTED) {
    g_ownerBodyLength = 0;
    g_ownerBodyReady = false;
    g_ownerBodyRejected = false;
    lightweaverOwnerCapability().revoke();
  }
}

class BoundedOwnerCapabilityHandler final : public RequestHandler {
 public:
  bool canHandle(HTTPMethod method, String uri) override {
    return method == HTTP_POST && uri == "/api/owner/capability";
  }
  bool canUpload(String) override { return false; }
  bool canRaw(String uri) override { return uri == "/api/owner/capability"; }
  bool handle(WebServer&, HTTPMethod method, String uri) override {
    if (!canHandle(method, uri)) return false;
    handleOwnerIssue();
    return true;
  }
  void raw(WebServer&, String uri, HTTPRaw& rawBody) override {
    if (canRaw(uri)) handleOwnerRaw(rawBody);
  }
};
}

void registerLightweaverOwnerCapability(WebServer& server) {
  g_ownerServer = &server;
  server.on("/api/owner/capability", HTTP_OPTIONS, handleOwnerOptions);
  server.addHandler(new BoundedOwnerCapabilityHandler());
}
#else
void registerLightweaverOwnerCapability(WebServer&) {}
#endif
