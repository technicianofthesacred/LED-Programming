import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultProject, migrateProject, toLegacyProject } from './projectModel.js';

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

test('generic Studio migration rejects mapper project payloads instead of inventing a default layout', () => {
  const foreign = {
    format: 'lightweaver.mapper-project',
    version: 3,
    id: 'mapper-export',
    name: 'Mapper export',
    paths: [{ id: 'path-1', d: 'M0 0L10 10' }],
  };

  assert.equal(migrateProject(foreign), null);
});

test('current-format imports reject duplicate strip ids before reference maps can collapse them', () => {
  const saved = createDefaultProject();
  const first = { ...saved.layout.strips[0], id: 'strip-7', name: 'First' };
  const second = { ...saved.layout.strips[0], id: 'strip-7', name: 'Second' };
  saved.layout.strips = [first, second];
  saved.layout.patchBoard = {
    ...saved.layout.patchBoard,
    patches: [
      { id: 'patch-first', source: { type: 'strip', stripId: 'strip-7' }, count: 10 },
      { id: 'patch-second', source: { type: 'strip', stripId: 'strip-7' }, count: 20 },
    ],
  };

  assert.equal(migrateProject(saved), null);
});

test('migration keeps valid Kaleidoscope metadata and warns while disabling malformed mappings', () => {
  const saved = createDefaultProject();
  saved.layout.strips[0].kaleidoscope = {
    enabled: true, pointCount: 4, startLed: 1, offsets: [0, 0, 0, 0],
  };
  saved.layout.strips[1].kaleidoscope = {
    enabled: true, pointCount: 4.5, startLed: 0, offsets: [0, 0, 0, 0],
  };

  const migrated = migrateProject(saved);

  assert.deepEqual(migrated.layout.strips[0].kaleidoscope, saved.layout.strips[0].kaleidoscope);
  assert.equal(migrated.layout.strips[1].kaleidoscope, undefined);
  assert.deepEqual(migrated.layout.projectWarnings.map(({ scope, stripId, code }) => ({ scope, stripId, code })), [{
    scope: 'kaleidoscope',
    stripId: saved.layout.strips[1].id,
    code: 'point-count',
  }]);
  assert.deepEqual(
    migrateProject(migrated).layout.projectWarnings,
    migrated.layout.projectWarnings,
    'startup validation and application may migrate the same project twice',
  );
});

test('old projects load without Kaleidoscope fields and legacy export strips new metadata', () => {
  const saved = createDefaultProject();
  assert.equal(migrateProject(saved).layout.strips.some(strip => 'kaleidoscope' in strip), false);
  saved.layout.strips[0].kaleidoscope = {
    enabled: true, pointCount: 4, startLed: 0, offsets: [0, 0, 0, 0],
  };
  saved.layout.projectWarnings = [{ scope: 'kaleidoscope', stripId: saved.layout.strips[0].id, code: 'x', message: 'x' }];
  const legacy = toLegacyProject(saved);
  assert.equal(legacy.strips.some(strip => 'kaleidoscope' in strip), false);
  assert.equal('projectWarnings' in legacy, false);
});
