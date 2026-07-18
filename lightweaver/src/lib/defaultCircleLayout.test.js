import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultProject, migrateProject } from './projectModel.js';
import {
  DEFAULT_CIRCLE_LAYOUT_ID,
  createDefaultCircleLayout,
  isDefaultCircleLayout,
} from './defaultCircleLayout.js';

test('default circle layout creates two hardware sections with all pixels assigned', () => {
  const strips = createDefaultCircleLayout({ totalPixels: 45, sectionCount: 2 });

  assert.equal(strips.length, 2);
  assert.equal(strips[0].name, 'Outer circle');
  assert.equal(strips[1].name, 'Inner circle');
  assert.deepEqual(strips.map(strip => strip.pixelCount), [23, 22]);
  assert.equal(strips.reduce((sum, strip) => sum + strip.pixelCount, 0), 45);
  assert.equal(strips.every(strip => strip.generatedLayout === DEFAULT_CIRCLE_LAYOUT_ID), true);
  assert.equal(strips.every(strip => strip.pathData.includes('A')), true);
  assert.equal(strips.every(strip => strip.pixels.length === strip.pixelCount), true);
  assert.equal(isDefaultCircleLayout(strips), true);
});

test('default circle layout can create ten switchable hardware sections', () => {
  const strips = createDefaultCircleLayout({ totalPixels: 100, sectionCount: 10 });

  assert.equal(strips.length, 10);
  assert.equal(strips[9].name, 'Ring 10');
  assert.equal(strips.reduce((sum, strip) => sum + strip.pixelCount, 0), 100);
  assert.equal(strips.every(strip => strip.pixels.length === strip.pixelCount), true);
});

test('new projects open with the two-ring customer hardware layout', () => {
  const project = createDefaultProject();

  assert.equal(project.layout.svgText, null);
  assert.equal(project.layout.strips.length, 2);
  assert.equal(isDefaultCircleLayout(project.layout.strips), true);
  assert.equal(project.layout.strips.reduce((sum, strip) => sum + strip.pixelCount, 0), 44);
  assert.deepEqual(project.layout.strips.map(strip => strip.pixelCount), [27, 17]);
  assert.equal(project.layout.starterPending, true);
  assert.deepEqual(project.layout.patchBoard.chains[0].rowIds, [
    'patch-default-outer-circle',
    'patch-default-inner-circle',
  ]);
});

test('only explicit starter provenance survives project migration', () => {
  const fresh = createDefaultProject();
  assert.equal(migrateProject(fresh).layout.starterPending, true);

  const legacy = createDefaultProject();
  delete legacy.layout.starterPending;
  assert.equal(migrateProject(legacy).layout.starterPending, false);
});
