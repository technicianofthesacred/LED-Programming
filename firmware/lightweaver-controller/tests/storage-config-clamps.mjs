import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../src/LightweaverStorage.cpp'), 'utf8');
const types = readFileSync(resolve(import.meta.dirname, '../src/LightweaverOutputColorConfig.h'), 'utf8');
const runtimeTypes = readFileSync(resolve(import.meta.dirname, '../src/LightweaverTypes.h'), 'utf8');
const validationHeader = resolve(import.meta.dirname, '../src/LightweaverConfigValidation.h');

assert.match(
  source,
  /uint16_t\s+clampOutputPixelsForRemaining\(int value,\s*uint16_t used\)/,
  'storage parser should clamp each output against the remaining fixed LED buffer',
);

assert.match(
  source,
  /LW_MAX_PIXELS\s*-\s*used/,
  'output clamping should cap total configured pixels at LW_MAX_PIXELS',
);

assert.match(
  source,
  /uint16_t\s+clampRangeStart\(int value,\s*uint16_t totalPixels\)/,
  'storage parser should clamp zone range starts to the loaded LED count',
);

assert.match(
  source,
  /uint16_t\s+clampRangeCount\(int value,\s*uint16_t start,\s*uint16_t totalPixels\)/,
  'storage parser should clip zone range lengths to the remaining loaded LEDs',
);

assert.match(
  source,
  /zone\.ranges\[zone\.rangeCount\]\.start\s*=\s*clampRangeStart\(rangeJson\["start"\]\s*\|\s*0,\s*totalPixels\)/,
  'zone parser should use the range start clamp before storing config',
);

assert.match(
  source,
  /zone\.ranges\[zone\.rangeCount\]\.count\s*=\s*clampRangeCount\(rangeJson\["count"\]\s*\|\s*0,\s*zone\.ranges\[zone\.rangeCount\]\.start,\s*totalPixels\)/,
  'zone parser should use the range count clamp before storing config',
);

assert.match(
  types,
  /struct OutputColorConfig\s*{[\s\S]*bool gammaEnabled\s*=\s*false;[\s\S]*float gammaValue\s*=\s*2\.2f;[\s\S]*float red\s*=\s*1\.0f;[\s\S]*float green\s*=\s*1\.0f;[\s\S]*float blue\s*=\s*1\.0f;[\s\S]*};/,
  'runtime model should define byte-compatible neutral output color defaults',
);
assert.match(
  runtimeTypes,
  /struct RuntimeConfig\s*{[\s\S]*OutputColorConfig outputColor;/,
  'runtime config should carry installation output color settings',
);
assert.match(
  source,
  /void resetOutputColor\(OutputColorConfig& outputColor\)\s*{\s*outputColor\s*=\s*OutputColorConfig{};\s*}/,
  'old configs should reset to the neutral output color contract',
);
assert.match(
  source,
  /parseOutputColorConfig\(\s*doc\["led"\],\s*parsedOutputColor,\s*outputColorErrorPath,\s*outputColorErrorReason\)/,
  'storage should call the focused production parser at the ArduinoJson boundary',
);
assert.match(
  source,
  /if\s*\(!parseOutputColorConfig[\s\S]*return false;[\s\S]*applyJsonToConfig\(doc,\s*config,\s*source\);[\s\S]*config\.outputColor\s*=\s*parsedOutputColor;/,
  'output color parsing should reject invalid input before applying and commit only after config parsing',
);
assert.match(
  source,
  /if\s*\(!(?:loadJsonString\(json,\s*\*parsed,\s*SOURCE_NVS,\s*message\)|validateRuntimeConfigJsonStrict\(json,\s*\*parsed,\s*message\))\)[\s\S]*return false;[\s\S]*config\s*=\s*\*parsed;/,
  'save validation should parse into a temporary config so a rejected save leaves active config unchanged',
);
assert.match(
  source,
  /doc\["led"\]\["outputGammaEnabled"\]\s*=\s*config\.outputColor\.gammaEnabled;/,
  'runtime status should emit outputGammaEnabled',
);
assert.match(
  source,
  /doc\["led"\]\["outputGammaValue"\]\s*=\s*config\.outputColor\.gammaValue;/,
  'runtime status should emit outputGammaValue',
);
for (const channel of ['red', 'green', 'blue']) {
  assert.match(
    source,
    new RegExp(`doc\\["led"\\]\\["calibration"\\]\\["${channel}"\\]\\s*=\\s*config\\.outputColor\\.${channel};`),
    `runtime status should emit ${channel} calibration`,
  );
}

const tempDir = mkdtempSync(resolve(os.tmpdir(), 'lightweaver-config-validation-'));
try {
  const fixture = resolve(tempDir, 'config-validation-test.cpp');
  const binary = resolve(tempDir, 'config-validation-test');
  writeFileSync(fixture, `
#include <cassert>
#include <limits>
#include "${validationHeader}"

static void verifyRange(float minimum, float maximum) {
  assert(validateOptionalConfigNumber(false, false, 0.0f, minimum, maximum) == ConfigNumberValidation::MISSING);
  assert(validateOptionalConfigNumber(true, true, int(minimum), minimum, maximum) == ConfigNumberValidation::VALID);
  assert(validateOptionalConfigNumber(true, true, (minimum + maximum) / 2.0f, minimum, maximum) == ConfigNumberValidation::VALID);
  assert(validateOptionalConfigNumber(true, false, minimum, minimum, maximum) == ConfigNumberValidation::INVALID_TYPE);
  assert(validateOptionalConfigNumber(true, true, std::numeric_limits<float>::infinity(), minimum, maximum) == ConfigNumberValidation::NON_FINITE);
  assert(validateOptionalConfigNumber(true, true, std::numeric_limits<float>::quiet_NaN(), minimum, maximum) == ConfigNumberValidation::NON_FINITE);
  assert(validateOptionalConfigNumber(true, true, minimum - 0.01f, minimum, maximum) == ConfigNumberValidation::BELOW_MINIMUM);
  assert(validateOptionalConfigNumber(true, true, maximum + 0.01f, minimum, maximum) == ConfigNumberValidation::ABOVE_MAXIMUM);
  assert(validateOptionalConfigNumber(true, true, maximum, minimum, maximum) == ConfigNumberValidation::VALID);
}

int main() {
  verifyRange(1.0f, 3.0f);
  verifyRange(0.0f, 1.0f);
  return 0;
}
`);
  execFileSync('c++', ['-std=c++17', fixture, '-o', binary], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('storage-config-clamps tests passed');
