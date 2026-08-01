import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_KALEIDOSCOPE_MAX_AGGREGATE_OFFSETS,
  CARD_KALEIDOSCOPE_MAX_MAPPINGS,
  CARD_KALEIDOSCOPE_MAX_SPANS_PER_MAPPING,
  compileCardKaleidoscopeMappings,
  runtimeConfigUsesKaleidoscope,
} from './cardKaleidoscope.js';
import { deriveReflectionPointIndices } from './kaleidoscope.js';

function mapping(pointCount, startLed = 0, offsets = Array(pointCount).fill(0)) {
  return { enabled: true, pointCount, startLed, offsets };
}

function strip(id, pixelCount, kaleidoscope = mapping(4)) {
  return { id, name: id, pixelCount, kaleidoscope };
}

function contiguousPixels(stripId, count, {
  start = 0,
  sourceStart = 0,
  runId = `${stripId}-run`,
  outputId = 'out1',
} = {}) {
  return Array.from({ length: count }, (_, offset) => ({
    index: start + offset,
    stripId,
    sourceLed: sourceStart + offset,
    runId,
    outputId,
    inactive: false,
  }));
}

function zone(id, ranges) {
  return { id, label: id, ranges };
}

test('compiles exact 400 and 453 pixel mappings for 4, 6, and 8 unevenly spaced points', () => {
  const cases = [
    [400, 4, [0, 100, 200, 300]],
    [400, 6, [0, 67, 133, 200, 267, 333]],
    [400, 8, [0, 50, 100, 150, 200, 250, 300, 350]],
    [453, 4, [0, 113, 227, 340]],
    [453, 6, [0, 76, 151, 227, 302, 378]],
    [453, 8, [0, 57, 113, 170, 227, 283, 340, 396]],
  ];

  for (const [pixelCount, pointCount, expectedPoints] of cases) {
    const source = strip(`frame-${pixelCount}-${pointCount}`, pixelCount, mapping(pointCount));
    const result = compileCardKaleidoscopeMappings({
      strips: [source],
      pixels: contiguousPixels(source.id, pixelCount),
      zones: [zone(source.id, [{ start: 0, count: pixelCount }])],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.mappings, [{
      id: source.id,
      zoneId: source.id,
      pixelCount,
      pointCount,
      startLed: 0,
      offsets: Array(pointCount).fill(0),
      spans: [{ start: 0, count: pixelCount, sourceStart: 0, sourceStep: 1 }],
    }]);
    assert.deepEqual(deriveReflectionPointIndices(result.mappings[0], pixelCount), expectedPoints);
  }
});

test('preserves source identity across seams, split runs, inactive gaps, and output boundaries', () => {
  const source = strip('frame', 8, mapping(4, 6));
  const pixels = [
    ...contiguousPixels('frame', 2, { start: 0, sourceStart: 6, runId: 'seam-tail', outputId: 'out1' }),
    ...contiguousPixels('frame', 2, { start: 4, sourceStart: 0, runId: 'split-a', outputId: 'out1' }),
    ...contiguousPixels('frame', 2, { start: 6, sourceStart: 2, runId: 'split-b', outputId: 'out2' }),
    ...contiguousPixels('frame', 2, { start: 8, sourceStart: 4, runId: 'split-c', outputId: 'out2' }),
  ];
  const result = compileCardKaleidoscopeMappings({
    strips: [source],
    pixels,
    zones: [zone('grouped-zone', [
      { start: 0, count: 2 },
      { start: 4, count: 2 },
      { start: 6, count: 4 },
    ])],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.mappings[0].spans, [
    { start: 0, count: 2, sourceStart: 6, sourceStep: 1 },
    { start: 4, count: 2, sourceStart: 0, sourceStep: 1 },
    { start: 6, count: 4, sourceStart: 2, sourceStep: 1 },
  ]);
  assert.equal(result.mappings[0].zoneId, 'grouped-zone');
});

test('compresses five adjacent same-output runs into one 400-pixel span', () => {
  const source = strip('adjacent-runs', 400, mapping(4, 100));
  const pixels = Array.from({ length: 5 }, (_, runIndex) => contiguousPixels(source.id, 80, {
    start: runIndex * 80,
    sourceStart: runIndex * 80,
    runId: `adjacent-${runIndex + 1}`,
    outputId: 'out1',
  })).flat();
  const result = compileCardKaleidoscopeMappings({
    strips: [source],
    pixels,
    zones: [zone(source.id, Array.from({ length: 5 }, (_, runIndex) => ({
      start: runIndex * 80,
      count: 80,
    })))],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.mappings[0].spans, [
    { start: 0, count: 400, sourceStart: 0, sourceStep: 1 },
  ]);
});

test('keeps a normal two-pixel source traversal in one span', () => {
  const source = strip('two-pixel', 2, mapping(2));
  const result = compileCardKaleidoscopeMappings({
    strips: [source],
    pixels: contiguousPixels(source.id, 2),
    zones: [zone(source.id, [{ start: 0, count: 2 }])],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.mappings[0].spans, [
    { start: 0, count: 2, sourceStart: 0, sourceStep: 1 },
  ]);
});

test('compiles exact 400-pixel split, gap, output, and seam regression spans', () => {
  const splitSource = strip('split-400', 400, mapping(4, 100));
  const splitAcrossGapAndOutputs = compileCardKaleidoscopeMappings({
    strips: [splitSource],
    pixels: [
      ...contiguousPixels(splitSource.id, 125, {
        start: 0, sourceStart: 0, runId: 'head', outputId: 'out1',
      }),
      ...contiguousPixels(splitSource.id, 150, {
        start: 128, sourceStart: 125, runId: 'middle', outputId: 'out1',
      }),
      ...contiguousPixels(splitSource.id, 125, {
        start: 278, sourceStart: 275, runId: 'tail', outputId: 'out2',
      }),
    ],
    zones: [zone(splitSource.id, [
      { start: 0, count: 125 },
      { start: 128, count: 150 },
      { start: 278, count: 125 },
    ])],
  });
  assert.equal(splitAcrossGapAndOutputs.ok, true);
  assert.deepEqual(splitAcrossGapAndOutputs.mappings[0].spans, [
    { start: 0, count: 125, sourceStart: 0, sourceStep: 1 },
    { start: 128, count: 150, sourceStart: 125, sourceStep: 1 },
    { start: 278, count: 125, sourceStart: 275, sourceStep: 1 },
  ]);

  const seamSource = strip('seam-400', 400, mapping(4, 300));
  const seamAt300 = compileCardKaleidoscopeMappings({
    strips: [seamSource],
    pixels: [
      ...contiguousPixels(seamSource.id, 100, {
        start: 0, sourceStart: 300, runId: 'seamed', outputId: 'out1',
      }),
      ...contiguousPixels(seamSource.id, 300, {
        start: 100, sourceStart: 0, runId: 'seamed', outputId: 'out1',
      }),
    ],
    zones: [zone(seamSource.id, [{ start: 0, count: 400 }])],
  });
  assert.equal(seamAt300.ok, true);
  assert.deepEqual(seamAt300.mappings[0].spans, [
    { start: 0, count: 100, sourceStart: 300, sourceStep: 1 },
    { start: 100, count: 300, sourceStart: 0, sourceStep: 1 },
  ]);
});

test('keeps grouped strip mappings separate while sharing the runtime zone', () => {
  const strips = [strip('outer', 4), strip('inner', 4)];
  const pixels = [
    ...contiguousPixels('outer', 4, { start: 0, runId: 'outer' }),
    ...contiguousPixels('inner', 4, { start: 4, runId: 'inner' }),
  ];
  const result = compileCardKaleidoscopeMappings({
    strips,
    pixels,
    zones: [zone('rings', [{ start: 0, count: 4 }, { start: 4, count: 4 }])],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.mappings.map(item => [item.id, item.zoneId]), [
    ['outer', 'rings'],
    ['inner', 'rings'],
  ]);
});

test('omits disabled mappings and detects enabled runtime packages', () => {
  const result = compileCardKaleidoscopeMappings({
    strips: [
      { id: 'missing', pixelCount: 4 },
      { id: 'disabled', pixelCount: 4, kaleidoscope: { enabled: false } },
    ],
    pixels: [],
    zones: [],
  });

  assert.deepEqual(result, { ok: true, mappings: [], errors: [] });
  assert.equal(runtimeConfigUsesKaleidoscope(), false);
  assert.equal(runtimeConfigUsesKaleidoscope({ kaleidoscopeMappings: [] }), false);
  assert.equal(runtimeConfigUsesKaleidoscope({ kaleidoscopeMappings: [{}] }), true);
  assert.equal(runtimeConfigUsesKaleidoscope({ config: { kaleidoscopeMappings: [{}] } }), true);
});

test('reports malformed mappings and exact source coverage errors without guessing', () => {
  const malformed = strip('bad', 4, { enabled: true, pointCount: 2.5, startLed: 0, offsets: [0, 0] });
  const malformedResult = compileCardKaleidoscopeMappings({
    strips: [malformed],
    pixels: contiguousPixels('bad', 4),
    zones: [zone('bad', [{ start: 0, count: 4 }])],
  });
  assert.equal(malformedResult.ok, false);
  assert.ok(malformedResult.errors.some(error => error.code === 'kaleidoscope-invalid' && error.stripId === 'bad'));

  const source = strip('coverage', 4);
  const missingResult = compileCardKaleidoscopeMappings({
    strips: [source],
    pixels: contiguousPixels('coverage', 3),
    zones: [zone('coverage', [{ start: 0, count: 3 }])],
  });
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some(error => error.code === 'kaleidoscope-source-coverage'));

  const duplicateResult = compileCardKaleidoscopeMappings({
    strips: [source],
    pixels: [
      ...contiguousPixels('coverage', 4),
      { ...contiguousPixels('coverage', 1, { start: 4 })[0], sourceLed: 0 },
    ],
    zones: [zone('coverage', [{ start: 0, count: 5 }])],
  });
  assert.equal(duplicateResult.ok, false);
  assert.ok(duplicateResult.errors.some(error => error.code === 'kaleidoscope-source-coverage'));

  const partialZoneResult = compileCardKaleidoscopeMappings({
    strips: [source],
    pixels: contiguousPixels('coverage', 4),
    zones: [zone('coverage', [{ start: 0, count: 3 }])],
  });
  assert.equal(partialZoneResult.ok, false);
  assert.ok(partialZoneResult.errors.some(error => error.code === 'kaleidoscope-zone-coverage'));
});

test('rejects span, mapping, and aggregate-offset limits instead of truncating', () => {
  const splitSource = strip('split', 10);
  const splitPixels = Array.from({ length: 10 }, (_, sourceLed) => ({
    index: sourceLed * 2,
    stripId: 'split',
    sourceLed,
    runId: `run-${sourceLed}`,
    outputId: 'out1',
    inactive: false,
  }));
  const splitResult = compileCardKaleidoscopeMappings({
    strips: [splitSource],
    pixels: splitPixels,
    zones: [zone('split', splitPixels.map(pixel => ({ start: pixel.index, count: 1 })))],
  });
  assert.equal(CARD_KALEIDOSCOPE_MAX_SPANS_PER_MAPPING, 4);
  assert.equal(splitResult.ok, false);
  assert.ok(splitResult.errors.some(error => error.code === 'kaleidoscope-span-limit'));

  const manyStrips = Array.from({ length: 33 }, (_, index) => strip(`s${index}`, 2, mapping(2)));
  const manyPixels = manyStrips.flatMap((source, index) => contiguousPixels(source.id, 2, { start: index * 2 }));
  const manyZones = manyStrips.map((source, index) => zone(source.id, [{ start: index * 2, count: 2 }]));
  const mappingLimit = compileCardKaleidoscopeMappings({ strips: manyStrips, pixels: manyPixels, zones: manyZones });
  assert.equal(CARD_KALEIDOSCOPE_MAX_MAPPINGS, 32);
  assert.equal(mappingLimit.ok, false);
  assert.ok(mappingLimit.errors.some(error => error.code === 'kaleidoscope-mapping-limit'));

  const offsetStrips = Array.from({ length: 32 }, (_, index) => strip(`p${index}`, 40, mapping(40)));
  const offsetPixels = offsetStrips.flatMap((source, index) => contiguousPixels(source.id, 40, { start: index * 40 }));
  const offsetZones = offsetStrips.map((source, index) => zone(source.id, [{ start: index * 40, count: 40 }]));
  const offsetLimit = compileCardKaleidoscopeMappings({ strips: offsetStrips, pixels: offsetPixels, zones: offsetZones });
  assert.equal(CARD_KALEIDOSCOPE_MAX_AGGREGATE_OFFSETS, 1024);
  assert.equal(offsetLimit.ok, false);
  assert.ok(offsetLimit.errors.some(error => error.code === 'kaleidoscope-offset-limit'));
});
