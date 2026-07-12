import assert from 'node:assert/strict';
import {
  TEST_STRIP_ZONE_ID,
  applyTestStripToRuntimePackage,
} from '../src/lib/testStrip.js';

const runtimePackage = {
  app: 'Lightweaver',
  format: 'lightweaver-card-runtime-package',
  version: 1,
  config: {
    version: 1,
    mode: 'website-flash',
    piece: { id: 'shanghai-mandala', name: 'Shanghai Mandala' },
    led: {
      pixels: 94,
      outputs: [
        { id: 'out1', name: 'Output 1', pin: 16, pixels: 44 },
        { id: 'out2', name: 'Output 2', pin: 17, pixels: 50 },
      ],
      colorOrder: 'RGB',
      brightnessLimit: 0.65,
    },
    controls: {},
    patterns: [],
    looks: [
      { id: 'fire', label: 'Fire', mode: 'procedural', preset: 'fire', brightness: 1 },
      {
        id: 'sunrise-mix',
        label: 'Sunrise mix',
        mode: 'combo',
        preset: 'aurora',
        brightness: 1,
        zones: [
          { id: 'outer', label: 'Outer', patternId: 'aurora', brightness: 1, speed: 1, hueShift: 0, customHue: 32, customSaturation: 230, customBreathe: false, customDrift: true },
          { id: 'inner', label: 'Inner', patternId: 'ripple', brightness: 0.8, speed: 1.2, hueShift: 10, customHue: 40, customSaturation: 200, customBreathe: true, customDrift: false },
        ],
      },
    ],
    startupPatternId: 'fire',
    zones: [
      { id: 'outer', label: 'Outer', patternId: 'aurora', brightness: 1, speed: 1, hueShift: 0, customHue: 32, customSaturation: 230, customBreathe: false, customDrift: true, ranges: [{ start: 0, count: 44 }] },
      { id: 'inner', label: 'Inner', patternId: 'ripple', brightness: 0.8, speed: 1.2, hueShift: 10, customHue: 40, customSaturation: 200, customBreathe: true, customDrift: false, ranges: [{ start: 44, count: 50 }] },
    ],
    syncZones: false,
  },
};

// Keep a deep snapshot to prove the transform never mutates its input.
const snapshotBefore = JSON.parse(JSON.stringify(runtimePackage));

const testPackage = applyTestStripToRuntimePackage(runtimePackage, 30);

// Input is untouched.
assert.deepEqual(runtimePackage, snapshotBefore);
assert.notEqual(testPackage, runtimePackage);
assert.notEqual(testPackage.config, runtimePackage.config);

// Single output of the requested length.
assert.equal(testPackage.config.led.pixels, 30);
assert.equal(testPackage.config.led.outputs.length, 1);
assert.equal(testPackage.config.led.outputs[0].pixels, 30);
assert.equal(testPackage.config.led.outputs[0].pin, 16); // first real output's pin

// One full-range zone, carrying the first real zone's look.
assert.equal(testPackage.config.zones.length, 1);
assert.equal(testPackage.config.zones[0].id, TEST_STRIP_ZONE_ID);
assert.deepEqual(testPackage.config.zones[0].ranges, [{ start: 0, count: 30 }]);
assert.equal(testPackage.config.zones[0].patternId, 'aurora');
assert.equal(testPackage.config.syncZones, true);

// Looks keep playlist order and their primary pattern; combo looks collapse
// to the single full-piece zone instead of listing multiple zones.
assert.equal(testPackage.config.looks.length, 2);
assert.equal(testPackage.config.looks[0].id, 'fire');
assert.equal(testPackage.config.looks[0].preset, 'fire');
assert.ok(!testPackage.config.looks[0].zones);
assert.equal(testPackage.config.looks[1].id, 'sunrise-mix');
assert.equal(testPackage.config.looks[1].preset, 'aurora');
assert.equal(testPackage.config.looks[1].zones.length, 1);
assert.equal(testPackage.config.looks[1].zones[0].id, TEST_STRIP_ZONE_ID);
assert.equal(testPackage.config.looks[1].zones[0].patternId, 'aurora');

// A non-positive/garbage length falls back to the default rather than
// producing a zero/negative-pixel package.
const fallbackPackage = applyTestStripToRuntimePackage(runtimePackage, 0);
assert.equal(fallbackPackage.config.led.pixels, 30);

console.log('test-strip tests passed');
