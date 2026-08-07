import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cardPixelTotal,
  describeCardCapacity,
  designPixelTotal,
  measuredStripPorts,
  planStripCountShares,
  shouldRescaleDrawing,
} from './designCapacity.js';

const strip = (id, pixelCount) => ({ id, pixelCount });
const port = (pin, pixelCount, role = 'strip') => ({ pin, role, pixelCount, controlKind: '' });

test('designPixelTotal sums the drawing, ignoring junk counts', () => {
  assert.equal(designPixelTotal([strip('a', 25), strip('b', 16)]), 41);
  assert.equal(designPixelTotal([strip('a', 25), { id: 'b' }, strip('c', -4)]), 25);
  assert.equal(designPixelTotal(null), 0);
});

test('measuredStripPorts keeps only counted strip ports', () => {
  const roles = [
    port(18, 41),
    port(16, 0),
    port(17, 12, 'control'),
    { pin: 21, role: 'strip', pixelCount: 8 },
  ];
  assert.deepEqual(measuredStripPorts(roles).map(entry => entry.pin), [18, 21]);
  assert.equal(cardPixelTotal(roles), 49);
});

// The development-card case this whole module exists for.
test('a small card against a large design reports short, not broken', () => {
  const result = describeCardCapacity({
    strips: [strip('outer', 250), strip('inner', 150)],
    portRoles: [port(18, 41)],
  });
  assert.equal(result.state, 'short');
  assert.equal(result.designPixels, 400);
  assert.equal(result.cardPixels, 41);
  assert.equal(result.attached, 41);
  assert.equal(result.unattached, 359);
});

test('capacity states cover matched, over and unmeasured', () => {
  assert.equal(describeCardCapacity({
    strips: [strip('a', 41)], portRoles: [port(18, 41)],
  }).state, 'matched');
  assert.equal(describeCardCapacity({
    strips: [strip('a', 30)], portRoles: [port(18, 41)],
  }).state, 'over');
  const none = describeCardCapacity({ strips: [strip('a', 400)], portRoles: [] });
  assert.equal(none.state, 'unmeasured');
  assert.equal(none.cardPixels, 0);
  assert.equal(none.unattached, 400);
});

// The regression this module was extracted to prevent: counting a 41-light bench
// card used to rewrite a hand-drawn 400-light design down to 41, because the old
// guard only protected IMPORTED artwork and drawing by hand never sets svgText.
test('a drawing the owner has touched is never rescaled automatically', () => {
  assert.equal(shouldRescaleDrawing({ starterPending: false }), false);
  assert.equal(shouldRescaleDrawing({ starterPending: false, force: false }), false);
  assert.equal(shouldRescaleDrawing({}), false);
});

test('the untouched factory placeholder may follow the card, and force always may', () => {
  assert.equal(shouldRescaleDrawing({ starterPending: true }), true);
  assert.equal(shouldRescaleDrawing({ starterPending: false, force: true }), true);
});

test('planStripCountShares splits the counted total in the drawing proportions', () => {
  assert.deepEqual(planStripCountShares([strip('a', 20), strip('b', 20)], 41), [20, 21]);
  assert.deepEqual(planStripCountShares([strip('a', 30), strip('b', 10)], 80), [60, 20]);
});

test('planStripCountShares always adds up to exactly the counted total', () => {
  for (const count of [7, 41, 99, 400, 1234]) {
    const shares = planStripCountShares([strip('a', 3), strip('b', 5), strip('c', 7)], count);
    assert.equal(shares.reduce((sum, share) => sum + share, 0), count, `total for ${count}`);
    assert.ok(shares.every(share => share >= 1), `every shape keeps a light for ${count}`);
  }
});

test('planStripCountShares refuses work it cannot do honestly', () => {
  assert.equal(planStripCountShares([], 41), null, 'no strips');
  assert.equal(planStripCountShares([strip('a', 41)], 41), null, 'already correct');
  assert.equal(planStripCountShares([strip('a', 1), strip('b', 1)], 1), null, 'fewer lights than shapes');
  assert.equal(planStripCountShares([strip('a', 10)], 0), null, 'no count');
  assert.equal(planStripCountShares([strip('a', 10)], Number.NaN), null, 'not a number');
});
