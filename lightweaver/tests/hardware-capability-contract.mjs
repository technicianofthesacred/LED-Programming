import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CARD_HARDWARE_CAPABILITIES } from '../src/lib/cardRuntimeContract.js';

const types = fs.readFileSync('../firmware/lightweaver-controller/src/LightweaverTypes.h', 'utf8');
const main = fs.readFileSync('../firmware/lightweaver-controller/src/main.cpp', 'utf8');

const integer = (source, pattern, label) => {
  const match = source.match(pattern);
  assert.ok(match, `missing firmware declaration for ${label}`);
  return Number(match[1]);
};

assert.equal(CARD_HARDWARE_CAPABILITIES.maxPixels, integer(types, /#define\s+LW_MAX_PIXELS\s+(\d+)/, 'LW_MAX_PIXELS'));
assert.equal(CARD_HARDWARE_CAPABILITIES.maxOutputs, integer(types, /LW_MAX_OUTPUTS\s*=\s*(\d+)/, 'LW_MAX_OUTPUTS'));
assert.equal(CARD_HARDWARE_CAPABILITIES.maxZones, integer(types, /LW_MAX_ZONES\s*=\s*(\d+)/, 'LW_MAX_ZONES'));
assert.equal(CARD_HARDWARE_CAPABILITIES.maxRangesPerZone, integer(types, /LW_MAX_RANGES_PER_ZONE\s*=\s*(\d+)/, 'LW_MAX_RANGES_PER_ZONE'));

const pinFunction = main.match(/bool addLedsForPin[\s\S]*?switch \(pin\) \{([\s\S]*?)\n  \}/)?.[1] || '';
const firmwarePins = [...pinFunction.matchAll(/case\s+(\d+)\s*:/g)].map(match => Number(match[1]));
assert.deepEqual(CARD_HARDWARE_CAPABILITIES.supportedOutputPins, firmwarePins);

assert.throws(
  () => CARD_HARDWARE_CAPABILITIES.assertSupported({ outputs: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, pin: 16 + i, pixels: 1 })) }),
  /at most 4 outputs/,
);
