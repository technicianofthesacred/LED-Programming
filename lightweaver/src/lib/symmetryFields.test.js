import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TAU,
  SYMMETRY_MODEL_VERSION,
  DEFAULT_COPY_MAPPING,
  copyIndexOf,
  copyToInstance,
  deriveInstancePhases,
  divisorsOf,
  enumerateCopies,
  expandFieldInstances,
  fieldCopyCount,
  foldPhases,
  instanceCentroid,
  isValidFold,
  memberStripIds,
  normalizeArea,
  normalizeField,
  normalizeFields,
  readAreaSymmetry,
  resolveFieldForArea,
  resolveFieldForStrip,
  stripCentroids,
  wedgeIndexOf,
  withAreaSymmetry,
  wrap01,
  wrapTau,
} from './symmetryFields.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const SIXFOLD = { id: 'six', fold: 6, centre: { x: 0, y: 0 }, rotationOffset: 0 };

function legacyGroup(stripIds) {
  // Exactly the shape produced by layoutReducer.js stripGroupMember() and by
  // useLayoutState.js stripGroupMember() — no `symmetry` key anywhere.
  return {
    groupId: 'strip-grp-1',
    type: 'strip',
    name: 'Lotus',
    _hidden: false,
    _expanded: true,
    members: stripIds.map(id => ({
      type: 'strip',
      stripId: id,
      pathId: `layer-${id}`,
      layerId: `layer-${id}`,
      pathData: 'M0 0 L1 1',
      name: id,
      svgLength: 10,
      pixelCount: 4,
      color: '#fff',
    })),
  };
}

function wedgeArea(fold, count = fold, extra = {}) {
  return {
    version: SYMMETRY_MODEL_VERSION,
    fieldId: 'six',
    fold,
    orderMode: 'field',
    instances: Array.from({ length: count }, (_, k) => ({
      stripIds: [`s${k}`],
      wedgeIndex: k,
      flip: false,
      confirmed: true,
      source: 'field',
    })),
    ...extra,
  };
}

/** Geometry lookup placing `count` strips evenly on a circle of radius r. */
function ringGeometry(count, radius, startAngle = 0) {
  const map = new Map();
  for (let k = 0; k < count; k += 1) {
    const a = startAngle + (TAU / count) * k;
    map.set(`s${k}`, { x: Math.cos(a) * radius, y: Math.sin(a) * radius });
  }
  return map;
}

// ── numeric helpers ──────────────────────────────────────────────────────────

test('wrap helpers land inside their ranges without perturbing exact values', () => {
  assert.equal(wrap01(0), 0);
  assert.equal(wrap01(1 / 6), 1 / 6);
  assert.equal(wrap01(-1 / 6), 1 - 1 / 6);
  assert.equal(wrap01(1), 0);
  assert.equal(wrapTau(0), 0);
  assert.equal(wrapTau(-Math.PI / 2), TAU - Math.PI / 2);
  assert.equal(wrapTau(Number.NaN), 0);
});

test('divisors and the fold rule agree about what may divide N', () => {
  assert.deepEqual(divisorsOf(6), [1, 2, 3, 6]);
  assert.deepEqual(divisorsOf(12), [1, 2, 3, 4, 6, 12]);
  for (const f of [1, 2, 3, 6]) assert.equal(isValidFold(f, 6), true, `${f} divides 6`);
  for (const f of [4, 5, 7, 12]) assert.equal(isValidFold(f, 6), false, `${f} does not divide 6`);
  assert.equal(isValidFold(0, 6), false);
  assert.equal(isValidFold(-2, 6), false);
});

// ── fields ───────────────────────────────────────────────────────────────────

test('normalizeField is total — garbage yields a usable fold-1 field', () => {
  const field = normalizeField(null, 3);
  assert.equal(field.version, SYMMETRY_MODEL_VERSION);
  assert.equal(field.id, 'field-3');
  assert.equal(field.fold, 1);
  assert.deepEqual(field.centre, { x: 0, y: 0 });
  assert.equal(field.rotationOffset, 0);
  assert.equal(field.mirror, false);
  assert.deepEqual(field.scope, { kind: 'all' });
  assert.equal(field.order, 3);

  // American spelling accepted on input, canonical `centre` on output.
  assert.deepEqual(normalizeField({ center: { x: 5, y: 6 } }).centre, { x: 5, y: 6 });
  // Corrupt folds clamp rather than throw.
  assert.equal(normalizeField({ fold: -4 }).fold, 1);
  assert.equal(normalizeField({ fold: 1e9 }).fold, 64);
  // A radius scope with a null outer means unbounded.
  assert.equal(normalizeField({ scope: { kind: 'radius', inner: 10, outer: null } }).scope.outer, Infinity);
  // Normalization is idempotent.
  const once = normalizeField({ fold: 6 });
  assert.equal(normalizeField(once), once);
});

test('mirror doubles the copy count, because a mirrored kaleidoscope has 2N sectors', () => {
  assert.equal(fieldCopyCount({ fold: 6 }), 6);
  assert.equal(fieldCopyCount({ fold: 6, mirror: true }), 12);
  assert.equal(fieldCopyCount({ fold: 1, mirror: true }), 2);
});

test('wedgeIndexOf reads the wedge from the angle about the field centre', () => {
  assert.equal(wedgeIndexOf({ x: 10, y: 0 }, SIXFOLD), 0);
  assert.equal(wedgeIndexOf({ x: 0, y: 10 }, SIXFOLD), 1);
  assert.equal(wedgeIndexOf({ x: -10, y: 0 }, SIXFOLD), 3);
  assert.equal(wedgeIndexOf({ x: 0, y: -10 }, SIXFOLD), 4);
  // A fold-1 field has one wedge, whatever the angle.
  assert.equal(wedgeIndexOf({ x: -3, y: -7 }, { fold: 1 }), 0);
  // rotationOffset rotates the wedge boundaries.
  const turned = { fold: 4, centre: { x: 0, y: 0 }, rotationOffset: Math.PI / 4 };
  assert.equal(wedgeIndexOf({ x: 10, y: 0 }, turned), 3);
  assert.equal(wedgeIndexOf({ x: 10, y: 10 }, turned), 0);
  // An unknown point never throws.
  assert.equal(wedgeIndexOf(null, SIXFOLD), 0);
});

test('multiple fields coexist on one piece and resolve by ascending order, first match wins', () => {
  // The owner's case: "just the lily flower would be six and then the outer
  // spot ring would be one" — here an inner 4-fold under an outer 6-fold.
  const fields = [
    { id: 'outer', fold: 6, order: 2, centre: { x: 0, y: 0 }, scope: { kind: 'radius', inner: 60, outer: null } },
    { id: 'inner', fold: 4, order: 1, centre: { x: 0, y: 0 }, scope: { kind: 'radius', inner: 0, outer: 60 } },
  ];
  const geometry = new Map([
    ['near', { x: 10, y: 0 }],
    ['far', { x: 200, y: 0 }],
    ['nowhere', { x: 10, y: 0 }],
  ]);

  // Sorted by `order`, not by declaration order.
  assert.deepEqual(normalizeFields(fields).map(f => f.id), ['inner', 'outer']);
  assert.equal(resolveFieldForStrip('near', fields, geometry).id, 'inner');
  assert.equal(resolveFieldForStrip('near', fields, geometry).fold, 4);
  assert.equal(resolveFieldForStrip('far', fields, geometry).id, 'outer');
  assert.equal(resolveFieldForStrip('far', fields, geometry).fold, 6);

  // A strips-scoped field placed first overrides the radius reading for the
  // strips it names, and only those.
  const withOverride = [
    { id: 'pinned', fold: 2, order: 0, scope: { kind: 'strips', stripIds: ['near'] } },
    ...fields,
  ];
  assert.equal(resolveFieldForStrip('near', withOverride, geometry).id, 'pinned');
  assert.equal(resolveFieldForStrip('far', withOverride, geometry).id, 'outer');

  // A strip claimed by no field is fold 1 — it stands alone.
  const innerOnly = [fields[1]];
  assert.equal(resolveFieldForStrip('far', innerOnly, geometry), null);
  assert.equal(resolveFieldForStrip('near', [], geometry), null);

  // A radius field must not claim a strip it cannot measure.
  assert.equal(resolveFieldForStrip('unmeasured', fields, geometry), null);
});

test('a motif resolves to the field most of its strips sit in', () => {
  const fields = [
    { id: 'inner', fold: 4, order: 0, scope: { kind: 'radius', inner: 0, outer: 60 } },
    { id: 'outer', fold: 6, order: 1, scope: { kind: 'radius', inner: 60, outer: null } },
  ];
  const geometry = new Map([
    ['s0', { x: 200, y: 0 }],
    ['s1', { x: 0, y: 200 }],
    ['s2', { x: 10, y: 0 }],
  ]);
  const group = legacyGroup(['s0', 's1', 's2']);
  assert.equal(resolveFieldForArea(group, fields, geometry).id, 'outer');
  assert.equal(resolveFieldForArea(legacyGroup([]), fields, geometry), null);
});

// ── copies → instances ───────────────────────────────────────────────────────

test('copyToInstance offers interleaved (default) and contiguous, and they differ visibly', () => {
  const interleaved = [0, 1, 2, 3, 4, 5].map(k => copyToInstance(k, 6, 2, 'interleaved'));
  const contiguous = [0, 1, 2, 3, 4, 5].map(k => copyToInstance(k, 6, 2, 'contiguous'));
  assert.deepEqual(interleaved, [0, 1, 0, 1, 0, 1], 'alternating petals');
  assert.deepEqual(contiguous, [0, 0, 0, 1, 1, 1], 'solid arcs');
  assert.equal(DEFAULT_COPY_MAPPING, 'interleaved');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(k => copyToInstance(k, 6, 2)), interleaved);

  // fold = N: every copy is its own instance, and both mappings agree.
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(k => copyToInstance(k, 6, 6, 'interleaved')), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(k => copyToInstance(k, 6, 6, 'contiguous')), [0, 1, 2, 3, 4, 5]);
  // fold = 1: one body.
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(k => copyToInstance(k, 6, 1)), [0, 0, 0, 0, 0, 0]);
  // fold = 3 on N = 6.
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(k => copyToInstance(k, 6, 3, 'interleaved')), [0, 1, 2, 0, 1, 2]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(k => copyToInstance(k, 6, 3, 'contiguous')), [0, 0, 1, 1, 2, 2]);
});

test('enumerateCopies places each mirrored twin immediately after its wedge', () => {
  assert.deepEqual(enumerateCopies({ fold: 3 }).map(c => [c.wedgeIndex, c.flip]),
    [[0, false], [1, false], [2, false]]);
  assert.deepEqual(enumerateCopies({ fold: 3, mirror: true }).map(c => [c.wedgeIndex, c.flip]),
    [[0, false], [0, true], [1, false], [1, true], [2, false], [2, true]]);
  assert.equal(copyIndexOf(2, true, { fold: 3, mirror: true }), 5);
  assert.equal(copyIndexOf(2, true, { fold: 3 }), 2, 'flip is ignored on an unmirrored field');
  assert.equal(copyIndexOf(-1, false, { fold: 3 }), 2, 'wedge indices wrap');
});

test('a mirrored field gives two instances with flip on the second', () => {
  const instances = expandFieldInstances({ fold: 1, mirror: true });
  assert.equal(instances.length, 2);
  assert.equal(instances[0].flip, false);
  assert.equal(instances[1].flip, true);
  assert.deepEqual(instances[0].copies.map(c => c.copyIndex), [0]);
  assert.deepEqual(instances[1].copies.map(c => c.copyIndex), [1]);
  assert.deepEqual(instances.map(i => i.phase), [0, 0.5]);

  // At fold 1 the mirrored pair is ONE symmetric body, so it is not "flipped".
  const merged = expandFieldInstances({ fold: 1, mirror: true }, { fold: 1 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].flip, false);
  assert.equal(merged[0].copies.length, 2);

  // Six-fold mirrored: twelve copies, twelve instances, alternating flips.
  const twelve = expandFieldInstances({ fold: 6, mirror: true });
  assert.equal(twelve.length, 12);
  assert.deepEqual(twelve.map(i => i.flip),
    [false, true, false, true, false, true, false, true, false, true, false, true]);
});

// ── phases ───────────────────────────────────────────────────────────────────

test('a six-fold motif gets phases exactly k/6', () => {
  const phases = foldPhases(6);
  assert.equal(phases.length, 6);
  for (let k = 0; k < 6; k += 1) assert.equal(phases[k], k / 6, `phase ${k}`);

  const plan = deriveInstancePhases(wedgeArea(6), SIXFOLD);
  assert.equal(plan.fold, 6);
  assert.equal(plan.copies, 6);
  assert.equal(plan.orderMode, 'field');
  assert.equal(plan.needsUserOrder, false);
  assert.deepEqual(plan.order, [0, 1, 2, 3, 4, 5]);
  for (let k = 0; k < 6; k += 1) assert.equal(plan.phases[k], k / 6, `instance ${k}`);
  assert.deepEqual(plan.instances.map(i => i.phase), plan.phases);
});

test('direction reverses the travel without leaving [0, 1)', () => {
  // Reversed phases are `1 - k/6` wrapped, which is within one ulp of `(6-k)/6`
  // rather than bit-identical to it — so this one compares numerically.
  const expected = [0, 5 / 6, 4 / 6, 3 / 6, 2 / 6, 1 / 6];
  const near = (actual, label) => {
    assert.equal(actual.length, expected.length, label);
    actual.forEach((value, k) => {
      assert.ok(value >= 0 && value < 1, `${label} ${k} in range`);
      assert.ok(Math.abs(value - expected[k]) < 1e-12, `${label} ${k}: ${value} ≈ ${expected[k]}`);
    });
  };
  near(foldPhases(6, { direction: -1 }), 'foldPhases');
  near(deriveInstancePhases(wedgeArea(6), SIXFOLD, { direction: -1 }).phases, 'plan');
});

test('fold = 1 and spread = 0 are different, and stay different', () => {
  // fold = 1 is STRUCTURAL: one body, so exactly ONE phase exists. No spread
  // value in existence can fan it apart.
  assert.deepEqual(foldPhases(1, { spread: 1 }), [0]);
  assert.deepEqual(foldPhases(1, { spread: 0 }), [0]);
  assert.equal(foldPhases(1, { spread: 0.37 }).length, 1);

  // spread = 0 is TEMPORAL: six separate instances that merely happen to sit
  // at the same phase right now.
  const unison = foldPhases(6, { spread: 0 });
  assert.equal(unison.length, 6);
  assert.deepEqual(unison, [0, 0, 0, 0, 0, 0]);

  // The observable difference is the LENGTH of the phase table, which is what
  // every per-instance state array must be keyed off.
  const oneBody = deriveInstancePhases(wedgeArea(1, 6), SIXFOLD);
  const sixInUnison = deriveInstancePhases(wedgeArea(6), SIXFOLD, { spread: 0 });
  assert.equal(oneBody.fold, 1);
  assert.equal(oneBody.phaseTable.length, 1);
  assert.equal(sixInUnison.fold, 6);
  assert.equal(sixInUnison.phaseTable.length, 6);
  // Right now they LOOK identical on the wall — every instance at phase 0 …
  assert.deepEqual(oneBody.phases, [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(sixInUnison.phases, [0, 0, 0, 0, 0, 0]);
  // … but turning the spread dial up separates only the six-instance one.
  assert.deepEqual(deriveInstancePhases(wedgeArea(1, 6), SIXFOLD, { spread: 1 }).phases,
    [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(deriveInstancePhases(wedgeArea(6), SIXFOLD, { spread: 1 }).phases,
    [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6]);
});

test('fold = 2 on a six-fold field makes two instances of three, interleaved by default', () => {
  const plan = deriveInstancePhases(wedgeArea(2, 6), SIXFOLD);
  assert.equal(plan.fold, 2);
  assert.deepEqual(plan.order, [0, 1, 0, 1, 0, 1]);
  assert.deepEqual(plan.phases, [0, 0.5, 0, 0.5, 0, 0.5]);

  const arcs = deriveInstancePhases(wedgeArea(2, 6), SIXFOLD, { copyMapping: 'contiguous' });
  assert.deepEqual(arcs.order, [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(arcs.phases, [0, 0, 0, 0.5, 0.5, 0.5]);
});

test('a fold that does not divide N is rejected, and says so', () => {
  const area = normalizeArea(wedgeArea(4, 6), { field: SIXFOLD });
  assert.equal(area.copies, 6);
  assert.equal(area.fold, 6, 'falls back to full independence, not to one body');
  assert.equal(area.foldRejected, 4);

  const plan = deriveInstancePhases(wedgeArea(4, 6), SIXFOLD);
  assert.equal(plan.fold, 6);
  assert.equal(plan.foldRejected, 4);

  // Legal folds pass through untouched and report no rejection.
  for (const fold of [1, 2, 3, 6]) {
    const ok = normalizeArea(wedgeArea(fold, 6), { field: SIXFOLD });
    assert.equal(ok.fold, fold);
    assert.equal(ok.foldRejected, null);
  }

  // Mirroring changes N, and therefore changes which folds are legal.
  const mirrored = { ...SIXFOLD, mirror: true };
  assert.equal(normalizeArea({ fold: 4, instances: [] }, { field: mirrored }).fold, 4,
    '4 divides the 12 copies of a mirrored six-fold');
  assert.equal(normalizeArea({ fold: 5, instances: [] }, { field: mirrored }).foldRejected, 5);
});

// ── migration ────────────────────────────────────────────────────────────────

test('a group saved before this feature reads as exactly one confirmed instance', () => {
  const group = legacyGroup(['s0', 's1', 's2', 's3']);
  const area = readAreaSymmetry(group);

  assert.equal(area.legacy, true);
  assert.equal(area.fold, 1, 'one body — identical to how it renders today');
  assert.equal(area.instances.length, 1);
  assert.deepEqual(area.instances[0].stripIds, ['s0', 's1', 's2', 's3']);
  assert.equal(area.instances[0].confirmed, true);
  assert.equal(area.instances[0].source, 'legacy');
  assert.equal(area.instances[0].flip, false);
  assert.equal(area.unassignedStripIds.length, 0);

  // Nothing is rewritten on load: no `symmetry` key appears on the group.
  assert.equal('symmetry' in group, false);
  assert.equal(group.members.length, 4);

  // Even with a six-fold field declared on the piece, the legacy motif stays
  // one body until the owner says otherwise.
  const withField = readAreaSymmetry(group, { field: SIXFOLD });
  assert.equal(withField.fold, 1);
  assert.equal(withField.fieldId, 'six');
  assert.equal(withField.instances.length, 1);
  assert.deepEqual(deriveInstancePhases(withField, SIXFOLD).phases, [0]);
});

test('an empty or malformed symmetry key is treated as legacy, never as an error', () => {
  const base = legacyGroup(['s0', 's1']);
  for (const symmetry of [null, undefined, {}, { instances: [] }, { instances: 'nope' }, 7]) {
    const area = readAreaSymmetry({ ...base, symmetry });
    assert.equal(area.legacy, true, `symmetry=${JSON.stringify(symmetry)}`);
    assert.equal(area.instances.length, 1);
    assert.deepEqual(area.instances[0].stripIds, ['s0', 's1']);
  }
  // A group with no members at all still reads without throwing.
  assert.equal(readAreaSymmetry({ groupId: 'g', type: 'strip' }).instances[0].stripIds.length, 0);
});

test('membership is read through both member key spellings the two group implementations use', () => {
  // layoutReducer.js prunes on `stripId`; useLayoutStrips.js prunes on
  // `stripId || pathId`. Members can legitimately carry either.
  const mixed = {
    groupId: 'g',
    type: 'strip',
    members: [
      { type: 'strip', stripId: 's0' },
      { type: 'path', pathId: 'p1' },
      { type: 'strip', stripId: 's0' },
      null,
    ],
  };
  assert.deepEqual(memberStripIds(mixed), ['s0', 'p1']);
});

test('stored instances are pruned to current membership and leftovers are reported, not guessed', () => {
  const group = {
    ...legacyGroup(['s0', 's1', 's2']),
    symmetry: {
      version: 1,
      fieldId: 'six',
      fold: 3,
      orderMode: 'field',
      instances: [
        { stripIds: ['s0', 'deleted'], wedgeIndex: 0, confirmed: true, source: 'field' },
        { stripIds: ['s1'], wedgeIndex: 2, confirmed: true, source: 'field' },
      ],
    },
  };
  const area = readAreaSymmetry(group, { field: SIXFOLD });
  assert.equal(area.legacy, false);
  assert.deepEqual(area.instances[0].stripIds, ['s0'], 'a deleted strip is dropped');
  assert.deepEqual(area.unassignedStripIds, ['s2'], 's2 joined the group later and is surfaced');
});

test('withAreaSymmetry attaches without mutating, and dropping restores the legacy read', () => {
  const group = legacyGroup(['s0', 's1']);
  const next = withAreaSymmetry(group, wedgeArea(2, 2), { field: { fold: 2 } });
  assert.equal('symmetry' in group, false, 'the original group is untouched');
  assert.equal(next.symmetry.fold, 2);
  assert.equal(next.groupId, group.groupId);
  assert.equal('symmetry' in withAreaSymmetry(next, null), false);
  assert.equal(readAreaSymmetry(withAreaSymmetry(next, null)).legacy, true);
});

// ── ordering fallbacks ───────────────────────────────────────────────────────

test('the rotational case takes phase straight from the wedge index, with no geometry at all', () => {
  const shuffled = {
    ...wedgeArea(6),
    instances: [4, 1, 5, 0, 3, 2].map(k => ({
      stripIds: [`s${k}`], wedgeIndex: k, flip: false, confirmed: true, source: 'field',
    })),
  };
  const plan = deriveInstancePhases(shuffled, SIXFOLD);
  assert.equal(plan.orderMode, 'field');
  assert.equal(plan.needsUserOrder, false);
  // Array order is irrelevant: wedge 4 is instance 4 wherever it is listed.
  assert.deepEqual(plan.order, [4, 1, 5, 0, 3, 2]);
  assert.deepEqual(plan.phases, [4 / 6, 1 / 6, 5 / 6, 0, 3 / 6, 2 / 6]);
});

test('angle ordering is a fallback only, used when there is no wedge index', () => {
  const area = {
    fold: 3,
    orderMode: 'angle',
    instances: [2, 0, 1].map(k => ({ stripIds: [`s${k}`], confirmed: true, source: 'angle' })),
  };
  const field = { id: 'three', fold: 3, centre: { x: 0, y: 0 } };
  const plan = deriveInstancePhases(area, field, { geometry: ringGeometry(3, 100) });
  assert.equal(plan.orderMode, 'angle');
  assert.equal(plan.needsUserOrder, false);
  // s2 is at 240 deg, s0 at 0 deg, s1 at 120 deg.
  assert.deepEqual(plan.order, [2, 0, 1]);
  assert.deepEqual(plan.phases, [2 / 3, 0, 1 / 3]);
});

test('a set clustered in one corner refuses to invent an order', () => {
  const geometry = new Map([
    ['s0', { x: Math.cos(0) * 100, y: Math.sin(0) * 100 }],
    ['s1', { x: Math.cos(0.2) * 100, y: Math.sin(0.2) * 100 }],
    ['s2', { x: Math.cos(0.4) * 100, y: Math.sin(0.4) * 100 }],
  ]);
  const area = {
    fold: 3,
    orderMode: 'angle',
    instances: ['s0', 's1', 's2'].map(id => ({ stripIds: [id], confirmed: false, source: 'angle' })),
  };
  const field = { id: 'three', fold: 3, centre: { x: 0, y: 0 } };
  const plan = deriveInstancePhases(area, field, { geometry });

  assert.equal(plan.needsUserOrder, true);
  assert.equal(plan.orderReason, 'clustered');
  assert.equal(plan.order, null, 'no order is invented');
  // It still renders — honestly, in unison — rather than failing.
  assert.deepEqual(plan.phases, [0, 0, 0]);
  assert.deepEqual(plan.instances.map(i => i.order), [null, null, null]);

  // The same three strips spread evenly around the centre DO get an order.
  const spreadOut = deriveInstancePhases(area, field, { geometry: ringGeometry(3, 100) });
  assert.equal(spreadOut.needsUserOrder, false);
  assert.deepEqual(spreadOut.order, [0, 1, 2]);
});

test('unknown geometry refuses too, rather than ordering from a faked position', () => {
  const area = {
    fold: 2,
    orderMode: 'angle',
    instances: [{ stripIds: ['s0'] }, { stripIds: ['ghost'] }],
  };
  const plan = deriveInstancePhases(area, { fold: 2, centre: { x: 0, y: 0 } }, {
    geometry: new Map([['s0', { x: 100, y: 0 }]]),
  });
  assert.equal(plan.needsUserOrder, true);
  assert.equal(plan.orderReason, 'missing-geometry');
  assert.equal(plan.order, null);
});

test('manual mode keeps array order and honours an authored phase', () => {
  const area = {
    fold: 3,
    orderMode: 'manual',
    instances: [
      { stripIds: ['a'] },
      { stripIds: ['b'], phase: 0.9 },
      { stripIds: ['c'] },
    ],
  };
  const plan = deriveInstancePhases(area, { fold: 3, centre: { x: 0, y: 0 } });
  assert.equal(plan.orderMode, 'manual');
  assert.deepEqual(plan.order, [0, 1, 2]);
  assert.deepEqual(plan.phases, [0, 0.9, 2 / 3]);

  // An authored phase is ignored in field mode — there the structure decides.
  const structural = deriveInstancePhases({
    ...area,
    orderMode: 'field',
    instances: area.instances.map((inst, k) => ({ ...inst, wedgeIndex: k })),
  }, { fold: 3, centre: { x: 0, y: 0 } });
  assert.deepEqual(structural.phases, [0, 1 / 3, 2 / 3]);
});

test('field mode with no wedge index degrades to angle when geometry exists, manual when it does not', () => {
  const area = {
    fold: 3,
    orderMode: 'field',
    instances: [2, 0, 1].map(k => ({ stripIds: [`s${k}`] })),
  };
  const field = { id: 'three', fold: 3, centre: { x: 0, y: 0 } };

  const viaAngle = deriveInstancePhases(area, field, { geometry: ringGeometry(3, 100) });
  assert.equal(viaAngle.orderMode, 'angle');
  assert.equal(viaAngle.orderReason, 'no-wedge-index');
  assert.deepEqual(viaAngle.order, [2, 0, 1]);

  const viaManual = deriveInstancePhases(area, field);
  assert.equal(viaManual.orderMode, 'manual');
  assert.deepEqual(viaManual.order, [0, 1, 2]);
});

test('four motifs sharing one field agree on instance ordering, whether authored via wedgeIndex or derived from geometry alone', () => {
  // Each motif declares its 6 instances in a DIFFERENT array order (a
  // different authoring history), and two of the four have NO stored
  // wedgeIndex at all — only geometry. All four must still agree on what
  // phase "the strip at wedge W" gets, because that is the whole point of
  // declaring the symmetry once at the field.
  function phaseByWedge(area, geometry) {
    const plan = deriveInstancePhases(area, SIXFOLD, { spread: 1, geometry });
    const byWedge = {};
    area.instances.forEach((inst, i) => {
      const wedge = Number.isFinite(inst.wedgeIndex) ? inst.wedgeIndex : wedgeIndexOf(
        instanceCentroid(inst.stripIds, geometry), SIXFOLD,
      );
      byWedge[wedge] = plan.phases[i];
    });
    return byWedge;
  }

  const orders = [
    [0, 1, 2, 3, 4, 5],
    [4, 1, 5, 0, 3, 2],
    [3, 1, 4, 0, 5, 2],
    [2, 5, 0, 3, 1, 4],
  ];

  // Motifs A and B carry an authored wedgeIndex ('field' mode).
  const motifA = {
    fold: 6,
    orderMode: 'field',
    instances: orders[0].map(w => ({ stripIds: [`a${w}`], wedgeIndex: w, confirmed: true, source: 'field' })),
  };
  const motifB = {
    fold: 6,
    orderMode: 'field',
    instances: orders[1].map(w => ({ stripIds: [`b${w}`], wedgeIndex: w, confirmed: true, source: 'field' })),
  };

  // Motifs C and D carry NO wedgeIndex at all — only geometry, forcing the
  // 'angle' fallback to derive each instance's field wedge for itself. The
  // ring is offset by half a sector so every point sits at a wedge CENTRE
  // rather than exactly on a wedge boundary, where floating-point rounding
  // in atan2/cos/sin could otherwise tip a point into the neighbouring
  // sector — a numerical fragility of wedgeIndexOf's floor(), not something
  // this test is trying to probe.
  const ringC = ringGeometry(6, 100, (TAU / 6) / 2);
  const motifC = {
    fold: 6,
    orderMode: 'field',
    instances: orders[2].map(w => ({ stripIds: [`s${w}`] })),
  };
  const motifD = {
    fold: 6,
    orderMode: 'field',
    instances: orders[3].map(w => ({ stripIds: [`s${w}`] })),
  };

  const byWedgeA = phaseByWedge(motifA, null);
  const byWedgeB = phaseByWedge(motifB, null);
  const byWedgeC = phaseByWedge(motifC, ringC);
  const byWedgeD = phaseByWedge(motifD, ringC);

  assert.deepEqual(byWedgeA, byWedgeB);
  assert.deepEqual(byWedgeA, byWedgeC);
  assert.deepEqual(byWedgeA, byWedgeD);
});

test('an empty instance (a gap in a partial fold) does not knock a motif out of field-mode ordering', () => {
  // 4 of 6 copies present, declared in NON-wedge array order, plus two
  // explicit empty placeholder slots (no strips, no wedgeIndex — exactly
  // what a save/reload round trip produces for the missing copies). The
  // populated instances must still get their true field-order phase, not
  // an array-position phase.
  const partial = {
    fold: 6,
    orderMode: 'field',
    instances: [
      { stripIds: ['s4'], wedgeIndex: 4, confirmed: true, source: 'field' },
      { stripIds: ['s1'], wedgeIndex: 1, confirmed: true, source: 'field' },
      { stripIds: ['s5'], wedgeIndex: 5, confirmed: true, source: 'field' },
      { stripIds: ['s0'], wedgeIndex: 0, confirmed: true, source: 'field' },
      { stripIds: [], wedgeIndex: null, confirmed: false, source: 'field' },
      { stripIds: [], wedgeIndex: null, confirmed: false, source: 'field' },
    ],
  };
  const plan = deriveInstancePhases(partial, SIXFOLD, { spread: 1 });
  assert.equal(plan.orderMode, 'field', 'a gap must not demote the whole motif to manual/array order');
  assert.equal(plan.phases[0], 4 / 6, 's4 (wedge 4)');
  assert.equal(plan.phases[1], 1 / 6, 's1 (wedge 1)');
  assert.equal(plan.phases[2], 5 / 6, 's5 (wedge 5)');
  assert.equal(plan.phases[3], 0, 's0 (wedge 0)');
});

test('partial fold survives a JSON save/reload round trip with the gap preserved and timing unchanged', () => {
  const group = {
    groupId: 'g1', type: 'strip', name: 'Lotus',
    members: ['s0', 's1', 's2', 's3'].map(id => ({ type: 'strip', stripId: id })),
  };
  const symmetry = {
    fold: 6,
    orderMode: 'field',
    instances: [
      { stripIds: ['s0'], wedgeIndex: 0, confirmed: true, source: 'field' },
      { stripIds: ['s1'], wedgeIndex: 1, confirmed: true, source: 'field' },
      { stripIds: ['s2'], wedgeIndex: 2, confirmed: true, source: 'field' },
      { stripIds: ['s3'], wedgeIndex: 3, confirmed: true, source: 'field' },
      { stripIds: [], wedgeIndex: 4, confirmed: false, source: 'field' },
      { stripIds: [], wedgeIndex: 5, confirmed: false, source: 'field' },
    ],
  };

  const saved = withAreaSymmetry(group, symmetry, { field: SIXFOLD });
  // Simulate an actual save/reload: serialize to JSON and back.
  const reloadedGroup = JSON.parse(JSON.stringify(saved));
  const reread = readAreaSymmetry(reloadedGroup, { field: SIXFOLD });

  assert.equal(reread.fold, 6, 'authored fold survives the round trip');
  assert.equal(reread.instances.length, 6, 'the empty slots are preserved, not dropped');
  assert.equal(reread.instances[4].stripIds.length, 0);
  assert.equal(reread.instances[5].stripIds.length, 0);

  const plan = deriveInstancePhases(reread, SIXFOLD, { spread: 1 });
  const full = deriveInstancePhases({
    fold: 6,
    orderMode: 'field',
    instances: [0, 1, 2, 3, 4, 5].map(w => ({ stripIds: [`s${w}`], wedgeIndex: w, confirmed: true, source: 'field' })),
  }, SIXFOLD, { spread: 1 });

  // Surviving instances (0-3) get IDENTICAL phases before and after the
  // round trip, whether or not the other two copies exist — a gap in the
  // wave, never a re-timed wave.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(plan.phases[i], full.phases[i]);
  }
});

// ── geometry helpers ─────────────────────────────────────────────────────────

test('instanceCentroid is pixel-count weighted and null when nothing is known', () => {
  const geometry = new Map([
    ['a', { x: 0, y: 0, weight: 3 }],
    ['b', { x: 10, y: 0, weight: 1 }],
  ]);
  assert.deepEqual(instanceCentroid(['a', 'b'], geometry), { x: 2.5, y: 0 });
  assert.deepEqual(instanceCentroid(['a'], geometry), { x: 0, y: 0 });
  assert.equal(instanceCentroid(['ghost'], geometry), null);
  assert.equal(instanceCentroid([], geometry), null);
  assert.equal(instanceCentroid(['a'], null), null);
  // A partially known instance uses what it has rather than refusing.
  assert.deepEqual(instanceCentroid(['a', 'ghost'], geometry), { x: 0, y: 0 });
});

test('stripCentroids averages sampled pixels and skips strips with none', () => {
  const map = stripCentroids([
    { id: 's0', pixels: [{ x: 0, y: 0 }, { x: 4, y: 2 }] },
    { id: 's1', pixels: [] },
    { id: 's2' },
    { id: 's3', pixels: [{ x: 1, y: 1 }] },
  ]);
  assert.deepEqual(map.get('s0'), { x: 2, y: 1, weight: 2 });
  assert.equal(map.has('s1'), false);
  assert.equal(map.has('s2'), false);
  assert.deepEqual(map.get('s3'), { x: 1, y: 1, weight: 1 });
  assert.equal(stripCentroids(null).size, 0);

  // End to end: real strips → geometry → field resolution. s3's centroid sits
  // at r = √2 ≈ 1.41 (inside) and s0's at r = √5 ≈ 2.24 (outside).
  const fields = [{ id: 'inner', fold: 4, order: 0, scope: { kind: 'radius', inner: 0, outer: 2 } }];
  assert.equal(resolveFieldForStrip('s3', fields, map).id, 'inner');
  assert.equal(resolveFieldForStrip('s0', fields, map), null);
});

// ── the locked aesthetic, enforced structurally ──────────────────────────────

test('no export here can be handed an audio band — phases are authored constants only', () => {
  // The guarantee is structural: there is no argument on any of these functions
  // that a band value could occupy, so a band value physically cannot reach an
  // authored clock through this module. Pinning it as a test means a future
  // change that adds one fails here first.
  const fnSource = [foldPhases, deriveInstancePhases, expandFieldInstances, copyToInstance,
    wedgeIndexOf, normalizeField, normalizeArea, readAreaSymmetry]
    .map(fn => fn.toString())
    .join('\n');
  for (const forbidden of ['bass', 'mid', 'high', 'energy', 'centroid', 'flux', 'audio', 'band']) {
    assert.equal(new RegExp(`\\b${forbidden}\\b`, 'i').test(fnSource), false,
      `"${forbidden}" must not appear in the symmetry phase math`);
  }

  // And the output is a phase OFFSET in [0, 1), never a rate: identical for a
  // silent piece and a loud one, because there is nothing to vary it with.
  for (const phase of deriveInstancePhases(wedgeArea(6), SIXFOLD).phases) {
    assert.ok(phase >= 0 && phase < 1, `phase ${phase} is a normalized offset`);
  }
});
