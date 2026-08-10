#pragma once

#include <cstdint>

namespace lightweaver {

static constexpr uint32_t kFirmwareBootProbationMs = 30000;

enum class FirmwareBootDecision : uint8_t {
  NotPending,
  Wait,
  MarkValid,
  Rollback,
};

enum class FirmwareBootHandoffOutcome : uint8_t {
  Empty = 0,
  Armed = 1,
  Valid = 2,
  RollbackRequested = 3,
};

enum class FirmwareBootEvidenceDecision : uint8_t {
  None,
  Valid,
  RolledBack,
};

inline FirmwareBootEvidenceDecision evaluateFirmwareBootHandoffEvidence(
    bool recordValid, FirmwareBootHandoffOutcome outcome,
    bool expectedBuildMatchesCurrent) {
  if (!recordValid) return FirmwareBootEvidenceDecision::None;
  if (outcome == FirmwareBootHandoffOutcome::RollbackRequested ||
      (outcome == FirmwareBootHandoffOutcome::Armed &&
       !expectedBuildMatchesCurrent)) {
    return FirmwareBootEvidenceDecision::RolledBack;
  }
  if (outcome == FirmwareBootHandoffOutcome::Valid)
    return FirmwareBootEvidenceDecision::Valid;
  return FirmwareBootEvidenceDecision::None;
}

struct FirmwareBootHealthFacts {
  bool pendingVerification = false;
  bool compiledIdentityMatches = false;
  bool nvsReadable = false;
  bool projectStorageReadable = false;
  bool savedConfigReadable = false;
  bool projectHeadReadable = false;
  bool rendererReady = false;
  bool controlsReady = false;
  bool webReady = false;
  bool watchdogReady = false;
  bool outputReady = false;
  bool recoveryReady = false;
  bool withinDeadline = false;

  // Deliberately ignored by the decision. A healthy card remains valid while
  // the router, mDNS, public Studio, or browser is offline.
  bool routerReachable = false;
  bool mdnsReady = false;
  bool browserConnected = false;
};

struct FirmwareBootHealthDecision {
  FirmwareBootDecision decision = FirmwareBootDecision::NotPending;
  const char* reason = "not-pending";
  FirmwareBootHealthDecision(FirmwareBootDecision value, const char* detail)
      : decision(value), reason(detail) {}
};

inline FirmwareBootHealthDecision evaluateFirmwareBootHealth(
    const FirmwareBootHealthFacts& facts) {
  if (!facts.pendingVerification)
    return {FirmwareBootDecision::NotPending, "not-pending"};
  if (!facts.withinDeadline)
    return {FirmwareBootDecision::Rollback, "probation-deadline-expired"};
  if (!facts.compiledIdentityMatches)
    return {FirmwareBootDecision::Rollback, "compiled-identity-mismatch"};
  if (!facts.nvsReadable)
    return {FirmwareBootDecision::Rollback, "nvs-unreadable"};
  if (!facts.projectStorageReadable)
    return {FirmwareBootDecision::Rollback, "project-storage-unreadable"};
  if (!facts.savedConfigReadable)
    return {FirmwareBootDecision::Rollback, "saved-config-unreadable"};
  if (!facts.projectHeadReadable)
    return {FirmwareBootDecision::Rollback, "project-head-unreadable"};
  if (!facts.rendererReady)
    return {FirmwareBootDecision::Rollback, "renderer-not-ready"};
  if (!facts.controlsReady)
    return {FirmwareBootDecision::Rollback, "controls-not-ready"};
  if (!facts.webReady)
    return {FirmwareBootDecision::Rollback, "card-api-not-ready"};
  if (!facts.watchdogReady)
    return {FirmwareBootDecision::Rollback, "watchdog-not-ready"};
  if (!facts.outputReady)
    return {FirmwareBootDecision::Rollback, "output-not-ready"};
  if (!facts.recoveryReady)
    return {FirmwareBootDecision::Rollback, "recovery-controls-not-ready"};
  return {FirmwareBootDecision::MarkValid, "local-health-confirmed"};
}

}  // namespace lightweaver

bool beginLightweaverFirmwareBootHealth();
bool lightweaverFirmwareBootProbationActive();
bool armLightweaverFirmwareBootHealth(const char* expectedBuildId,
                                      const char* expectedProjectHead,
                                      const char* rebootCorrelation);
void cancelLightweaverFirmwareBootHealthHandoff();
bool confirmLightweaverFirmwareBootHealth(
    bool nvsReadable, bool projectStorageReadable, bool savedConfigReadable,
    bool projectHeadReadable, bool rendererReady, bool controlsReady,
    bool webReady, bool watchdogReady, bool outputReady, bool recoveryReady,
    const char* currentProjectHead);
void handleLightweaverFirmwareBootHealth();
