import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultProject, migrateProject } from './projectModel.js';

test('new projects start with one explicit physical data wire', () => {
  const project = createDefaultProject();

  assert.equal(project.layout.patchBoard.dataWireCount, 1);
  assert.equal(project.layout.patchBoard.dataWireCountNeedsReview, false);
  assert.equal(project.layout.wiring.outputs.length, 1);
});

test('migration preserves explicit saved output count and GPIO assignments', () => {
  const saved = createDefaultProject();
  delete saved.layout.patchBoard.dataWireCount;
  delete saved.layout.patchBoard.dataWireCountNeedsReview;
  saved.layout.wiring.outputs = [
    { id: 'outer-wire', name: 'Outer wire', pin: 18, runIds: saved.layout.wiring.outputs[0].runIds.slice(0, 1) },
    { id: 'inner-wire', name: 'Inner wire', pin: 21, runIds: saved.layout.wiring.outputs[0].runIds.slice(1) },
  ];

  const migrated = migrateProject(saved);

  assert.equal(migrated.layout.patchBoard.dataWireCount, 2);
  assert.equal(migrated.layout.patchBoard.dataWireCountNeedsReview, false);
  assert.deepEqual(
    migrated.layout.wiring.outputs.map(({ id, pin }) => ({ id, pin })),
    [{ id: 'outer-wire', pin: 18 }, { id: 'inner-wire', pin: 21 }],
  );
});

test('saved physical outputs repair stale duplicate count metadata without requiring review', () => {
  const saved = createDefaultProject();
  const runIds = saved.layout.wiring.outputs[0].runIds;
  saved.layout.wiring.outputs = [
    { id: 'wire-a', pin: 16, runIds: runIds.slice(0, 1) },
    { id: 'wire-b', pin: 17, runIds: runIds.slice(1) },
  ];

  const migrated = migrateProject(saved);

  assert.equal(migrated.layout.patchBoard.dataWireCount, 2);
  assert.equal(migrated.layout.patchBoard.dataWireCountNeedsReview, false);
  assert.deepEqual(migrated.layout.wiring.outputs.map(output => output.pin), [16, 17]);
});

test('ambiguous saved projects default to one data wire and require review', () => {
  const saved = createDefaultProject();
  delete saved.layout.patchBoard.dataWireCount;
  delete saved.layout.patchBoard.dataWireCountNeedsReview;
  saved.layout.wiring = null;
  saved.devices.standaloneController.outputs = saved.devices.standaloneController.outputs.map(output => ({
    ...output,
    pixels: 0,
  }));

  const migrated = migrateProject(saved);

  assert.equal(migrated.layout.patchBoard.dataWireCount, 1);
  assert.equal(migrated.layout.patchBoard.dataWireCountNeedsReview, true);
  assert.equal(migrated.layout.wiring.outputs.length, 1);
});

test('empty legacy layouts still receive safe physical wiring metadata', () => {
  const migrated = migrateProject({
    version: 2,
    projectId: 'empty-layout',
    strips: [],
    patchBoard: null,
  });

  assert.equal(migrated.layout.patchBoard.dataWireCount, 1);
  assert.equal(migrated.layout.patchBoard.dataWireCountNeedsReview, true);
  assert.equal(migrated.layout.wiring.outputs.length, 1);
});
