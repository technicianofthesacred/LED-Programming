import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CARD_HARDWARE_CAPABILITIES } from '../src/lib/cardRuntimeContract.js';

const types = fs.readFileSync('../firmware/lightweaver-controller/src/LightweaverTypes.h', 'utf8');
const main = fs.readFileSync('../firmware/lightweaver-controller/src/main.cpp', 'utf8');
const platformio = fs.readFileSync('../firmware/lightweaver-controller/platformio.ini', 'utf8');

const integer = (source, pattern, label) => {
  const match = source.match(pattern);
  assert.ok(match, `missing firmware declaration for ${label}`);
  return Number(match[1]);
};

assert.equal(CARD_HARDWARE_CAPABILITIES.maxPixels, integer(types, /#define\s+LW_MAX_PIXELS\s+(\d+)/, 'LW_MAX_PIXELS'));
assert.equal(CARD_HARDWARE_CAPABILITIES.maxOutputs, integer(types, /LW_MAX_OUTPUTS\s*=\s*(\d+)/, 'LW_MAX_OUTPUTS'));
assert.equal(CARD_HARDWARE_CAPABILITIES.maxZones, integer(types, /LW_MAX_ZONES\s*=\s*(\d+)/, 'LW_MAX_ZONES'));
assert.equal(CARD_HARDWARE_CAPABILITIES.maxRangesPerZone, integer(types, /LW_MAX_RANGES_PER_ZONE\s*=\s*(\d+)/, 'LW_MAX_RANGES_PER_ZONE'));

// The header's #define is only the fallback; the card is actually built with
// the -D flag, and the firmware static_assert ties that to the contract. Pin
// the flag too, so a platformio.ini edit can't quietly build a different card
// than the contract everyone else reads.
assert.equal(
  CARD_HARDWARE_CAPABILITIES.maxPixels,
  integer(platformio, /-DLW_MAX_PIXELS=(\d+)/, 'the -DLW_MAX_PIXELS build flag'),
);
// 65535 is the uint16_t totalPixels / OutputConfig.start ceiling. Past it the
// bound stops being a validation number and becomes a silent wrap.
assert.ok(CARD_HARDWARE_CAPABILITIES.maxPixels <= 65535,
  'maxPixels must stay within the uint16_t pixel-index ceiling');

// addLedsForPin's switch IS the pin menu: FastLED takes DATA_PIN as a
// compile-time template parameter, so a contract pin with no case compiles to
// "unsupported pin" on the card while Studio happily offers it.
const pinFunction = main.match(/bool addLedsForPin[\s\S]*?switch \(pin\) \{([\s\S]*?)\n  \}/)?.[1] || '';
const firmwarePins = [...pinFunction.matchAll(/case\s+(\d+)\s*:/g)].map(match => Number(match[1]));
assert.deepEqual(CARD_HARDWARE_CAPABILITIES.supportedOutputPins, firmwarePins);

// GPIOs that must never reach the pin menu on an ESP32-S3 N16R8, and why.
// A strip on any of these does not fail loudly — it breaks booting, flashing,
// the microSD bus, or the serial log an owner reads during recovery.
const RESERVED_GPIOS = new Map([
  ...[0, 3, 45, 46].map(pin => [pin, 'strapping pin']),
  ...[10, 11, 12, 13].map(pin => [pin, 'microSD SPI bus (LW_SD_CS/MOSI/SCK/MISO)']),
  ...[19, 20].map(pin => [pin, 'native USB D-/D+']),
  ...[43, 44].map(pin => [pin, 'UART0 boot log']),
  ...Array.from({ length: 12 }, (_, i) => [26 + i, 'SPI flash + octal PSRAM bus']),
]);
for (const pin of CARD_HARDWARE_CAPABILITIES.supportedOutputPins) {
  assert.ok(!RESERVED_GPIOS.has(pin), `GPIO ${pin} is reserved: ${RESERVED_GPIOS.get(pin)}`);
}
assert.ok(
  CARD_HARDWARE_CAPABILITIES.supportedOutputPins.length >= CARD_HARDWARE_CAPABILITIES.maxOutputs,
  'the pin menu must cover every concurrent output the card can drive',
);

assert.throws(
  () => CARD_HARDWARE_CAPABILITIES.assertSupported({ outputs: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, pin: 16 + i, pixels: 1 })) }),
  /at most 4 outputs/,
);
