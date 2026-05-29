import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultCircleLayout } from './defaultCircleLayout.js';
import { createDefaultPatchBoard } from './patchBoard.js';
import { defaultStandaloneController } from './projectModel.js';
import {
  ALL_SECTIONS_TARGET_ID,
  applyLookToPatchBoard,
  deriveSectionTargets,
  normalizeSavedLooks,
  normalizeSectionVisualLook,
  applySavedLookToPatchBoard,
  saveCurrentLookToController,
} from './sectionLookModel.js';

test('deriveSectionTargets exposes all and each default hardware section', () => {
  const strips = createDefaultCircleLayout({ totalPixels: 60, sectionCount: 3 });
  const patchBoard = createDefaultPatchBoard(strips);

  const targets = deriveSectionTargets({ strips, patchBoard });

  assert.deepEqual(targets.map(target => target.id), [
    ALL_SECTIONS_TARGET_ID,
    'patch-default-outer-circle',
    'patch-default-inner-circle',
    'patch-default-ring-3',
  ]);
  assert.deepEqual(targets.map(target => target.label), [
    'All sections',
    'Outer circle',
    'Inner circle',
    'Ring 3',
  ]);
  assert.equal(targets[0].pixelCount, 60);
  assert.deepEqual(targets.slice(1).map(target => target.pixelCount), [20, 20, 20]);
});

test('applyLookToPatchBoard applies one look to every section when target is all', () => {
  const strips = createDefaultCircleLayout({ totalPixels: 44, sectionCount: 2 });
  const patchBoard = createDefaultPatchBoard(strips);
  const look = normalizeSectionVisualLook({
    patternId: 'ocean',
    brightness: 0.72,
    speed: 1.35,
    hueShift: -12,
    customHue: 144,
    customSaturation: 198,
    customBreathe: true,
    customDrift: true,
  });

  const next = applyLookToPatchBoard({
    patchBoard,
    strips,
    targetId: ALL_SECTIONS_TARGET_ID,
    look,
  });

  assert.deepEqual(next.patches.map(patch => patch.playback.patternId), ['ocean', 'ocean']);
  assert.deepEqual(next.patches.map(patch => patch.playback.customHue), [144, 144]);
  assert.deepEqual(next.patches.map(patch => patch.playback.speed), [1.35, 1.35]);
  assert.deepEqual(next.patches.map(patch => patch.playback.hueShift), [-12, -12]);
});

test('applyLookToPatchBoard applies one look to a selected section without touching others', () => {
  const strips = createDefaultCircleLayout({ totalPixels: 44, sectionCount: 2 });
  const patchBoard = createDefaultPatchBoard(strips);

  const next = applyLookToPatchBoard({
    patchBoard,
    strips,
    targetId: 'patch-default-inner-circle',
    look: {
      patternId: 'fire',
      brightness: 0.55,
      speed: 0.8,
      hueShift: 18,
      customHue: 18,
      customSaturation: 240,
    },
  });

  assert.equal(next.patches[0].playback.patternId, null);
  assert.equal(next.patches[1].playback.patternId, 'fire');
  assert.equal(next.patches[1].playback.brightness, 0.55);
  assert.equal(next.patches[1].playback.speed, 0.8);
  assert.equal(next.patches[1].playback.hueShift, 18);
});

test('saveCurrentLookToController preserves named multi-section looks', () => {
  const strips = createDefaultCircleLayout({ totalPixels: 44, sectionCount: 2 });
  const patchBoard = applyLookToPatchBoard({
    patchBoard: createDefaultPatchBoard(strips),
    strips,
    targetId: 'patch-default-inner-circle',
    look: { patternId: 'scanner', customHue: 12, speed: 1.6 },
  });
  const targets = deriveSectionTargets({ strips, patchBoard });

  const controller = saveCurrentLookToController(defaultStandaloneController(), {
    label: 'Opening glow',
    defaultLook: { patternId: 'aurora', brightness: 0.9, speed: 1.1 },
    targets,
  });

  assert.equal(controller.activeLookId, 'opening-glow');
  assert.equal(controller.looks.length, 1);
  assert.equal(controller.looks[0].label, 'Opening glow');
  assert.equal(controller.looks[0].defaultLook.patternId, 'aurora');
  assert.equal(controller.looks[0].sectionLooks['patch-default-inner-circle'].patternId, 'scanner');

  const restored = defaultStandaloneController(controller);
  assert.equal(restored.activeLookId, 'opening-glow');
  assert.equal(restored.looks[0].sectionLooks['patch-default-inner-circle'].speed, 1.6);
});

test('applySavedLookToPatchBoard restores global and section look assignments', () => {
  const strips = createDefaultCircleLayout({ totalPixels: 44, sectionCount: 2 });
  const patchBoard = createDefaultPatchBoard(strips);

  const next = applySavedLookToPatchBoard({
    patchBoard,
    strips,
    savedLook: {
      defaultLook: { patternId: 'ocean', speed: 1.2 },
      sectionLooks: {
        'patch-default-inner-circle': { patternId: 'ember', brightness: 0.4, customHue: 28 },
      },
    },
  });

  assert.equal(next.patches[0].playback.patternId, 'ocean');
  assert.equal(next.patches[0].playback.speed, 1.2);
  assert.equal(next.patches[1].playback.patternId, 'ember');
  assert.equal(next.patches[1].playback.brightness, 0.4);
  assert.equal(next.patches[1].playback.customHue, 28);
});

test('normalizeSavedLooks drops invalid entries and clamps look values', () => {
  const looks = normalizeSavedLooks([
    null,
    {
      id: 'My Look!',
      label: 'My Look!',
      defaultLook: { patternId: 'missing', brightness: 4, speed: 8, hueShift: 999 },
      sectionLooks: {
        outer: { patternId: 'ember', brightness: -1, speed: 0, hueShift: -999 },
      },
    },
  ]);

  assert.equal(looks.length, 1);
  assert.equal(looks[0].id, 'my-look');
  assert.equal(looks[0].defaultLook.patternId, 'aurora');
  assert.equal(looks[0].defaultLook.brightness, 1);
  assert.equal(looks[0].defaultLook.speed, 3);
  assert.equal(looks[0].defaultLook.hueShift, 128);
  assert.equal(looks[0].sectionLooks.outer.patternId, 'ember');
  assert.equal(looks[0].sectionLooks.outer.brightness, 0);
  assert.equal(looks[0].sectionLooks.outer.speed, 0.05);
  assert.equal(looks[0].sectionLooks.outer.hueShift, -128);
});
