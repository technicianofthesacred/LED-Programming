#pragma once

#include <Arduino.h>

static constexpr uint8_t LW_UPDATE_GRANT_SCHEMA_VERSION = 1;
static constexpr uint32_t LW_UPDATE_GRANT_TTL_MS = 60000;
static constexpr size_t LW_UPDATE_GRANT_NONCE_BYTES = 32;
static constexpr size_t LW_UPDATE_GRANT_SIGNATURE_BYTES = 64;
static constexpr size_t LW_UPDATE_GRANT_MAX_PAYLOAD_BYTES = 1024;

struct FirmwareUpdateGrantBinding {
  String cardId;
  String bootId;
  String expectedProjectHead;
  String allowedOrigin;
  String host;
  String networkIdentity;
  String ownerSessionId;
  uint32_t operationGeneration = 0;
  String releaseBuildId;
  String ticketSha256;
};

enum class FirmwareUpdateGrantResult : uint8_t {
  Accepted,
  Missing,
  Expired,
  BindingMismatch,
  PayloadMismatch,
  SignatureRejected,
  CapabilityMismatch,
};

using FirmwareUpdateGrantVerifier = bool (*)(
    const uint8_t* payload, size_t payloadLength,
    const uint8_t* signature, size_t signatureLength);

class LightweaverFirmwareUpdateGrant {
 public:
  bool issueChallenge(const FirmwareUpdateGrantBinding& binding,
                      const uint8_t nonce[LW_UPDATE_GRANT_NONCE_BYTES],
                      uint32_t nowMs, uint8_t* payload, size_t payloadCapacity,
                      size_t& payloadLength);
  FirmwareUpdateGrantResult consumeSignedGrant(
      const uint8_t* payload, size_t payloadLength,
      const uint8_t* signature, size_t signatureLength,
      FirmwareUpdateGrantVerifier verifier,
      const FirmwareUpdateGrantBinding& binding,
      const String& capabilityToken, uint32_t nowMs);
  FirmwareUpdateGrantResult validateCapability(
      const String& capabilityToken,
      const FirmwareUpdateGrantBinding& binding, uint32_t nowMs);
  void revokeChallenge();
  void revokeCapability();
  void revokeAll();
  bool expire(uint32_t nowMs);

 private:
  static bool sameBinding(const FirmwareUpdateGrantBinding& left,
                          const FirmwareUpdateGrantBinding& right);
  static bool completeBinding(const FirmwareUpdateGrantBinding& binding);

  FirmwareUpdateGrantBinding challengeBinding_;
  uint8_t challengePayload_[LW_UPDATE_GRANT_MAX_PAYLOAD_BYTES] = {};
  size_t challengePayloadLength_ = 0;
  uint32_t challengeExpiresAtMs_ = 0;
  bool challengeIssued_ = false;

  FirmwareUpdateGrantBinding capabilityBinding_;
  String capabilityToken_;
  uint32_t capabilityExpiresAtMs_ = 0;
  bool capabilityIssued_ = false;
};

bool verifyLightweaverUpdateGrantSignature(
    const uint8_t* payload, size_t payloadLength,
    const uint8_t* signature, size_t signatureLength);
void lightweaverUpdateGrantRandom(uint8_t* output, size_t outputLength);
LightweaverFirmwareUpdateGrant& lightweaverFirmwareUpdateGrant();
