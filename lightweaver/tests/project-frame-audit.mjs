import assert from 'node:assert/strict';
import { PATTERNS } from '../src/lib/patterns-library.js';
import { compile, evalPixel } from '../src/lib/patterns.js';
import { createDefaultProject, migrateProject, PROJECT_VERSION } from '../src/lib/projectModel.js';
import { compilePattern, normalizePalette, renderPixelFrame } from '../src/lib/frameEngine.js';
import { makeBlackoutFrame, makeWledFrameMessage, makeWledSegments } from '../src/lib/deviceController.js';
import {
  easeCrossfade,
  formatMotionSpeed,
  smoothPixelFrame,
} from '../src/lib/motionSmoothing.js';
import {
  CUSTOM_PATTERNS_EVENT,
  CUSTOM_PATTERNS_KEY,
  CUSTOM_PATTERN_REVISIONS_KEY,
  buildCustomPatternEntry,
  buildCustomPatternId,
  deleteCustomPattern,
  loadCustomPatterns,
  saveCustomPattern,
  updateCustomPattern,
} from '../src/lib/customPatterns.js';
import {
  getPatternById,
  getPatternCode,
  isBuiltInPattern,
  listPatterns,
} from '../src/lib/patternRegistry.js';
import {
  buildAiPatternPreviewFrame,
  validateAiPatternDraft,
} from '../src/lib/aiPatternDraft.js';
import { parseParamsFromCode } from '../src/lib/patternParams.js';

const palette = normalizePalette(['#123456', '#abcdef', '#ffcc00']);
const duplicateIds = PATTERNS.map(p => p.id).filter((id, i, arr) => arr.indexOf(id) !== i);
assert.deepEqual(duplicateIds, [], 'pattern ids must be unique');

const memoryStorage = (() => {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
})();

const parsedParams = parseParamsFromCode('// @param speed float 0.25 0.05 1.0\nreturn rgb(params.speed,0,0);');
assert.deepEqual(parsedParams, [{ name: 'speed', value: 0.25, min: 0.05, max: 1, step: 0.01 }]);

assert.equal(buildCustomPatternId('Aurora Glass Drift'), 'custom_aurora_glass_drift');
assert.match(buildCustomPatternId('###'), /^custom_[a-z0-9]+$/);

const customEntry = buildCustomPatternEntry({
  name: 'Aurora Glass Drift',
  code: 'return hsv(time, 1, 1);',
  palette: ['#102a2b', '#57e7c1'],
});
assert.equal(customEntry.id, 'custom_aurora_glass_drift');
assert.equal(customEntry.custom, true);
assert.equal(customEntry.preview, 'linear-gradient(135deg,#102a2b,#57e7c1)');

saveCustomPattern(customEntry, { storage: memoryStorage, dispatch: false });
assert.equal(loadCustomPatterns({ storage: memoryStorage }).length, 1);
assert.equal(getPatternById('custom_aurora_glass_drift', { storage: memoryStorage }).name, 'Aurora Glass Drift');
assert.equal(getPatternCode('custom_aurora_glass_drift', { storage: memoryStorage }), 'return hsv(time, 1, 1);');
assert.equal(isBuiltInPattern('aurora'), true);
assert.equal(isBuiltInPattern('custom_aurora_glass_drift'), false);
assert.ok(listPatterns({ storage: memoryStorage }).some(pattern => pattern.id === 'custom_aurora_glass_drift'));

updateCustomPattern('custom_aurora_glass_drift', {
  name: 'Aurora Glass Drift',
  code: 'return hsv(0.6, 1, 1);',
  palette: ['#000000', '#ffffff'],
}, { storage: memoryStorage, dispatch: false });
const revisions = JSON.parse(memoryStorage.getItem(CUSTOM_PATTERN_REVISIONS_KEY));
assert.equal(revisions.custom_aurora_glass_drift.length, 1);
assert.equal(revisions.custom_aurora_glass_drift[0].code, 'return hsv(time, 1, 1);');
assert.equal(getPatternCode('custom_aurora_glass_drift', { storage: memoryStorage }), 'return hsv(0.6, 1, 1);');

deleteCustomPattern('custom_aurora_glass_drift', { storage: memoryStorage, dispatch: false });
assert.equal(loadCustomPatterns({ storage: memoryStorage }).length, 0);
assert.equal(CUSTOM_PATTERNS_EVENT, 'lw:custom-updated');
assert.equal(CUSTOM_PATTERNS_KEY, 'lw_custom_patterns');

saveCustomPattern({
  id: 'aurora',
  name: 'Fake Aurora',
  code: 'return rgb(1, 0, 0);',
}, { storage: memoryStorage, dispatch: false });
assert.equal(getPatternById('aurora', { storage: memoryStorage }).custom, undefined);
assert.notEqual(getPatternCode('aurora', { storage: memoryStorage }), 'return rgb(1, 0, 0);');
deleteCustomPattern('aurora', { storage: memoryStorage, dispatch: false });

const validDraft = validateAiPatternDraft({
  name: 'Soft Reef',
  description: 'Blue-green bioluminescent drift.',
  changeSummary: ['Created slow ocean motion'],
  palette: ['#001a2a', '#22e6c7', '#7aa7ff'],
  code: '// @param speed float 0.2 0.05 1.0\nconst v = fbm(x * 2 + t * params.speed, y * 2, 4);\nreturn samplePalette(v);',
  suggestedParams: { speed: 0.2 },
}, {
  strips: [{
    id: 'draft-strip',
    pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
  }],
});
assert.equal(validDraft.ok, true);
assert.equal(validDraft.draft.name, 'Soft Reef');
assert.equal(validDraft.params[0].name, 'speed');

const unsafeDraft = validateAiPatternDraft({
  name: 'Unsafe',
  description: 'Attempts browser access.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#ffffff'],
  code: 'fetch("https://example.com"); return rgb(1,1,1);',
});
assert.equal(unsafeDraft.ok, false);
assert.equal(unsafeDraft.error.kind, 'unsafe-code');

const blankDraft = validateAiPatternDraft({
  name: 'Blank',
  description: 'Accidental blackout.',
  changeSummary: ['Invalid'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(blankDraft.ok, false);
assert.equal(blankDraft.error.kind, 'blank-render');

const blackoutDraft = validateAiPatternDraft({
  name: 'Blackout',
  description: 'Intentional blackout scene.',
  changeSummary: ['Turns all LEDs off'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  instruction: 'make an intentional blackout',
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(blackoutDraft.ok, true);

const lightsOffDraft = validateAiPatternDraft({
  name: 'Lights Off',
  description: 'Intentional lights-off scene.',
  changeSummary: ['Turns all LEDs off'],
  palette: ['#000000', '#111111'],
  code: 'return rgb(0,0,0);',
}, {
  instruction: 'make the lights off',
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(lightsOffDraft.ok, true);

const previewFrame = buildAiPatternPreviewFrame(validDraft.draft, {
  strips: [{ id: 'draft-strip', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
});
assert.equal(previewFrame.pixels.length, 2);

const customParamEntry = saveCustomPattern({
  name: 'Param Glow',
  code: '// @param speed float 0.5 0 1\nreturn rgb(params.speed, 0, 0);',
}, { storage: memoryStorage, dispatch: false });
const originalLocalStorage = globalThis.localStorage;
globalThis.localStorage = memoryStorage;
try {
  assert.ok(compilePattern(customParamEntry.id), 'custom pattern should compile through frame engine registry lookup');
  const customParamFrame = renderPixelFrame({
    t: 0,
    strips: [{
      id: 'custom-param-strip',
      pts: [{ x: 0, y: 0, p: 0 }],
    }],
    patternId: customParamEntry.id,
    paletteNorm: palette,
  });
  assert.deepEqual(customParamFrame.pixels[0], { r: 128, g: 0, b: 0 });
} finally {
  if (originalLocalStorage === undefined) {
    delete globalThis.localStorage;
  } else {
    globalThis.localStorage = originalLocalStorage;
  }
}

for (const pattern of PATTERNS) {
  const { fn, error } = compile(pattern.code || 'return [0,0,0];');
  assert.equal(error, null, `${pattern.id} should compile`);
  assert.ok(fn, `${pattern.id} should return a compiled function`);
  for (const sample of [
    { index: 0, x: 0, y: 0, t: 0, time: 0, pixelCount: 1, stripProgress: 0 },
    { index: 1, x: 0.25, y: 0.5, t: 0.25, time: 0.1, pixelCount: 8, stripProgress: 0.2 },
    { index: 7, x: 1, y: 1, t: 1.5, time: 0.75, pixelCount: 8, stripProgress: 1 },
  ]) {
    const out = evalPixel(fn, sample.index, sample.x, sample.y, sample.t, sample.time, sample.pixelCount, palette, 0.25, 0.5, {}, 'audit', sample.stripProgress);
    assert.ok(Number.isFinite(out.r) && Number.isFinite(out.g) && Number.isFinite(out.b), `${pattern.id} produced invalid RGB`);
  }
}

const defaultProject = createDefaultProject();
assert.equal(defaultProject.version, PROJECT_VERSION);
assert.deepEqual(defaultProject.devices, { wledIp: '', segmentMap: {} });
assert.equal(defaultProject.pattern.motionSmoothing, 'soft');
const migratedV1 = migrateProject({
  version: 1,
  name: 'Legacy',
  strips: [{ id: 's1', name: 'Strip 1', pixelCount: 2, pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
  showClips: [{ id: 'c', track: 0, patternId: 'aurora', start: 0, end: 1 }],
  motionSmoothing: 'off',
});
assert.equal(migratedV1.version, PROJECT_VERSION);
assert.equal(migratedV1.layout.strips.length, 1);
assert.equal(migratedV1.show.clips.length, 1);
assert.equal(migratedV1.pattern.motionSmoothing, 'off');
const migratedV3 = migrateProject({
  version: PROJECT_VERSION,
  name: 'Hardware',
  pattern: { motionSmoothing: 'silk' },
  devices: { wledIp: '192.168.4.22', segmentMap: { s1: 2 } },
});
assert.equal(migratedV3.devices.wledIp, '192.168.4.22');
assert.deepEqual(migratedV3.devices.segmentMap, { s1: 2 });
assert.equal(migratedV3.pattern.motionSmoothing, 'silk');
assert.equal(migrateProject({ version: PROJECT_VERSION, pattern: { motionSmoothing: 'invalid' } }).pattern.motionSmoothing, 'soft');

const frame = renderPixelFrame({
  t: 0.2,
  strips: [{
    id: 's1',
    pts: [{ x: 0, y: 0, p: 0 }, { x: 1, y: 0, p: 1 }],
  }],
  patternId: 'aurora',
  paletteNorm: palette,
});
assert.equal(frame.pixels.length, 2);
assert.equal(frame.stripFrames.length, 1);
frame.pixels.forEach(px => {
  assert.ok(Number.isFinite(px.r) && Number.isFinite(px.g) && Number.isFinite(px.b));
});

assert.deepEqual(
  smoothPixelFrame([{ r: 100, g: 50, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'off', dt: 1 / 60 }),
  [{ r: 100, g: 50, b: 0 }],
);
const softFrame = smoothPixelFrame([{ r: 100, g: 0, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'soft', dt: 1 / 60 });
assert.ok(softFrame[0].r > 0 && softFrame[0].r < 100, 'soft smoothing moves toward target without overshoot');
const silkFrame = smoothPixelFrame([{ r: 100, g: 0, b: 0 }], [{ r: 0, g: 0, b: 0 }], { mode: 'silk', dt: 1 / 60 });
assert.ok(silkFrame[0].r > 0 && silkFrame[0].r < softFrame[0].r, 'silk smoothing is slower than soft');
assert.deepEqual(
  smoothPixelFrame([{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }], [{ r: 0, g: 0, b: 0 }], { mode: 'silk', dt: 1 / 60 }),
  [{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }],
);
assert.equal(easeCrossfade(0, 'ease-in-out'), 0);
assert.equal(easeCrossfade(1, 'ease-in-out'), 1);
assert.equal(easeCrossfade(-1, 'ease-in-out'), 0);
assert.equal(easeCrossfade(2, 'ease-in-out'), 1);
assert.equal(easeCrossfade(0.5, 'linear'), 0.5);
assert.ok(easeCrossfade(0.25, 'ease-in-out') < 0.25);
assert.ok(easeCrossfade(0.75, 'ease-in-out') > 0.75);
assert.equal(formatMotionSpeed(0.03), '0.03x');
assert.equal(formatMotionSpeed(1), '1.0x');

assert.deepEqual(makeBlackoutFrame(2), [{ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }]);
assert.deepEqual(makeWledFrameMessage([{ r: 1.2, g: 2.8, b: 300 }]).seg[0].i, [1, 3, 255]);
assert.deepEqual(makeWledSegments([{ id: 'a', pixels: [1, 2] }, { id: 'b', pixelCount: 3 }], { b: 4 }), [
  { id: 0, start: 0, stop: 2, on: true },
  { id: 4, start: 2, stop: 5, on: true },
]);

console.log('project-frame-audit passed');
