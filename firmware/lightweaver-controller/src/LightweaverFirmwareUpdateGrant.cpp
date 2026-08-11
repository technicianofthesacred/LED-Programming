#include "LightweaverFirmwareUpdateGrant.h"

#include <cstdio>
#include <cstring>

namespace {
LightweaverFirmwareUpdateGrant g_updateGrant;

bool expiredAt(uint32_t nowMs, uint32_t expiresAtMs) {
  return static_cast<int32_t>(nowMs - expiresAtMs) > 0;
}

bool constantTimeEqual(const String& left, const String& right) {
  const size_t leftLength = left.length();
  const size_t rightLength = right.length();
  const size_t length = leftLength > rightLength ? leftLength : rightLength;
  uint8_t difference = static_cast<uint8_t>(leftLength ^ rightLength);
  for (size_t index = 0; index < length; index++) {
    const uint8_t leftByte = index < leftLength
        ? static_cast<uint8_t>(left.c_str()[index]) : 0;
    const uint8_t rightByte = index < rightLength
        ? static_cast<uint8_t>(right.c_str()[index]) : 0;
    difference |= leftByte ^ rightByte;
  }
  return difference == 0;
}

class JsonWriter {
 public:
  JsonWriter(uint8_t* output, size_t capacity)
      : output_(output), capacity_(capacity) {}

  bool bytes(const void* source, size_t length) {
    if (!output_ || used_ > capacity_ || length > capacity_ - used_) return false;
    memcpy(output_ + used_, source, length);
    used_ += length;
    return true;
  }
  bool literal(const char* value) { return bytes(value, strlen(value)); }
  bool unsignedNumber(uint32_t value) {
    char encoded[11] = {};
    const int length = snprintf(encoded, sizeof(encoded), "%lu",
                                static_cast<unsigned long>(value));
    return length > 0 && static_cast<size_t>(length) < sizeof(encoded) &&
        bytes(encoded, static_cast<size_t>(length));
  }
  bool string(const String& value) {
    if (!literal("\"")) return false;
    static const char digits[] = "0123456789abcdef";
    for (size_t index = 0; index < value.length(); index++) {
      const uint8_t byte = static_cast<uint8_t>(value.c_str()[index]);
      switch (byte) {
        case '\"': if (!literal("\\\"")) return false; break;
        case '\\': if (!literal("\\\\")) return false; break;
        case '\b': if (!literal("\\b")) return false; break;
        case '\f': if (!literal("\\f")) return false; break;
        case '\n': if (!literal("\\n")) return false; break;
        case '\r': if (!literal("\\r")) return false; break;
        case '\t': if (!literal("\\t")) return false; break;
        default:
          if (byte < 0x20) {
            const char escaped[] = {'\\', 'u', '0', '0',
                digits[byte >> 4], digits[byte & 0x0f]};
            if (!bytes(escaped, sizeof(escaped))) return false;
          } else if (!bytes(&byte, 1)) {
            return false;
          }
      }
    }
    return literal("\"");
  }
  size_t size() const { return used_; }

 private:
  uint8_t* output_;
  size_t capacity_;
  size_t used_ = 0;
};

bool encodeBase64Url(const uint8_t* source, size_t length,
                     char* output, size_t capacity) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const size_t required = (length * 4 + 2) / 3;
  if (!source || !output || capacity <= required) return false;
  size_t input = 0;
  size_t written = 0;
  while (input + 3 <= length) {
    const uint32_t word = (static_cast<uint32_t>(source[input]) << 16) |
        (static_cast<uint32_t>(source[input + 1]) << 8) | source[input + 2];
    output[written++] = alphabet[(word >> 18) & 63];
    output[written++] = alphabet[(word >> 12) & 63];
    output[written++] = alphabet[(word >> 6) & 63];
    output[written++] = alphabet[word & 63];
    input += 3;
  }
  if (input < length) {
    uint32_t word = static_cast<uint32_t>(source[input]) << 16;
    if (input + 1 < length) word |= static_cast<uint32_t>(source[input + 1]) << 8;
    output[written++] = alphabet[(word >> 18) & 63];
    output[written++] = alphabet[(word >> 12) & 63];
    if (input + 1 < length) output[written++] = alphabet[(word >> 6) & 63];
  }
  output[written] = '\0';
  return written == required;
}

bool canonicalPayload(const FirmwareUpdateGrantBinding& binding,
                      const uint8_t nonce[LW_UPDATE_GRANT_NONCE_BYTES],
                      uint8_t* payload,
                      size_t capacity, size_t& length) {
  char challenge[45] = {};
  if (!encodeBase64Url(nonce, LW_UPDATE_GRANT_NONCE_BYTES,
                       challenge, sizeof(challenge))) return false;
  JsonWriter writer(payload, capacity);
  const bool ok = writer.literal("{\"schemaVersion\":1,\"scope\":\"firmware-update\",\"cardId\":") &&
      writer.string(binding.cardId) && writer.literal(",\"bootId\":") &&
      writer.string(binding.bootId) && writer.literal(",\"challenge\":") &&
      writer.string(String(challenge)) && writer.literal(",\"studioOrigin\":") &&
      writer.string(binding.allowedOrigin) && writer.literal(",\"cardHost\":") &&
      writer.string(binding.host) && writer.literal(",\"networkIdentity\":") &&
      writer.string(binding.networkIdentity) && writer.literal(",\"ownerSessionId\":") &&
      writer.string(binding.ownerSessionId) && writer.literal(",\"operationGeneration\":") &&
      writer.unsignedNumber(binding.operationGeneration) &&
      writer.literal(",\"expectedProjectHead\":") &&
      writer.string(binding.expectedProjectHead) && writer.literal(",\"releaseBuildId\":") &&
      writer.string(binding.releaseBuildId) && writer.literal(",\"ticketSha256\":") &&
      writer.string(binding.ticketSha256) && writer.literal("}");
  length = ok ? writer.size() : 0;
  return ok;
}
}

bool LightweaverFirmwareUpdateGrant::sameBinding(
    const FirmwareUpdateGrantBinding& left,
    const FirmwareUpdateGrantBinding& right) {
  return left.cardId == right.cardId && left.bootId == right.bootId &&
      left.expectedProjectHead == right.expectedProjectHead &&
      left.allowedOrigin == right.allowedOrigin && left.host == right.host &&
      left.networkIdentity == right.networkIdentity &&
      left.ownerSessionId == right.ownerSessionId &&
      left.operationGeneration == right.operationGeneration &&
      left.releaseBuildId == right.releaseBuildId &&
      left.ticketSha256 == right.ticketSha256;
}

bool LightweaverFirmwareUpdateGrant::completeBinding(
    const FirmwareUpdateGrantBinding& binding) {
  return binding.cardId.length() && binding.bootId.length() &&
      binding.allowedOrigin.length() && binding.host.length() &&
      binding.networkIdentity.length() && binding.ownerSessionId.length() &&
      binding.operationGeneration != 0 && binding.releaseBuildId.length() == 40 &&
      binding.ticketSha256.length() == 64;
}

bool LightweaverFirmwareUpdateGrant::issueChallenge(
    const FirmwareUpdateGrantBinding& binding,
    const uint8_t nonce[LW_UPDATE_GRANT_NONCE_BYTES], uint32_t nowMs,
    uint8_t* payload, size_t payloadCapacity, size_t& payloadLength) {
  revokeChallenge();
  if (!completeBinding(binding) || !nonce || !payload ||
      payloadCapacity > LW_UPDATE_GRANT_MAX_PAYLOAD_BYTES) return false;
  const uint32_t expiresAtMs = nowMs + LW_UPDATE_GRANT_TTL_MS;
  if (!canonicalPayload(binding, nonce, payload,
                        payloadCapacity, payloadLength)) return false;
  memcpy(challengePayload_, payload, payloadLength);
  challengePayloadLength_ = payloadLength;
  challengeBinding_ = binding;
  challengeExpiresAtMs_ = expiresAtMs;
  challengeIssued_ = true;
  return true;
}

FirmwareUpdateGrantResult LightweaverFirmwareUpdateGrant::consumeSignedGrant(
    const uint8_t* payload, size_t payloadLength,
    const uint8_t* signature, size_t signatureLength,
    FirmwareUpdateGrantVerifier verifier,
    const FirmwareUpdateGrantBinding& binding,
    const String& capabilityToken, uint32_t nowMs) {
  if (!challengeIssued_) return FirmwareUpdateGrantResult::Missing;
  if (expiredAt(nowMs, challengeExpiresAtMs_)) {
    revokeChallenge();
    return FirmwareUpdateGrantResult::Expired;
  }
  if (!sameBinding(challengeBinding_, binding))
    return FirmwareUpdateGrantResult::BindingMismatch;
  if (!payload || payloadLength != challengePayloadLength_ ||
      memcmp(payload, challengePayload_, payloadLength) != 0)
    return FirmwareUpdateGrantResult::PayloadMismatch;
  if (!signature || !verifier ||
      !verifier(payload, payloadLength, signature, signatureLength))
    return FirmwareUpdateGrantResult::SignatureRejected;
  if (!capabilityToken.length())
    return FirmwareUpdateGrantResult::CapabilityMismatch;

  // Consume before exposing authority. This grant can never be replayed, and
  // the resulting bearer is scoped to this class and the firmware updater.
  revokeChallenge();
  capabilityBinding_ = binding;
  capabilityToken_ = capabilityToken;
  capabilityExpiresAtMs_ = nowMs + LW_UPDATE_GRANT_TTL_MS;
  capabilityIssued_ = true;
  return FirmwareUpdateGrantResult::Accepted;
}

FirmwareUpdateGrantResult LightweaverFirmwareUpdateGrant::validateCapability(
    const String& capabilityToken,
    const FirmwareUpdateGrantBinding& binding, uint32_t nowMs) {
  if (!capabilityIssued_) return FirmwareUpdateGrantResult::Missing;
  if (expiredAt(nowMs, capabilityExpiresAtMs_)) {
    revokeCapability();
    return FirmwareUpdateGrantResult::Expired;
  }
  if (!sameBinding(capabilityBinding_, binding)) {
    revokeCapability();
    return FirmwareUpdateGrantResult::BindingMismatch;
  }
  if (!constantTimeEqual(capabilityToken_, capabilityToken))
    return FirmwareUpdateGrantResult::CapabilityMismatch;
  return FirmwareUpdateGrantResult::Accepted;
}

void LightweaverFirmwareUpdateGrant::revokeChallenge() {
  challengeBinding_ = FirmwareUpdateGrantBinding{};
  memset(challengePayload_, 0, sizeof(challengePayload_));
  challengePayloadLength_ = 0;
  challengeExpiresAtMs_ = 0;
  challengeIssued_ = false;
}

void LightweaverFirmwareUpdateGrant::revokeCapability() {
  capabilityBinding_ = FirmwareUpdateGrantBinding{};
  capabilityToken_ = String();
  capabilityExpiresAtMs_ = 0;
  capabilityIssued_ = false;
}

void LightweaverFirmwareUpdateGrant::revokeAll() {
  revokeChallenge();
  revokeCapability();
}

bool LightweaverFirmwareUpdateGrant::expire(uint32_t nowMs) {
  bool changed = false;
  if (challengeIssued_ && expiredAt(nowMs, challengeExpiresAtMs_)) {
    revokeChallenge(); changed = true;
  }
  if (capabilityIssued_ && expiredAt(nowMs, capabilityExpiresAtMs_)) {
    revokeCapability(); changed = true;
  }
  return changed;
}

LightweaverFirmwareUpdateGrant& lightweaverFirmwareUpdateGrant() {
  return g_updateGrant;
}

#if defined(ARDUINO_ARCH_ESP32)
#include <esp_system.h>
#include <mbedtls/ecdsa.h>
#include <mbedtls/pk.h>
#include <mbedtls/sha256.h>

// Dedicated online update-authorization key. It is deliberately distinct from
// the offline release-signing key used by LightweaverFirmwareUpdate.cpp.
constexpr char LIGHTWEAVER_UPDATE_GRANT_PUBLIC_KEY_PEM[] =
    "-----BEGIN PUBLIC KEY-----\n"
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE79R+C1CKiCB9LiaBTnyJAzu85npY\n"
    "+PMDVtnLLfKYk7nB14YtoSehIcyx9ScVPtW9uRQHW9FRZgdhCRAeyd4IWw==\n"
    "-----END PUBLIC KEY-----\n";

bool verifyLightweaverUpdateGrantSignature(
    const uint8_t* payload, size_t payloadLength,
    const uint8_t* signature, size_t signatureLength) {
  if (!payload || !payloadLength || !signature ||
      signatureLength != LW_UPDATE_GRANT_SIGNATURE_BYTES) return false;
  uint8_t digest[32] = {};
  if (mbedtls_sha256_ret(payload, payloadLength, digest, 0) != 0) return false;
  mbedtls_pk_context key;
  mbedtls_pk_init(&key);
  int result = mbedtls_pk_parse_public_key(
      &key, reinterpret_cast<const unsigned char*>(
          LIGHTWEAVER_UPDATE_GRANT_PUBLIC_KEY_PEM),
      sizeof(LIGHTWEAVER_UPDATE_GRANT_PUBLIC_KEY_PEM));
  if (result != 0 || !mbedtls_pk_can_do(&key, MBEDTLS_PK_ECKEY)) {
    mbedtls_pk_free(&key); return false;
  }
  mbedtls_mpi r, s;
  mbedtls_mpi_init(&r); mbedtls_mpi_init(&s);
  result = mbedtls_mpi_read_binary(&r, signature, 32);
  if (result == 0) result = mbedtls_mpi_read_binary(&s, signature + 32, 32);
  if (result == 0) {
    mbedtls_ecp_keypair* ec = mbedtls_pk_ec(key);
    result = mbedtls_ecdsa_verify(
        &ec->grp, digest, sizeof(digest), &ec->Q, &r, &s);
  }
  mbedtls_mpi_free(&r); mbedtls_mpi_free(&s); mbedtls_pk_free(&key);
  return result == 0;
}

void lightweaverUpdateGrantRandom(uint8_t* output, size_t outputLength) {
  if (!output) return;
  for (size_t offset = 0; offset < outputLength;) {
    const uint32_t word = esp_random();
    const size_t count = outputLength - offset < sizeof(word)
        ? outputLength - offset : sizeof(word);
    memcpy(output + offset, &word, count);
    offset += count;
  }
}
#else
bool verifyLightweaverUpdateGrantSignature(
    const uint8_t*, size_t, const uint8_t*, size_t) { return false; }
void lightweaverUpdateGrantRandom(uint8_t*, size_t) {}
#endif
