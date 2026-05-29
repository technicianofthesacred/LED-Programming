import assert from 'node:assert/strict';
import {
  CARD_RUNTIME_MODES,
  DEFAULT_CARD_PATTERN_BANK,
  buildCardRuntimeConfig,
  normalizeCardRuntimeConfig,
  makeCardRuntimePackage,
} from '../src/lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';

assert.deepEqual(CARD_RUNTIME_MODES, ['factory-flash', 'website-flash', 'sd-sequence', 'live-host']);

assert.deepEqual(
  DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id),
  ['aurora', 'ember', 'rainbow', 'breathe', 'scanner', 'warm-white'],
);

const normalized = normalizeCardRuntimeConfig({
  mode: 'website-flash',
  led: { pixels: 44, colorOrder: 'rgb', brightnessLimit: 0.7 },
  controls: {
    encoder: {
      a: 4,
      b: 5,
      press: 0,
      rotateDirection: 'clockwise-brighter',
      brightnessStep: 18,
      patternCycleIds: ['scanner', 'aurora', 'ember'],
    },
  },
});

assert.equal(normalized.mode, 'website-flash');
assert.equal(normalized.led.pixels, 44);
assert.equal(normalized.led.colorOrder, 'RGB');
assert.equal(normalized.led.brightnessLimit, 0.7);
assert.equal(normalized.controls.encoder.press, 0);
assert.deepEqual(normalized.controls.encoder.patternCycleIds, ['scanner', 'aurora', 'ember']);

const fallback = buildCardRuntimeConfig({ projectName: 'Bench Piece' });
assert.equal(fallback.mode, 'factory-flash');
assert.equal(fallback.piece.name, 'Bench Piece');
assert.deepEqual(fallback.patterns.map(pattern => pattern.id), DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id));

const pkg = makeCardRuntimePackage({
  projectName: 'Bench Piece',
  mode: 'website-flash',
  led: { pixels: 44, colorOrder: 'RGB' },
  controls: normalized.controls,
});

assert.equal(pkg.app, 'Lightweaver');
assert.equal(pkg.format, 'lightweaver-card-runtime-package');
assert.equal(pkg.version, 1);
assert.equal(pkg.config.mode, 'website-flash');
assert.equal(pkg.config.piece.name, 'Bench Piece');
assert.equal(pkg.config.led.pixels, 44);
assert.deepEqual(pkg.config.controls.encoder.patternCycleIds, ['scanner', 'aurora', 'ember']);

const zoned = makeCardRuntimePackage({
  projectName: 'Zoned Piece',
  mode: 'website-flash',
  led: {
    pixels: 96,
    outputs: [
      { id: 'out1', pin: 16, pixels: 0 },
      { id: 'out2', pin: 17, pixels: 0 },
    ],
  },
  zones: [
    { id: 'outer', label: 'Outer', patternId: 'scanner', ranges: [{ start: 0, count: 48 }] },
    { id: 'inner', label: 'Inner', patternId: 'ember', ranges: [{ start: 48, count: 48 }] },
  ],
  syncZones: false,
});
assert.equal(zoned.config.led.pixels, 96);
assert.equal(zoned.config.led.outputs.length, 1);
assert.equal(zoned.config.led.outputs[0].pixels, 96);
assert.deepEqual(zoned.config.zones.map(zone => zone.id), ['outer', 'inner']);
assert.equal(zoned.config.syncZones, false);

const projectPkg = buildCardRuntimePackageFromProject({
  projectName: 'Customer V3',
  strips: [
    { id: 'inner', name: 'Inner', pixelCount: 8 },
    { id: 'outer', name: 'Outer', pixelCount: 12 },
  ],
  patchBoard: {
    patches: [
      {
        id: 'inner-zone',
        name: 'Inner Zone',
        source: { type: 'strip', stripId: 'inner', startLed: 0, endLed: 7 },
        output: { mode: 'on' },
        playback: { patternId: 'ember', brightness: 0.4 },
      },
    ],
  },
  standaloneController: {
    led: { colorOrder: 'GRB', brightnessLimit: 0.55 },
    outputs: [{ id: 'main', name: 'Main', pin: 16, pixels: 20 }],
    controls: { encoder: { patternCycleIds: ['ember', 'scanner'] } },
  },
});
assert.equal(projectPkg.config.piece.name, 'Customer V3');
assert.equal(projectPkg.config.led.pixels, 20);
assert.equal(projectPkg.config.led.colorOrder, 'GRB');
assert.equal(projectPkg.config.led.brightnessLimit, 0.55);
assert.deepEqual(projectPkg.config.controls.encoder.patternCycleIds, ['ember', 'scanner']);
assert.deepEqual(projectPkg.config.zones.map(zone => zone.patternId), ['ember']);

console.log('card-runtime-contract tests passed');
