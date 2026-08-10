#include "LightweaverFirmwareUpdate.h"

#if defined(ARDUINO_ARCH_ESP32)
#include <ArduinoJson.h>
#include <WebServer.h>
#include <esp_app_format.h>
#include <esp_flash.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <mbedtls/base64.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>

#include "LightweaverCardStudio.h"
#include "LightweaverFirmwareBootHealth.h"
#include "LightweaverHttpFrameStream.h"
#include "LightweaverOwnerCapability.h"
#include "LightweaverProjectRepository.h"
#include "LightweaverRuntimeApi.h"
#include "LightweaverStorage.h"
#include "LightweaverWeb.h"

#ifndef LW_FIRMWARE_VERSION
#define LW_FIRMWARE_VERSION "1.0.0"
#endif
#ifndef LW_BUILD_ID
#define LW_BUILD_ID "dev"
#endif
#ifndef LW_BUILD_NUMBER
#define LW_BUILD_NUMBER 0
#endif
#ifndef LW_CAPABILITIES_VERSION
#define LW_CAPABILITIES_VERSION 1
#endif
#ifndef LW_PROJECT_SCHEMA_VERSION
#error "LW_PROJECT_SCHEMA_VERSION must be defined by the firmware build"
#endif

namespace {
constexpr const char* LW_UPDATE_TARGET = "esp32-s3-n16r8";
constexpr const char* LW_UPDATE_LAYOUT = "default_16MB.csv";
constexpr uint32_t LW_PARTITION_TABLE_OFFSET = 0x8000;
constexpr size_t LW_PARTITION_TABLE_BYTES = 0x1000;
constexpr uint32_t LW_APP0_OFFSET = 0x10000;
constexpr uint32_t LW_APP1_OFFSET = 0x650000;
constexpr size_t LW_APP_SLOT_BYTES = 0x640000;

// Same public key as release/keys/lightweaver-release-public.pem. Production
// firmware never compiles a test-key override.
constexpr char LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM[] =
    "-----BEGIN PUBLIC KEY-----\n"
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQ+nuEatzP5juWyVYJDC3GpSozW/y\n"
    "LAB3xjDNBGPyFvbvZKhZl+cFxuR1VB2cRrIo2XaaeuqefTz1oMRb6zwQLw==\n"
    "-----END PUBLIC KEY-----\n";

struct VerifiedTicket {
  String firmwareVersion;
  String buildId;
  uint32_t buildNumber = 0;
  size_t imageSize = 0;
  String imageSha256;
  String partitionTableSha256;
};

WebServer* g_updateServer = nullptr;
uint8_t* g_updateBody = nullptr;
size_t g_updateBodyLength = 0;
size_t g_updateExpectedLength = 0;
bool g_updateBodyReady = false;
bool g_updateBodyRejected = false;
LightweaverFirmwareTransferState g_transfer;
LightweaverFirmwareUpdateMutationRate g_mutationRate;
FirmwareUpdateStatus g_status;
VerifiedTicket g_ticket;
String g_leaseId;
esp_ota_handle_t g_otaHandle = 0;
const esp_partition_t* g_updatePartition = nullptr;
mbedtls_sha256_context g_imageSha;
bool g_imageShaActive = false;
bool g_restoreBlackout = false;
bool g_bootHandoffArmed = false;
uint32_t g_rebootAtMs = 0;

const char* phaseLabel(FirmwareUpdatePhase phase) {
  switch (phase) {
    case FirmwareUpdatePhase::Preflighted: return "preflighted";
    case FirmwareUpdatePhase::Receiving: return "receiving";
    case FirmwareUpdatePhase::Verifying: return "verifying";
    case FirmwareUpdatePhase::PendingReboot: return "pending-reboot";
    case FirmwareUpdatePhase::Probation: return "probation";
    case FirmwareUpdatePhase::Valid: return "valid";
    case FirmwareUpdatePhase::RolledBack: return "rolled-back";
    case FirmwareUpdatePhase::Failed: return "failed";
    case FirmwareUpdatePhase::Idle:
    default: return "idle";
  }
}

const char* resultLabel(FirmwareUpdateResult result) {
  switch (result) {
    case FirmwareUpdateResult::InvalidTicket: return "invalid-ticket";
    case FirmwareUpdateResult::SignatureRejected: return "signature-rejected";
    case FirmwareUpdateResult::CompatibilityRejected: return "compatibility-rejected";
    case FirmwareUpdateResult::AuthorityRejected: return "authority-rejected";
    case FirmwareUpdateResult::PhysicalConfirmationRequired: return "physical-confirmation-required";
    case FirmwareUpdateResult::ConcurrentMutation: return "concurrent-mutation";
    case FirmwareUpdateResult::BindingMismatch: return "binding-mismatch";
    case FirmwareUpdateResult::LeaseMismatch: return "lease-mismatch";
    case FirmwareUpdateResult::LeaseExpired: return "lease-expired";
    case FirmwareUpdateResult::SequenceMismatch: return "sequence-mismatch";
    case FirmwareUpdateResult::OffsetMismatch: return "offset-mismatch";
    case FirmwareUpdateResult::ChunkTooLarge: return "chunk-too-large";
    case FirmwareUpdateResult::SizeMismatch: return "size-mismatch";
    case FirmwareUpdateResult::DigestMismatch: return "digest-mismatch";
    case FirmwareUpdateResult::ImageRejected: return "image-rejected";
    case FirmwareUpdateResult::PlatformFailure: return "platform-failure";
    case FirmwareUpdateResult::RateLimited: return "rate-limited";
    case FirmwareUpdateResult::InvalidState: return "invalid-state";
    case FirmwareUpdateResult::Accepted:
    default: return "accepted";
  }
}

void freeUpdateBody() {
  if (g_updateBody) free(g_updateBody);
  g_updateBody = nullptr;
  g_updateBodyLength = 0;
  g_updateExpectedLength = 0;
  g_updateBodyReady = false;
}

void sendUpdateCors() {
  const String origin = g_updateServer->header("Origin");
  if (corsOriginAllowed(origin)) {
    g_updateServer->sendHeader("Access-Control-Allow-Origin", origin);
    g_updateServer->sendHeader("Vary", "Origin");
    g_updateServer->sendHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,X-Lightweaver-Card-Id,X-Lightweaver-Boot-Id,"
        "X-Lightweaver-Owner-Session,X-Lightweaver-Operation-Generation,"
        "X-Lightweaver-Expected-Head,X-Lightweaver-Capability,"
        "X-Lightweaver-Release-Build,X-Lightweaver-Ticket-Sha256");
    g_updateServer->sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    g_updateServer->sendHeader("Access-Control-Allow-Private-Network", "true");
  }
  g_updateServer->sendHeader("Cache-Control", "no-store");
}

void sendUpdateError(int status, FirmwareUpdateResult result,
                     const String& detail = String()) {
  g_status.phase = FirmwareUpdatePhase::Failed;
  g_status.lastError = detail.length() ? detail : String(resultLabel(result));
  JsonDocument doc;
  doc["ok"] = false;
  doc["error"] = resultLabel(result);
  if (detail.length()) doc["detail"] = detail;
  String body;
  serializeJson(doc, body);
  g_updateServer->send(status, "application/json", body);
}

void sendUpdateRateLimit() {
  freeUpdateBody();
  JsonDocument doc;
  doc["ok"] = false;
  doc["error"] = resultLabel(FirmwareUpdateResult::RateLimited);
  doc["detail"] = "firmware update mutation rate exceeded";
  String body;
  serializeJson(doc, body);
  // A rate refusal must not abort or otherwise alter an active inactive-slot
  // write. The exact owner capability remains mandatory when requests resume.
  g_updateServer->send(429, "application/json", body);
}

bool allowUpdateMutation() {
  if (g_mutationRate.allow(millis())) return true;
  sendUpdateRateLimit();
  return false;
}

bool exactKeys(JsonObjectConst object, const char* const* keys, size_t count) {
  if (object.size() != count) return false;
  for (JsonPairConst pair : object) {
    bool found = false;
    for (size_t index = 0; index < count; index++) {
      if (strcmp(pair.key().c_str(), keys[index]) == 0) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

bool strictHex(const String& value, size_t length) {
  if (value.length() != length) return false;
  for (size_t index = 0; index < length; index++) {
    const char c = value.c_str()[index];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

bool strictSemver(const String& value, uint32_t parts[3]) {
  const char* cursor = value.c_str();
  if (!*cursor) return false;
  for (size_t part = 0; part < 3; part++) {
    if (*cursor < '0' || *cursor > '9') return false;
    if (*cursor == '0' && cursor[1] >= '0' && cursor[1] <= '9') return false;
    uint64_t number = 0;
    while (*cursor >= '0' && *cursor <= '9') {
      number = number * 10 + static_cast<uint8_t>(*cursor - '0');
      if (number > UINT32_MAX) return false;
      cursor++;
    }
    parts[part] = static_cast<uint32_t>(number);
    if (part < 2) { if (*cursor != '.') return false; cursor++; }
  }
  return *cursor == '\0';
}

int compareSemver(const String& left, const String& right) {
  uint32_t leftParts[3] = {}, rightParts[3] = {};
  if (!strictSemver(left, leftParts) || !strictSemver(right, rightParts)) return 0;
  for (size_t index = 0; index < 3; index++) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

String hexDigest(const uint8_t digest[32]) {
  static const char digits[] = "0123456789abcdef";
  char value[65] = {};
  for (size_t index = 0; index < 32; index++) {
    value[index * 2] = digits[digest[index] >> 4];
    value[index * 2 + 1] = digits[digest[index] & 0x0f];
  }
  return String(value);
}

bool sha256Bytes(const uint8_t* bytes, size_t length, uint8_t digest[32]) {
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  const bool ok = mbedtls_sha256_starts_ret(&context, 0) == 0 &&
      mbedtls_sha256_update_ret(&context, bytes, length) == 0 &&
      mbedtls_sha256_finish_ret(&context, digest) == 0;
  mbedtls_sha256_free(&context);
  return ok;
}

bool decodeBase64(const String& encoded, uint8_t* output, size_t capacity,
                  size_t& outputLength) {
  return mbedtls_base64_decode(output, capacity, &outputLength,
      reinterpret_cast<const unsigned char*>(encoded.c_str()),
      encoded.length()) == 0;
}

bool decodeBase64UrlSignature(const String& encoded,
                              uint8_t signature[LW_FIRMWARE_UPDATE_SIGNATURE_BYTES]) {
  if (encoded.length() < 80 || encoded.length() > 88) return false;
  String standard = encoded;
  standard.replace('-', '+');
  standard.replace('_', '/');
  while (standard.length() % 4) standard += '=';
  size_t decoded = 0;
  return decodeBase64(standard, signature, LW_FIRMWARE_UPDATE_SIGNATURE_BYTES, decoded) &&
      decoded == LW_FIRMWARE_UPDATE_SIGNATURE_BYTES;
}

bool verifyPublisherSignature(const uint8_t* ticketBytes, size_t ticketLength,
                              const uint8_t signature[64]) {
  uint8_t digest[32] = {};
  if (!sha256Bytes(ticketBytes, ticketLength, digest)) return false;
  mbedtls_pk_context key;
  mbedtls_pk_init(&key);
  int result = mbedtls_pk_parse_public_key(&key,
      reinterpret_cast<const unsigned char*>(LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM),
      sizeof(LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM));
  if (result != 0 || !mbedtls_pk_can_do(&key, MBEDTLS_PK_ECKEY)) {
    mbedtls_pk_free(&key);
    return false;
  }
  mbedtls_mpi r, s;
  mbedtls_mpi_init(&r);
  mbedtls_mpi_init(&s);
  result = mbedtls_mpi_read_binary(&r, signature, 32);
  if (result == 0) result = mbedtls_mpi_read_binary(&s, signature + 32, 32);
  if (result == 0) {
    mbedtls_ecp_keypair* ec = mbedtls_pk_ec(key);
    result = mbedtls_ecdsa_verify(&ec->grp, digest, sizeof(digest), &ec->Q, &r, &s);
  }
  mbedtls_mpi_free(&r);
  mbedtls_mpi_free(&s);
  mbedtls_pk_free(&key);
  return result == 0;
}

bool partitionTableDigest(String& digest, String& error) {
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  if (mbedtls_sha256_starts_ret(&context, 0) != 0) {
    mbedtls_sha256_free(&context); error = "partition table hash failed"; return false;
  }
  uint8_t bytes[256] = {};
  for (size_t offset = 0; offset < LW_PARTITION_TABLE_BYTES; offset += sizeof(bytes)) {
    if (esp_flash_read(esp_flash_default_chip, bytes,
            LW_PARTITION_TABLE_OFFSET + offset, sizeof(bytes)) != ESP_OK ||
        mbedtls_sha256_update_ret(&context, bytes, sizeof(bytes)) != 0) {
      mbedtls_sha256_free(&context); error = "partition table read failed"; return false;
    }
  }
  uint8_t hash[32] = {};
  if (mbedtls_sha256_finish_ret(&context, hash) != 0) {
    mbedtls_sha256_free(&context); error = "partition table hash failed"; return false;
  }
  mbedtls_sha256_free(&context);
  digest = hexDigest(hash);
  return true;
}

bool parseAndVerifyTicket(const uint8_t* bytes, size_t length,
                          const uint8_t signature[64],
                          const FirmwareUpdateBinding& binding,
                          VerifiedTicket& ticket, String& error) {
  if (!bytes || !length || length > LW_FIRMWARE_UPDATE_TICKET_MAX_BYTES) {
    error = "ticket size rejected"; return false;
  }
  uint8_t digest[32] = {};
  if (!sha256Bytes(bytes, length, digest) ||
      binding.ticketSha256 != hexDigest(digest)) {
    error = "ticket digest mismatch"; return false;
  }
  if (!verifyPublisherSignature(bytes, length, signature)) {
    error = "ticket signature rejected"; return false;
  }
  JsonDocument doc;
  if (deserializeJson(doc, bytes, length) || !doc.is<JsonObject>()) {
    error = "ticket JSON invalid"; return false;
  }
  static const char* rootKeys[] = {"schemaVersion", "firmwareVersion", "buildId",
      "buildNumber", "target", "image", "partition", "compatibility", "preservation"};
  static const char* imageKeys[] = {"url", "size", "sha256"};
  static const char* partitionKeys[] = {"layout", "tableSha256", "app0Offset", "app1Offset", "slotSize"};
  static const char* compatibilityKeys[] = {"firmwareApiMin", "firmwareApiMax",
      "projectSchemaMin", "projectSchemaMax", "minimumUpdaterVersion", "minimumBootstrapBuild"};
  static const char* preservationKeys[] = {"dataPartitionsIncluded"};
  if (!exactKeys(doc.as<JsonObjectConst>(), rootKeys, 9) ||
      !doc["image"].is<JsonObject>() || !exactKeys(doc["image"].as<JsonObjectConst>(), imageKeys, 3) ||
      !doc["partition"].is<JsonObject>() || !exactKeys(doc["partition"].as<JsonObjectConst>(), partitionKeys, 5) ||
      !doc["compatibility"].is<JsonObject>() || !exactKeys(doc["compatibility"].as<JsonObjectConst>(), compatibilityKeys, 6) ||
      !doc["preservation"].is<JsonObject>() || !exactKeys(doc["preservation"].as<JsonObjectConst>(), preservationKeys, 1)) {
    error = "unsupported ticket fields"; return false;
  }
  if (!doc["schemaVersion"].is<uint32_t>() || !doc["firmwareVersion"].is<const char*>() ||
      !doc["buildId"].is<const char*>() || !doc["buildNumber"].is<uint32_t>() ||
      !doc["target"].is<const char*>() || !doc["image"]["url"].is<const char*>() ||
      !doc["image"]["size"].is<uint32_t>() || !doc["image"]["sha256"].is<const char*>() ||
      !doc["partition"]["layout"].is<const char*>() ||
      !doc["partition"]["tableSha256"].is<const char*>() ||
      !doc["partition"]["app0Offset"].is<uint32_t>() ||
      !doc["partition"]["app1Offset"].is<uint32_t>() ||
      !doc["partition"]["slotSize"].is<uint32_t>() ||
      !doc["compatibility"]["firmwareApiMin"].is<uint32_t>() ||
      !doc["compatibility"]["firmwareApiMax"].is<uint32_t>() ||
      !doc["compatibility"]["projectSchemaMin"].is<uint32_t>() ||
      !doc["compatibility"]["projectSchemaMax"].is<uint32_t>() ||
      !doc["compatibility"]["minimumUpdaterVersion"].is<uint32_t>() ||
      !doc["compatibility"]["minimumBootstrapBuild"].is<uint32_t>() ||
      !doc["preservation"]["dataPartitionsIncluded"].is<bool>()) {
    error = "ticket field types rejected"; return false;
  }

  ticket.firmwareVersion = doc["firmwareVersion"] | "";
  ticket.buildId = doc["buildId"] | "";
  ticket.buildNumber = doc["buildNumber"] | 0U;
  ticket.imageSize = doc["image"]["size"] | 0U;
  ticket.imageSha256 = doc["image"]["sha256"] | "";
  ticket.partitionTableSha256 = doc["partition"]["tableSha256"] | "";
  const String target = doc["target"] | "";
  const String layout = doc["partition"]["layout"] | "";
  const String imageUrl = doc["image"]["url"] | "";
  const String expectedImageUrl = String("/firmware/releases/") +
      ticket.firmwareVersion + "/" + ticket.buildId +
      "/lightweaver-controller-esp32s3-app.bin";
  uint32_t semver[3] = {};
  if (doc["schemaVersion"].as<uint32_t>() != 1 || target != LW_UPDATE_TARGET ||
      !strictSemver(ticket.firmwareVersion, semver) || !strictHex(ticket.buildId, 40) ||
      ticket.buildNumber == 0 || binding.releaseBuildId != ticket.buildId ||
      !strictHex(ticket.imageSha256, 64) || !strictHex(ticket.partitionTableSha256, 64) ||
      imageUrl != expectedImageUrl ||
      layout != LW_UPDATE_LAYOUT ||
      doc["partition"]["app0Offset"].as<uint32_t>() != LW_APP0_OFFSET ||
      doc["partition"]["app1Offset"].as<uint32_t>() != LW_APP1_OFFSET ||
      doc["partition"]["slotSize"].as<uint32_t>() != LW_APP_SLOT_BYTES ||
      ticket.imageSize == 0 || ticket.imageSize > LW_APP_SLOT_BYTES ||
      doc["preservation"]["dataPartitionsIncluded"].as<bool>() ||
      doc["compatibility"]["minimumUpdaterVersion"].as<uint32_t>() > LW_FIRMWARE_UPDATE_VERSION) {
    error = "ticket target, layout, identity, or preservation rejected"; return false;
  }
  const uint32_t apiMin = doc["compatibility"]["firmwareApiMin"] | 0U;
  const uint32_t apiMax = doc["compatibility"]["firmwareApiMax"] | 0U;
  const uint32_t schemaMin = doc["compatibility"]["projectSchemaMin"] | 0U;
  const uint32_t schemaMax = doc["compatibility"]["projectSchemaMax"] | 0U;
  if (apiMin > LW_CAPABILITIES_VERSION || apiMax < LW_CAPABILITIES_VERSION ||
      schemaMin > LW_PROJECT_SCHEMA_VERSION || schemaMax < LW_PROJECT_SCHEMA_VERSION ||
      compareSemver(ticket.firmwareVersion, LW_FIRMWARE_VERSION) <= 0 ||
      (LW_BUILD_NUMBER > 0 && ticket.buildNumber <= LW_BUILD_NUMBER)) {
    error = "ticket API, project schema, or downgrade policy rejected"; return false;
  }
  String livePartitionDigest;
  if (!partitionTableDigest(livePartitionDigest, error) ||
      livePartitionDigest != ticket.partitionTableSha256) {
    error = "partition table digest mismatch"; return false;
  }
  const esp_partition_t* running = esp_ota_get_running_partition();
  const esp_partition_t* update = esp_ota_get_next_update_partition(nullptr);
  if (!running || !update || running == update || update->size != LW_APP_SLOT_BYTES ||
      (update->address != LW_APP0_OFFSET && update->address != LW_APP1_OFFSET) ||
      (running->address != LW_APP0_OFFSET && running->address != LW_APP1_OFFSET)) {
    error = "active or inactive application slot rejected"; return false;
  }
  return true;
}

FirmwareUpdateBinding updateBinding(JsonVariantConst source) {
  FirmwareUpdateBinding binding;
  binding.cardId = source["cardId"] | "";
  binding.bootId = source["bootId"] | "";
  binding.ownerSessionId = source["ownerSessionId"] | "";
  binding.operationGeneration = source["operationGeneration"] | 0U;
  binding.expectedProjectHead = source["expectedProjectHead"] | "";
  binding.releaseBuildId = source["releaseBuildId"] | "";
  binding.ticketSha256 = source["ticketSha256"] | "";
  return binding;
}

bool authorizeUpdate(JsonVariantConst source, const FirmwareUpdateBinding& update,
                     bool requirePhysical, String& error) {
  LightweaverOwnerBinding owner;
  owner.cardId = update.cardId;
  owner.bootId = update.bootId;
  owner.allowedOrigin = g_updateServer->header("Origin");
  owner.host = g_updateServer->hostHeader();
  owner.networkIdentity = runtimeNetworkIdentity();
  owner.ownerSessionId = update.ownerSessionId;
  owner.operationGeneration = update.operationGeneration;
  owner.expectedProjectHead = update.expectedProjectHead;
  const String capability = source["capability"] | "";
  if (lightweaverOwnerCapability().validate(capability, owner, millis()) !=
          LightweaverOwnerValidation::Accepted ||
      update.cardId != runtimeCardId() || update.bootId != runtimeBootId() ||
      update.expectedProjectHead != lightweaverProjectRepository().currentHead()) {
    error = "owner capability or exact-card binding rejected";
    return false;
  }
  if (requirePhysical && (!runtimeOwnerPairingAuthorized() ||
      !String(source["physicalConfirmationNonce"] | "").length())) {
    error = "fresh physical confirmation required";
    return false;
  }
  return true;
}

bool parseUpdateBody(JsonDocument& doc) {
  if (!g_updateBodyReady || g_updateBodyRejected || !g_updateBody) {
    sendUpdateError(400, FirmwareUpdateResult::InvalidTicket, "update request body unavailable");
    return false;
  }
  DeserializationError parsed = deserializeJson(doc, g_updateBody, g_updateBodyLength);
  freeUpdateBody();
  if (parsed || !doc.is<JsonObject>()) {
    sendUpdateError(400, FirmwareUpdateResult::InvalidTicket, "update request is not valid JSON");
    return false;
  }
  return true;
}

String makeRandomId(const char* prefix) {
  char value[48] = {};
  snprintf(value, sizeof(value), "%s-%08lx%08lx%08lx%08lx", prefix,
      static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()),
      static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(esp_random()));
  return String(value);
}

String partitionLabel(const esp_partition_t* partition) {
  if (!partition) return String();
  return partition->address == LW_APP0_OFFSET ? "app0" :
      partition->address == LW_APP1_OFFSET ? "app1" : String(partition->label);
}

void syncTransferStatus() {
  g_status.phase = g_transfer.phase();
  g_status.receivedBytes = g_transfer.receivedBytes();
  g_status.expectedBytes = g_transfer.expectedBytes();
}

void abortInactiveWrite(const String& reason, bool failed) {
  if (g_otaHandle) esp_ota_abort(g_otaHandle);
  g_otaHandle = 0;
  g_updatePartition = nullptr;
  if (g_bootHandoffArmed) {
    cancelLightweaverFirmwareBootHealthHandoff();
    g_bootHandoffArmed = false;
  }
  if (g_imageShaActive) { mbedtls_sha256_free(&g_imageSha); g_imageShaActive = false; }
  g_transfer.reset();
  g_leaseId = String();
  if (!g_restoreBlackout) runtimeSetBlackout(false);
  g_restoreBlackout = false;
  g_status.phase = failed ? FirmwareUpdatePhase::Failed : FirmwareUpdatePhase::Idle;
  g_status.lastError = reason;
  g_status.receivedBytes = 0;
  g_status.pendingSlot = String();
}

void sendStatusBody(int status = 200) {
  JsonDocument doc;
  doc["ok"] = status < 400;
  doc["phase"] = phaseLabel(g_status.phase);
  doc["receivedBytes"] = g_status.receivedBytes;
  doc["expectedBytes"] = g_status.expectedBytes;
  doc["expectedBuildId"] = g_status.expectedBuildId;
  doc["activeSlot"] = g_status.activeSlot;
  doc["pendingSlot"] = g_status.pendingSlot;
  doc["lastError"] = g_status.lastError;
  doc["rollbackReason"] = g_status.rollbackReason;
  doc["rebootCorrelation"] = g_status.rebootCorrelation;
  doc["restoredFirmwareVersion"] = g_status.restoredFirmwareVersion;
  doc["restoredBuildId"] = g_status.restoredBuildId;
  doc["restoredBuildNumber"] = g_status.restoredBuildNumber;
  String body;
  serializeJson(doc, body);
  g_updateServer->send(status, "application/json", body);
}

void handlePreflight() {
  sendUpdateCors();
  if (!allowUpdateMutation()) return;
  JsonDocument doc;
  if (!parseUpdateBody(doc)) return;
  if (!lightweaverCardStudioMutationsEnabled()) {
    sendUpdateError(503, FirmwareUpdateResult::ConcurrentMutation,
                    lightweaverCardStudioValidationError()); return;
  }
  if (lightweaverFirmwareUpdateActive() || lightweaverHttpFrameStreamActive() ||
      lightweaverProjectRepository().stagingActive() || !runtimeCommandReady()) {
    sendUpdateError(409, FirmwareUpdateResult::ConcurrentMutation); return;
  }
  FirmwareUpdateBinding binding = updateBinding(doc.as<JsonVariantConst>());
  String authError;
  if (!authorizeUpdate(doc.as<JsonVariantConst>(), binding, true, authError)) {
    sendUpdateError(403, authError.indexOf("physical") >= 0
        ? FirmwareUpdateResult::PhysicalConfirmationRequired
        : FirmwareUpdateResult::AuthorityRejected, authError); return;
  }
  const String encodedTicket = doc["ticket"] | "";
  const String encodedSignature = doc["signature"] | "";
  if (encodedTicket.length() > ((LW_FIRMWARE_UPDATE_TICKET_MAX_BYTES + 2) / 3) * 4) {
    sendUpdateError(413, FirmwareUpdateResult::InvalidTicket, "ticket encoding too large"); return;
  }
  uint8_t* ticketBytes = static_cast<uint8_t*>(malloc(LW_FIRMWARE_UPDATE_TICKET_MAX_BYTES));
  if (!ticketBytes) { sendUpdateError(503, FirmwareUpdateResult::PlatformFailure, "ticket allocation failed"); return; }
  size_t ticketLength = 0;
  uint8_t signature[64] = {};
  const bool decoded = decodeBase64(encodedTicket, ticketBytes,
      LW_FIRMWARE_UPDATE_TICKET_MAX_BYTES, ticketLength) &&
      decodeBase64UrlSignature(encodedSignature, signature);
  VerifiedTicket ticket;
  String verifyError;
  const bool verified = decoded && parseAndVerifyTicket(ticketBytes, ticketLength,
      signature, binding, ticket, verifyError);
  free(ticketBytes);
  if (!verified) {
    sendUpdateError(409, decoded ? FirmwareUpdateResult::CompatibilityRejected
        : FirmwareUpdateResult::InvalidTicket,
        verifyError.length() ? verifyError : "ticket or signature encoding rejected");
    return;
  }
  g_transfer.reset();
  FirmwareUpdateResult result = g_transfer.preflight(binding, ticket.imageSize, millis());
  if (result != FirmwareUpdateResult::Accepted) { sendUpdateError(409, result); return; }
  g_ticket = ticket;
  g_status = FirmwareUpdateStatus{};
  syncTransferStatus();
  g_status.expectedBuildId = ticket.buildId;
  g_status.activeSlot = partitionLabel(esp_ota_get_running_partition());
  g_status.pendingSlot = partitionLabel(esp_ota_get_next_update_partition(nullptr));
  sendStatusBody();
}

void handleBegin() {
  sendUpdateCors(); if (!allowUpdateMutation()) return;
  JsonDocument doc; if (!parseUpdateBody(doc)) return;
  FirmwareUpdateBinding binding = updateBinding(doc.as<JsonVariantConst>());
  String authError;
  if (!authorizeUpdate(doc.as<JsonVariantConst>(), binding, true, authError)) {
    abortInactiveWrite(authError, true);
    sendUpdateError(403, authError.indexOf("physical") >= 0
        ? FirmwareUpdateResult::PhysicalConfirmationRequired
        : FirmwareUpdateResult::AuthorityRejected, authError); return;
  }
  if (g_transfer.phase() != FirmwareUpdatePhase::Preflighted) {
    sendUpdateError(409, FirmwareUpdateResult::InvalidState); return;
  }
  stopLightweaverHttpFrameStream();
  runtimeCancelStream();
  g_restoreBlackout = runtimeIsBlackedOut();
  runtimeSetBlackout(true);
  g_updatePartition = esp_ota_get_next_update_partition(nullptr);
  if (!g_updatePartition || g_updatePartition == esp_ota_get_running_partition() ||
      esp_ota_begin(g_updatePartition, g_ticket.imageSize, &g_otaHandle) != ESP_OK) {
    abortInactiveWrite("inactive slot open failed", true);
    sendUpdateError(500, FirmwareUpdateResult::PlatformFailure); return;
  }
  mbedtls_sha256_init(&g_imageSha);
  if (mbedtls_sha256_starts_ret(&g_imageSha, 0) != 0) {
    abortInactiveWrite("image hash initialization failed", true);
    sendUpdateError(500, FirmwareUpdateResult::PlatformFailure); return;
  }
  g_imageShaActive = true;
  g_leaseId = makeRandomId("update");
  FirmwareUpdateResult result = g_transfer.begin(binding, g_leaseId, millis());
  if (result != FirmwareUpdateResult::Accepted) {
    abortInactiveWrite(resultLabel(result), true); sendUpdateError(409, result); return;
  }
  syncTransferStatus();
  JsonDocument response;
  response["ok"] = true;
  response["phase"] = phaseLabel(g_status.phase);
  response["leaseId"] = g_leaseId;
  response["nextSequence"] = g_transfer.nextSequence();
  response["nextOffset"] = g_transfer.nextOffset();
  response["expiresInMs"] = LW_FIRMWARE_UPDATE_LEASE_TTL_MS;
  String body; serializeJson(response, body);
  g_updateServer->send(200, "application/json", body);
}

void handleChunk() {
  sendUpdateCors(); if (!allowUpdateMutation()) return;
  JsonDocument doc; if (!parseUpdateBody(doc)) return;
  FirmwareUpdateBinding binding = updateBinding(doc.as<JsonVariantConst>());
  String authError;
  if (!authorizeUpdate(doc.as<JsonVariantConst>(), binding, false, authError)) {
    abortInactiveWrite(authError, true);
    sendUpdateError(403, FirmwareUpdateResult::AuthorityRejected, authError); return;
  }
  const String encoded = doc["data"] | "";
  if (encoded.length() > ((LW_FIRMWARE_UPDATE_MAX_CHUNK_BYTES + 2) / 3) * 4) {
    abortInactiveWrite("chunk encoding too large", true);
    sendUpdateError(413, FirmwareUpdateResult::ChunkTooLarge); return;
  }
  uint8_t* bytes = static_cast<uint8_t*>(malloc(LW_FIRMWARE_UPDATE_MAX_CHUNK_BYTES));
  if (!bytes) { abortInactiveWrite("chunk allocation failed", true); sendUpdateError(503, FirmwareUpdateResult::PlatformFailure); return; }
  size_t decoded = 0;
  if (!decodeBase64(encoded, bytes, LW_FIRMWARE_UPDATE_MAX_CHUNK_BYTES, decoded)) {
    free(bytes); abortInactiveWrite("chunk base64 invalid", true);
    sendUpdateError(400, FirmwareUpdateResult::InvalidTicket); return;
  }
  const String leaseId = doc["leaseId"] | "";
  FirmwareUpdateResult result = g_transfer.acceptChunk(binding, leaseId,
      doc["sequence"] | 0U, doc["offset"] | 0U, decoded, millis());
  if (result == FirmwareUpdateResult::Accepted) {
    if (esp_ota_write(g_otaHandle, bytes, decoded) != ESP_OK ||
        mbedtls_sha256_update_ret(&g_imageSha, bytes, decoded) != 0) {
      result = FirmwareUpdateResult::PlatformFailure;
    }
  }
  free(bytes);
  if (result != FirmwareUpdateResult::Accepted) {
    abortInactiveWrite(resultLabel(result), true); sendUpdateError(409, result); return;
  }
  syncTransferStatus();
  JsonDocument response;
  response["ok"] = true; response["phase"] = phaseLabel(g_status.phase);
  response["acceptedSequence"] = doc["sequence"] | 0U;
  response["receivedBytes"] = g_status.receivedBytes;
  response["nextSequence"] = g_transfer.nextSequence();
  response["nextOffset"] = g_transfer.nextOffset();
  String body; serializeJson(response, body); g_updateServer->send(200, "application/json", body);
}

bool partitionContainsString(const esp_partition_t* partition, size_t length,
                             const String& needle) {
  if (!partition || !needle.length()) return false;
  uint8_t buffer[1024 + 64] = {};
  size_t carry = 0;
  for (size_t offset = 0; offset < length;) {
    const size_t count = min(static_cast<size_t>(1024), length - offset);
    if (esp_partition_read(partition, offset, buffer + carry, count) != ESP_OK) return false;
    const size_t available = carry + count;
    for (size_t index = 0; index + needle.length() <= available; index++) {
      if (memcmp(buffer + index, needle.c_str(), needle.length()) == 0) return true;
    }
    carry = min(static_cast<size_t>(63), available);
    memmove(buffer, buffer + available - carry, carry);
    offset += count;
    delay(0);
  }
  return false;
}

bool partitionImageDigest(const esp_partition_t* partition, size_t length,
                          String& digest) {
  if (!partition || !length || length > partition->size) return false;
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  if (mbedtls_sha256_starts_ret(&context, 0) != 0) {
    mbedtls_sha256_free(&context); return false;
  }
  uint8_t buffer[1024] = {};
  for (size_t offset = 0; offset < length;) {
    const size_t count = min(sizeof(buffer), length - offset);
    if (esp_partition_read(partition, offset, buffer, count) != ESP_OK ||
        mbedtls_sha256_update_ret(&context, buffer, count) != 0) {
      mbedtls_sha256_free(&context); return false;
    }
    offset += count;
    delay(0);
  }
  uint8_t hash[32] = {};
  const bool ok = mbedtls_sha256_finish_ret(&context, hash) == 0;
  mbedtls_sha256_free(&context);
  if (ok) digest = hexDigest(hash);
  return ok;
}

void handleCommit() {
  sendUpdateCors(); if (!allowUpdateMutation()) return;
  JsonDocument doc; if (!parseUpdateBody(doc)) return;
  FirmwareUpdateBinding binding = updateBinding(doc.as<JsonVariantConst>());
  String authError;
  if (!authorizeUpdate(doc.as<JsonVariantConst>(), binding, false, authError)) {
    abortInactiveWrite(authError, true); sendUpdateError(403, FirmwareUpdateResult::AuthorityRejected, authError); return;
  }
  FirmwareUpdateResult result = g_transfer.readyToCommit(binding,
      String(doc["leaseId"] | ""), millis());
  syncTransferStatus();
  if (result != FirmwareUpdateResult::Accepted) {
    abortInactiveWrite(resultLabel(result), true); sendUpdateError(409, result); return;
  }
  uint8_t digest[32] = {};
  if (!g_imageShaActive || mbedtls_sha256_finish_ret(&g_imageSha, digest) != 0) {
    abortInactiveWrite("image hash finalization failed", true); sendUpdateError(500, FirmwareUpdateResult::PlatformFailure); return;
  }
  mbedtls_sha256_free(&g_imageSha); g_imageShaActive = false;
  if (hexDigest(digest) != g_ticket.imageSha256) {
    abortInactiveWrite("image digest mismatch", true); sendUpdateError(409, FirmwareUpdateResult::DigestMismatch); return;
  }
  if (esp_ota_end(g_otaHandle) != ESP_OK) {
    g_otaHandle = 0; abortInactiveWrite("ESP application image rejected", true);
    sendUpdateError(409, FirmwareUpdateResult::ImageRejected); return;
  }
  g_otaHandle = 0;
  String readbackDigest;
  if (!partitionImageDigest(g_updatePartition, g_ticket.imageSize, readbackDigest) ||
      readbackDigest != g_ticket.imageSha256 ||
      !partitionContainsString(g_updatePartition, g_ticket.imageSize, g_ticket.buildId) ||
      !partitionContainsString(g_updatePartition, g_ticket.imageSize, g_ticket.firmwareVersion)) {
    abortInactiveWrite("embedded firmware identity mismatch", true);
    sendUpdateError(409, FirmwareUpdateResult::ImageRejected); return;
  }
  g_status.rebootCorrelation = makeRandomId("reboot");
  if (!armLightweaverFirmwareBootHealth(g_ticket.buildId.c_str(),
          binding.expectedProjectHead.c_str(), g_status.rebootCorrelation.c_str())) {
    abortInactiveWrite("boot probation handoff failed", true);
    sendUpdateError(500, FirmwareUpdateResult::PlatformFailure); return;
  }
  g_bootHandoffArmed = true;
  if (esp_ota_set_boot_partition(g_updatePartition) != ESP_OK) {
    abortInactiveWrite("pending boot slot selection failed", true);
    sendUpdateError(500, FirmwareUpdateResult::PlatformFailure); return;
  }
  g_bootHandoffArmed = false;  // Boot health now owns the reboot correlation.
  g_status.pendingSlot = partitionLabel(g_updatePartition);
  g_status.lastError = String();
  g_transfer.markPendingReboot();
  syncTransferStatus();
  g_rebootAtMs = millis() + LW_FIRMWARE_UPDATE_REBOOT_DELAY_MS;
  sendStatusBody();
}

void handleCancel() {
  sendUpdateCors(); if (!allowUpdateMutation()) return;
  JsonDocument doc; if (!parseUpdateBody(doc)) return;
  FirmwareUpdateBinding binding = updateBinding(doc.as<JsonVariantConst>());
  String authError;
  if (!authorizeUpdate(doc.as<JsonVariantConst>(), binding, false, authError)) {
    abortInactiveWrite(authError, true); sendUpdateError(403, FirmwareUpdateResult::AuthorityRejected, authError); return;
  }
  abortInactiveWrite("cancelled by owner", false);
  sendStatusBody();
}

void handleStatus() { sendUpdateCors(); sendStatusBody(); }

void handleUpdateMutation(const String& uri) {
  if (uri == "/api/update/preflight") handlePreflight();
  else if (uri == "/api/update/begin") handleBegin();
  else if (uri == "/api/update/chunk") handleChunk();
  else if (uri == "/api/update/commit") handleCommit();
  else handleCancel();
}

void handleUpdateRaw(HTTPRaw& raw) {
  if (raw.status == RAW_START) {
    freeUpdateBody();
    g_updateBodyRejected = false;
    g_updateExpectedLength = g_updateServer->clientContentLength();
    if (g_updateExpectedLength == 0 ||
        g_updateExpectedLength > LW_FIRMWARE_UPDATE_HTTP_MAX_BODY_BYTES) {
      g_updateBodyRejected = true;
      sendUpdateCors();
      sendUpdateError(g_updateExpectedLength ? 413 : 411,
          FirmwareUpdateResult::ChunkTooLarge, "update request size rejected");
      g_updateServer->client().stop();
      return;
    }
    g_updateBody = static_cast<uint8_t*>(malloc(g_updateExpectedLength + 1));
    if (!g_updateBody) {
      g_updateBodyRejected = true;
      sendUpdateCors(); sendUpdateError(503, FirmwareUpdateResult::PlatformFailure,
          "update request allocation failed");
      g_updateServer->client().stop();
    }
  } else if (raw.status == RAW_WRITE && !g_updateBodyRejected) {
    if (!g_updateBody || g_updateBodyLength + raw.currentSize > g_updateExpectedLength) {
      g_updateBodyRejected = true; freeUpdateBody();
      cancelLightweaverFirmwareUpdate("interrupted update request");
      g_updateServer->client().stop();
    } else {
      memcpy(g_updateBody + g_updateBodyLength, raw.buf, raw.currentSize);
      g_updateBodyLength += raw.currentSize;
    }
  } else if (raw.status == RAW_END && !g_updateBodyRejected) {
    if (!g_updateBody || g_updateBodyLength != g_updateExpectedLength) {
      g_updateBodyRejected = true; freeUpdateBody();
      cancelLightweaverFirmwareUpdate("incomplete update request");
    } else {
      g_updateBody[g_updateBodyLength] = 0;
      g_updateBodyReady = true;
    }
  } else if (raw.status == RAW_ABORTED) {
    freeUpdateBody();
    g_updateBodyRejected = false;
    cancelLightweaverFirmwareUpdate("aborted update request");
  }
}

class BoundedFirmwareUpdateHandler final : public RequestHandler {
 public:
  bool canHandle(HTTPMethod method, String uri) override {
    return method == HTTP_POST && (uri == "/api/update/preflight" ||
        uri == "/api/update/begin" || uri == "/api/update/chunk" ||
        uri == "/api/update/commit" || uri == "/api/update/cancel");
  }
  bool canUpload(String) override { return false; }
  bool canRaw(String uri) override { return canHandle(HTTP_POST, uri); }
  bool handle(WebServer&, HTTPMethod method, String uri) override {
    if (!canHandle(method, uri)) return false;
    handleUpdateMutation(uri); return true;
  }
  void raw(WebServer&, String uri, HTTPRaw& rawBody) override {
    if (canRaw(uri)) handleUpdateRaw(rawBody);
  }
};

void handleUpdateOptions() {
  sendUpdateCors(); g_updateServer->send(204, "text/plain", "");
}
}

void registerLightweaverFirmwareUpdate(WebServer& server) {
  g_updateServer = &server;
  server.on("/api/update/status", HTTP_GET, handleStatus);
  for (const char* route : {"/api/update/preflight", "/api/update/begin",
      "/api/update/chunk", "/api/update/commit", "/api/update/cancel",
      "/api/update/status"}) {
    server.on(route, HTTP_OPTIONS, handleUpdateOptions);
  }
  server.addHandler(new BoundedFirmwareUpdateHandler());
  const esp_partition_t* running = esp_ota_get_running_partition();
  g_status.activeSlot = partitionLabel(running);
}

void handleLightweaverFirmwareUpdate() {
  if (g_transfer.expire(millis())) {
    abortInactiveWrite("update lease expired", true);
  }
  if (g_rebootAtMs && static_cast<int32_t>(millis() - g_rebootAtMs) >= 0) {
    g_rebootAtMs = 0;
    delay(50);
    ESP.restart();
  }
}

void cancelLightweaverFirmwareUpdate(const String& reason) {
  abortInactiveWrite(reason.length() ? reason : "update cancelled", reason.length() > 0);
}

bool lightweaverFirmwareUpdateActive() {
  const FirmwareUpdatePhase phase = g_transfer.phase();
  return phase == FirmwareUpdatePhase::Preflighted ||
      phase == FirmwareUpdatePhase::Receiving ||
      phase == FirmwareUpdatePhase::Verifying ||
      phase == FirmwareUpdatePhase::PendingReboot;
}

bool lightweaverFirmwareUpdateOutputHeld() {
  const FirmwareUpdatePhase phase = g_transfer.phase();
  return phase == FirmwareUpdatePhase::Receiving ||
      phase == FirmwareUpdatePhase::Verifying ||
      phase == FirmwareUpdatePhase::PendingReboot;
}

String lightweaverFirmwareUpdateStatusJson() {
  JsonDocument doc;
  doc["phase"] = phaseLabel(g_status.phase);
  doc["receivedBytes"] = g_status.receivedBytes;
  doc["expectedBytes"] = g_status.expectedBytes;
  doc["expectedBuildId"] = g_status.expectedBuildId;
  doc["activeSlot"] = g_status.activeSlot;
  doc["pendingSlot"] = g_status.pendingSlot;
  doc["lastError"] = g_status.lastError;
  doc["rollbackReason"] = g_status.rollbackReason;
  doc["rebootCorrelation"] = g_status.rebootCorrelation;
  doc["restoredFirmwareVersion"] = g_status.restoredFirmwareVersion;
  doc["restoredBuildId"] = g_status.restoredBuildId;
  doc["restoredBuildNumber"] = g_status.restoredBuildNumber;
  String body; serializeJson(doc, body); return body;
}

void lightweaverFirmwareUpdateSetBootEvidence(FirmwareUpdatePhase phase,
                                               const String& rollbackReason,
                                               const String& rebootCorrelation,
                                               const String& restoredFirmwareVersion,
                                               const String& restoredBuildId,
                                               uint32_t restoredBuildNumber) {
  g_status.phase = phase;
  g_status.rollbackReason = rollbackReason;
  g_status.rebootCorrelation = rebootCorrelation;
  g_status.restoredFirmwareVersion = restoredFirmwareVersion;
  g_status.restoredBuildId = restoredBuildId;
  g_status.restoredBuildNumber = restoredBuildNumber;
  g_status.activeSlot = partitionLabel(esp_ota_get_running_partition());
  g_status.pendingSlot = String();
}
#else
void registerLightweaverFirmwareUpdate(WebServer&) {}
void handleLightweaverFirmwareUpdate() {}
void cancelLightweaverFirmwareUpdate(const String&) {}
bool lightweaverFirmwareUpdateActive() { return false; }
bool lightweaverFirmwareUpdateOutputHeld() { return false; }
String lightweaverFirmwareUpdateStatusJson() { return "{\"phase\":\"idle\"}"; }
void lightweaverFirmwareUpdateSetBootEvidence(FirmwareUpdatePhase, const String&,
    const String&, const String&, const String&, uint32_t) {}
#endif
