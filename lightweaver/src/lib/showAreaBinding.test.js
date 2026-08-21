import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindFields, bindAreas, bindPixelIndex } from './showAreaBinding.js';

const TAU = Math.PI * 2;

function px(outputIndex, stripId, stripProgress, x, y) {
  const radius = Math.hypot(x, y);
  const angle = Math.atan2(y, x) < 0 ? Math.atan2(y, x) + TAU : Math.atan2(y, x);
  return { outputIndex, stripId, stripIndex: 0, stripProgress, x, y, radius, angle };
}

test('pixelIndex is sorted by instance and instanceStart partitions exactly', () => {
  const template = [
    px(0, 'a', 0), px(1, 'a', 0.5), px(2, 'a', 1),
    px(3, 'b', 0), px(4, 'b', 1),
  ];
  const areas = [{
    areaId: 'motif', fieldId: null,
    instances: [
      { stripIds: ['b'], wedgeIndex: 0, flip: false },
      { stripIds: ['a'], wedgeIndex: 1, flip: false },
    ],
  }];
  const [binding] = bindAreas(areas, [], template, new Map());

  assert.equal(binding.fold, 2);
  assert.equal(binding.count, 5);
  assert.equal(binding.instanceStart.length, 3);
  assert.equal(binding.instanceStart[0], 0);
  assert.equal(binding.instanceStart[2], 5);

  // instance 0 owns strip 'b' (2 pixels), instance 1 owns strip 'a' (3 pixels)
  assert.equal(binding.instanceStart[1], 2);

  // Every run is contiguous and covers exactly [start, end).
  let cursor = 0;
  for (let k = 0; k < binding.fold; k += 1) {
    const start = binding.instanceStart[k];
    const end = binding.instanceStart[k + 1];
    assert.equal(start, cursor);
    cursor = end;
  }
  assert.equal(cursor, binding.count);

  // Within instance 1 (strip 'a'), pixelIndex ascends by outputIndex.
  const instance1 = Array.from(
    binding.pixelIndex.slice(binding.instanceStart[1], binding.instanceStart[2]),
  );
  assert.deepEqual(instance1, [...instance1].sort((x1, y1) => x1 - y1));
  assert.deepEqual(instance1, [0, 1, 2]);

  const instance0 = Array.from(
    binding.pixelIndex.slice(binding.instanceStart[0], binding.instanceStart[1]),
  );
  assert.deepEqual(instance0, [3, 4]);
});

test('angularOrder for a synthetic 6-fold ring is a permutation using each rank once', () => {
  const fold = 6;
  const template = [];
  const instances = [];
  for (let k = 0; k < fold; k += 1) {
    // Deliberately NOT declared in angular order, so the binder must sort by
    // measured angle rather than trust array position.
    const shuffledK = (k * 5) % fold; // a permutation of 0..5
    const angle = (shuffledK / fold) * TAU;
    const stripId = `ring-${k}`;
    template.push(px(k, stripId, 0.5, Math.cos(angle) * 10, Math.sin(angle) * 10));
    instances.push({ stripIds: [stripId], wedgeIndex: shuffledK, flip: false });
  }
  const field = { id: 'ring-field', fold, centre: { x: 0, y: 0 }, rotationOffset: 0, mirror: false, scope: { kind: 'all' }, order: 0 };
  const areas = [{ areaId: 'ring', fieldId: 'ring-field', instances }];

  const fieldBindings = bindFields([field], areas, template);
  const binding = fieldBindings.get('ring-field');

  assert.equal(binding.fold, fold);
  const seen = new Set(binding.angularOrder);
  assert.equal(seen.size, fold);
  for (let rank = 0; rank < fold; rank += 1) assert.ok(seen.has(rank));
});

test('radialRank orders inner before outer', () => {
  const fold = 3;
  // wedge 0 is farthest out, wedge 1 is closest in, wedge 2 is in between.
  const radii = [5, 1, 3];
  const template = [];
  const instances = [];
  for (let k = 0; k < fold; k += 1) {
    const angle = (k / fold) * TAU;
    const stripId = `arm-${k}`;
    template.push(px(k, stripId, 0.5, Math.cos(angle) * radii[k], Math.sin(angle) * radii[k]));
    instances.push({ stripIds: [stripId], wedgeIndex: k, flip: false });
  }
  const field = { id: 'radial-field', fold, centre: { x: 0, y: 0 }, rotationOffset: 0, mirror: false, scope: { kind: 'all' }, order: 0 };
  const areas = [{ areaId: 'arms', fieldId: 'radial-field', instances }];

  const fieldBindings = bindFields([field], areas, template);
  const binding = fieldBindings.get('radial-field');

  // wedge 1 (radius 1) is innermost -> rank 0; wedge 0 (radius 5) outermost -> rank 2.
  assert.equal(binding.radialRank[1], 0);
  assert.equal(binding.radialRank[2], 1);
  assert.equal(binding.radialRank[0], 2);

  // Ranks strictly increase with measured radius.
  const byRank = [0, 1, 2].map((k) => binding.radialRank[k]);
  const radiiInRankOrder = byRank
    .map((rank, k) => ({ rank, radius: binding.centreRadius[k] }))
    .sort((a, b) => a.rank - b.rank)
    .map((e) => e.radius);
  for (let i = 1; i < radiiInRankOrder.length; i += 1) {
    assert.ok(radiiInRankOrder[i] >= radiiInRankOrder[i - 1]);
  }
});

test('mirrored instances have u exactly 1-stripProgress and negated angLoc', () => {
  const template = [
    px(0, 'wing', 0.2, 10, 0),
    px(1, 'wing', 0.8, 8, 4),
  ];
  const field = { id: 'wing-field', fold: 1, centre: { x: 0, y: 0 }, rotationOffset: 0, mirror: true, scope: { kind: 'all' }, order: 0 };
  const areas = [{
    areaId: 'wings',
    fieldId: 'wing-field',
    instances: [
      { stripIds: ['wing'], wedgeIndex: 0, flip: false },
      { stripIds: ['wing'], wedgeIndex: 0, flip: true },
    ],
  }];
  const fieldBindings = bindFields([field], areas, template);
  const [binding] = bindAreas(areas, [field], template, fieldBindings);

  const direct = new Map();
  const mirroredRows = new Map();
  for (let k = 0; k < binding.fold; k += 1) {
    const start = binding.instanceStart[k];
    const end = binding.instanceStart[k + 1];
    for (let i = start; i < end; i += 1) {
      const target = binding.mirrored[i] ? mirroredRows : direct;
      target.set(binding.pixelIndex[i], { u: binding.u[i], angLoc: binding.angLoc[i] });
    }
  }

  assert.equal(direct.size, 2);
  assert.equal(mirroredRows.size, 2);

  for (const [outputIndex, directRow] of direct) {
    const mirroredRow = mirroredRows.get(outputIndex);
    const stripProgress = outputIndex === 0 ? 0.2 : 0.8;
    assert.ok(Math.abs(directRow.u - stripProgress) < 1e-6);
    assert.ok(Math.abs(mirroredRow.u - (1 - stripProgress)) < 1e-6);
    assert.ok(Math.abs(mirroredRow.angLoc - (-directRow.angLoc)) < 1e-6);
  }
});

test('a 4-fold, a 6-fold, and a fold-1 area in one bind produce disjoint coverage with correct fieldOf/instanceOf', () => {
  const template = [];
  let cursor = 0;
  const push = (stripId, angle, radius) => {
    template.push(px(cursor, stripId, 0.5, Math.cos(angle) * radius, Math.sin(angle) * radius));
    cursor += 1;
  };

  const fold4Instances = [];
  for (let k = 0; k < 4; k += 1) {
    const stripId = `sq-${k}`;
    push(stripId, (k / 4) * TAU, 5);
    fold4Instances.push({ stripIds: [stripId], wedgeIndex: k, flip: false });
  }

  const fold6Instances = [];
  for (let k = 0; k < 6; k += 1) {
    const stripId = `hex-${k}`;
    push(stripId, (k / 6) * TAU, 9);
    fold6Instances.push({ stripIds: [stripId], wedgeIndex: k, flip: false });
  }

  push('solo', 0, 1);
  const soloInstances = [{ stripIds: ['solo'], wedgeIndex: 0, flip: false }];

  const fieldA = { id: 'field-4', fold: 4, centre: { x: 0, y: 0 }, rotationOffset: 0, mirror: false, scope: { kind: 'all' }, order: 0 };
  const fieldB = { id: 'field-6', fold: 6, centre: { x: 0, y: 0 }, rotationOffset: 0, mirror: false, scope: { kind: 'all' }, order: 1 };
  const fields = [fieldA, fieldB];

  const areas = [
    { areaId: 'squares', fieldId: 'field-4', instances: fold4Instances },
    { areaId: 'hexes', fieldId: 'field-6', instances: fold6Instances },
    { areaId: 'solo', fieldId: null, instances: soloInstances },
  ];

  const fieldBindings = bindFields(fields, areas, template);
  const areaBindings = bindAreas(areas, fields, template, fieldBindings);

  assert.equal(areaBindings[0].count, 4);
  assert.equal(areaBindings[1].count, 6);
  assert.equal(areaBindings[2].count, 1);

  const total = template.length;
  const { areaOf, fieldOf, instanceOf } = bindPixelIndex(areaBindings, total);

  assert.equal(areaOf.length, total);
  assert.equal(fieldOf.length, total);
  assert.equal(instanceOf.length, total);

  // Every pixel is claimed exactly once, by exactly the area it belongs to.
  const seenAreaIdx = new Set();
  for (let i = 0; i < total; i += 1) {
    assert.notEqual(areaOf[i], -1, `pixel ${i} unclaimed`);
    seenAreaIdx.add(areaOf[i]);
  }
  assert.equal(seenAreaIdx.size, 3);

  // Disjointness: no pixel index appears in more than one area's pixelIndex.
  const claimedBy = new Map();
  areaBindings.forEach((binding, areaIdx) => {
    for (let i = 0; i < binding.count; i += 1) {
      const outputIndex = binding.pixelIndex[i];
      assert.ok(!claimedBy.has(outputIndex), `pixel ${outputIndex} claimed twice`);
      claimedBy.set(outputIndex, areaIdx);
    }
  });
  assert.equal(claimedBy.size, total);

  // fieldOf agrees for every pixel in the 4-fold and 6-fold areas, and
  // differs between them; the fold-1 area has no field (-1).
  const squareIndexes = Array.from(areaBindings[0].pixelIndex);
  const hexIndexes = Array.from(areaBindings[1].pixelIndex);
  const soloIndexes = Array.from(areaBindings[2].pixelIndex);

  const squareFieldOrdinals = new Set(squareIndexes.map((i) => fieldOf[i]));
  const hexFieldOrdinals = new Set(hexIndexes.map((i) => fieldOf[i]));
  assert.equal(squareFieldOrdinals.size, 1);
  assert.equal(hexFieldOrdinals.size, 1);
  assert.notEqual([...squareFieldOrdinals][0], [...hexFieldOrdinals][0]);
  for (const i of soloIndexes) assert.equal(fieldOf[i], -1);

  // instanceOf runs 0..fold-1 exactly once each, matching wedgeIndex.
  const squareInstances = squareIndexes.map((i) => instanceOf[i]).sort((a, b) => a - b);
  assert.deepEqual(squareInstances, [0, 1, 2, 3]);
  const hexInstancesSeen = hexIndexes.map((i) => instanceOf[i]).sort((a, b) => a - b);
  assert.deepEqual(hexInstancesSeen, [0, 1, 2, 3, 4, 5]);
  assert.equal(instanceOf[soloIndexes[0]], 0);
});
