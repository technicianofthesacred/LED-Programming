import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';

import { buildCardRuntimeConfig } from '../../../lightweaver/src/lib/cardRuntimeContract.js';
import {
  CARD_CONFIG_STORAGE_LIMIT_BYTES,
  CardConfigCapacityError,
  prepareCardStoragePayload,
} from '../../../lightweaver/src/lib/cardStoragePayload.js';
import { CARD_HARDWARE_CONTRACT } from '../../../lightweaver/src/lib/cardHardwareContract.js';

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

// ── boot-time pixel buffer allocation ─────────────────────────────────────
// The pixel-scaled buffers are no longer statics sized at LW_MAX_PIXELS; they
// are heap-allocated once at boot from the loaded config's own totalPixels.
// The invariants that keep that safe are asserted here because getting any of
// them wrong hands FastLED a pointer it writes through on every show().
const mainSource = readFileSync(resolve(import.meta.dirname, '../src/main.cpp'), 'utf8');
for (const buffer of [
  'CRGB\\* leds',
  'CRGB\\* physicalLeds',
  'uint8_t\\* frameBuffer',
  'uint8_t\\* preparedSequenceFrameBuffer',
  'KaleidoscopePixelLookup\\* kaleidoscopePixelLookup',
]) {
  assert.match(mainSource, new RegExp(`${buffer} = nullptr;`),
    `${buffer} must start null so nothing can use it before the boot allocation`);
}
// Allocation happens before applyRuntimeConfig() (which fills the kaleidoscope
// lookup) and long before setupLedOutputs() registers anything with FastLED.
const allocateAt = mainSource.indexOf('allocatePixelBuffers(configTotalPixels(runtimeConfig))');
const applyAt = mainSource.indexOf('applyRuntimeConfig(runtimeConfig);');
const setupOutputsAt = mainSource.indexOf('if (!setupLedOutputs())');
assert.ok(allocateAt > 0 && allocateAt < applyAt && applyAt < setupOutputsAt,
  'boot must allocate the pixel buffers before applying the config and before registering outputs');
// A failed allocation frees everything and fails safe rather than half-running.
assert.match(mainSource, /if \(!allocatePixelBuffers\([\s\S]{0,80}?fail\(ERROR_CONFIG, "pixel buffer allocation failed"\);/,
  'a failed allocation must fall into the existing ERROR_CONFIG path');
assert.match(mainSource, /if \(!claimPixelBuffers\(count, secondCaps\)\) \{\s*releasePixelBuffers\(\);/,
  'a partially satisfied allocation must release every pointer before giving up');
// Every path that hands FastLED a slice refuses while any pointer is null.
for (const guarded of ['bool setupLedOutputs()', 'bool setupFactoryBeaconOutputs()', 'bool setupSafeDiscoveryOutputs(uint8_t stepIndex)']) {
  const start = mainSource.indexOf(`${guarded} {`);
  assert.ok(start > 0, `could not find ${guarded}`);
  assert.match(mainSource.slice(start, start + 400), /pixelBuffersReady\(\)/,
    `${guarded} must refuse to register outputs while any pixel buffer is null`);
}
assert.match(mainSource, /if \(start == nullptr \|\| !pixelBuffersReady\(\)\) return false;/,
  'addLedsForPin must reject a null slice outright');
// PSRAM is reported at boot so a bench operator can see whether the octal RAM
// actually came up before blaming a large config.
assert.match(mainSource, /psramFound\(\)/);
assert.match(mainSource, /ESP\.getPsramSize\(\)/);
// The stock esp32-s3-devkitc-1 board file assumes no PSRAM. Without BOTH of
// these the octal RAM is never brought up and every MALLOC_CAP_SPIRAM request
// fails, which turns a large piece into an ERROR_CONFIG card.
const platformioSource = readFileSync(resolve(import.meta.dirname, '../platformio.ini'), 'utf8');
assert.match(platformioSource, /board_build\.arduino\.memory_type\s*=\s*qio_opi/,
  'the N16R8 octal PSRAM memory type must be selected or PSRAM never initialises');
assert.match(platformioSource, /-DBOARD_HAS_PSRAM/,
  'the Arduino core needs BOARD_HAS_PSRAM to initialise external RAM at startup');

// ── explicit vs defaulted current ceiling ─────────────────────────────────
// The 1500 mA fallback is a SILENT throttle: FastLED scales brightness down to
// hold it, so an installer who wired 100 A and never set a value sees a dim
// piece and no reason why. Recording the provenance is what lets /api/status
// say whose number is in force. It never rejects a config.
assert.match(
  source,
  /config\.maxMilliampsExplicit\s*=\s*!led\["maxMilliamps"\]\.isNull\(\);/,
  'the parser must record whether the loaded config actually carried a current ceiling',
);
assert.match(
  source,
  /config\.maxMilliamps\s*=\s*clampMilliamps\(led\["maxMilliamps"\]\s*\|\s*LW_DEFAULT_MAX_MILLIAMPS\);/,
  'the conservative fallback must remain in place as the safety net',
);
assert.doesNotMatch(
  source,
  /maxMilliampsExplicit[\s\S]{0,200}?message\s*=\s*"/,
  'a missing current ceiling must warn, never reject the config',
);
// Both endpoints report the provenance so Studio can warn on a defaulted
// ceiling: /api/status is the poll, /api/firmware-info is what a commissioning
// screen can read before any bridge handshake.
const webSource = readFileSync(resolve(import.meta.dirname, '../src/LightweaverWeb.cpp'), 'utf8');
for (const handler of ['void handleStatus()', 'void handleFirmwareInfo()']) {
  const start = webSource.indexOf(handler);
  assert.ok(start > 0, `could not find ${handler}`);
  const body = webSource.slice(start, webSource.indexOf('\n}', start));
  assert.match(body, /maxMilliampsSource/, `${handler} must report the current-ceiling provenance`);
  assert.match(body, /maxMilliampsExplicit \? "config" : "default"/,
    `${handler} must derive the provenance from the loaded config, not guess it`);
  assert.match(body, /"maxMilliamps\\?":/, `${handler} must report the active ceiling alongside its source`);
}
// The boot log says it out loud too — an installer watching serial should not
// have to poll an endpoint to learn the card is holding them to 1500 mA.
assert.match(mainSource, /!runtimeConfig\.maxMilliampsExplicit && outputCount > 0/,
  'boot must warn when a piece with outputs is running on the defaulted current ceiling');

// ── the contract limits must be limits the card can actually store ────────
// Configs persist as JSON in NVS, capped at configCapacityBytes. A contract
// number the byte budget cannot hold would be a promise Studio makes and the
// card breaks, so the zone/range maxima are proven here rather than asserted.
// The widened pin menu overlaps the DEFAULT control assignment (encoder 4/5/6,
// previous 7). That overlap is the point — a port may carry a strip OR a knob —
// and the collision check rejects a config that claims both, so pick pins the
// stock controls have not already taken.
const DEFAULT_CONTROL_PINS = new Set([0, 2, 4, 5, 6, 7, 8, 9]);
const FREE_OUTPUT_PINS = CARD_HARDWARE_CONTRACT.outputPins.filter(pin => !DEFAULT_CONTROL_PINS.has(pin));
assert.ok(
  FREE_OUTPUT_PINS.length >= CARD_HARDWARE_CONTRACT.maxOutputs,
  'the pin menu must leave enough GPIOs free of the default controls to fill every output',
);

function configAtLimits({ zones, ranges, looks = 1, outputs = 1 }) {
  const pins = FREE_OUTPUT_PINS;
  const perOutput = Math.floor(CARD_HARDWARE_CONTRACT.maxPixels / outputs);
  return buildCardRuntimeConfig({
    projectId: 'p',
    projectName: 'P',
    mode: 'website-flash',
    led: {
      type: 'WS2812B',
      colorOrder: 'GRB',
      pixels: perOutput * outputs,
      maxMilliamps: 20000,
      outputs: Array.from({ length: outputs }, (_, i) => ({
        id: `o${i}`, pin: pins[i], pixels: perOutput,
      })),
    },
    // Shortest legal ids but worst-case five-digit range numbers: the most
    // generous shape a real project could take at these dimensions.
    looks: Array.from({ length: looks }, (_, i) => ({
      id: `l${i}`, label: `l${i}`, mode: 'procedural', preset: 'aurora',
    })),
    zones: Array.from({ length: zones }, (_, z) => ({
      id: `z${z}`, label: `z${z}`, patternId: 'aurora',
      ranges: Array.from({ length: ranges }, (_, r) => ({ start: 10000 + r, count: 10000 })),
    })),
    startupPatternId: 'l0',
  });
}

const { maxZones, maxRangesPerZone } = CARD_HARDWARE_CONTRACT;
const atLimits = prepareCardStoragePayload(
  configAtLimits({ zones: maxZones, ranges: maxRangesPerZone }),
  { maxBytes: Number.MAX_SAFE_INTEGER },
);
assert.ok(
  atLimits.bytes <= CARD_CONFIG_STORAGE_LIMIT_BYTES,
  `a config using every zone (${maxZones}) and range (${maxRangesPerZone}) must fit the ` +
  `${CARD_CONFIG_STORAGE_LIMIT_BYTES}-byte card budget; measured ${atLimits.bytes}`,
);
// Why the contract is not larger: 16 zones was the first candidate and it does
// not fit. Step the contract down, not the budget up — configCapacityBytes is
// pinned by the 20 KB NVS partition holding a known-good AND a candidate copy,
// and repartitioning is off-limits while app1 stays reserved. The builder
// refuses to emit 16 zones now, so the rejected step is measured by extending
// the serialized shape past the contract.
const overZones = configAtLimits({ zones: maxZones, ranges: maxRangesPerZone });
overZones.zones = [
  ...overZones.zones,
  ...Array.from({ length: 16 - maxZones }, (_, i) => ({
    ...overZones.zones[0],
    id: `x${i}`,
    label: `x${i}`,
  })),
];
assert.throws(
  () => prepareCardStoragePayload(overZones),
  CardConfigCapacityError,
  '16 zones x 6 ranges is the rejected ladder step — record why the shipped number is lower',
);

// The dimensional maxima are NOT simultaneously reachable, and never have been
// (the previous 10-zone/4-range contract also overflowed once all 32 looks and
// all 4 outputs were present). What matters is that overflow is LOUD: Studio
// throws before the write and the card's body cap rejects it, so a config is
// never silently truncated into a piece that lights up wrong.
assert.throws(
  () => prepareCardStoragePayload(
    configAtLimits({ zones: maxZones, ranges: maxRangesPerZone, looks: 32, outputs: 4 }),
  ),
  CardConfigCapacityError,
  'a config over the byte budget must be refused with the capacity error, never trimmed',
);

// Kaleidoscope offsets serialize per point into this same budget, which is why
// LW_MAX_KALEIDOSCOPE_OFFSETS is decoupled from LW_MAX_PIXELS and left at 1024:
// even 1024 offsets alone cannot fit, so raising the constant buys nothing and
// costs RAM in every RuntimeConfig copy.
const KALEIDOSCOPE_MAX_OFFSETS = 1024;
function configWithOffsetPool(offsetCount) {
  return buildCardRuntimeConfig({
    projectId: 'p', projectName: 'P', mode: 'website-flash',
    led: {
      type: 'WS2812B', colorOrder: 'GRB', pixels: 2048, maxMilliamps: 20000,
      outputs: [{ id: 'o', pin: FREE_OUTPUT_PINS[0], pixels: 2048 }],
    },
    looks: [{ id: 'l0', label: 'l0', mode: 'procedural', preset: 'aurora' }],
    zones: [{ id: 'z0', label: 'z0', patternId: 'aurora', ranges: [{ start: 0, count: 2048 }] }],
    kaleidoscopeMappings: offsetCount === 0 ? [] : [{
      id: 'k0', zoneId: 'z0', pixelCount: offsetCount, pointCount: offsetCount, startLed: 0,
      // Zero offsets are the CHEAPEST legal pool ("0," per point); real
      // installations carry multi-digit values, so this is a lower bound.
      offsets: Array.from({ length: offsetCount }, () => 0),
      spans: [{ start: 0, count: offsetCount, sourceStart: 0, sourceStep: 1 }],
    }],
    startupPatternId: 'l0',
  });
}
const withoutPool = prepareCardStoragePayload(configWithOffsetPool(0), { maxBytes: Number.MAX_SAFE_INTEGER });
const withPool = prepareCardStoragePayload(
  configWithOffsetPool(KALEIDOSCOPE_MAX_OFFSETS), { maxBytes: Number.MAX_SAFE_INTEGER },
);
const poolCost = withPool.bytes - withoutPool.bytes;
assert.ok(
  poolCost > CARD_CONFIG_STORAGE_LIMIT_BYTES / 2,
  `a full ${KALEIDOSCOPE_MAX_OFFSETS}-offset pool costs ${poolCost} of the ` +
  `${CARD_CONFIG_STORAGE_LIMIT_BYTES}-byte budget even at its cheapest encoding, so the byte ` +
  'budget — not LW_MAX_KALEIDOSCOPE_OFFSETS — is the binding limit; raising the constant ' +
  'would buy nothing and cost RAM in every RuntimeConfig copy',
);

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
