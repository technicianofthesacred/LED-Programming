#include "LightweaverCardStudio.h"

#include <Arduino.h>

#if __has_include("LightweaverCardStudioBundle.h")
#include "LightweaverCardStudioBundle.h"
#define LW_CARD_STUDIO_GENERATED_BUNDLE_PRESENT 1
#else
// Compile-safe placeholder ABI. Tooling replaces this branch by generating
// LightweaverCardStudioBundle.h; a firmware built without it deliberately
// leaves /studio/ on the existing small recovery/card page.
struct LightweaverCardStudioAsset {
  const char* path; const char* contentType; const char* contentEncoding;
  const uint8_t* bytes; size_t compressedSize; size_t uncompressedSize;
  const char* compressedSha256; bool immutable;
};
static constexpr char LW_CARD_STUDIO_BUILD_ID[] = "";
static constexpr uint32_t LW_CARD_STUDIO_BUILD_NUMBER = 0;
static constexpr uint32_t LW_CARD_STUDIO_PROJECT_SCHEMA_MIN = 0;
static constexpr uint32_t LW_CARD_STUDIO_PROJECT_SCHEMA_MAX = 0;
static constexpr uint32_t LW_CARD_STUDIO_FIRMWARE_API_MIN = 0;
static constexpr uint32_t LW_CARD_STUDIO_FIRMWARE_API_MAX = 0;
static constexpr size_t LW_CARD_STUDIO_TOTAL_SIZE = 0;
static constexpr char LW_CARD_STUDIO_BUNDLE_SHA256[] = "";
static constexpr size_t LW_CARD_STUDIO_ASSET_COUNT = 0;
static constexpr LightweaverCardStudioAsset LW_CARD_STUDIO_ASSETS[] = {};
#define LW_CARD_STUDIO_GENERATED_BUNDLE_PRESENT 0
#endif

#if defined(ARDUINO_ARCH_ESP32)
#include <ArduinoJson.h>
#include <WebServer.h>
#include <mbedtls/sha256.h>
#include <pgmspace.h>

#ifndef LW_CONFIG_SCHEMA_VERSION
#define LW_CONFIG_SCHEMA_VERSION 1
#endif
#ifndef LW_CAPABILITIES_VERSION
#define LW_CAPABILITIES_VERSION 1
#endif

namespace {
WebServer* g_cardStudioServer = nullptr;
bool g_cardStudioMutationsEnabled = false;
const char* g_cardStudioValidationError = "card Studio bundle not validated";

bool shaMetadataValid(const char* value) {
  if (!value || strlen(value) != 64) return false;
  for (size_t index = 0; index < 64; index++) {
    const char c = value[index];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

bool compressedAssetHashValid(const LightweaverCardStudioAsset& asset) {
  if (!asset.bytes || !asset.compressedSize || !shaMetadataValid(asset.compressedSha256)) return false;
  mbedtls_sha256_context context; mbedtls_sha256_init(&context); mbedtls_sha256_starts_ret(&context, 0);
  uint8_t buffer[512];
  for (size_t offset = 0; offset < asset.compressedSize;) {
    const size_t count = min(sizeof(buffer), asset.compressedSize - offset);
    for (size_t index = 0; index < count; index++) buffer[index] = pgm_read_byte(asset.bytes + offset + index);
    mbedtls_sha256_update_ret(&context, buffer, count); offset += count;
    delay(0);
  }
  uint8_t digest[32] = {}; mbedtls_sha256_finish_ret(&context, digest); mbedtls_sha256_free(&context);
  static const char* digits = "0123456789abcdef";
  char hex[65] = {};
  for (size_t index = 0; index < 32; index++) { hex[index * 2] = digits[digest[index] >> 4]; hex[index * 2 + 1] = digits[digest[index] & 0x0f]; }
  return strcmp(hex, asset.compressedSha256) == 0;
}

bool validateBundle() {
  if (!LW_CARD_STUDIO_GENERATED_BUNDLE_PRESENT) { g_cardStudioValidationError = "card Studio bundle missing"; return false; }
  if (!LW_CARD_STUDIO_BUILD_ID[0] || LW_CARD_STUDIO_BUILD_NUMBER == 0) { g_cardStudioValidationError = "card Studio build identity missing"; return false; }
  if (LW_CONFIG_SCHEMA_VERSION < LW_CARD_STUDIO_PROJECT_SCHEMA_MIN ||
      LW_CONFIG_SCHEMA_VERSION > LW_CARD_STUDIO_PROJECT_SCHEMA_MAX) { g_cardStudioValidationError = "card Studio project schema incompatible"; return false; }
  if (LW_CAPABILITIES_VERSION < LW_CARD_STUDIO_FIRMWARE_API_MIN ||
      LW_CAPABILITIES_VERSION > LW_CARD_STUDIO_FIRMWARE_API_MAX) { g_cardStudioValidationError = "card Studio firmware API incompatible"; return false; }
  if (!LW_CARD_STUDIO_ASSET_COUNT || !LW_CARD_STUDIO_TOTAL_SIZE ||
      !shaMetadataValid(LW_CARD_STUDIO_BUNDLE_SHA256)) { g_cardStudioValidationError = "card Studio bundle metadata damaged"; return false; }
  size_t total = 0; bool hasIndex = false;
  for (size_t index = 0; index < LW_CARD_STUDIO_ASSET_COUNT; index++) {
    const auto& asset = LW_CARD_STUDIO_ASSETS[index];
    if (!asset.path || strncmp(asset.path, "/studio/", 8) != 0 || !asset.contentType ||
        !asset.contentEncoding || strcmp(asset.contentEncoding, "br") != 0 ||
        !asset.uncompressedSize || !compressedAssetHashValid(asset)) {
      g_cardStudioValidationError = "card Studio asset hash/readback failed"; return false;
    }
    total += asset.compressedSize;
    if (strcmp(asset.path, "/studio/") == 0 || strcmp(asset.path, "/studio/index.html") == 0) hasIndex = true;
  }
  if (!hasIndex || total != LW_CARD_STUDIO_TOTAL_SIZE) { g_cardStudioValidationError = "card Studio asset table incomplete"; return false; }
  g_cardStudioValidationError = "";
  return true;
}

void sendCardStudioAsset(size_t index) {
  if (!g_cardStudioMutationsEnabled || index >= LW_CARD_STUDIO_ASSET_COUNT) {
    g_cardStudioServer->sendHeader("Location", "/");
    g_cardStudioServer->sendHeader("Cache-Control", "no-store");
    g_cardStudioServer->send(302, "text/plain", "Open the Lightweaver recovery page");
    return;
  }
  const auto& asset = LW_CARD_STUDIO_ASSETS[index];
  g_cardStudioServer->sendHeader("Content-Encoding", asset.contentEncoding);
  g_cardStudioServer->sendHeader("Vary", "Accept-Encoding");
  g_cardStudioServer->sendHeader("Cache-Control", asset.immutable
      ? "public, max-age=31536000, immutable" : "no-store, no-cache, must-revalidate");
  g_cardStudioServer->send_P(200, asset.contentType,
      reinterpret_cast<const char*>(asset.bytes), asset.compressedSize);
}

void sendCardStudioRelease() {
  g_cardStudioServer->sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  JsonDocument doc; doc["app"] = "LightweaverCardStudio"; doc["buildId"] = LW_CARD_STUDIO_BUILD_ID;
  doc["buildNumber"] = LW_CARD_STUDIO_BUILD_NUMBER; doc["projectSchemaMin"] = LW_CARD_STUDIO_PROJECT_SCHEMA_MIN;
  doc["projectSchemaMax"] = LW_CARD_STUDIO_PROJECT_SCHEMA_MAX; doc["firmwareApiMin"] = LW_CARD_STUDIO_FIRMWARE_API_MIN;
  doc["firmwareApiMax"] = LW_CARD_STUDIO_FIRMWARE_API_MAX; doc["totalSize"] = LW_CARD_STUDIO_TOTAL_SIZE;
  doc["bundleSha256"] = LW_CARD_STUDIO_BUNDLE_SHA256; doc["mutationsEnabled"] = g_cardStudioMutationsEnabled;
  String body; serializeJson(doc, body); g_cardStudioServer->send(200, "application/json", body);
}

void sendCardStudioFallback() {
  // Missing/damaged/incompatible bundles preserve the existing small card and
  // recovery page, including safe pattern, brightness, blackout, recovery,
  // and the legacy bridge. /studio/ simply returns the owner to that surface.
  g_cardStudioServer->sendHeader("Location", "/");
  g_cardStudioServer->sendHeader("Cache-Control", "no-store");
  g_cardStudioServer->send(302, "text/plain", g_cardStudioValidationError);
}
}

void registerLightweaverCardStudio(WebServer& server) {
  g_cardStudioServer = &server;
  g_cardStudioMutationsEnabled = validateBundle();
  server.on("/studio/card-studio-release.json", HTTP_GET, sendCardStudioRelease);
  if (!g_cardStudioMutationsEnabled) {
    server.on("/studio/", HTTP_GET, sendCardStudioFallback);
    server.on("/studio/index.html", HTTP_GET, sendCardStudioFallback);
    return;
  }
  for (size_t index = 0; index < LW_CARD_STUDIO_ASSET_COUNT; index++) {
    server.on(LW_CARD_STUDIO_ASSETS[index].path, HTTP_GET, [index]() { sendCardStudioAsset(index); });
  }
}

bool lightweaverCardStudioMutationsEnabled() { return g_cardStudioMutationsEnabled; }
const char* lightweaverCardStudioValidationError() { return g_cardStudioValidationError; }
#else
void registerLightweaverCardStudio(WebServer&) {}
bool lightweaverCardStudioMutationsEnabled() { return false; }
const char* lightweaverCardStudioValidationError() { return "card Studio unsupported"; }
#endif
