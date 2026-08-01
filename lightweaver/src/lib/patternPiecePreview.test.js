import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSectionTargets } from './sectionLookModel.js';
import {
  applyPatternPreviewSegmentLooks,
  buildPatternPreviewSegments,
  fitPreviewViewBox,
  readPatternPreviewUiState,
  writePatternPreviewUiState,
} from './patternPiecePreview.js';
import { compilePattern, normalizePalette, renderPixelFrame } from './frameEngine.js';

const strips = [{
  id: 'petal-strip',
  name: 'Petals',
  offsetX: 100,
  offsetY: 20,
  pixels: [
    { x: 0, y: 0, index: 0 },
    { x: 10, y: 10, index: 1 },
    { x: 20, y: 20, index: 2 },
    { x: 30, y: 30, index: 3 },
  ],
}, {
  id: 'center-strip',
  name: 'Center',
  pixels: [
    { x: 300, y: 150, index: 0 },
    { x: 310, y: 150, index: 1 },
  ],
}, {
  id: 'art-only-layer',
  name: 'Artwork only',
  pixels: [],
}];

const patchBoard = {
  physicalLocked: false,
  dataWireCount: 1,
  chains: [{
    id: 'main',
    name: 'Main physical strip',
    rowIds: ['center', 'art-only', 'petal-tail', 'petal-head'],
  }],
  groups: [],
  patches: [{
    id: 'petal-head',
    name: 'Petal head',
    source: { type: 'strip', stripId: 'petal-strip', startLed: 0, endLed: 1 },
    output: { mode: 'normal' },
    playback: { patternId: 'fire', brightness: 0.4, speed: 1.5 },
  }, {
    id: 'center',
    name: 'Center',
    source: { type: 'strip', stripId: 'center-strip', startLed: 0, endLed: 1 },
    output: { mode: 'normal' },
    playback: { patternId: 'ocean', brightness: 0.8, speed: 0.7 },
  }, {
    id: 'petal-tail',
    name: 'Petal tail',
    source: { type: 'strip', stripId: 'petal-strip', startLed: 3, endLed: 2 },
    output: { mode: 'normal' },
    playback: { patternId: 'sparkle' },
  }, {
    id: 'art-only',
    name: 'Artwork only',
    source: { type: 'strip', stripId: 'art-only-layer', startLed: 0, endLed: 8 },
    output: { mode: 'normal' },
    playback: { patternId: 'aurora' },
  }],
};

test('preview segments include only real LED ranges in physical wiring order', () => {
  const targets = deriveSectionTargets({ strips, patchBoard, defaultLook: { patternId: 'aurora' } });
  const segments = buildPatternPreviewSegments({ strips, patchBoard, targets });
  const targetIds = targets
    .filter(target => target.kind === 'section' && target.id !== 'art-only')
    .map(target => target.id);

  assert.deepEqual(segments.map(segment => segment.id), targetIds);
  assert.deepEqual(segments.map(segment => segment.pixels.length), [2, 2, 2]);
  assert.deepEqual(segments[1].pixels.map(pixel => [pixel.x, pixel.y]), [[130, 50], [120, 40]]);
});

test('preview segments preserve each target assignment and an unsaved draft override', () => {
  const targets = deriveSectionTargets({ strips, patchBoard, defaultLook: { patternId: 'aurora' } });
  const draftTarget = targets.find(target => target.id.includes('2-3'));
  const effectiveTargets = targets.map(target => target.id === draftTarget.id
    ? {
        ...target,
        look: {
          ...target.look,
          patternId: 'plasma',
          brightness: 0.33,
          speed: 1.75,
          hueShift: -24,
          customHue: 160,
          customSaturation: 91,
          customBreathe: true,
          customDrift: true,
        },
      }
    : target);

  const segments = buildPatternPreviewSegments({ strips, patchBoard, targets: effectiveTargets });
  const draft = segments.find(segment => segment.id === draftTarget.id);
  const saved = segments.find(segment => segment.id === 'center');

  assert.equal(saved.patternId, 'ocean');
  assert.deepEqual(draft.visualLook, effectiveTargets.find(target => target.id === draftTarget.id).look);
  assert.equal(draft.patternId, 'plasma');
  assert.equal(draft.brightness, 0.33);
  assert.equal(draft.speed, 1.75);
  assert.equal(draft.hueShift, 0, 'the firmware-faithful visual post-pass owns hue shift');
  assert.ok(Array.isArray(draft.palette) && draft.palette.length > 0);
});

test('selected-target viewBox tightly fits actual mapped geometry with padding', () => {
  const viewBox = fitPreviewViewBox([{
    pixels: [{ x: 100, y: 20 }, { x: 130, y: 50 }],
  }], '0 0 640 400');

  assert.equal(viewBox, '96 16 38 38');
});

test('preview UI state is isolated per project and falls back when a target was deleted', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  writePatternPreviewUiState({
    projectId: 'piece-a',
    state: { mode: 'piece', lastTargetId: 'petal-tail' },
    storage,
  });
  writePatternPreviewUiState({
    projectId: 'piece-b',
    state: { mode: 'strip', lastTargetId: 'center' },
    storage,
  });

  assert.deepEqual(readPatternPreviewUiState({
    projectId: 'piece-a', targetIds: ['center', 'petal-tail'], storage,
  }), { mode: 'piece', lastTargetId: 'petal-tail', restored: true });
  assert.deepEqual(readPatternPreviewUiState({
    projectId: 'piece-a', targetIds: ['center'], storage,
  }), { mode: 'piece', lastTargetId: 'center', restored: true });
  assert.deepEqual(readPatternPreviewUiState({
    projectId: 'piece-b', targetIds: ['center', 'petal-tail'], storage,
  }), { mode: 'strip', lastTargetId: 'center', restored: true });
});

test('whole-piece rendering supports a palette and firmware color look per segment', () => {
  const fn = compilePattern('gradient');
  const segments = [{
    id: 'warm',
    patternId: 'gradient',
    pixels: [{ x: 0, y: 0 }],
    visualLook: { customHue: 32, customSaturation: 230 },
  }, {
    id: 'cool',
    patternId: 'gradient',
    pixels: [{ x: 1, y: 0 }],
    visualLook: { customHue: 96, customSaturation: 230, customBreathe: true },
  }];
  const stripsForFrame = segments.map(segment => ({
    ...segment,
    pts: segment.pixels.map((pixel, index) => ({ ...pixel, p: index })),
  }));
  const frame = renderPixelFrame({
    t: 1,
    strips: stripsForFrame,
    patternId: 'gradient',
    activeFn: fn,
    perStripFns: new Map([['gradient', fn]]),
    perStripPalettes: new Map([
      ['warm', normalizePalette(['#ff0000', '#ff0000'])],
      ['cool', normalizePalette(['#0000ff', '#0000ff'])],
    ]),
  });
  assert.deepEqual(frame.pixels[0], { r: 255, g: 0, b: 0 });
  assert.deepEqual(frame.pixels[1], { r: 0, g: 0, b: 255 });
  const pixels = applyPatternPreviewSegmentLooks(frame.pixels, segments, 1000);

  assert.deepEqual(pixels[0], { r: 255, g: 0, b: 0 });
  assert.notDeepEqual(pixels[1], pixels[0]);
  assert.ok(pixels[1].b > 0 || pixels[1].g > 0);
});
