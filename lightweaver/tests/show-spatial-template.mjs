import assert from 'node:assert/strict';
import {
  createMandalaSpatialTemplate,
  createConnectedSpatialTemplate,
  hasUsableConnectedLayout,
} from '../src/lib/showSpatialTemplate.js';
import {
  RINGS,
  TOTAL_PIXELS,
  ringOf,
  rfOf,
  angOf,
} from '../src/lib/mandalaEngine.js';

const SAMPLE_KEYS = [
  'outputIndex',
  'stripId',
  'stripIndex',
  'stripProgress',
  'x',
  'y',
  'radius',
  'angle',
];

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, got ${actual}`);
}

// Mandala geometry is a direct spatial view of the existing 675-pixel map.
const mandala = createMandalaSpatialTemplate();
assert.equal(mandala.length, TOTAL_PIXELS);
assert.deepEqual(Object.keys(mandala[0]), SAMPLE_KEYS);
assert.deepEqual(
  RINGS.map((ring) => mandala.filter((sample) => sample.stripIndex === RINGS.indexOf(ring)).length),
  RINGS.map((ring) => ring.count),
  'each hardware ring keeps its existing pixel count',
);
for (let outputIndex = 0; outputIndex < TOTAL_PIXELS; outputIndex += 1) {
  const sample = mandala[outputIndex];
  const stripIndex = ringOf[outputIndex];
  const ring = RINGS[stripIndex];
  const pixelInRing = outputIndex - ring.start;
  assert.equal(sample.outputIndex, outputIndex);
  assert.equal(sample.stripId, `ring-${stripIndex + 1}`);
  assert.equal(sample.stripIndex, stripIndex);
  assertClose(sample.stripProgress, pixelInRing / (ring.count - 1), `pixel ${outputIndex} strip progress`);
  assertClose(sample.radius, rfOf[outputIndex], `pixel ${outputIndex} radius`);
  assertClose(sample.angle, angOf[outputIndex], `pixel ${outputIndex} angle`);
  assertClose(sample.x, Math.cos(angOf[outputIndex]) * rfOf[outputIndex], `pixel ${outputIndex} x`);
  assertClose(sample.y, Math.sin(angOf[outputIndex]) * rfOf[outputIndex], `pixel ${outputIndex} y`);
}

// Connected layouts keep strip/pixel order while producing one contiguous output.
const connected = createConnectedSpatialTemplate({
  strips: [
    { id: 'wide', pixels: [{ x: 0, y: 0 }, { x: 4, y: 0 }] },
    { id: 'detail', pixels: [{ x: 1, y: 1 }, { x: 3, y: 1 }] },
  ],
});
assert.deepEqual(connected.map(({ outputIndex, stripId, stripIndex, stripProgress }) => ({
  outputIndex,
  stripId,
  stripIndex,
  stripProgress,
})), [
  { outputIndex: 0, stripId: 'wide', stripIndex: 0, stripProgress: 0 },
  { outputIndex: 1, stripId: 'wide', stripIndex: 0, stripProgress: 1 },
  { outputIndex: 2, stripId: 'detail', stripIndex: 1, stripProgress: 0 },
  { outputIndex: 3, stripId: 'detail', stripIndex: 1, stripProgress: 1 },
]);
assert.deepEqual(connected.map(({ x, y }) => [x, y]), [
  [-1, -0.25],
  [1, -0.25],
  [-0.5, 0.25],
  [0.5, 0.25],
], 'the longer dimension fills [-1, 1] and the shorter one remains centered without distortion');
assert.deepEqual(Object.keys(connected[0]), SAMPLE_KEYS);
assertClose(connected[2].radius, Math.hypot(-0.5, 0.25), 'connected radius');
assertClose(connected[2].angle, Math.atan2(0.25, -0.5), 'connected angle');

// When a board exists, its main chain is the sole physical address authority:
// ranges may split/reverse strips and off rows reserve black addresses.
const physical = createConnectedSpatialTemplate({
  strips: [
    { id: 'a', pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }] },
    { id: 'b', pixels: [{ x: 10, y: 0 }, { x: 11, y: 0 }, { x: 12, y: 0 }] },
  ],
  hidden: { b: true },
  patchBoard: {
    chains: [{ id: 'main', rowIds: ['b-reverse', 'off', 'a-tail', 'a-head'] }],
    groups: [],
    patches: [
      { id: 'a-head', source: { type: 'strip', stripId: 'a', startLed: 0, endLed: 1 }, output: { mode: 'normal' } },
      { id: 'a-tail', source: { type: 'strip', stripId: 'a', startLed: 3, endLed: 2 }, output: { mode: 'normal' } },
      { id: 'b-reverse', source: { type: 'strip', stripId: 'b', startLed: 2, endLed: 0 }, output: { mode: 'normal' } },
      { id: 'off', source: { type: 'off', ledCount: 2 }, output: { mode: 'off' } },
    ],
  },
});
assert.equal(physical.length, 9, 'hidden and off physical addresses remain reserved');
assert.deepEqual(physical.map(sample => sample.outputIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
assert.deepEqual(physical.map(sample => sample.stripId), [null, null, null, null, null, 'a', 'a', 'a', 'a']);
assert.deepEqual(physical.slice(5).map(sample => sample.stripProgress), [1, 2 / 3, 0, 1 / 3]);

// Hidden, empty, malformed, and non-finite points never enter physical output order.
const filtered = createConnectedSpatialTemplate({
  strips: [
    { id: 'hidden', pixels: [{ x: 99, y: 99 }] },
    { id: 'empty', pixels: [] },
    null,
    { id: 'mixed', pixels: [{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }, { x: 2, y: 0 }, { x: 3, y: Infinity }] },
  ],
  hidden: { hidden: true },
});
assert.deepEqual(filtered.map(({ outputIndex, stripId, stripIndex, stripProgress }) => ({
  outputIndex,
  stripId,
  stripIndex,
  stripProgress,
})), [
  { outputIndex: 0, stripId: 'mixed', stripIndex: 3, stripProgress: 0 },
  { outputIndex: 1, stripId: 'mixed', stripIndex: 3, stripProgress: 1 },
]);
assert.equal(hasUsableConnectedLayout([
  { id: 'hidden', pixels: [{ x: 0, y: 0 }] },
  { id: 'invalid', pixels: [{ x: '0', y: 0 }, { x: 1, y: undefined }] },
], { hidden: true }), false);
assert.equal(hasUsableConnectedLayout([{ id: 'valid', pixels: [{ x: -1, y: 2 }] }]), true);
assert.equal(hasUsableConnectedLayout(), false);

// Degenerate bounds stay finite and center collapsed dimensions without division by zero.
const vertical = createConnectedSpatialTemplate({
  strips: [{ id: 'vertical', pixels: [{ x: 7, y: 2 }, { x: 7, y: 6 }] }],
});
assert.deepEqual(vertical.map(({ x, y }) => [x, y]), [[0, -1], [0, 1]]);
const point = createConnectedSpatialTemplate({
  strips: [{ id: 'point', pixels: [{ x: 7, y: 2 }] }],
});
assert.deepEqual(point.map(({ x, y, radius, angle }) => ({ x, y, radius, angle })), [
  { x: 0, y: 0, radius: 0, angle: 0 },
]);
assert.ok([...vertical, ...point].every((sample) => SAMPLE_KEYS.every((key) => (
  typeof sample[key] !== 'number' || Number.isFinite(sample[key])
))));

// Persisted or caller-provided malformed containers degrade to an empty layout.
for (const strips of [null, false, 42, {}, 'not-strips']) {
  assert.equal(hasUsableConnectedLayout(strips, null), false);
  assert.deepEqual(createConnectedSpatialTemplate({ strips, hidden: null }), []);
}
assert.deepEqual(createConnectedSpatialTemplate(null), []);
assert.equal(
  hasUsableConnectedLayout([{ id: 'visible', pixels: [{ x: 0, y: 0 }] }], null),
  true,
  'a null hidden map does not hide or crash a valid layout',
);
assert.equal(
  createConnectedSpatialTemplate({
    strips: [{ id: 'visible', pixels: [{ x: 0, y: 0 }] }],
    hidden: 'not-a-map',
  }).length,
  1,
);

// Large installations must not pass every coordinate through Math.min/max spread.
const LARGE_POINT_COUNT = 125_001;
const large = createConnectedSpatialTemplate({
  strips: [{
    id: 'large',
    pixels: Array.from({ length: LARGE_POINT_COUNT }, (_, index) => ({
      x: index,
      y: index % 2 === 0 ? 10 : 20,
    })),
  }],
});
assert.equal(large.length, LARGE_POINT_COUNT);
assert.equal(large[0].outputIndex, 0);
assert.equal(large.at(-1).outputIndex, LARGE_POINT_COUNT - 1);
assertClose(large[0].x, -1, 'large layout minimum x');
assertClose(large.at(-1).x, 1, 'large layout maximum x');
assertClose(large[0].y, -0.00008, 'large layout centered minimum y');
assertClose(large[1].y, 0.00008, 'large layout centered maximum y');

console.log('show-spatial-template tests passed');
