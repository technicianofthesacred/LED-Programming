import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const sourceRoot = resolve(import.meta.dirname, '../src');
const headerPath = join(sourceRoot, 'LightweaverFirmwareUpdate.h');
assert.ok(existsSync(headerPath), 'firmware update state machine header must exist');

const dir = mkdtempSync(join(tmpdir(), 'lw-firmware-update-state-'));
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
#include <cstdint>
#include "LightweaverFirmwareUpdate.h"

static FirmwareUpdateBinding binding() {
  FirmwareUpdateBinding value;
  value.cardId = "lw-card"; value.bootId = "boot-a";
  value.ownerSessionId = "owner-a"; value.operationGeneration = 4;
  value.expectedProjectHead = "head-a"; value.releaseBuildId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  value.ticketSha256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  return value;
}

int main() {
  LightweaverFirmwareUpdateMutationRate rate;
  for (uint32_t request = 0; request < LW_FIRMWARE_UPDATE_RATE_MAX_MUTATIONS; request++) {
    assert(rate.allow(1000) == true);
  }
  assert(rate.allow(1000) == false);
  assert(rate.allow(1000 + LW_FIRMWARE_UPDATE_RATE_WINDOW_MS - 1) == false);
  assert(rate.allow(1000 + LW_FIRMWARE_UPDATE_RATE_WINDOW_MS) == true);

  LightweaverFirmwareTransferState state;
  auto expected = binding();
  assert(state.preflight(expected, 16, 1000) == FirmwareUpdateResult::Accepted);
  assert(state.begin(expected, "lease-a", 1001) == FirmwareUpdateResult::Accepted);
  assert(state.acceptChunk(expected, "lease-a", 1, 0, 8, 1002) == FirmwareUpdateResult::Accepted);
  assert(state.acceptChunk(expected, "lease-a", 3, 8, 8, 1003) == FirmwareUpdateResult::SequenceMismatch);
  assert(state.phase() == FirmwareUpdatePhase::Failed);

  state.reset();
  assert(state.preflight(expected, 16, 1100) == FirmwareUpdateResult::Accepted);
  assert(state.begin(expected, "lease-offset", 1101) == FirmwareUpdateResult::Accepted);
  assert(state.acceptChunk(expected, "lease-offset", 1, 1, 8, 1102) == FirmwareUpdateResult::OffsetMismatch);
  assert(state.phase() == FirmwareUpdatePhase::Failed);

  state.reset();
  assert(state.preflight(expected, 16, 1200) == FirmwareUpdateResult::Accepted);
  assert(state.begin(expected, "lease-binding", 1201) == FirmwareUpdateResult::Accepted);
  auto stale = expected; stale.expectedProjectHead = "head-b";
  assert(state.acceptChunk(stale, "lease-binding", 1, 0, 8, 1202) == FirmwareUpdateResult::BindingMismatch);
  assert(state.phase() == FirmwareUpdatePhase::Failed);

  state.reset();
  assert(state.preflight(expected, 16, 2000) == FirmwareUpdateResult::Accepted);
  assert(state.begin(expected, "lease-b", 2001) == FirmwareUpdateResult::Accepted);
  assert(state.acceptChunk(expected, "lease-b", 1, 0, LW_FIRMWARE_UPDATE_MAX_CHUNK_BYTES + 1, 2002) == FirmwareUpdateResult::ChunkTooLarge);
  assert(state.phase() == FirmwareUpdatePhase::Failed);

  state.reset();
  assert(state.preflight(expected, 16, 3000) == FirmwareUpdateResult::Accepted);
  assert(state.begin(expected, "lease-c", 3001) == FirmwareUpdateResult::Accepted);
  assert(state.expire(3001 + LW_FIRMWARE_UPDATE_LEASE_TTL_MS + 1));
  assert(state.phase() == FirmwareUpdatePhase::Failed);

  state.reset();
  assert(state.preflight(expected, 16, 4000) == FirmwareUpdateResult::Accepted);
  assert(state.begin(expected, "lease-d", 4001) == FirmwareUpdateResult::Accepted);
  assert(state.acceptChunk(expected, "lease-d", 1, 0, 8, 4002) == FirmwareUpdateResult::Accepted);
  assert(state.acceptChunk(expected, "lease-d", 2, 8, 8, 4003) == FirmwareUpdateResult::Accepted);
  assert(state.readyToCommit(expected, "lease-d", 4004) == FirmwareUpdateResult::Accepted);
  state.markPendingReboot();
  assert(state.phase() == FirmwareUpdatePhase::PendingReboot);
  return 0;
}
`);
  const binary = join(dir, 'firmware-update-state');
  execFileSync(process.env.CXX || 'c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', dir, '-I', sourceRoot,
    join(dir, 'test.cpp'), '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const source = readFileSync(resolve(sourceRoot, 'LightweaverFirmwareUpdate.cpp'), 'utf8');
for (const symbol of ['esp_ota_get_next_update_partition', 'esp_ota_begin', 'esp_ota_write',
  'esp_ota_end', 'esp_ota_set_boot_partition', 'esp_ota_abort']) {
  assert.match(source, new RegExp(symbol), `${symbol} must participate in the inactive-slot lifecycle`);
}
assert.match(source, /esp_flash_read[\s\S]*LW_PARTITION_TABLE_OFFSET|LW_PARTITION_TABLE_OFFSET[\s\S]*esp_flash_read/,
  'preflight verifies the exact partition-table flash sector');
assert.match(source, /runtimeCancelStream\(\)/,
  'begin uses the canonical Stop path');
assert.match(source, /runtimeSetBlackout\(true\)/,
  'begin puts the output in an acknowledged safe state');
assert.match(source, /429[\s\S]*rate-limited|rate-limited[\s\S]*429/i,
  'excess update mutations fail closed with a bounded rate response');
assert.match(source, /sendUpdateRateLimit[\s\S]*handlePreflight|handlePreflight[\s\S]*sendUpdateRateLimit/,
  'the rate refusal is applied to firmware update mutations');

console.log('firmware update state tests passed');
