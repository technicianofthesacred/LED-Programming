#include "LightweaverFirmwareBootHealth.h"

#if defined(ARDUINO_ARCH_ESP32)
#include <Arduino.h>
#include <esp_attr.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <cstring>

#include "LightweaverFirmwareUpdate.h"

#ifndef LW_BUILD_ID
#define LW_BUILD_ID "dev"
#endif
#ifndef LW_FIRMWARE_VERSION
#define LW_FIRMWARE_VERSION "1.0.0"
#endif
#ifndef LW_BUILD_NUMBER
#define LW_BUILD_NUMBER 0
#endif

namespace {
constexpr uint32_t LW_BOOT_HANDOFF_MAGIC = 0x4c574f54;  // LWOT
constexpr uint16_t LW_BOOT_HANDOFF_VERSION = 1;

struct BootHandoffRecord {
  uint32_t magic;
  uint16_t version;
  uint8_t outcome;
  uint8_t reserved;
  char expectedBuildId[41];
  char expectedProjectHead[65];
  char rebootCorrelation[48];
  char reason[64];
  uint32_t checksum;
};

// The handoff intentionally lives only in RTC memory: normal software resets
// preserve the rollback diagnosis without writing NVS or project storage. A
// total power loss clears that diagnostic correlation, although the bootloader
// still preserves active-slot safety and rolls back an unconfirmed image.
RTC_NOINIT_ATTR BootHandoffRecord g_bootHandoff;
bool g_probationActive = false;
uint32_t g_probationStartedAtMs = 0;

uint32_t handoffChecksum(const BootHandoffRecord& record) {
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&record);
  const size_t length = offsetof(BootHandoffRecord, checksum);
  uint32_t hash = 2166136261U;
  for (size_t index = 0; index < length; index++) {
    hash ^= bytes[index];
    hash *= 16777619U;
  }
  return hash;
}

bool validHandoff() {
  return g_bootHandoff.magic == LW_BOOT_HANDOFF_MAGIC &&
      g_bootHandoff.version == LW_BOOT_HANDOFF_VERSION &&
      g_bootHandoff.checksum == handoffChecksum(g_bootHandoff) &&
      g_bootHandoff.expectedBuildId[40] == '\0' &&
      g_bootHandoff.expectedProjectHead[64] == '\0' &&
      g_bootHandoff.rebootCorrelation[47] == '\0' &&
      g_bootHandoff.reason[63] == '\0';
}

void sealHandoff() { g_bootHandoff.checksum = handoffChecksum(g_bootHandoff); }

void setReason(const char* reason) {
  snprintf(g_bootHandoff.reason, sizeof(g_bootHandoff.reason), "%s",
           reason ? reason : "firmware probation failed");
  sealHandoff();
}

void rollbackAndReboot(const char* reason) {
  if (validHandoff()) {
    g_bootHandoff.outcome = static_cast<uint8_t>(
        lightweaver::FirmwareBootHandoffOutcome::RollbackRequested);
    setReason(reason);
  }
  lightweaverFirmwareUpdateSetBootEvidence(FirmwareUpdatePhase::RolledBack,
      String(reason), validHandoff() ? String(g_bootHandoff.rebootCorrelation) : String());
  delay(20);
  esp_ota_mark_app_invalid_rollback_and_reboot();
  ESP.restart();  // Fail closed even if the IDF call unexpectedly returns.
}
}

bool armLightweaverFirmwareBootHealth(const char* expectedBuildId,
                                      const char* expectedProjectHead,
                                      const char* rebootCorrelation) {
  if (!expectedBuildId || strlen(expectedBuildId) != 40 ||
      !rebootCorrelation || !*rebootCorrelation ||
      (expectedProjectHead && strlen(expectedProjectHead) > 64)) return false;
  memset(&g_bootHandoff, 0, sizeof(g_bootHandoff));
  g_bootHandoff.magic = LW_BOOT_HANDOFF_MAGIC;
  g_bootHandoff.version = LW_BOOT_HANDOFF_VERSION;
  g_bootHandoff.outcome = static_cast<uint8_t>(
      lightweaver::FirmwareBootHandoffOutcome::Armed);
  snprintf(g_bootHandoff.expectedBuildId, sizeof(g_bootHandoff.expectedBuildId),
           "%s", expectedBuildId);
  snprintf(g_bootHandoff.expectedProjectHead, sizeof(g_bootHandoff.expectedProjectHead),
           "%s", expectedProjectHead ? expectedProjectHead : "");
  snprintf(g_bootHandoff.rebootCorrelation, sizeof(g_bootHandoff.rebootCorrelation),
           "%s", rebootCorrelation);
  setReason("awaiting-new-slot-health");
  return validHandoff();
}

void cancelLightweaverFirmwareBootHealthHandoff() {
  memset(&g_bootHandoff, 0, sizeof(g_bootHandoff));
}

bool beginLightweaverFirmwareBootHealth() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  const bool pending = running &&
      esp_ota_get_state_partition(running, &state) == ESP_OK &&
      state == ESP_OTA_IMG_PENDING_VERIFY;
  if (pending) {
    g_probationActive = true;
    g_probationStartedAtMs = millis();
    lightweaverFirmwareUpdateSetBootEvidence(FirmwareUpdatePhase::Probation,
        String(), validHandoff() ? String(g_bootHandoff.rebootCorrelation) : String());
    return true;
  }

  g_probationActive = false;
  const bool handoffValid = validHandoff();
  const auto handoffOutcome = static_cast<lightweaver::FirmwareBootHandoffOutcome>(
      g_bootHandoff.outcome);
  const auto evidence = lightweaver::evaluateFirmwareBootHandoffEvidence(
      handoffValid, handoffOutcome,
      handoffValid && strcmp(g_bootHandoff.expectedBuildId, LW_BUILD_ID) == 0);
  if (evidence == lightweaver::FirmwareBootEvidenceDecision::RolledBack) {
    const esp_partition_t* invalid = esp_ota_get_last_invalid_partition();
    if (handoffOutcome == lightweaver::FirmwareBootHandoffOutcome::Armed) {
      const char* reason = invalid ? "new-slot-reset-before-health-confirmation"
                                   : "new-slot-rollback-detected";
      g_bootHandoff.outcome = static_cast<uint8_t>(
          lightweaver::FirmwareBootHandoffOutcome::RollbackRequested);
      setReason(reason);
    }
    const String restoredFirmwareVersion = LW_FIRMWARE_VERSION;
    lightweaverFirmwareUpdateSetBootEvidence(FirmwareUpdatePhase::RolledBack,
        String(g_bootHandoff.reason), String(g_bootHandoff.rebootCorrelation),
        restoredFirmwareVersion, String(LW_BUILD_ID), LW_BUILD_NUMBER);
  } else if (evidence == lightweaver::FirmwareBootEvidenceDecision::Valid) {
    lightweaverFirmwareUpdateSetBootEvidence(FirmwareUpdatePhase::Valid,
        String(), String(g_bootHandoff.rebootCorrelation));
  }
  return false;
}

bool lightweaverFirmwareBootProbationActive() { return g_probationActive; }

bool confirmLightweaverFirmwareBootHealth(
    bool nvsReadable, bool projectStorageReadable, bool savedConfigReadable,
    bool projectHeadReadable, bool rendererReady, bool controlsReady,
    bool webReady, bool watchdogReady, bool outputReady, bool recoveryReady,
    const char* currentProjectHead) {
  if (!g_probationActive) return true;
  const bool handoffValid = validHandoff();
  const bool identityMatches = handoffValid &&
      strcmp(g_bootHandoff.expectedBuildId, LW_BUILD_ID) == 0;
  const char* currentHead = currentProjectHead ? currentProjectHead : "";
  const bool projectMatches = handoffValid &&
      strcmp(g_bootHandoff.expectedProjectHead, currentHead) == 0;
  const bool withinDeadline =
      millis() - g_probationStartedAtMs <= lightweaver::kFirmwareBootProbationMs;
  lightweaver::FirmwareBootHealthFacts facts{};
  facts.pendingVerification = true;
  facts.compiledIdentityMatches = identityMatches;
  facts.nvsReadable = nvsReadable;
  facts.projectStorageReadable = projectStorageReadable;
  facts.savedConfigReadable = savedConfigReadable;
  facts.projectHeadReadable = projectHeadReadable && projectMatches;
  facts.rendererReady = rendererReady;
  facts.controlsReady = controlsReady;
  facts.webReady = webReady;
  facts.watchdogReady = watchdogReady;
  facts.outputReady = outputReady;
  facts.recoveryReady = recoveryReady;
  facts.withinDeadline = withinDeadline;
  const lightweaver::FirmwareBootHealthDecision decision =
      lightweaver::evaluateFirmwareBootHealth(facts);
  if (decision.decision == lightweaver::FirmwareBootDecision::Rollback) {
    rollbackAndReboot(decision.reason);
    return false;
  }
  if (decision.decision != lightweaver::FirmwareBootDecision::MarkValid ||
      esp_ota_mark_app_valid_cancel_rollback() != ESP_OK) {
    rollbackAndReboot("mark-valid-failed");
    return false;
  }
  g_probationActive = false;
  g_bootHandoff.outcome = static_cast<uint8_t>(
      lightweaver::FirmwareBootHandoffOutcome::Valid);
  setReason("local-health-confirmed");
  lightweaverFirmwareUpdateSetBootEvidence(FirmwareUpdatePhase::Valid,
      String(), String(g_bootHandoff.rebootCorrelation));
  return true;
}

void handleLightweaverFirmwareBootHealth() {
  if (g_probationActive &&
      millis() - g_probationStartedAtMs > lightweaver::kFirmwareBootProbationMs) {
    rollbackAndReboot("probation-deadline-expired");
  }
}
#else
bool beginLightweaverFirmwareBootHealth() { return false; }
bool lightweaverFirmwareBootProbationActive() { return false; }
bool armLightweaverFirmwareBootHealth(const char*, const char*, const char*) { return false; }
void cancelLightweaverFirmwareBootHealthHandoff() {}
bool confirmLightweaverFirmwareBootHealth(bool, bool, bool, bool, bool, bool,
    bool, bool, bool, bool, const char*) { return true; }
void handleLightweaverFirmwareBootHealth() {}
#endif
