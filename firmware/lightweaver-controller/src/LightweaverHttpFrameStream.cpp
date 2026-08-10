#include "LightweaverHttpFrameStream.h"

#if defined(ARDUINO_ARCH_ESP32)
#include <ArduinoJson.h>
#include <WebServer.h>
#include <esp_system.h>

#include "LightweaverOwnerCapability.h"
#include "LightweaverFirmwareUpdate.h"
#include "LightweaverProjectRepository.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverWeb.h"
#include "LightweaverCardStudio.h"

namespace {
WebServer* g_streamServer = nullptr;
uint8_t g_streamBody[LW_HTTP_STREAM_MAX_BODY_BYTES + 1] = {};
size_t g_streamBodyLength = 0;
size_t g_streamExpectedLength = 0;
bool g_streamBodyReady = false;
bool g_streamBodyRejected = false;
bool g_streamLeaseActive = false;
LightweaverHttpStreamBinding g_streamBinding;
String g_streamLeaseId;
uint32_t g_streamExpiresAtMs = 0;
uint32_t g_streamNextSequence = 1;

void sendStreamCors() {
  const String origin = g_streamServer->header("Origin");
  if (corsOriginAllowed(origin)) {
    g_streamServer->sendHeader("Access-Control-Allow-Origin", origin);
    g_streamServer->sendHeader("Vary", "Origin");
    g_streamServer->sendHeader("Access-Control-Allow-Headers", "Content-Type,X-Lightweaver-Card-Id,X-Lightweaver-Boot-Id,X-Lightweaver-Owner-Session,X-Lightweaver-Operation-Generation,X-Lightweaver-Expected-Head,X-Lightweaver-Capability");
    g_streamServer->sendHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    g_streamServer->sendHeader("Access-Control-Allow-Private-Network", "true");
  }
  g_streamServer->sendHeader("Cache-Control", "no-store");
}

void streamError(int status, const String& error) {
  JsonDocument doc; doc["ok"] = false; doc["error"] = error;
  String body; serializeJson(doc, body);
  g_streamServer->send(status, "application/json", body);
}

bool parseStreamBody(JsonDocument& doc) {
  if (!g_streamBodyReady || g_streamBodyRejected) {
    streamError(400, "stream request body unavailable"); return false;
  }
  DeserializationError error = deserializeJson(doc, g_streamBody, g_streamBodyLength);
  g_streamBodyReady = false; g_streamBodyLength = 0;
  if (error || !doc.is<JsonObject>()) { streamError(400, "stream request is not valid JSON"); return false; }
  return true;
}

LightweaverHttpStreamBinding streamBinding(JsonVariantConst source) {
  LightweaverHttpStreamBinding binding;
  binding.cardId = source["cardId"] | "";
  binding.bootId = source["bootId"] | "";
  binding.ownerSessionId = source["ownerSessionId"] | "";
  binding.operationGeneration = source["operationGeneration"] | 0U;
  binding.host = source["host"] | "";
  binding.origin = g_streamServer->header("Origin");
  binding.networkIdentity = runtimeNetworkIdentity();
  return binding;
}

bool sameStreamBinding(const LightweaverHttpStreamBinding& left,
                       const LightweaverHttpStreamBinding& right) {
  return left.cardId == right.cardId && left.bootId == right.bootId &&
      left.ownerSessionId == right.ownerSessionId &&
      left.operationGeneration == right.operationGeneration &&
      left.host == right.host && left.origin == right.origin &&
      left.networkIdentity == right.networkIdentity;
}

String makeLeaseId() {
  char value[33] = {};
  snprintf(value, sizeof(value), "%08lx%08lx%08lx%08lx",
      static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
      static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
  return String(value);
}

bool validateLease(JsonVariantConst source, String& error) {
  if (!g_streamLeaseActive) { error = "stream lease is missing"; return false; }
  if (static_cast<int32_t>(millis() - g_streamExpiresAtMs) > 0) {
    stopLightweaverHttpFrameStream(); error = "stream lease expired"; return false;
  }
  const LightweaverHttpStreamBinding request = streamBinding(source);
  if (!constantTimeTokenEqual(g_streamLeaseId, String(source["leaseId"] | "")) ||
      !sameStreamBinding(g_streamBinding, request) ||
      request.cardId != runtimeCardId() || request.bootId != runtimeBootId() ||
      request.host != g_streamServer->hostHeader()) {
    stopLightweaverHttpFrameStream(); error = "stream lease binding changed"; return false;
  }
  return true;
}

void handleLease() {
  sendStreamCors(); JsonDocument doc; if (!parseStreamBody(doc)) return;
  if (lightweaverFirmwareUpdateActive()) {
    streamError(409, "firmware update owns the card mutation lease"); return;
  }
  if (!lightweaverCardStudioMutationsEnabled()) {
    streamError(503, lightweaverCardStudioValidationError()); return;
  }
  LightweaverHttpStreamBinding requested = streamBinding(doc.as<JsonVariantConst>());
  LightweaverOwnerBinding owner;
  owner.cardId = requested.cardId; owner.bootId = requested.bootId;
  owner.allowedOrigin = requested.origin; owner.host = requested.host;
  owner.networkIdentity = runtimeNetworkIdentity(); owner.ownerSessionId = requested.ownerSessionId;
  owner.operationGeneration = requested.operationGeneration;
  owner.expectedProjectHead = doc["expectedHead"] | "";
  LightweaverOwnerValidation authority = lightweaverOwnerCapability().validate(
      String(doc["capability"] | ""), owner, millis());
  if (authority != LightweaverOwnerValidation::Accepted ||
      requested.cardId != runtimeCardId() || requested.bootId != runtimeBootId() ||
      requested.host != g_streamServer->hostHeader()) {
    stopLightweaverHttpFrameStream(); streamError(403, "owner capability rejected for stream lease"); return;
  }
  if (g_streamLeaseActive) stopLightweaverHttpFrameStream();
  g_streamBinding = requested;
  g_streamLeaseId = makeLeaseId();
  g_streamExpiresAtMs = millis() + LW_HTTP_STREAM_LEASE_TTL_MS;
  g_streamNextSequence = 1;
  g_streamLeaseActive = true;
  JsonDocument response; response["ok"] = true; response["leaseId"] = g_streamLeaseId;
  response["expiresInMs"] = LW_HTTP_STREAM_LEASE_TTL_MS; response["nextSequence"] = g_streamNextSequence;
  String body; serializeJson(response, body); g_streamServer->send(200, "application/json", body);
}

bool parsePixel(const char* value, uint8_t* rgb) {
  if (!value || strlen(value) != 6) return false;
  for (uint8_t byte = 0; byte < 3; byte++) {
    uint8_t parsed = 0;
    for (uint8_t nibble = 0; nibble < 2; nibble++) {
      const char c = value[byte * 2 + nibble];
      uint8_t digit = c >= '0' && c <= '9' ? c - '0'
          : c >= 'a' && c <= 'f' ? c - 'a' + 10
          : c >= 'A' && c <= 'F' ? c - 'A' + 10 : 255;
      if (digit == 255) return false;
      parsed = static_cast<uint8_t>((parsed << 4) | digit);
    }
    rgb[byte] = parsed;
  }
  return true;
}

void handleFrame() {
  sendStreamCors(); JsonDocument doc; if (!parseStreamBody(doc)) return;
  String validationError;
  if (!validateLease(doc.as<JsonVariantConst>(), validationError)) { streamError(409, validationError); return; }
  const uint32_t sequence = doc["sequence"] | 0U;
  if (sequence != g_streamNextSequence) { streamError(409, "sequence is not nextSequence"); return; }
  JsonArrayConst pixels = doc["pixels"].as<JsonArrayConst>();
  if (pixels.isNull() || !pixels.size() || pixels.size() > LW_HTTP_STREAM_MAX_PIXELS_PER_CHUNK) {
    streamError(413, "frame chunk is empty or too large"); return;
  }
  uint8_t rgb[LW_HTTP_STREAM_MAX_PIXELS_PER_CHUNK * 3] = {};
  size_t index = 0;
  for (JsonVariantConst pixel : pixels) {
    if (!pixel.is<const char*>() || !parsePixel(pixel.as<const char*>(), rgb + index * 3)) {
      streamError(400, "frame pixel must be RRGGBB"); return;
    }
    index++;
  }
  const uint32_t start = doc["start"] | 0U;
  if (start > UINT16_MAX || !runtimeWriteHttpFrame(static_cast<uint16_t>(start), rgb, index)) {
    streamError(409, "frame source busy or frame range invalid"); return;
  }
  g_streamNextSequence++;
  if (g_streamNextSequence == 0) { stopLightweaverHttpFrameStream(); streamError(409, "stream sequence exhausted"); return; }
  g_streamExpiresAtMs = millis() + LW_HTTP_STREAM_LEASE_TTL_MS;
  JsonDocument response; response["ok"] = true; response["acceptedSequence"] = sequence;
  response["nextSequence"] = g_streamNextSequence; response["expiresInMs"] = LW_HTTP_STREAM_LEASE_TTL_MS;
  String body; serializeJson(response, body); g_streamServer->send(200, "application/json", body);
}

void handleStop() {
  sendStreamCors(); JsonDocument doc; if (!parseStreamBody(doc)) return;
  String validationError;
  if (!validateLease(doc.as<JsonVariantConst>(), validationError)) { streamError(409, validationError); return; }
  stopLightweaverHttpFrameStream();
  g_streamServer->send(200, "application/json", "{\"ok\":true,\"stopped\":true}");
}

void handleStreamMutation(const String& uri) {
  if (uri == "/api/stream/lease") handleLease();
  else if (uri == "/api/stream/frame") handleFrame();
  else handleStop();
}

void handleStreamRaw(HTTPRaw& raw) {
  if (raw.status == RAW_START) {
    g_streamBodyLength = 0; g_streamBodyReady = false; g_streamBodyRejected = false;
    g_streamExpectedLength = g_streamServer->clientContentLength();
    if (g_streamExpectedLength == 0 || g_streamExpectedLength > LW_HTTP_STREAM_MAX_BODY_BYTES) {
      g_streamBodyRejected = true; sendStreamCors(); streamError(g_streamExpectedLength ? 413 : 411, "stream request size rejected"); g_streamServer->client().stop();
    }
  } else if (raw.status == RAW_WRITE && !g_streamBodyRejected) {
    if (g_streamBodyLength + raw.currentSize > g_streamExpectedLength || g_streamBodyLength + raw.currentSize > LW_HTTP_STREAM_MAX_BODY_BYTES) {
      g_streamBodyRejected = true; stopLightweaverHttpFrameStream(); g_streamServer->client().stop();
    } else { memcpy(g_streamBody + g_streamBodyLength, raw.buf, raw.currentSize); g_streamBodyLength += raw.currentSize; }
  } else if (raw.status == RAW_END && !g_streamBodyRejected) {
    if (g_streamBodyLength != g_streamExpectedLength) { g_streamBodyRejected = true; stopLightweaverHttpFrameStream(); }
    else { g_streamBody[g_streamBodyLength] = 0; g_streamBodyReady = true; }
  } else if (raw.status == RAW_ABORTED) {
    g_streamBodyLength = 0; g_streamBodyReady = false; g_streamBodyRejected = false;
    // An interrupted request is an ownership interruption: stop and recover.
    stopLightweaverHttpFrameStream();
  }
}

class BoundedHttpFrameStreamHandler final : public RequestHandler {
 public:
  bool canHandle(HTTPMethod method, String uri) override { return method == HTTP_POST &&
      (uri == "/api/stream/lease" || uri == "/api/stream/frame" || uri == "/api/stream/stop"); }
  bool canUpload(String) override { return false; }
  bool canRaw(String uri) override { return canHandle(HTTP_POST, uri); }
  bool handle(WebServer&, HTTPMethod method, String uri) override { if (!canHandle(method, uri)) return false; handleStreamMutation(uri); return true; }
  void raw(WebServer&, String uri, HTTPRaw& rawBody) override { if (canRaw(uri)) handleStreamRaw(rawBody); }
};

void handleStreamOptions() { sendStreamCors(); g_streamServer->send(204, "text/plain", ""); }
}

void registerLightweaverHttpFrameStream(WebServer& server) {
  g_streamServer = &server;
  for (const char* route : {"/api/stream/lease", "/api/stream/frame", "/api/stream/stop"})
    server.on(route, HTTP_OPTIONS, handleStreamOptions);
  server.addHandler(new BoundedHttpFrameStreamHandler());
}

void stopLightweaverHttpFrameStream() {
  const bool hadLease = g_streamLeaseActive;
  g_streamLeaseActive = false;
  g_streamBinding = LightweaverHttpStreamBinding{};
  g_streamLeaseId = String();
  g_streamExpiresAtMs = 0;
  g_streamNextSequence = 1;
  if (hadLease) runtimeCancelStream();
}

void handleLightweaverHttpFrameStream() {
  if (g_streamLeaseActive && static_cast<int32_t>(millis() - g_streamExpiresAtMs) > 0)
    stopLightweaverHttpFrameStream();
}

bool lightweaverHttpFrameStreamActive() { return g_streamLeaseActive; }
#else
void registerLightweaverHttpFrameStream(WebServer&) {}
void handleLightweaverHttpFrameStream() {}
bool lightweaverHttpFrameStreamActive() { return false; }
void stopLightweaverHttpFrameStream() {}
#endif
