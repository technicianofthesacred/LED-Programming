import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const sourceRoot = resolve(import.meta.dirname, '../src');
const ownerHeaderPath = join(sourceRoot, 'LightweaverOwnerCapability.h');
const ownerSourcePath = join(sourceRoot, 'LightweaverOwnerCapability.cpp');
assert.ok(existsSync(ownerHeaderPath) && existsSync(ownerSourcePath),
  'owner-capability firmware module must exist');
const header = readFileSync(ownerHeaderPath, 'utf8');
const source = readFileSync(ownerSourcePath, 'utf8');
const web = readFileSync(join(sourceRoot, 'LightweaverWeb.cpp'), 'utf8');
const runtime = readFileSync(join(sourceRoot, 'LightweaverRuntimeApi.h'), 'utf8');

assert.match(header, /LW_OWNER_CAPABILITY_TTL_MS/);
assert.match(header, /cardId[\s\S]*bootId[\s\S]*allowedOrigin[\s\S]*host[\s\S]*networkIdentity[\s\S]*ownerSessionId[\s\S]*operationGeneration[\s\S]*expectedProjectHead/,
  'capability binds every identity and concurrency boundary');
assert.match(source, /constantTimeTokenEqual/, 'bearer tokens use constant-time comparison');
assert.match(source, /revoke\(\)/, 'mismatch and expiry paths revoke the active capability');
assert.match(source, /\/api\/owner\/capability/, 'firmware exposes an explicit owner-capability issuance endpoint');
assert.match(source, /runtimeOwnerPairingAuthorized\(\)/,
  'issuance is gated by commissioning authority or deliberate physical presence');
assert.doesNotMatch(source, /corsOriginAllowed\([^)]*\)[\s\S]{0,120}issue\(/,
  'an allowed/same origin alone must not issue ownership');
assert.match(runtime, /runtimeNetworkIdentity\(\)/);
assert.match(runtime, /runtimeOwnerPairingAuthorized\(\)/);
assert.match(web, /registerLightweaverOwnerCapability/);
assert.match(web, /projectHead/,
  'status exposes the exact editable-project head used to bind owner capabilities');

const tempDir = mkdtempSync(join(tmpdir(), 'lightweaver-owner-capability-'));
try {
  writeFileSync(join(tempDir, 'Arduino.h'), `
#pragma once
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
  writeFileSync(join(tempDir, 'test.cpp'), `
#include <cassert>
#include "LightweaverOwnerCapability.h"

static LightweaverOwnerBinding binding() {
  LightweaverOwnerBinding b;
  b.cardId = "lw-card"; b.bootId = "boot-a";
  b.allowedOrigin = "https://led.mandalacodes.com"; b.host = "192.168.1.4";
  b.networkIdentity = "station:192.168.1.4"; b.ownerSessionId = "owner-a";
  b.operationGeneration = 7; b.expectedProjectHead = "head-a";
  return b;
}

int main() {
  LightweaverOwnerCapability capability;
  auto expected = binding();
  assert(capability.issue(expected, "token-a", 1000));
  assert(capability.validate("token-a", expected, 1001) == LightweaverOwnerValidation::Accepted);
  assert(capability.advanceExpectedProjectHead("token-a", expected, "head-b", 1002));
  expected.expectedProjectHead = "head-b";
  assert(capability.validate("token-a", expected, 1003) == LightweaverOwnerValidation::Accepted);
  auto wrong = expected; wrong.bootId = "boot-b";
  assert(capability.validate("token-a", wrong, 1004) == LightweaverOwnerValidation::BindingMismatch);
  assert(capability.validate("token-a", expected, 1005) == LightweaverOwnerValidation::Missing);
  assert(capability.issue(expected, "token-b", 2000));
  assert(capability.validate("token-b", expected, 2000 + LW_OWNER_CAPABILITY_TTL_MS + 1) == LightweaverOwnerValidation::Expired);
  assert(capability.validate("token-b", expected, 2001) == LightweaverOwnerValidation::Missing);
  assert(capability.issue(expected, "token-c", 3000));
  assert(capability.validate("wrong", expected, 3001) == LightweaverOwnerValidation::TokenMismatch);
  return 0;
}
`);
  const binary = join(tempDir, 'owner-capability');
  execFileSync('c++', ['-std=c++17', '-I', tempDir, '-I', sourceRoot,
    join(sourceRoot, 'LightweaverOwnerCapability.cpp'), join(tempDir, 'test.cpp'), '-o', binary],
  { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('windowless owner capability tests passed');
