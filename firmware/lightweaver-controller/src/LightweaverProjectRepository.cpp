#include "LightweaverProjectRepository.h"

#include <ArduinoJson.h>
#include <LittleFS.h>
#include <mbedtls/sha256.h>

#include "LightweaverOwnerCapability.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverWeb.h"
#include "LightweaverCardStudio.h"

namespace {
constexpr const char* LW_PROJECT_DIR = "/lw-projects";
constexpr const char* LW_PROJECT_STAGING_PATH = "/lw-projects/staging.bin";
constexpr const char* LW_PROJECT_HEAD_PATH = "/lw-projects/head.json";
constexpr const char* LW_PROJECT_HEAD_TMP_PATH = "/lw-projects/head.tmp";

LightweaverProjectRepository g_projectRepository;

String hexDigest(const uint8_t digest[32]) {
  static const char* digits = "0123456789abcdef";
  char value[65] = {};
  for (size_t index = 0; index < 32; index++) {
    value[index * 2] = digits[digest[index] >> 4];
    value[index * 2 + 1] = digits[digest[index] & 0x0f];
  }
  return String(value);
}
}

LightweaverProjectRepository& lightweaverProjectRepository() {
  return g_projectRepository;
}

bool LightweaverProjectRepository::validProjectId(const String& value) const {
  if (!value.length() || value.length() > 64) return false;
  for (size_t index = 0; index < value.length(); index++) {
    const char c = value[index];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
  }
  return true;
}

bool LightweaverProjectRepository::validHash(const String& value) const {
  if (value.length() != 64) return false;
  for (size_t index = 0; index < value.length(); index++) {
    const char c = value[index];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

String LightweaverProjectRepository::immutablePath(const String& hash) const {
  return String(LW_PROJECT_DIR) + "/immutable-" + hash + ".json";
}

void LightweaverProjectRepository::cleanupAbandonedStaging() {
  // Boot cleanup abandons staging only. The installed configuration is separate
  // from the complete editable project, and neither it nor the previous head is
  // inferred from or modified by this recovery action.
  if (LittleFS.exists(LW_PROJECT_STAGING_PATH)) LittleFS.remove(LW_PROJECT_STAGING_PATH);
  if (LittleFS.exists(LW_PROJECT_HEAD_TMP_PATH)) LittleFS.remove(LW_PROJECT_HEAD_TMP_PATH);
  stagedProjectId_ = String();
  stagedProjectHead_ = String();
  stagedTransferHash_ = String();
  stagedExpectedHead_ = String();
  stagedTotalBytes_ = stagedChunkSize_ = stagedBytes_ = 0;
  nextChunkIndex_ = 0;
}

bool LightweaverProjectRepository::begin(String& message) {
  available_ = false;
  if (!LittleFS.begin(false)) {
    message = "project filesystem unavailable";
    return false;
  }
  if (!LittleFS.exists(LW_PROJECT_DIR) && !LittleFS.mkdir(LW_PROJECT_DIR)) {
    message = "project directory unavailable";
    return false;
  }
  cleanupAbandonedStaging();
  if (!loadHead(message)) return false;
  available_ = true;
  message = "project repository ready";
  return true;
}

bool LightweaverProjectRepository::loadHead(String& message) {
  head_ = LightweaverProjectHead{};
  if (!LittleFS.exists(LW_PROJECT_HEAD_PATH)) return true;
  File file = LittleFS.open(LW_PROJECT_HEAD_PATH, FILE_READ);
  if (!file) { message = "project head unreadable"; return false; }
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, file);
  file.close();
  if (error || !doc.is<JsonObject>()) { message = "project head damaged"; return false; }
  head_.projectId = doc["projectId"] | "";
  head_.current = doc["current"] | "";
  head_.currentBlob = doc["currentBlob"] | head_.current;
  head_.knownGood = doc["knownGood"] | "";
  head_.knownGoodBlob = doc["knownGoodBlob"] | head_.knownGood;
  head_.generation = doc["generation"] | 0U;
  if ((head_.current.length() && !validHash(head_.current)) ||
      (head_.knownGood.length() && !validHash(head_.knownGood)) ||
      (head_.currentBlob.length() && !validHash(head_.currentBlob)) ||
      (head_.knownGoodBlob.length() && !validHash(head_.knownGoodBlob)) ||
      (head_.projectId.length() && !validProjectId(head_.projectId)) ||
      (head_.current.length() && !LittleFS.exists(immutablePath(head_.currentBlob)))) {
    message = "project head does not resolve to an immutable version";
    return false;
  }
  return true;
}

size_t LightweaverProjectRepository::usedBytes() const {
  return available_ ? LittleFS.usedBytes() : 0;
}

bool LightweaverProjectRepository::preflight(const String& projectId,
    size_t totalBytes, const String& expectedHead, String& message) const {
  if (!available_) { message = "project repository unavailable"; return false; }
  if (!validProjectId(projectId)) { message = "project id is invalid"; return false; }
  if (!totalBytes || totalBytes > LW_PROJECT_MAX_BYTES) {
    message = "complete project exceeds card capacity";
    return false;
  }
  if (expectedHead != head_.current) { message = "stale expected head"; return false; }
  const size_t filesystemFree = LittleFS.totalBytes() > LittleFS.usedBytes()
      ? LittleFS.totalBytes() - LittleFS.usedBytes() : 0;
  const size_t quotaFree = LW_PROJECT_REPOSITORY_QUOTA_BYTES > usedBytes()
      ? LW_PROJECT_REPOSITORY_QUOTA_BYTES - usedBytes() : 0;
  if (totalBytes + LW_PROJECT_RECOVERY_HEADROOM_BYTES > filesystemFree ||
      totalBytes + LW_PROJECT_RECOVERY_HEADROOM_BYTES > quotaFree) {
    message = "project quota needs recovery headroom before staging";
    return false;
  }
  message = "project fits";
  return true;
}

bool LightweaverProjectRepository::beginStaging(const String& projectId,
    size_t totalBytes, size_t chunkSize, const String& contentHash,
    const String& transferHash,
    const String& expectedHead, String& message) {
  if (!preflight(projectId, totalBytes, expectedHead, message)) return false;
  if (!validHash(contentHash) || !validHash(transferHash) || !chunkSize || chunkSize > LW_PROJECT_MAX_CHUNK_BYTES) {
    message = "project hash or chunk size is invalid";
    return false;
  }
  cleanupAbandonedStaging();
  File staging = LittleFS.open(LW_PROJECT_STAGING_PATH, FILE_WRITE);
  if (!staging) { message = "cannot create project staging file"; return false; }
  staging.close();
  stagedProjectId_ = projectId;
  stagedProjectHead_ = contentHash;
  stagedTransferHash_ = transferHash;
  stagedExpectedHead_ = expectedHead;
  stagedTotalBytes_ = totalBytes;
  stagedChunkSize_ = chunkSize;
  stagedBytes_ = 0;
  nextChunkIndex_ = 0;
  message = "project staging started";
  return true;
}

bool LightweaverProjectRepository::appendChunk(uint32_t chunkIndex,
    const uint8_t* bytes, size_t size, String& message) {
  if (!stagedProjectId_.length()) { message = "no project staging transaction"; return false; }
  if (chunkIndex != nextChunkIndex_) { message = "chunkIndex is not nextChunkIndex"; return false; }
  if (!bytes || !size || size > stagedChunkSize_ || size > LW_PROJECT_MAX_CHUNK_BYTES ||
      stagedBytes_ + size > stagedTotalBytes_) {
    message = "project chunk size is invalid";
    return false;
  }
  if (stagedBytes_ + size < stagedTotalBytes_ && size != stagedChunkSize_) {
    message = "non-final project chunk is short";
    return false;
  }
  File staging = LittleFS.open(LW_PROJECT_STAGING_PATH, FILE_APPEND);
  if (!staging) { message = "project staging file unavailable"; return false; }
  const size_t written = staging.write(bytes, size);
  staging.flush();
  staging.close();
  if (written != size) { message = "project chunk write failed"; return false; }
  stagedBytes_ += size;
  nextChunkIndex_++;
  message = "project chunk accepted";
  return true;
}

bool LightweaverProjectRepository::hashFile(const String& path, String& hash,
    size_t& bytes, String& message) const {
  File file = LittleFS.open(path, FILE_READ);
  if (!file) { message = "project readback unavailable"; return false; }
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  mbedtls_sha256_starts_ret(&context, 0);
  uint8_t buffer[1024];
  bytes = 0;
  while (file.available()) {
    const size_t readbackBytes = file.read(buffer, sizeof(buffer));
    if (!readbackBytes) break;
    mbedtls_sha256_update_ret(&context, buffer, readbackBytes);
    bytes += readbackBytes;
  }
  file.close();
  uint8_t digest[32] = {};
  mbedtls_sha256_finish_ret(&context, digest);
  mbedtls_sha256_free(&context);
  hash = hexDigest(digest);
  return true;
}

bool LightweaverProjectRepository::writeHeadAtomically(
    const LightweaverProjectHead& head, String& message) {
  JsonDocument doc;
  doc["projectId"] = head.projectId;
  doc["current"] = head.current;
  doc["currentBlob"] = head.currentBlob;
  doc["knownGood"] = head.knownGood;
  doc["knownGoodBlob"] = head.knownGoodBlob;
  doc["generation"] = head.generation;
  File temp = LittleFS.open(LW_PROJECT_HEAD_TMP_PATH, FILE_WRITE);
  if (!temp) { message = "cannot stage project head"; return false; }
  const size_t expected = measureJson(doc);
  const size_t written = serializeJson(doc, temp);
  temp.flush();
  temp.close();
  if (written != expected) { LittleFS.remove(LW_PROJECT_HEAD_TMP_PATH); message = "project head write failed"; return false; }
  File readback = LittleFS.open(LW_PROJECT_HEAD_TMP_PATH, FILE_READ);
  JsonDocument verified;
  DeserializationError readbackError = deserializeJson(verified, readback);
  readback.close();
  if (readbackError || String(verified["current"] | "") != head.current ||
      String(verified["currentBlob"] | "") != head.currentBlob ||
      String(verified["knownGood"] | "") != head.knownGood ||
      String(verified["knownGoodBlob"] | "") != head.knownGoodBlob) {
    LittleFS.remove(LW_PROJECT_HEAD_TMP_PATH);
    message = "project head readback failed";
    return false;
  }
  // LittleFS rename is the atomic small head pointer promotion boundary.
  if (!LittleFS.rename(LW_PROJECT_HEAD_TMP_PATH, LW_PROJECT_HEAD_PATH)) {
    LittleFS.remove(LW_PROJECT_HEAD_TMP_PATH);
    message = "project head promotion failed";
    return false;
  }
  return true;
}

bool LightweaverProjectRepository::commit(const String& expectedHead,
    String& promotedHead, String& message) {
  if (!stagedProjectId_.length() || stagedBytes_ != stagedTotalBytes_ ||
      expectedHead != stagedExpectedHead_ || expectedHead != head_.current) {
    message = "staging is incomplete or expected head is stale";
    return false;
  }
  // The staging handle is closed after every chunk. Hashing therefore verifies
  // the closed file and performs a full readback before any pointer changes.
  String readbackHash;
  size_t readbackBytes = 0;
  if (!hashFile(LW_PROJECT_STAGING_PATH, readbackHash, readbackBytes, message) ||
      readbackBytes != stagedTotalBytes_ || readbackHash != stagedTransferHash_) {
    message = "project content hash or full readback failed";
    return false;
  }
  const String immutable = immutablePath(stagedTransferHash_);
  if (!LittleFS.exists(immutable) &&
      !LittleFS.rename(LW_PROJECT_STAGING_PATH, immutable)) {
    message = "immutable project version write failed";
    return false;
  }
  String immutableHash;
  size_t immutableBytes = 0;
  if (!hashFile(immutable, immutableHash, immutableBytes, message) ||
      immutableHash != stagedTransferHash_ || immutableBytes != stagedTotalBytes_) {
    message = "immutable project readback failed";
    return false;
  }
  LightweaverProjectHead next;
  next.projectId = stagedProjectId_;
  next.current = stagedProjectHead_;
  next.currentBlob = stagedTransferHash_;
  next.knownGood = head_.current;
  next.knownGoodBlob = head_.currentBlob;
  next.generation = head_.generation + 1;
  if (next.generation == 0) next.generation = 1;
  const String retiredRecovery = head_.knownGoodBlob;
  if (!writeHeadAtomically(next, message)) return false;
  head_ = next;
  // Verify the promoted head from storage before cleanup. Prior current is now
  // the retained known-good recovery; only the older recovery may be retired.
  LightweaverProjectHead promoted = head_;
  if (!loadHead(message) || head_.current != promoted.current ||
      head_.currentBlob != promoted.currentBlob || head_.knownGood != promoted.knownGood ||
      head_.knownGoodBlob != promoted.knownGoodBlob) return false;
  if (retiredRecovery.length() && retiredRecovery != head_.currentBlob &&
      retiredRecovery != head_.knownGoodBlob) LittleFS.remove(immutablePath(retiredRecovery));
  if (LittleFS.exists(LW_PROJECT_STAGING_PATH)) LittleFS.remove(LW_PROJECT_STAGING_PATH);
  promotedHead = head_.current;
  stagedProjectId_ = stagedProjectHead_ = stagedTransferHash_ = stagedExpectedHead_ = String();
  stagedTotalBytes_ = stagedChunkSize_ = stagedBytes_ = 0;
  nextChunkIndex_ = 0;
  message = "project committed";
  return true;
}

bool LightweaverProjectRepository::remove(const String& projectId,
    const String& expectedHead, String& message) {
  if (!available_ || expectedHead != head_.current || projectId != head_.projectId) {
    message = "stale expected head or project mismatch";
    return false;
  }
  LightweaverProjectHead empty;
  empty.generation = head_.generation + 1;
  if (!writeHeadAtomically(empty, message)) return false;
  const LightweaverProjectHead old = head_;
  head_ = empty;
  if (old.currentBlob.length()) LittleFS.remove(immutablePath(old.currentBlob));
  if (old.knownGoodBlob.length() && old.knownGoodBlob != old.currentBlob)
    LittleFS.remove(immutablePath(old.knownGoodBlob));
  cleanupAbandonedStaging();
  message = "project deleted";
  return true;
}

File LightweaverProjectRepository::openCurrent(String& message) const {
  if (!available_ || !head_.current.length()) { message = "project not found"; return File(); }
  File file = LittleFS.open(immutablePath(head_.currentBlob), FILE_READ);
  if (!file) message = "project version unreadable";
  return file;
}

#if defined(ARDUINO_ARCH_ESP32)
#include <WebServer.h>
#include <mbedtls/base64.h>

namespace {
WebServer* g_projectServer = nullptr;
uint8_t g_projectBody[LW_PROJECT_HTTP_MAX_BODY_BYTES + 1] = {};
size_t g_projectBodyLength = 0;
size_t g_projectExpectedLength = 0;
bool g_projectBodyReady = false;
bool g_projectBodyRejected = false;

void sendProjectCors() {
  String origin = g_projectServer->header("Origin");
  if (corsOriginAllowed(origin)) {
    g_projectServer->sendHeader("Access-Control-Allow-Origin", origin);
    g_projectServer->sendHeader("Vary", "Origin");
    g_projectServer->sendHeader("Access-Control-Allow-Headers", "Content-Type,X-Lightweaver-Card-Id,X-Lightweaver-Boot-Id,X-Lightweaver-Owner-Session,X-Lightweaver-Operation-Generation,X-Lightweaver-Expected-Head,X-Lightweaver-Capability");
    g_projectServer->sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    g_projectServer->sendHeader("Access-Control-Allow-Private-Network", "true");
  }
  g_projectServer->sendHeader("Cache-Control", "no-store");
}

LightweaverOwnerBinding projectBinding(JsonVariantConst source) {
  LightweaverOwnerBinding binding;
  binding.cardId = source["cardId"] | "";
  binding.bootId = source["bootId"] | "";
  binding.allowedOrigin = g_projectServer->header("Origin");
  binding.host = g_projectServer->hostHeader();
  binding.networkIdentity = runtimeNetworkIdentity();
  binding.ownerSessionId = source["ownerSessionId"] | "";
  binding.operationGeneration = source["operationGeneration"] | 0U;
  binding.expectedProjectHead = source["expectedHead"] | "";
  return binding;
}

bool authorizeProject(JsonVariantConst source, String& error) {
  const String token = source["capability"] | "";
  LightweaverOwnerValidation result = lightweaverOwnerCapability().validate(
      token, projectBinding(source), millis());
  if (result == LightweaverOwnerValidation::Accepted) return true;
  error = "owner capability rejected";
  return false;
}

void sendProjectError(int status, const String& error) {
  JsonDocument doc; doc["ok"] = false; doc["error"] = error;
  String body; serializeJson(doc, body);
  g_projectServer->send(status, "application/json", body);
}

bool parseProjectBody(JsonDocument& doc) {
  if (!g_projectBodyReady || g_projectBodyRejected) {
    sendProjectError(400, "project request body unavailable"); return false;
  }
  DeserializationError error = deserializeJson(doc, g_projectBody, g_projectBodyLength);
  g_projectBodyReady = false; g_projectBodyLength = 0;
  if (error || !doc.is<JsonObject>()) { sendProjectError(400, "project request is not valid JSON"); return false; }
  return true;
}

void handleProjectList() {
  sendProjectCors();
  JsonDocument query;
  query["cardId"] = g_projectServer->header("X-Lightweaver-Card-Id");
  query["bootId"] = g_projectServer->header("X-Lightweaver-Boot-Id");
  query["ownerSessionId"] = g_projectServer->header("X-Lightweaver-Owner-Session");
  query["operationGeneration"] = static_cast<uint32_t>(g_projectServer->header("X-Lightweaver-Operation-Generation").toInt());
  query["expectedHead"] = g_projectServer->header("X-Lightweaver-Expected-Head");
  query["capability"] = g_projectServer->header("X-Lightweaver-Capability");
  String authError;
  if (!authorizeProject(query.as<JsonVariantConst>(), authError)) { sendProjectError(403, authError); return; }
  const auto& head = lightweaverProjectRepository().head();
  JsonDocument response; response["ok"] = true; response["quotaBytes"] = LW_PROJECT_REPOSITORY_QUOTA_BYTES;
  response["usedBytes"] = lightweaverProjectRepository().usedBytes();
  JsonArray projects = response["projects"].to<JsonArray>();
  if (head.current.length()) { JsonObject project = projects.add<JsonObject>(); project["projectId"] = head.projectId; project["head"] = head.current; project["knownGood"] = head.knownGood; }
  String body; serializeJson(response, body); g_projectServer->send(200, "application/json", body);
}

void handleProjectRead() {
  sendProjectCors();
  JsonDocument query;
  query["cardId"] = g_projectServer->header("X-Lightweaver-Card-Id");
  query["bootId"] = g_projectServer->header("X-Lightweaver-Boot-Id");
  query["ownerSessionId"] = g_projectServer->header("X-Lightweaver-Owner-Session");
  query["operationGeneration"] = static_cast<uint32_t>(g_projectServer->header("X-Lightweaver-Operation-Generation").toInt());
  query["expectedHead"] = g_projectServer->header("X-Lightweaver-Expected-Head");
  query["capability"] = g_projectServer->header("X-Lightweaver-Capability");
  String authError;
  if (!authorizeProject(query.as<JsonVariantConst>(), authError)) { sendProjectError(403, authError); return; }
  if (g_projectServer->arg("id") != lightweaverProjectRepository().currentProjectId()) { sendProjectError(404, "project not found"); return; }
  String message; File file = lightweaverProjectRepository().openCurrent(message);
  if (!file) { sendProjectError(404, message); return; }
  g_projectServer->sendHeader("X-Lightweaver-Project-Head", lightweaverProjectRepository().currentHead());
  g_projectServer->streamFile(file, "application/json"); file.close();
}

void handleProjectMutation(const String& uri) {
  sendProjectCors();
  if (!lightweaverCardStudioMutationsEnabled()) {
    sendProjectError(503, lightweaverCardStudioValidationError()); return;
  }
  JsonDocument doc;
  if (!parseProjectBody(doc)) return;
  String authError;
  if (!authorizeProject(doc.as<JsonVariantConst>(), authError)) { sendProjectError(403, authError); return; }
  String message; bool ok = false; JsonDocument response;
  const String projectId = doc["projectId"] | "";
  const String expectedHead = doc["expectedHead"] | "";
  if (uri == "/api/projects/preflight") {
    ok = lightweaverProjectRepository().preflight(projectId, doc["totalBytes"] | 0U, expectedHead, message);
  } else if (uri == "/api/projects/begin") {
    ok = lightweaverProjectRepository().beginStaging(projectId, doc["totalBytes"] | 0U,
        doc["chunkSize"] | 0U, String(doc["contentHash"] | ""),
        String(doc["transferHash"] | ""), expectedHead, message);
  } else if (uri == "/api/projects/chunk") {
    const String encoded = doc["data"] | "";
    uint8_t decoded[LW_PROJECT_MAX_CHUNK_BYTES] = {};
    size_t decodedSize = 0;
    int result = mbedtls_base64_decode(decoded, sizeof(decoded), &decodedSize,
        reinterpret_cast<const unsigned char*>(encoded.c_str()), encoded.length());
    ok = result == 0 && lightweaverProjectRepository().appendChunk(
        doc["chunkIndex"] | UINT32_MAX, decoded, decodedSize, message);
    if (result != 0) message = "project chunk base64 is invalid";
  } else if (uri == "/api/projects/commit") {
    String promoted;
    ok = lightweaverProjectRepository().commit(expectedHead, promoted, message);
    response["head"] = promoted;
    if (ok) {
      response["capabilityHeadAdvanced"] = lightweaverOwnerCapability().advanceExpectedProjectHead(
          String(doc["capability"] | ""), projectBinding(doc.as<JsonVariantConst>()), promoted, millis());
    }
  } else if (uri == "/api/projects/delete") {
    ok = lightweaverProjectRepository().remove(projectId, expectedHead, message);
  }
  response["ok"] = ok; response[ok ? "message" : "error"] = message;
  response["projectHead"] = lightweaverProjectRepository().currentHead();
  String body; serializeJson(response, body);
  g_projectServer->send(ok ? 200 : 409, "application/json", body);
}

void handleProjectRaw(HTTPRaw& raw) {
  if (raw.status == RAW_START) {
    g_projectBodyLength = 0; g_projectBodyReady = false; g_projectBodyRejected = false;
    g_projectExpectedLength = g_projectServer->clientContentLength();
    if (g_projectExpectedLength == 0 || g_projectExpectedLength > LW_PROJECT_HTTP_MAX_BODY_BYTES) {
      g_projectBodyRejected = true; sendProjectCors(); sendProjectError(g_projectExpectedLength ? 413 : 411, "project request size rejected"); g_projectServer->client().stop();
    }
  } else if (raw.status == RAW_WRITE && !g_projectBodyRejected) {
    if (g_projectBodyLength + raw.currentSize > g_projectExpectedLength || g_projectBodyLength + raw.currentSize > LW_PROJECT_HTTP_MAX_BODY_BYTES) {
      g_projectBodyRejected = true; lightweaverOwnerCapability().revoke(); g_projectServer->client().stop();
    } else { memcpy(g_projectBody + g_projectBodyLength, raw.buf, raw.currentSize); g_projectBodyLength += raw.currentSize; }
  } else if (raw.status == RAW_END && !g_projectBodyRejected) {
    if (g_projectBodyLength != g_projectExpectedLength) { g_projectBodyRejected = true; lightweaverOwnerCapability().revoke(); }
    else { g_projectBody[g_projectBodyLength] = 0; g_projectBodyReady = true; }
  } else if (raw.status == RAW_ABORTED) {
    g_projectBodyLength = 0; g_projectBodyReady = false; g_projectBodyRejected = false;
    lightweaverOwnerCapability().revoke(); lightweaverProjectRepository().cleanupAbandonedStaging();
  }
}

class BoundedProjectRequestHandler final : public RequestHandler {
 public:
  bool canHandle(HTTPMethod method, String uri) override {
    return method == HTTP_POST && (uri == "/api/projects/preflight" || uri == "/api/projects/begin" ||
      uri == "/api/projects/chunk" || uri == "/api/projects/commit" || uri == "/api/projects/delete");
  }
  bool canUpload(String) override { return false; }
  bool canRaw(String uri) override { return canHandle(HTTP_POST, uri); }
  bool handle(WebServer&, HTTPMethod method, String uri) override { if (!canHandle(method, uri)) return false; handleProjectMutation(uri); return true; }
  void raw(WebServer&, String uri, HTTPRaw& rawBody) override { if (canRaw(uri)) handleProjectRaw(rawBody); }
};

void handleProjectOptions() { sendProjectCors(); g_projectServer->send(204, "text/plain", ""); }
}

void registerLightweaverProjectRepository(WebServer& server) {
  g_projectServer = &server;
  server.on("/api/projects/list", HTTP_GET, handleProjectList);
  server.on("/api/projects/read", HTTP_GET, handleProjectRead);
  for (const char* route : {"/api/projects/list", "/api/projects/read", "/api/projects/preflight",
      "/api/projects/begin", "/api/projects/chunk", "/api/projects/commit", "/api/projects/delete"})
    server.on(route, HTTP_OPTIONS, handleProjectOptions);
  server.addHandler(new BoundedProjectRequestHandler());
}
#else
void registerLightweaverProjectRepository(WebServer&) {}
#endif
