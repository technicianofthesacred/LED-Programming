import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(root, 'src');
const headerPath = resolve(sourceRoot, 'LightweaverFirmwareBootHealth.h');
const sourcePath = resolve(sourceRoot, 'LightweaverFirmwareBootHealth.cpp');
assert.ok(existsSync(headerPath) && existsSync(sourcePath),
  'firmware boot-health module must exist');

const temp = mkdtempSync(join(tmpdir(), 'lw-firmware-boot-health-'));
try {
  const binary = join(temp, 'firmware-boot-health');
  execFileSync(process.env.CXX || 'c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror',
    resolve(import.meta.dirname, 'firmware-boot-health.cpp'), '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const source = readFileSync(sourcePath, 'utf8');
const main = readFileSync(resolve(sourceRoot, 'main.cpp'), 'utf8');
const storage = readFileSync(resolve(sourceRoot, 'LightweaverStorage.cpp'), 'utf8');
assert.match(source, /esp_ota_get_state_partition/);
assert.match(source, /ESP_OTA_IMG_PENDING_VERIFY/);
assert.match(source, /esp_ota_mark_app_valid_cancel_rollback/);
assert.match(source, /esp_ota_mark_app_invalid_rollback_and_reboot/);
assert.match(source, /RTC_NOINIT_ATTR/,
  'rollback correlation is retained without writing owner data partitions');
assert.match(source, /FirmwareBootEvidenceDecision::RolledBack[\s\S]*restoredFirmwareVersion|restoredFirmwareVersion[\s\S]*FirmwareBootEvidenceDecision::RolledBack/,
  'the old slot publishes its restored firmware identity for a valid rollback record');
assert.match(source, /total power loss|power loss clears/i,
  'RTC-only rollback diagnostics document that total power loss clears correlation without touching data storage');
assert.match(main, /beginLightweaverFirmwareBootHealth\(\)/,
  'pending OTA state is detected before application storage initialization');
assert.match(main, /confirmLightweaverFirmwareBootHealth/,
  'mark-valid occurs only after local subsystems initialize');
assert.match(main, /handleLightweaverFirmwareBootHealth/,
  'the deadline is enforced from the main loop');
assert.match(storage, /RuntimeStorageAccessMode::ReadOnlyProbation/,
  'pending firmware reads configuration without migrations, cleanup, or NVS writes');
assert.doesNotMatch(source, /WiFi\.status|MDNS|browser/i,
  'router, mDNS, and browser presence are not boot-health requirements');

console.log('firmware boot health tests passed');
