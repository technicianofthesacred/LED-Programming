import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../src/LightweaverStorage.cpp'), 'utf8');

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

console.log('storage-config-clamps tests passed');
