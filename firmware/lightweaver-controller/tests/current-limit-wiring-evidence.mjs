import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const types = fs.readFileSync(path.join(root, 'src/LightweaverTypes.h'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'src/LightweaverStorage.cpp'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.cpp'), 'utf8');

assert.match(types, /LW_DEFAULT_MAX_MILLIAMPS\s*=\s*1500\b/,
  'cards need a conservative nonzero aggregate current default');
assert.match(types, /uint32_t\s+maxMilliamps\s*=\s*LW_DEFAULT_MAX_MILLIAMPS/,
  'runtime config must never default to a disabled limiter');
assert.match(storage, /uint32_t\s+clampMilliamps\(long value\)[\s\S]*value\s*==\s*0[\s\S]*LW_DEFAULT_MAX_MILLIAMPS/,
  'a legacy zero value must migrate to the conservative limiter rather than disabling it');
assert.match(types, /uint32_t\s+wiringRevision\s*=\s*0/);
assert.match(types, /String\s+wiringDigest/);
assert.match(types, /static_assert\(lightweaverLimitedMilliamps\(LW_MAX_PIXELS,\s*LW_DEFAULT_MAX_MILLIAMPS\)\s*==\s*LW_DEFAULT_MAX_MILLIAMPS/,
  'a worst-case 1024-pixel estimate must remain clamped to the configured aggregate cap');

const strictStart = storage.indexOf('bool validateRuntimeConfigJsonStrict(');
const strictEnd = storage.indexOf('bool loadSdConfig(', strictStart);
const strict = storage.slice(strictStart, strictEnd);
assert.match(strict, /productionJobId\.length\(\)[\s\S]*maxMilliamps[\s\S]*production config requires a current limit between 100 and/,
  'production packages must explicitly carry a nonzero current ceiling');
assert.match(strict, /wiringRevision[\s\S]*production wiring revision must be a positive integer/,
  'production packages must carry a monotonic wiring revision');
assert.match(strict, /wiringDigest[\s\S]*production wiring digest must be 64 lowercase hex characters/,
  'production packages must carry an exact wiring digest');
assert.match(storage, /calculateWiringDigest\(doc\)[\s\S]*wiring digest does not match physical configuration/,
  'firmware must independently recompute the supplied digest before accepting it');
for (const canonicalField of ['version', 'colorOrder', 'maxMilliamps', 'outputs', 'id', 'pin', 'pixels', 'segments', 'count', 'direction']) {
  assert.match(storage, new RegExp(`canonical(?:Led|Output|Segment)?\\["${canonicalField}"\\]`),
    `canonical wiring digest must bind ${canonicalField}`);
}

for (const assignment of [
  /config\.maxMilliamps\s*=\s*clampMilliamps\(led\["maxMilliamps"\]\s*\|\s*LW_DEFAULT_MAX_MILLIAMPS\)/,
  /config\.wiringRevision\s*=\s*doc\["wiringRevision"\]/,
  /config\.wiringDigest\s*=\s*String\(doc\["wiringDigest"\]/,
]) {
  assert.match(storage, assignment, 'accepted safety evidence must remain in RuntimeConfig');
}

const setupStart = main.indexOf('bool setupLedOutputs() {');
const setupEnd = main.indexOf('bool setupSafeDiscoveryOutputs(', setupStart);
const setup = main.slice(setupStart, setupEnd);
assert.match(setup, /FastLED\.setMaxPowerInVoltsAndMilliamps\(5,\s*ledMaxMilliamps\)/,
  'FastLED must enforce one aggregate budget across every registered output');
assert.doesNotMatch(setup, /if\s*\(ledMaxMilliamps\s*>\s*0\)/,
  'runtime output setup must not allow the limiter to be disabled');
assert.match(storage, /totalPixels\s*>\s*LW_MAX_PIXELS/,
  'strict validation must retain the fixed 1024-pixel aggregate buffer bound');

const candidateStatusStart = storage.indexOf('String runtimeWiringSafetyStatusJson()');
const candidateStatusEnd = storage.indexOf('bool runtimeConfigJsonChangesWiring(', candidateStatusStart);
const candidateStatus = storage.slice(candidateStatusStart, candidateStatusEnd);
for (const field of ['maxMilliamps', 'wiringRevision', 'wiringDigest']) {
  assert.match(candidateStatus, new RegExp(`doc\\["${field}"\\]`),
    `candidate readback must expose ${field} from the exact staged JSON`);
}

const firmwareInfo = main.match(/String runtimeFirmwareInfo\(\)[\s\S]*?return out;\n\}/)?.[0] || '';
const finalWiringStatus = main.match(/String runtimeWiringSafetyStatus\(\)[\s\S]*?return out;\n\}/)?.[0] || '';
for (const field of ['maxMilliamps', 'wiringRevision', 'wiringDigest']) {
  assert.match(firmwareInfo, new RegExp(`doc\\["${field}"\\]\\s*=\\s*runtimeConfig\\.${field}`),
    `firmware-info must independently expose final ${field}`);
  assert.match(finalWiringStatus, new RegExp(`doc\\["${field}"\\]\\s*=\\s*runtimeConfig\\.${field}`),
    `known-good wiring status must independently expose final ${field}`);
}

console.log('current-limit-wiring-evidence tests passed');
