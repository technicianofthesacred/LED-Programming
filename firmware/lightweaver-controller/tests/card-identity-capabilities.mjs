import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const platform = fs.readFileSync(path.join(root, 'platformio.ini'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.cpp'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'src/LightweaverStorage.cpp'), 'utf8');
const runtimeApi = fs.readFileSync(path.join(root, 'src/LightweaverRuntimeApi.h'), 'utf8');
const firmwareInfo = main.match(/String runtimeFirmwareInfo\(\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
const runtimeStatus = storage.match(/String runtimeStatusJson\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';

for (const flag of [
  'LW_FIRMWARE_VERSION',
  'LW_CONFIG_SCHEMA_VERSION',
  'LW_CAPABILITIES_VERSION',
]) {
  assert.match(platform, new RegExp(`-D${flag}=`), `${flag} must have a pinned build default`);
}
assert.match(
  platform,
  /extra_scripts = pre:scripts\/inject-build-identity\.py/,
  'LW_BUILD_ID must be injected from the exact release source revision',
);

assert.match(main, /ESP\.getEfuseMac\(\)/, 'card identity must derive from the ESP32-S3 eFuse chip id');
assert.match(main, /lw-%012llx/, 'card identity must be a bounded lw- plus fixed-width hex id');

for (const [source, payload] of [[firmwareInfo, '/api/firmware-info'], [runtimeStatus, '/api/status']]) {
  for (const field of [
    'cardId', 'firmwareVersion', 'buildId', 'configSchemaVersion',
    'capabilitiesVersion', 'outputs', 'limits', 'runtimeSource',
    'resetReason', 'wiringProbation',
  ]) {
    assert.match(source, new RegExp(`doc\\["${field}"\\]`), `${payload} must expose ${field}`);
  }
  assert.match(source, /output\["(?:gpio|pin)"\]/, `${payload} outputs must expose GPIO`);
  assert.match(source, /output\["(?:count|pixels)"\]/, `${payload} outputs must expose pixel count`);
  for (const limit of ['pixels', 'outputs', 'looks', 'zones', 'rangesPerZone', 'configStorageBytes']) {
    assert.match(source, new RegExp(`\\["limits"\\]\\["${limit}"\\]`), `${payload} limits must expose ${limit}`);
  }
}

for (const source of [firmwareInfo, runtimeStatus]) {
  assert.match(source, /LW_MAX_PIXELS/);
  assert.match(source, /LW_MAX_OUTPUTS/);
  assert.match(source, /LW_MAX_LOOKS/);
  assert.match(source, /LW_MAX_ZONES/);
  assert.match(source, /LW_MAX_RANGES_PER_ZONE/);
  assert.doesNotMatch(source, /doc\["(?:password|credentials|rawNvs)"\]/i, 'identity payloads must not expose secrets or raw NVS');
}

assert.match(
  runtimeApi,
  /uint32_t\s+runtimeWiringProbationRemainingMs\(\)/,
  'runtime API must expose the live wiring probation remainder to /api/status',
);
assert.match(
  main,
  /uint32_t\s+runtimeWiringProbationRemainingMs\(\)[\s\S]*?wiringProbationActive[\s\S]*?wiringProbationDeadlineMs\s*-\s*millis\(\)/,
  'runtime probation getter must read the active in-memory deadline',
);
assert.match(
  runtimeStatus,
  /runtimeWiringProbationRemainingMs\(\)/,
  '/api/status must report the live runtime probation remainder rather than the unpopulated storage snapshot',
);

console.log('card identity capability contract tests passed');
