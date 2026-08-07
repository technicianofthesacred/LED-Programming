import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBenchStripView,
  compactFrameToStrip,
  maskFrameToStrip,
  templateStripIds,
  templateStripLength,
} from './benchStripView.js';

// A six-light design: three on "outer", two on "inner", one gap the chain
// crosses that belongs to no strip.
const TEMPLATE = [
  { stripId: 'outer' }, { stripId: 'outer' }, { stripId: 'outer' },
  { stripId: null },
  { stripId: 'inner' }, { stripId: 'inner' },
];
const FRAME = ['aa0000', 'bb0000', 'cc0000', '112233', '00aa00', '00bb00'];

test('templateStripIds lists each strip once, in chain order', () => {
  assert.deepEqual(templateStripIds(TEMPLATE), ['outer', 'inner']);
  assert.deepEqual(templateStripIds([]), []);
  assert.deepEqual(templateStripIds(null), []);
});

test('templateStripLength counts a strip\'s lights in the design', () => {
  assert.equal(templateStripLength(TEMPLATE, 'outer'), 3);
  assert.equal(templateStripLength(TEMPLATE, 'inner'), 2);
  assert.equal(templateStripLength(TEMPLATE, 'nope'), 0);
});

// The bench case: the chosen strip's real colours land on the first physical
// lights of the attached strip, in the design's own order, unscaled.
test('compactFrameToStrip moves the chosen strip to the front, unscaled', () => {
  assert.deepEqual(
    compactFrameToStrip(FRAME, TEMPLATE, 'outer'),
    ['aa0000', 'bb0000', 'cc0000', '000000', '000000', '000000'],
  );
  assert.deepEqual(
    compactFrameToStrip(FRAME, TEMPLATE, 'inner'),
    ['00aa00', '00bb00', '000000', '000000', '000000', '000000'],
  );
});

test('compactFrameToStrip never changes the frame length the card expects', () => {
  for (const stripId of ['outer', 'inner']) {
    assert.equal(compactFrameToStrip(FRAME, TEMPLATE, stripId).length, FRAME.length);
  }
});

test('maskFrameToStrip leaves the chosen strip exactly where it is', () => {
  assert.deepEqual(
    maskFrameToStrip(FRAME, TEMPLATE, 'inner'),
    ['000000', '000000', '000000', '000000', '00aa00', '00bb00'],
  );
});

test('an unknown strip is never silently shown as darkness', () => {
  assert.deepEqual(compactFrameToStrip(FRAME, TEMPLATE, 'missing'), FRAME);
  assert.deepEqual(applyBenchStripView(FRAME, TEMPLATE, { mode: 'compact', stripId: 'missing' }), FRAME);
});

test('the whole design is the default and passes straight through', () => {
  assert.deepEqual(applyBenchStripView(FRAME, TEMPLATE, null), FRAME);
  assert.deepEqual(applyBenchStripView(FRAME, TEMPLATE, { mode: 'whole', stripId: 'outer' }), FRAME);
  assert.deepEqual(applyBenchStripView(FRAME, TEMPLATE, { mode: 'compact', stripId: '' }), FRAME);
});

test('applyBenchStripView routes each mode to its own rule', () => {
  assert.deepEqual(
    applyBenchStripView(FRAME, TEMPLATE, { mode: 'compact', stripId: 'inner' }),
    ['00aa00', '00bb00', '000000', '000000', '000000', '000000'],
  );
  assert.deepEqual(
    applyBenchStripView(FRAME, TEMPLATE, { mode: 'mask', stripId: 'inner' }),
    ['000000', '000000', '000000', '000000', '00aa00', '00bb00'],
  );
});

// A strip longer than the attached one runs off the end rather than being
// squashed into it — the card lights the first N and the rest simply are not there.
test('a strip longer than the card is windowed by the hardware, not compressed', () => {
  const longTemplate = Array.from({ length: 400 }, () => ({ stripId: 'outer' }));
  const longFrame = longTemplate.map((_, index) => (index === 41 ? 'ff0000' : '010101'));
  const out = compactFrameToStrip(longFrame, longTemplate, 'outer');
  assert.equal(out.length, 400);
  // Untouched order: light 41 of the design is still light 41 of the frame.
  assert.equal(out[41], 'ff0000');
  assert.equal(out[0], '010101');
});
