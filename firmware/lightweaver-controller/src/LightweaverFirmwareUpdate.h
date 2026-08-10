#pragma once

#include <Arduino.h>

class WebServer;

static constexpr uint32_t LW_FIRMWARE_UPDATE_VERSION = 1;
static constexpr size_t LW_FIRMWARE_UPDATE_TICKET_MAX_BYTES = 4096;
static constexpr size_t LW_FIRMWARE_UPDATE_SIGNATURE_BYTES = 64;
static constexpr size_t LW_FIRMWARE_UPDATE_MAX_CHUNK_BYTES = 32768;
static constexpr size_t LW_FIRMWARE_UPDATE_HTTP_MAX_BODY_BYTES = 49152;
static constexpr uint32_t LW_FIRMWARE_UPDATE_LEASE_TTL_MS = 15000;
static constexpr uint32_t LW_FIRMWARE_UPDATE_REBOOT_DELAY_MS = 750;
static constexpr uint32_t LW_FIRMWARE_UPDATE_RATE_WINDOW_MS = 1000;
// One maximum-size image takes at most 200 chunks. This permits one complete
// transfer burst while bounding mutation work per client-visible time window.
static constexpr uint32_t LW_FIRMWARE_UPDATE_RATE_MAX_MUTATIONS = 256;

enum class FirmwareUpdatePhase : uint8_t {
  Idle,
  Preflighted,
  Receiving,
  Verifying,
  PendingReboot,
  Probation,
  Valid,
  RolledBack,
  Failed,
};

enum class FirmwareUpdateResult : uint8_t {
  Accepted,
  InvalidState,
  InvalidTicket,
  SignatureRejected,
  CompatibilityRejected,
  AuthorityRejected,
  PhysicalConfirmationRequired,
  ConcurrentMutation,
  BindingMismatch,
  LeaseMismatch,
  LeaseExpired,
  SequenceMismatch,
  OffsetMismatch,
  ChunkTooLarge,
  SizeMismatch,
  DigestMismatch,
  ImageRejected,
  PlatformFailure,
  RateLimited,
};

struct FirmwareUpdateBinding {
  String cardId;
  String bootId;
  String ownerSessionId;
  uint32_t operationGeneration = 0;
  String expectedProjectHead;
  String releaseBuildId;
  String ticketSha256;
};

struct FirmwareUpdateStatus {
  FirmwareUpdatePhase phase = FirmwareUpdatePhase::Idle;
  size_t receivedBytes = 0;
  size_t expectedBytes = 0;
  String expectedBuildId;
  String activeSlot;
  String pendingSlot;
  String lastError;
  String rollbackReason;
  String rebootCorrelation;
  String restoredFirmwareVersion;
  String restoredBuildId;
  uint32_t restoredBuildNumber = 0;
};

class LightweaverFirmwareUpdateMutationRate {
 public:
  bool allow(uint32_t nowMs) {
    if (!initialized_ || nowMs - windowStartedAtMs_ >= LW_FIRMWARE_UPDATE_RATE_WINDOW_MS) {
      initialized_ = true;
      windowStartedAtMs_ = nowMs;
      mutationCount_ = 0;
    }
    if (mutationCount_ >= LW_FIRMWARE_UPDATE_RATE_MAX_MUTATIONS) return false;
    mutationCount_++;
    return true;
  }

 private:
  bool initialized_ = false;
  uint32_t windowStartedAtMs_ = 0;
  uint32_t mutationCount_ = 0;
};

// Pure ownership/ordering policy. The ESP-IDF adapter below uses this same
// seam, while host contracts exercise it without pretending to write flash.
class LightweaverFirmwareTransferState {
 public:
  FirmwareUpdateResult preflight(const FirmwareUpdateBinding& binding,
                                 size_t expectedBytes, uint32_t nowMs) {
    if (phase_ != FirmwareUpdatePhase::Idle || !completeBinding(binding) ||
        expectedBytes == 0 || expectedBytes > 0x640000) {
      return fail(FirmwareUpdateResult::InvalidState);
    }
    binding_ = binding;
    expectedBytes_ = expectedBytes;
    receivedBytes_ = 0;
    nextSequence_ = 1;
    nextOffset_ = 0;
    leaseExpiresAtMs_ = nowMs + LW_FIRMWARE_UPDATE_LEASE_TTL_MS;
    phase_ = FirmwareUpdatePhase::Preflighted;
    return FirmwareUpdateResult::Accepted;
  }

  FirmwareUpdateResult begin(const FirmwareUpdateBinding& binding,
                             const String& leaseId, uint32_t nowMs) {
    if (phase_ != FirmwareUpdatePhase::Preflighted)
      return fail(FirmwareUpdateResult::InvalidState);
    if (!sameBinding(binding_, binding))
      return fail(FirmwareUpdateResult::BindingMismatch);
    if (!leaseId.length()) return fail(FirmwareUpdateResult::LeaseMismatch);
    leaseId_ = leaseId;
    leaseExpiresAtMs_ = nowMs + LW_FIRMWARE_UPDATE_LEASE_TTL_MS;
    phase_ = FirmwareUpdatePhase::Receiving;
    return FirmwareUpdateResult::Accepted;
  }

  FirmwareUpdateResult acceptChunk(const FirmwareUpdateBinding& binding,
                                   const String& leaseId, uint32_t sequence,
                                   size_t offset, size_t size,
                                   uint32_t nowMs) {
    FirmwareUpdateResult lease = validateLease(binding, leaseId, nowMs);
    if (lease != FirmwareUpdateResult::Accepted) return lease;
    if (size == 0 || size > LW_FIRMWARE_UPDATE_MAX_CHUNK_BYTES)
      return fail(FirmwareUpdateResult::ChunkTooLarge);
    if (sequence != nextSequence_)
      return fail(FirmwareUpdateResult::SequenceMismatch);
    if (offset != nextOffset_)
      return fail(FirmwareUpdateResult::OffsetMismatch);
    if (size > expectedBytes_ - receivedBytes_)
      return fail(FirmwareUpdateResult::SizeMismatch);
    receivedBytes_ += size;
    nextOffset_ += size;
    nextSequence_++;
    if (nextSequence_ == 0) return fail(FirmwareUpdateResult::SequenceMismatch);
    leaseExpiresAtMs_ = nowMs + LW_FIRMWARE_UPDATE_LEASE_TTL_MS;
    return FirmwareUpdateResult::Accepted;
  }

  FirmwareUpdateResult readyToCommit(const FirmwareUpdateBinding& binding,
                                     const String& leaseId,
                                     uint32_t nowMs) {
    FirmwareUpdateResult lease = validateLease(binding, leaseId, nowMs);
    if (lease != FirmwareUpdateResult::Accepted) return lease;
    if (receivedBytes_ != expectedBytes_)
      return fail(FirmwareUpdateResult::SizeMismatch);
    phase_ = FirmwareUpdatePhase::Verifying;
    return FirmwareUpdateResult::Accepted;
  }

  bool expire(uint32_t nowMs) {
    if ((phase_ == FirmwareUpdatePhase::Preflighted ||
         phase_ == FirmwareUpdatePhase::Receiving) &&
        static_cast<int32_t>(nowMs - leaseExpiresAtMs_) > 0) {
      fail(FirmwareUpdateResult::LeaseExpired);
      return true;
    }
    return false;
  }

  void markPendingReboot() { phase_ = FirmwareUpdatePhase::PendingReboot; }
  void markFailed() { phase_ = FirmwareUpdatePhase::Failed; }
  void reset() {
    binding_ = FirmwareUpdateBinding{};
    leaseId_ = String();
    expectedBytes_ = receivedBytes_ = nextOffset_ = 0;
    nextSequence_ = 1;
    leaseExpiresAtMs_ = 0;
    phase_ = FirmwareUpdatePhase::Idle;
  }

  FirmwareUpdatePhase phase() const { return phase_; }
  size_t expectedBytes() const { return expectedBytes_; }
  size_t receivedBytes() const { return receivedBytes_; }
  uint32_t nextSequence() const { return nextSequence_; }
  size_t nextOffset() const { return nextOffset_; }
  const FirmwareUpdateBinding& binding() const { return binding_; }

 private:
  static bool completeBinding(const FirmwareUpdateBinding& value) {
    return value.cardId.length() && value.bootId.length() &&
        value.ownerSessionId.length() && value.operationGeneration != 0 &&
        value.releaseBuildId.length() && value.ticketSha256.length();
  }
  static bool sameBinding(const FirmwareUpdateBinding& left,
                          const FirmwareUpdateBinding& right) {
    return left.cardId == right.cardId && left.bootId == right.bootId &&
        left.ownerSessionId == right.ownerSessionId &&
        left.operationGeneration == right.operationGeneration &&
        left.expectedProjectHead == right.expectedProjectHead &&
        left.releaseBuildId == right.releaseBuildId &&
        left.ticketSha256 == right.ticketSha256;
  }
  FirmwareUpdateResult validateLease(const FirmwareUpdateBinding& binding,
                                     const String& leaseId,
                                     uint32_t nowMs) {
    if (phase_ != FirmwareUpdatePhase::Receiving)
      return fail(FirmwareUpdateResult::InvalidState);
    if (static_cast<int32_t>(nowMs - leaseExpiresAtMs_) > 0)
      return fail(FirmwareUpdateResult::LeaseExpired);
    if (!sameBinding(binding_, binding))
      return fail(FirmwareUpdateResult::BindingMismatch);
    if (!(leaseId_ == leaseId))
      return fail(FirmwareUpdateResult::LeaseMismatch);
    return FirmwareUpdateResult::Accepted;
  }
  FirmwareUpdateResult fail(FirmwareUpdateResult result) {
    phase_ = FirmwareUpdatePhase::Failed;
    return result;
  }

  FirmwareUpdateBinding binding_;
  String leaseId_;
  FirmwareUpdatePhase phase_ = FirmwareUpdatePhase::Idle;
  size_t expectedBytes_ = 0;
  size_t receivedBytes_ = 0;
  size_t nextOffset_ = 0;
  uint32_t nextSequence_ = 1;
  uint32_t leaseExpiresAtMs_ = 0;
};

void registerLightweaverFirmwareUpdate(WebServer& server);
void handleLightweaverFirmwareUpdate();
void cancelLightweaverFirmwareUpdate(const String& reason = String());
bool lightweaverFirmwareUpdateActive();
bool lightweaverFirmwareUpdateOutputHeld();
String lightweaverFirmwareUpdateStatusJson();
void lightweaverFirmwareUpdateSetBootEvidence(FirmwareUpdatePhase phase,
                                               const String& rollbackReason,
                                               const String& rebootCorrelation,
                                               const String& restoredFirmwareVersion = String(),
                                               const String& restoredBuildId = String(),
                                               uint32_t restoredBuildNumber = 0);
