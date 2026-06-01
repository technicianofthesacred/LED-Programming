import assert from 'node:assert/strict';
import {
  CARD_RUNTIME_MODES,
  DEFAULT_CARD_PATTERN_BANK,
  buildCardRuntimeConfig,
  normalizeCardRuntimeConfig,
  makeCardRuntimePackage,
} from '../src/lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';
import {
  DEFAULT_STANDALONE_CONTROLS,
  DEFAULT_STANDALONE_LED,
} from '../src/lib/standaloneController.js';
import { defaultStandaloneController } from '../src/lib/projectModel.js';

assert.deepEqual(CARD_RUNTIME_MODES, ['factory-flash', 'website-flash', 'sd-sequence', 'live-host']);

assert.ok(DEFAULT_CARD_PATTERN_BANK.length >= 24);
for (const id of ['aurora', 'ember', 'rainbow', 'breathe', 'scanner', 'warm-white']) {
  assert.ok(DEFAULT_CARD_PATTERN_BANK.some(pattern => pattern.id === id), `missing default pattern ${id}`);
}

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
assert.equal(DEFAULT_STANDALONE_CONTROLS.brightness, -1);
assert.equal(DEFAULT_STANDALONE_LED.colorOrder, 'RGB');

const fallback = buildCardRuntimeConfig({ projectName: 'Bench Piece' });
assert.equal(fallback.mode, 'factory-flash');
assert.equal(fallback.piece.name, 'Bench Piece');
assert.deepEqual(fallback.patterns.map(pattern => pattern.id), DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id));

const cleanStudioController = defaultStandaloneController({
  playlist: DEFAULT_CARD_PATTERN_BANK.map((pattern, index) => ({
    id: pattern.id,
    type: 'pattern',
    patternId: pattern.id,
    label: pattern.label,
    enabled: true,
    createdAt: index,
  })),
  controls: { encoder: { patternCycleIds: DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id) } },
});
assert.deepEqual(cleanStudioController.playlist, []);
assert.deepEqual(cleanStudioController.controls.encoder.patternCycleIds, []);

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

const tenZonePackage = makeCardRuntimePackage({
  projectName: 'Ten Zone Piece',
  led: { pixels: 100 },
  zones: Array.from({ length: 10 }, (_, index) => ({
    id: `zone-${index + 1}`,
    label: `Zone ${index + 1}`,
    patternId: 'aurora',
    ranges: [{ start: index * 10, count: 10 }],
  })),
  syncZones: false,
});
assert.equal(tenZonePackage.config.zones.length, 10);
assert.deepEqual(tenZonePackage.config.zones.map(zone => zone.id).slice(-2), ['zone-9', 'zone-10']);

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
assert.deepEqual(projectPkg.config.controls.encoder.patternCycleIds, ['aurora', 'ember', 'scanner']);
assert.deepEqual(projectPkg.config.zones.map(zone => zone.patternId), ['ember']);

const visualLookPkg = buildCardRuntimePackageFromProject({
  projectName: 'Visual Look',
  standaloneController: {
    outputs: [{ id: 'main', name: 'Main', pin: 16, pixels: 60 }],
    defaultLook: {
      patternId: 'scanner',
      brightness: 0.72,
      speed: 1.45,
      hueShift: -18,
      customHue: 138,
      customSaturation: 210,
      customBreathe: true,
      customDrift: true,
    },
    controls: { encoder: { patternCycleIds: ['scanner', 'aurora'] } },
  },
});
assert.equal(visualLookPkg.config.startupPatternId, 'scanner');
assert.equal(visualLookPkg.config.zones.length, 1);
assert.equal(visualLookPkg.config.zones[0].patternId, 'scanner');
assert.equal(visualLookPkg.config.zones[0].brightness, 0.72);
assert.equal(visualLookPkg.config.zones[0].speed, 1.45);
assert.equal(visualLookPkg.config.zones[0].hueShift, -18);
assert.equal(visualLookPkg.config.zones[0].customHue, 138);
assert.equal(visualLookPkg.config.zones[0].customSaturation, 210);
assert.equal(visualLookPkg.config.zones[0].customBreathe, true);
assert.equal(visualLookPkg.config.zones[0].customDrift, true);
assert.deepEqual(visualLookPkg.config.zones[0].ranges, [{ start: 0, count: 60 }]);

const visualLookZonedPkg = buildCardRuntimePackageFromProject({
  projectName: 'Visual Zoned Look',
  strips: [{ id: 'main', name: 'Main', pixelCount: 16 }],
  patchBoard: {
    patches: [
      {
        id: 'front-zone',
        name: 'Front Zone',
        source: { type: 'strip', stripId: 'main', startLed: 0, endLed: 15 },
        output: { mode: 'on' },
        playback: {},
      },
    ],
  },
  standaloneController: {
    defaultLook: {
      patternId: 'rainbow',
      brightness: 0.66,
      speed: 1.72,
      hueShift: 22,
      customHue: 88,
      customSaturation: 180,
      customBreathe: true,
    },
  },
});
assert.equal(visualLookZonedPkg.config.zones[0].patternId, 'rainbow');
assert.equal(visualLookZonedPkg.config.zones[0].brightness, 0.66);
assert.equal(visualLookZonedPkg.config.zones[0].speed, 1.72);
assert.equal(visualLookZonedPkg.config.zones[0].hueShift, 22);
assert.equal(visualLookZonedPkg.config.zones[0].customHue, 88);
assert.equal(visualLookZonedPkg.config.zones[0].customSaturation, 180);
assert.equal(visualLookZonedPkg.config.zones[0].customBreathe, true);

const sectionLookPkg = buildCardRuntimePackageFromProject({
  projectName: 'Section Looks',
  strips: [
    { id: 'outer', name: 'Outer', pixelCount: 10 },
    { id: 'inner', name: 'Inner', pixelCount: 6 },
  ],
  patchBoard: {
    patches: [
      {
        id: 'patch-outer',
        name: 'Outer',
        source: { type: 'strip', stripId: 'outer', startLed: 0, endLed: 9 },
        output: { mode: 'normal' },
        playback: {
          patternId: 'fire',
          brightness: 0.5,
          speed: 0.65,
          hueShift: 12,
          customHue: 18,
          customSaturation: 240,
          customBreathe: true,
        },
      },
      {
        id: 'patch-inner',
        name: 'Inner',
        source: { type: 'strip', stripId: 'inner', startLed: 0, endLed: 5 },
        output: { mode: 'normal' },
        playback: {},
      },
    ],
  },
  standaloneController: {
    defaultLook: {
      patternId: 'ocean',
      brightness: 0.8,
      speed: 1.2,
      hueShift: -8,
      customHue: 160,
      customSaturation: 190,
    },
  },
});
assert.deepEqual(sectionLookPkg.config.zones.map(zone => zone.patternId), ['fire', 'ocean']);
assert.equal(sectionLookPkg.config.zones[0].brightness, 0.5);
assert.equal(sectionLookPkg.config.zones[0].speed, 0.65);
assert.equal(sectionLookPkg.config.zones[0].hueShift, 12);
assert.equal(sectionLookPkg.config.zones[0].customHue, 18);
assert.equal(sectionLookPkg.config.zones[0].customSaturation, 240);
assert.equal(sectionLookPkg.config.zones[0].customBreathe, true);
assert.equal(sectionLookPkg.config.zones[1].brightness, 0.8);
assert.equal(sectionLookPkg.config.zones[1].speed, 1.2);
assert.equal(sectionLookPkg.config.zones[1].hueShift, -8);
assert.equal(sectionLookPkg.config.zones[1].customHue, 160);

const staleOutputPkg = buildCardRuntimePackageFromProject({
  projectName: 'Stale Output Counts',
  strips: [
    { id: 'outer', name: 'Outer circle', pixelCount: 22 },
    { id: 'inner', name: 'Inner circle', pixelCount: 22 },
  ],
  standaloneController: {
    outputs: [{ id: 'out1', name: 'Output 1', pin: 16, pixels: 1 }],
  },
});
assert.equal(staleOutputPkg.config.led.pixels, 44);
assert.equal(staleOutputPkg.config.led.outputs.length, 2);
assert.deepEqual(staleOutputPkg.config.led.outputs.map(output => output.pin), [16, 17]);
assert.deepEqual(staleOutputPkg.config.led.outputs.map(output => output.pixels), [22, 22]);

const playlistComboPkg = buildCardRuntimePackageFromProject({
  projectName: 'Playlist Combo',
  strips: [
    { id: 'outer', name: 'Outer circle', pixelCount: 10 },
    { id: 'inner', name: 'Inner circle', pixelCount: 10 },
  ],
  patchBoard: {
    patches: [
      {
        id: 'patch-outer',
        name: 'Outer circle',
        source: { type: 'strip', stripId: 'outer', startLed: 0, endLed: 9 },
        output: { mode: 'normal' },
        playback: {},
      },
      {
        id: 'patch-inner',
        name: 'Inner circle',
        source: { type: 'strip', stripId: 'inner', startLed: 0, endLed: 9 },
        output: { mode: 'normal' },
        playback: {},
      },
    ],
  },
  standaloneController: {
    outputs: [{ id: 'main', name: 'Main', pin: 16, pixels: 20 }],
    defaultLook: { patternId: 'aurora', brightness: 0.8, speed: 1.1 },
    playlist: [
      { type: 'pattern', patternId: 'plasma' },
      { type: 'combo', lookId: 'outer-fire-inner-ocean' },
    ],
    looks: [{
      id: 'outer-fire-inner-ocean',
      label: 'Outer Fire + Inner Ocean',
      defaultLook: { patternId: 'aurora', brightness: 0.7, speed: 1.0 },
      sectionLooks: {
        'patch-outer': { patternId: 'fire', brightness: 0.5, speed: 0.75, customHue: 18 },
        'patch-inner': { patternId: 'ocean', brightness: 0.9, speed: 1.4, customHue: 160 },
      },
    }],
  },
});
assert.deepEqual(playlistComboPkg.config.controls.encoder.patternCycleIds, ['plasma', 'combo-outer-fire-inner-ocean']);
assert.equal(playlistComboPkg.config.startupPatternId, 'plasma');
assert.deepEqual(playlistComboPkg.config.looks.map(look => look.id), ['plasma', 'combo-outer-fire-inner-ocean']);
assert.equal(playlistComboPkg.config.looks[0].preset, 'plasma');
assert.deepEqual(playlistComboPkg.config.looks[0].zones.map(zone => zone.patternId), ['plasma', 'plasma']);
assert.equal(playlistComboPkg.config.looks[1].mode, 'combo');
assert.deepEqual(playlistComboPkg.config.looks[1].zones.map(zone => zone.id), ['patch-outer', 'patch-inner']);
assert.deepEqual(playlistComboPkg.config.looks[1].zones.map(zone => zone.patternId), ['fire', 'ocean']);
assert.equal(playlistComboPkg.config.looks[1].zones[0].brightness, 0.5);
assert.equal(playlistComboPkg.config.looks[1].zones[0].speed, 0.75);
assert.equal(playlistComboPkg.config.looks[1].zones[0].customHue, 18);
assert.equal(playlistComboPkg.config.looks[1].zones[1].brightness, 0.9);
assert.equal(playlistComboPkg.config.looks[1].zones[1].speed, 1.4);
assert.equal(playlistComboPkg.config.looks[1].zones[1].customHue, 160);

const singleOutputPkg = buildCardRuntimePackageFromProject({
  projectName: 'Single Wired Output',
  strips: [
    { id: 'outer', name: 'Outer circle', pixelCount: 22 },
    { id: 'inner', name: 'Inner circle', pixelCount: 22 },
  ],
  standaloneController: {
    outputs: [{ id: 'out1', name: 'Main chain', pin: 16, pixels: 44 }],
  },
});
assert.equal(singleOutputPkg.config.led.outputs.length, 1);
assert.deepEqual(singleOutputPkg.config.led.outputs.map(output => output.pixels), [44]);

const staleAnalogBrightnessPkg = buildCardRuntimePackageFromProject({
  projectName: 'No Floating Analog Brightness',
  standaloneController: {
    controls: {
      brightness: 1,
    },
  },
});
assert.equal(staleAnalogBrightnessPkg.config.controls.brightness, -1);

console.log('card-runtime-contract tests passed');
