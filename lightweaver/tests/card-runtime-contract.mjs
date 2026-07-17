import assert from 'node:assert/strict';
import {
  CARD_RUNTIME_MODES,
  DEFAULT_CARD_PATTERN_BANK,
  buildCardRuntimeConfig,
  normalizeCardRuntimeConfig,
  makeCardRuntimePackage,
  normalizeInclusiveRange,
  patchBoardToZones,
} from '../src/lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../src/lib/cardRuntimeProject.js';
import {
  DEFAULT_STANDALONE_CONTROLS,
  DEFAULT_STANDALONE_LED,
} from '../src/lib/standaloneController.js';
import { defaultStandaloneController } from '../src/lib/projectModel.js';

assert.deepEqual(CARD_RUNTIME_MODES, ['factory-flash', 'website-flash', 'sd-sequence', 'live-host']);

const aliasControls = normalizeCardRuntimeConfig({
  led: { pixels: 44, outputs: [{ id: 'main', pin: '16', pixels: 44 }] },
  controls: { encoder: { pinA: '10', pinB: '11', pressPin: '12', alternatePressPin: '13' }, previousPin: '14', nextPin: '15', blackoutPin: '19', brightnessPin: '20', statusLedPin: '47' },
}).controls;
assert.deepEqual(aliasControls.encoder.a, 10);
assert.equal('pinA' in aliasControls.encoder, false);
assert.equal('previousPin' in aliasControls, false);

const duplicateEncoderPressPackage = makeCardRuntimePackage({
  led: { pixels: 44, outputs: [{ id: 'main', pin: 16, pixels: 44 }] },
  controls: { encoder: { press: 6, alternatePress: 6 } },
});
assert.equal(duplicateEncoderPressPackage.config.controls.encoder.press, 6);
assert.equal(duplicateEncoderPressPackage.config.controls.encoder.alternatePress, -1);

assert.throws(() => normalizeCardRuntimeConfig({ led: { pixels: 44, outputs: [{ id: 'main', pin: 16, pixels: 44 }] }, controls: { encoder: { a: 10, b: 10, press: 12, alternatePress: -1 }, previous: -1, next: -1, blackout: -1, brightness: -1, statusLed: -1 } }), /already owned/i);

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
assert.equal(normalized.controls.encoder.brightnessStep, 18);
assert.equal(DEFAULT_STANDALONE_CONTROLS.encoder.press, 0);
assert.equal(DEFAULT_STANDALONE_CONTROLS.encoder.alternatePress, 6);
assert.equal(DEFAULT_STANDALONE_CONTROLS.encoder.brightnessStep, 18);
assert.equal(DEFAULT_STANDALONE_CONTROLS.brightness, -1);
assert.equal(DEFAULT_STANDALONE_LED.colorOrder, 'RGB');

assert.deepEqual(normalizeInclusiveRange(2, 0), { start: 0, count: 3, reversed: true });

const inactiveAddressBoard = {
  physicalLocked: true,
  chains: [{ id: 'main', rowIds: ['reverse', 'inactive', 'later'] }],
  patches: [
    { id: 'reverse', name: 'Reverse', source: { type: 'strip', stripId: 'first', startLed: 2, endLed: 0 }, output: { mode: 'normal' }, playback: {} },
    { id: 'inactive', name: 'Inactive', source: { type: 'off', ledCount: 4 }, output: { mode: 'off' }, playback: {} },
    { id: 'later', name: 'Later', source: { type: 'strip', stripId: 'second', startLed: 0, endLed: 1 }, output: { mode: 'normal' }, playback: {} },
  ],
};
assert.deepEqual(
  patchBoardToZones(inactiveAddressBoard, [
    { id: 'first', pixelCount: 3 },
    { id: 'second', pixelCount: 2 },
  ]).map(zone => zone.ranges[0]),
  [{ start: 0, count: 3 }, { start: 7, count: 2 }],
);

const inactiveAddressPkg = buildCardRuntimePackageFromProject({
  projectName: 'Inactive addresses',
  strips: [{ id: 'first', pixelCount: 3 }, { id: 'second', pixelCount: 2 }],
  patchBoard: inactiveAddressBoard,
  standaloneController: { outputs: [{ id: 'out1', pin: 16, pixels: 0 }] },
});
assert.equal(inactiveAddressPkg.config.led.pixels, 9);
assert.equal(inactiveAddressPkg.config.led.outputs.reduce((sum, output) => sum + output.pixels, 0), 9);
assert.equal(inactiveAddressPkg.config.zones.at(-1).ranges[0].start, 7);

const compiledRuntime = {
  ok: true,
  totalPixels: 5,
  outputs: [
    { id: 'wire-a', name: 'Wire A', pin: 16, pixels: 3, start: 0, count: 3 },
    { id: 'wire-b', name: 'Wire B', pin: 17, pixels: 2, start: 3, count: 2 },
  ],
  zones: [
    { id: 'outer', label: 'Outer', ranges: [{ start: 3, count: 2 }] },
    { id: 'inner', label: 'Inner', ranges: [{ start: 0, count: 3 }] },
  ],
};
const compiledWinsPkg = buildCardRuntimePackageFromProject({
  projectName: 'Compiled wins',
  compiledWiring: compiledRuntime,
  patchBoard: inactiveAddressBoard,
  standaloneController: {
    outputs: [
      { id: 'stale1', pin: 38, pixels: 100 },
      { id: 'stale2', pin: 39, pixels: 100 },
      { id: 'stale3', pin: 40, pixels: 100 },
      { id: 'stale4', pin: 48, pixels: 100 },
    ],
    looks: [{
      id: 'combo', label: 'Combo', type: 'compound-pattern',
      defaultLook: { patternId: 'aurora' },
      sectionLooks: { outer: { patternId: 'ember' }, inner: { patternId: 'scanner' } },
    }],
    playlist: [{ id: 'combo', type: 'combo', lookId: 'combo', enabled: true }],
  },
});
assert.equal(compiledWinsPkg.config.led.pixels, 5);
assert.deepEqual(compiledWinsPkg.config.led.outputs.map(output => [output.id, output.pin, output.pixels]), [['wire-a', 16, 3], ['wire-b', 17, 2]]);
assert.deepEqual(compiledWinsPkg.config.looks[0].zones.map(zone => zone.id), ['outer', 'inner']);
assert.deepEqual(compiledWinsPkg.config.zones.map(zone => zone.ranges), [[{ start: 3, count: 2 }], [{ start: 0, count: 3 }]]);

for (const badRange of [
  { start: -1, count: 1 },
  { start: 0.5, count: 1 },
  { start: 0, count: 0 },
  { start: 0, count: -1 },
  { start: 4, count: 2 },
]) {
  assert.throws(() => makeCardRuntimePackage({ led: { pixels: 5 }, zones: [{ id: 'bad', ranges: [badRange] }] }), /range/i);
}

const fallback = buildCardRuntimeConfig({ projectName: 'Bench Piece' });
assert.equal(fallback.mode, 'factory-flash');
for (const field of ['projectRevision', 'projectFingerprint', 'productionJobId', 'productionJobDigest']) {
  assert.equal(field in fallback, false, `ordinary Studio packages should omit absent ${field}`);
}
assert.equal(fallback.piece.id, 'bench-piece');
assert.equal(fallback.piece.name, 'Bench Piece');
assert.equal(fallback.controls.encoder.brightnessStep, 18);
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
  projectId: 'lwproj-bench-123',
  projectName: 'Bench Piece',
  projectRevision: 7,
  projectFingerprint: 'a'.repeat(16),
  productionJobId: 'batch-2026.07:artwork_42',
  productionJobDigest: 'b'.repeat(64),
  mode: 'website-flash',
  led: { pixels: 44, colorOrder: 'RGB' },
  controls: normalized.controls,
});

assert.equal(pkg.app, 'Lightweaver');
assert.equal(pkg.format, 'lightweaver-card-runtime-package');
assert.equal(pkg.version, 1);
assert.equal(pkg.config.mode, 'website-flash');
assert.equal(pkg.config.piece.id, 'lwproj-bench-123');
assert.equal(pkg.config.piece.name, 'Bench Piece');
assert.equal(pkg.config.projectRevision, 7);
assert.equal(pkg.config.projectFingerprint, 'a'.repeat(16));
assert.equal(pkg.config.productionJobId, 'batch-2026.07:artwork_42');
assert.equal(pkg.config.productionJobDigest, 'b'.repeat(64));
assert.equal(pkg.config.led.pixels, 44);
assert.deepEqual(pkg.config.controls.encoder.patternCycleIds, ['scanner', 'aurora', 'ember']);

for (const invalidIdentity of [
  { projectRevision: -1, projectFingerprint: 'a'.repeat(16) },
  { projectRevision: 1.5, projectFingerprint: 'a'.repeat(16) },
  { projectRevision: 1, projectFingerprint: 'A'.repeat(16) },
  { projectRevision: 1, projectFingerprint: 'a'.repeat(65) },
  { productionJobId: 'job id with spaces' },
  { productionJobId: 'x'.repeat(97) },
  { productionJobDigest: 'b'.repeat(63) },
  { productionJobDigest: 'B'.repeat(64) },
  { productionJobId: 'job-42' },
  { productionJobDigest: 'b'.repeat(64) },
]) {
  assert.throws(() => makeCardRuntimePackage(invalidIdentity), /revision|fingerprint|production job/i);
}

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
  projectId: 'lwproj-customer-v3',
  projectName: 'Customer V3',
  projectRevision: 11,
  projectFingerprint: 'c'.repeat(16),
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
    controls: { encoder: { press: 6, alternatePress: -1, patternCycleIds: ['ember', 'scanner'] } },
  },
});
assert.equal(projectPkg.config.piece.id, 'lwproj-customer-v3');
assert.equal(projectPkg.config.piece.name, 'Customer V3');
assert.equal(projectPkg.config.projectRevision, 11);
assert.equal(projectPkg.config.projectFingerprint, 'c'.repeat(16));
assert.equal(projectPkg.config.led.pixels, 20);
assert.equal(projectPkg.config.led.colorOrder, 'GRB');
assert.equal(projectPkg.config.led.brightnessLimit, 0.55);
assert.equal(projectPkg.config.controls.encoder.press, 6);
assert.equal(projectPkg.config.controls.encoder.alternatePress, -1);
assert.deepEqual(projectPkg.config.controls.encoder.patternCycleIds, ['ember', 'scanner']);
assert.deepEqual(projectPkg.config.zones.map(zone => zone.patternId), ['ember']);

const customControlsPkg = buildCardRuntimePackageFromProject({
  projectName: 'Custom controls',
  standaloneController: {
    outputs: [{ id: 'main', name: 'Main', pin: 16, pixels: 44 }],
    controls: {
      encoder: {
        a: 10,
        b: 11,
        press: 12,
        alternatePress: 13,
        rotateDirection: 'clockwise-dimmer',
        brightnessStep: 7,
        patternCycleIds: ['ember', 'scanner'],
      },
      previous: 14,
      next: 15,
      blackout: 19,
      brightness: 20,
      statusLed: 47,
    },
  },
});
assert.deepEqual(customControlsPkg.config.controls, {
  encoder: {
    a: 10,
    b: 11,
    press: 12,
    alternatePress: 13,
    rotateDirection: 'clockwise-dimmer',
    brightnessStep: 7,
    patternCycleIds: ['ember', 'scanner'],
  },
  previous: 14,
  next: 15,
  blackout: 19,
  brightness: 20,
  statusLed: 47,
});

assert.throws(() => buildCardRuntimePackageFromProject({
  projectName: 'Conflicting controls',
  standaloneController: {
    outputs: [{ id: 'main', name: 'Main', pin: 16, pixels: 44 }],
    controls: { encoder: { a: 16, b: 5 } },
  },
}), /control.*GPIO 16.*LED output|LED output.*GPIO 16/i);

const fullPiece395Pkg = buildCardRuntimePackageFromProject({
  projectId: 'lwproj-395',
  projectName: '395 LED Piece',
  strips: [{ id: 'main', name: 'Main', pixelCount: 395 }],
  standaloneController: {
    outputs: [
      { id: 'out1', name: 'Output 1', pin: 16, pixels: 395 },
      { id: 'out2', name: 'Output 2', pin: 17, pixels: 0 },
      { id: 'out3', name: 'Output 3', pin: 18, pixels: 0 },
      { id: 'out4', name: 'Output 4', pin: 21, pixels: 0 },
    ],
  },
});
assert.equal(fullPiece395Pkg.config.led.pixels, 395);
assert.deepEqual(
  fullPiece395Pkg.config.led.outputs.map(output => ({ pin: output.pin, pixels: output.pixels })),
  [{ pin: 16, pixels: 395 }],
);
assert.deepEqual(fullPiece395Pkg.config.zones[0].ranges, [{ start: 0, count: 395 }]);

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
assert.equal(playlistComboPkg.config.looks[0].zones, undefined);
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

const savedAnalogBrightnessPkg = buildCardRuntimePackageFromProject({
  projectName: 'Saved Analog Brightness',
  standaloneController: {
    controls: {
      brightness: 1,
    },
  },
});
assert.equal(savedAnalogBrightnessPkg.config.controls.brightness, 1);

const gallerySectionCounts = [46, 46, 46, 45, 45, 45, 45, 45, 45, 45];
const galleryStrips = gallerySectionCounts.map((pixelCount, index) => ({
  id: `section-${index + 1}`,
  name: `Section ${index + 1}`,
  pixelCount,
}));
const galleryPatchBoard = {
  patches: gallerySectionCounts.map((pixelCount, index) => ({
    id: `section-${index + 1}`,
    name: `Section ${index + 1}`,
    source: {
      type: 'strip',
      stripId: `section-${index + 1}`,
      startLed: 0,
      endLed: pixelCount - 1,
    },
    output: { mode: 'on' },
    playback: { patternId: 'aurora' },
  })),
};
const compactGalleryPackage = buildCardRuntimePackageFromProject({
  projectId: 'lwproj-gallery-453',
  projectName: 'Gallery 453',
  strips: galleryStrips,
  patchBoard: galleryPatchBoard,
  standaloneController: {
    outputs: [{ id: 'out1', name: 'Output 1', pin: 16, pixels: 453 }],
    defaultLook: { patternId: 'aurora' },
  },
});
assert.equal(compactGalleryPackage.config.led.pixels, 453);
assert.equal(compactGalleryPackage.config.zones.length, 10);
assert.deepEqual(compactGalleryPackage.config.patterns.map(pattern => pattern.id), ['aurora']);
assert.ok(
  Buffer.byteLength(JSON.stringify(compactGalleryPackage.config), 'utf8') < 3800,
  '453-pixel gallery card config should stay below the firmware NVS string budget',
);

console.log('card-runtime-contract tests passed');
