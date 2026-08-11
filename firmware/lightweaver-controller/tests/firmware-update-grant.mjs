import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const sourceRoot = resolve(import.meta.dirname, '../src');
const header = resolve(sourceRoot, 'LightweaverFirmwareUpdateGrant.h');
const source = resolve(sourceRoot, 'LightweaverFirmwareUpdateGrant.cpp');
const dir = mkdtempSync(join(tmpdir(), 'lw-update-grant-'));

try {
  writeFileSync(join(dir, 'Arduino.h'), `
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
class String {
 public:
  String() = default;
  String(const char* value): value_(value ? value : "") {}
  String(const std::string& value): value_(value) {}
  size_t length() const { return value_.length(); }
  const char* c_str() const { return value_.c_str(); }
  bool operator==(const String& other) const { return value_ == other.value_; }
  bool operator!=(const String& other) const { return value_ != other.value_; }
 private: std::string value_;
};
`);
  writeFileSync(join(dir, 'test.cpp'), `
#include <cassert>
#include <cstring>
#include "LightweaverFirmwareUpdateGrant.h"

static FirmwareUpdateGrantBinding binding() {
  FirmwareUpdateGrantBinding value;
  value.cardId = "lw-001122aabbcc";
  value.bootId = "boot-a";
  value.expectedProjectHead = "";
  value.allowedOrigin = "https://led.mandalacodes.com";
  value.host = "192.168.18.70";
  value.networkIdentity = "station:192.168.18.70:lightweaver:2";
  value.ownerSessionId = "owner-a";
  value.operationGeneration = 7;
  value.releaseBuildId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  value.ticketSha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  return value;
}

static bool verifier(const uint8_t*, size_t,
                     const uint8_t* signature, size_t signatureLength) {
  return signatureLength == LW_UPDATE_GRANT_SIGNATURE_BYTES && signature[0] == 0x42;
}

int main() {
  uint8_t nonce[LW_UPDATE_GRANT_NONCE_BYTES] = {};
  for (size_t i = 0; i < sizeof(nonce); i++) nonce[i] = static_cast<uint8_t>(i);
  uint8_t signature[LW_UPDATE_GRANT_SIGNATURE_BYTES] = {};
  signature[0] = 0x42;
  uint8_t payload[LW_UPDATE_GRANT_MAX_PAYLOAD_BYTES] = {};
  size_t payloadLength = 0;
  auto expected = binding();

  LightweaverFirmwareUpdateGrant grant;
  assert(grant.issueChallenge(expected, nonce, 1000, payload,
                              sizeof(payload), payloadLength));
  assert(payloadLength > LW_UPDATE_GRANT_NONCE_BYTES);
  const char expectedJson[] =
      "{\\\"schemaVersion\\\":1,\\\"scope\\\":\\\"firmware-update\\\","
      "\\\"cardId\\\":\\\"lw-001122aabbcc\\\",\\\"bootId\\\":\\\"boot-a\\\","
      "\\\"challenge\\\":\\\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\\\","
      "\\\"studioOrigin\\\":\\\"https://led.mandalacodes.com\\\","
      "\\\"cardHost\\\":\\\"192.168.18.70\\\","
      "\\\"networkIdentity\\\":\\\"station:192.168.18.70:lightweaver:2\\\","
      "\\\"ownerSessionId\\\":\\\"owner-a\\\",\\\"operationGeneration\\\":7,"
      "\\\"expectedProjectHead\\\":\\\"\\\","
      "\\\"releaseBuildId\\\":\\\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\\","
      "\\\"ticketSha256\\\":\\\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\\"}";
  assert(payloadLength == std::strlen(expectedJson));
  assert(std::memcmp(payload, expectedJson, payloadLength) == 0);

  uint8_t tampered[LW_UPDATE_GRANT_MAX_PAYLOAD_BYTES] = {};
  std::memcpy(tampered, payload, payloadLength);
  tampered[payloadLength - 1] ^= 1;
  assert(grant.consumeSignedGrant(tampered, payloadLength, signature,
      sizeof(signature), verifier, expected, "update-token", 1001) ==
      FirmwareUpdateGrantResult::PayloadMismatch);

  auto wrong = expected;
  wrong.bootId = "boot-b";
  assert(grant.consumeSignedGrant(payload, payloadLength, signature,
      sizeof(signature), verifier, wrong, "update-token", 1002) ==
      FirmwareUpdateGrantResult::BindingMismatch);

  signature[0] = 0;
  assert(grant.consumeSignedGrant(payload, payloadLength, signature,
      sizeof(signature), verifier, expected, "update-token", 1003) ==
      FirmwareUpdateGrantResult::SignatureRejected);
  signature[0] = 0x42;
  assert(grant.consumeSignedGrant(payload, payloadLength, signature,
      sizeof(signature), verifier, expected, "update-token", 1004) ==
      FirmwareUpdateGrantResult::Accepted);
  assert(grant.consumeSignedGrant(payload, payloadLength, signature,
      sizeof(signature), verifier, expected, "second-token", 1005) ==
      FirmwareUpdateGrantResult::Missing);
  assert(grant.validateCapability("wrong-token", expected, 1006) ==
      FirmwareUpdateGrantResult::CapabilityMismatch);
  assert(grant.validateCapability("update-token", expected, 1007) ==
      FirmwareUpdateGrantResult::Accepted);
  assert(grant.validateCapability("update-token", wrong, 1007) ==
      FirmwareUpdateGrantResult::BindingMismatch);
  assert(grant.validateCapability("update-token", expected, 1008) ==
      FirmwareUpdateGrantResult::Missing);
  grant.revokeCapability();
  assert(grant.validateCapability("update-token", expected, 1009) ==
      FirmwareUpdateGrantResult::Missing);

  assert(grant.issueChallenge(expected, nonce, 2000, payload,
                              sizeof(payload), payloadLength));
  assert(grant.consumeSignedGrant(payload, payloadLength, signature,
      sizeof(signature), verifier, expected, "late-token",
      2000 + LW_UPDATE_GRANT_TTL_MS + 1) == FirmwareUpdateGrantResult::Expired);

  assert(grant.issueChallenge(expected, nonce, 0xfffffff0U, payload,
                              sizeof(payload), payloadLength));
  assert(grant.consumeSignedGrant(payload, payloadLength, signature,
      sizeof(signature), verifier, expected, "wrap-token", 0x20U) ==
      FirmwareUpdateGrantResult::Accepted);
  return 0;
}
`);
  const binary = join(dir, 'firmware-update-grant');
  execFileSync(process.env.CXX || 'c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', dir, '-I', sourceRoot,
    source, join(dir, 'test.cpp'), '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const implementation = readFileSync(source, 'utf8');
assert.match(implementation, /LIGHTWEAVER_UPDATE_GRANT_PUBLIC_KEY_PEM/,
  'software update grants use a dedicated embedded P-256 public key');
assert.match(implementation, /mbedtls_ecdsa_verify/,
  'the ESP32 adapter verifies the SHA-256 digest with proven mbedTLS P-256');
assert.doesNotMatch(implementation, /lightweaverOwnerCapability|LightweaverOwnerCapability/,
  'update-only authorization must never create or feed general owner authority');
assert.match(implementation, /esp_random\(\)/,
  'the ESP32 adapter generates the challenge and capability from hardware randomness');
assert.match(implementation, /schemaVersion[\s\S]*scope[\s\S]*cardId[\s\S]*bootId[\s\S]*challenge[\s\S]*studioOrigin[\s\S]*cardHost[\s\S]*networkIdentity[\s\S]*ownerSessionId[\s\S]*operationGeneration[\s\S]*expectedProjectHead[\s\S]*releaseBuildId[\s\S]*ticketSha256/,
  'canonical JSON uses the shared server insertion order');

console.log('firmware update grant tests passed');
