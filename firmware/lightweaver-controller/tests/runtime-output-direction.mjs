import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileWiring } from '../../../lightweaver/src/lib/wiringCompiler.js';
import { CARD_HARDWARE_CAPABILITIES } from '../../../lightweaver/src/lib/cardRuntimeContract.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = fs.readFileSync(path.join(root, 'src/LightweaverTypes.h'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'src/LightweaverStorage.cpp'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src/main.cpp'), 'utf8');

assert.match(types, /struct OutputSegmentConfig[\s\S]*uint16_t count = 0;[\s\S]*bool reversed = false;/);
assert.match(types, /struct OutputConfig[\s\S]*OutputSegmentConfig segments\[LW_MAX_OUTPUT_SEGMENTS\];[\s\S]*uint8_t segmentCount = 0;/);
assert.match(storage, /parsedSegment\.reversed = String\(segment\["direction"\][\s\S]*== "reverse";/);
assert.match(storage, /next\.segmentCount != active\.segmentCount/);
assert.match(storage, /next\.segments\[segment\]\.reversed != active\.segments\[segment\]\.reversed/);
assert.match(storage, /segment\["direction"\] = source\.reversed \? "reverse" : "forward";/);
assert.match(runtime, /for \(uint8_t segmentIndex = 0; segmentIndex < output\.segmentCount; segmentIndex\+\+\)[\s\S]*physicalIndex = segment\.reversed[\s\S]*segmentStart \+ segment\.count - 1 - offset[\s\S]*physicalLeds\[physicalIndex\]/);
assert.match(runtime, /config\.segmentCount = 1;[\s\S]*config\.segments\[0\]\.count = config\.pixels;/, 'SD profiles must receive a full forward segment');

function copyCompiled(logical, output) {
  const physical = Array(logical.length).fill('dark');
  let segmentStart = output.start;
  for (const segment of output.segments) {
    for (let offset = 0; offset < segment.count; offset += 1) {
      const logicalIndex = segmentStart + offset;
      const physicalIndex = segment.direction === 'reverse'
        ? segmentStart + segment.count - 1 - offset
        : logicalIndex;
      physical[physicalIndex] = logical[logicalIndex];
    }
    segmentStart += segment.count;
  }
  return physical;
}

function compile(directions) {
  const strips = directions.map((_, index) => ({ id: `strip-${index}`, pixelCount: 3, pixels: [{}, {}, {}] }));
  const runs = directions.map((direction, index) => ({
    id: `run-${index}`, type: 'strip', source: { stripId: `strip-${index}`, from: 0, to: 2 },
    physicalDirection: direction === 'reverse' ? 'source-reverse' : 'source-forward',
  }));
  const result = compileWiring({
    strips, capabilities: CARD_HARDWARE_CAPABILITIES,
    wiring: { outputs: [{ id: 'rings', pin: 16, runIds: runs.map(run => run.id) }], runs },
  });
  assert.equal(result.ok, true);
  return result.outputs[0];
}

const twoReverseRuns = compile(['reverse', 'reverse']);
assert.deepEqual(twoReverseRuns.segments.map(segment => segment.direction), ['reverse', 'reverse']);
assert.deepEqual(
  copyCompiled(['blue', 'dim', 'red', 'blue', 'dim', 'red'], twoReverseRuns),
  ['red', 'dim', 'blue', 'red', 'dim', 'blue'],
  'firmware reverses inside each segment exactly once without reversing run order',
);

const explicitKnownGoodOutput = compile(['forward']);
assert.equal(explicitKnownGoodOutput.pin, 16);
assert.deepEqual(explicitKnownGoodOutput.segments.map(segment => segment.direction), ['forward']);
assert.deepEqual(
  copyCompiled(['blue', 'dim', 'red'], explicitKnownGoodOutput),
  ['blue', 'dim', 'red'],
  'an explicit configured known-good output receives a full forward segment',
);

const mixed = compile(['forward', 'reverse']);
assert.equal(mixed.direction, 'mixed');
assert.deepEqual(
  copyCompiled(['blue', 'dim', 'red', 'blue', 'dim', 'red'], mixed),
  ['blue', 'dim', 'red', 'red', 'dim', 'blue'],
  'mixed direction leaves the first run forward and reverses only the second',
);

assert.match(storage, /NVS_KNOWN_GOOD_CONFIG_KEY/);
assert.match(storage, /candidate probation marker write failed|candidate rollback failed/);

console.log('runtime segment direction contract passed');
