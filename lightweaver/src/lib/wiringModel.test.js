import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WIRING_VERSION,
  makeDefaultWiring,
  migrateWiring,
  normalizeWiring,
  validateWiring,
  updateWiring,
  invalidatesVerifiedWiring,
  wiringFingerprint,
  invalidateWiringVerification,
  physicalChangeKindForCompatField,
} from './wiringModel.js';
import { createDefaultProject, migrateProject } from './projectModel.js';

const strips = [
  { id: 'a', name: 'A', pixelCount: 3 },
  { id: 'b', name: 'B', pixelCount: 2 },
];

test('default wiring creates one ascending run per strip on one output', () => {
  const wiring = makeDefaultWiring(strips);
  assert.equal(wiring.version, WIRING_VERSION);
  assert.deepEqual(wiring.outputs[0].runIds, ['run-a', 'run-b']);
  assert.deepEqual(wiring.runs.map(run => run.source), [
    { stripId: 'a', from: 0, to: 2 },
    { stripId: 'b', from: 0, to: 1 },
  ]);
});

test('legacy descending chains migrate to ascending sources and physical reverse', () => {
  const wiring = migrateWiring(null, strips, {
    chains: [{ rowIds: ['pb', 'off', 'pa'] }],
    patches: [
      { id: 'pa', source: { type: 'strip', stripId: 'a', startLed: 0, endLed: 2 } },
      { id: 'pb', source: { type: 'strip', stripId: 'b', startLed: 1, endLed: 0 } },
      { id: 'off', source: { type: 'off', ledCount: 4 } },
    ],
  });
  assert.deepEqual(wiring.outputs[0].runIds, ['pb', 'off', 'pa']);
  assert.deepEqual(wiring.runs[0].source, { stripId: 'b', from: 0, to: 1 });
  assert.equal(wiring.runs[0].physicalDirection, 'source-reverse');
  assert.equal(wiring.runs[1].type, 'inactive');
  assert.equal(wiring.runs[1].count, 4);
});

test('validation rejects duplicate IDs and pins, missing runs, repeated runs, and invalid ranges', () => {
  const wiring = normalizeWiring({
    outputs: [
      { id: 'same', pin: 16, runIds: ['r', 'missing'] },
      { id: 'same', pin: 16, runIds: ['r'] },
    ],
    runs: [{ id: 'r', type: 'strip', source: { stripId: 'a', from: 2, to: 0 }, directionPolicy: 'nope' }],
  });
  const codes = validateWiring(wiring, strips).errors.map(error => error.code);
  for (const code of ['output-id-duplicate', 'output-pin-duplicate', 'run-missing', 'run-duplicate', 'source-range-descending', 'direction-policy-invalid']) {
    assert.ok(codes.includes(code), `missing ${code}`);
  }
});

test('validation rejects branches/cycles and non-positive inactive counts', () => {
  const wiring = normalizeWiring({
    outputs: [{ id: 'o', pin: 16, runIds: ['jump', 'off'] }],
    runs: [
      { id: 'jump', type: 'cable', nextRunIds: ['off', 'jump'] },
      { id: 'off', type: 'inactive', count: 0 },
    ],
  });
  const codes = validateWiring(wiring, strips).errors.map(error => error.code);
  assert.ok(codes.includes('run-branch'));
  assert.ok(codes.includes('run-cycle'));
  assert.ok(codes.includes('inactive-count-invalid'));
});

test('validation rejects non-boolean verification on every run type', () => {
  const wiring = {
    outputs: [{ id: 'o', pin: 16, runIds: ['off'] }],
    runs: [{ id: 'off', type: 'inactive', count: 1, verified: 'yes' }],
  };
  assert.ok(validateWiring(wiring).errors.some(error => error.code === 'run-verified-invalid'));
});

test('locked verified wiring mutations return structured errors without partial mutation', () => {
  const wiring = { ...makeDefaultWiring(strips), locked: true, verified: true };
  const before = wiringFingerprint(wiring);
  const result = updateWiring(wiring, draft => { draft.outputs[0].pin = 17; });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'wiring-locked');
  assert.equal(wiringFingerprint(wiring), before);

  const unlocked = updateWiring(wiring, draft => { draft.locked = false; });
  assert.equal(unlocked.ok, true);
  assert.equal(unlocked.wiring.locked, false);

  const smuggled = updateWiring(wiring, draft => { draft.locked = false; draft.outputs[0].pin = 17; });
  assert.equal(smuggled.ok, false);
});

test('mutation validation is mandatory and returns the original model at the context boundary', () => {
  const wiring = makeDefaultWiring(strips);
  const result = updateWiring(wiring, draft => {
    draft.outputs.push({ id: 'duplicate-pin', pin: 16, runIds: [] });
  }, { strips });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.code === 'output-pin-duplicate'));
  assert.equal(wiringFingerprint(result.wiring), wiringFingerprint(wiring));
});

test('legacy configured outputs split only at complete run boundaries', () => {
  const board = {
    chains: [{ rowIds: ['a', 'b'] }],
    patches: [
      { id: 'a', source: { type: 'strip', stripId: 'a', startLed: 0, endLed: 2 } },
      { id: 'b', source: { type: 'strip', stripId: 'b', startLed: 0, endLed: 1 } },
    ],
  };
  const exact = migrateWiring(null, strips, board, { outputs: [
    { id: 'left', name: 'Left', pin: 16, pixels: 3 },
    { id: 'right', name: 'Right', pin: 17, pixels: 2 },
  ] });
  assert.deepEqual(exact.outputs, [
    { id: 'left', name: 'Left', pin: 16, runIds: ['a'] },
    { id: 'right', name: 'Right', pin: 17, runIds: ['b'] },
  ]);
  assert.deepEqual(exact.migrationWarnings, []);

  const ambiguous = migrateWiring(null, strips, board, { outputs: [
    { id: 'left', name: 'Left', pin: 16, pixels: 2 },
    { id: 'right', name: 'Right', pin: 17, pixels: 3 },
  ] });
  assert.equal(ambiguous.migrationWarnings[0].code, 'output-boundary-inside-run');
  assert.equal(ambiguous.migrationWarnings[0].runId, 'a');
});

test('physical reducer boundary maps all compat fields and invalidates precise verification', () => {
  assert.equal(physicalChangeKindForCompatField('strips'), 'geometry');
  assert.equal(physicalChangeKindForCompatField('editCounts'), 'led-count');
  assert.equal(physicalChangeKindForCompatField('stripCountOverrides'), 'led-count');
  assert.equal(physicalChangeKindForCompatField('palette'), null);

  const verified = {
    ...makeDefaultWiring(strips),
    verified: true,
    runs: makeDefaultWiring(strips).runs.map(run => ({ ...run, verified: true })),
  };
  for (const kind of ['geometry', 'led-count', 'direction', 'route', 'output', 'seam', 'controller-anchor', 'gpio']) {
    const result = invalidateWiringVerification(verified, { kind, runIds: ['run-a'] });
    assert.equal(result.ok, true, kind);
    assert.equal(result.wiring.verified, false, kind);
    assert.equal(result.wiring.runs.find(run => run.id === 'run-a').verified, false, kind);
    assert.equal(result.wiring.runs.find(run => run.id === 'run-b').verified, true, kind);
  }
  assert.equal(invalidateWiringVerification(verified, { kind: 'color' }).wiring.verified, true);
  const locked = invalidateWiringVerification({ ...verified, locked: true }, { kind: 'geometry' });
  assert.equal(locked.ok, false);
  assert.equal(locked.errors[0].code, 'wiring-locked');
});

test('per-run verification survives normalize, JSON save/load, and history-style cloning', () => {
  const wiring = makeDefaultWiring(strips);
  wiring.verified = true;
  wiring.runs[0].verified = true;
  wiring.runs[1].verified = false;
  const normalized = normalizeWiring(wiring);
  const loaded = normalizeWiring(JSON.parse(JSON.stringify(normalized)));
  const undoSnapshot = JSON.parse(JSON.stringify(loaded));
  assert.deepEqual(undoSnapshot.runs.map(run => run.verified), [true, false]);
  assert.equal(undoSnapshot.verified, true);

  const project = createDefaultProject();
  project.layout.wiring.runs[0].verified = true;
  const loadedProject = migrateProject(JSON.parse(JSON.stringify(project)));
  assert.equal(loadedProject.layout.wiring.runs[0].verified, true);

  const verifiedMutation = updateWiring(makeDefaultWiring(strips), draft => {
    draft.runs[0].verified = true;
  }, { strips, changeKind: 'verification' });
  assert.equal(verifiedMutation.ok, true);
  assert.equal(verifiedMutation.wiring.runs[0].verified, true);

  const lockedMetadata = updateWiring({ ...verifiedMutation.wiring, locked: true }, draft => {
    draft.runs[1].verified = true;
  }, { strips, changeKind: 'verification' });
  assert.equal(lockedMetadata.ok, true);
});

test('single invalidation guard distinguishes physical edits from creative edits', () => {
  for (const kind of ['geometry', 'led-count', 'direction', 'route', 'output', 'seam', 'controller-anchor', 'gpio']) {
    assert.equal(invalidatesVerifiedWiring(kind), true, kind);
  }
  for (const kind of ['color', 'name', 'look']) assert.equal(invalidatesVerifiedWiring(kind), false, kind);
});

test('normalization preserves independent direction policy, direction, seam, and verification state', () => {
  const wiring = normalizeWiring({
    locked: true,
    verified: true,
    outputs: [{ id: 'o', pin: 16, runIds: ['r'] }],
    runs: [{ id: 'r', type: 'strip', source: { stripId: 'a', from: 0, to: 2 }, directionPolicy: 'fixed', physicalDirection: 'source-reverse', seamLed: 1 }],
  });
  assert.deepEqual(wiring.runs[0], {
    id: 'r', type: 'strip', source: { stripId: 'a', from: 0, to: 2 }, directionPolicy: 'fixed', physicalDirection: 'source-reverse', seamLed: 1, verified: false,
  });
  assert.equal(wiring.locked, true);
  assert.equal(wiring.verified, true);
});
