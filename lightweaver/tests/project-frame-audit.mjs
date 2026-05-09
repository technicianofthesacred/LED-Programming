import assert from 'node:assert/strict';
import { PATTERNS } from '../src/lib/patterns-library.js';
import { compile, evalPixel } from '../src/lib/patterns.js';
import { createDefaultProject, migrateProject, PROJECT_VERSION } from '../src/lib/projectModel.js';
import { normalizePalette, renderPixelFrame } from '../src/lib/frameEngine.js';
import { makeBlackoutFrame, makeWledFrameMessage, makeWledSegments } from '../src/lib/deviceController.js';

const palette = normalizePalette(['#123456', '#abcdef', '#ffcc00']);
const duplicateIds = PATTERNS.map(p => p.id).filter((id, i, arr) => arr.indexOf(id) !== i);
assert.deepEqual(duplicateIds, [], 'pattern ids must be unique');

for (const pattern of PATTERNS) {
  const { fn, error } = compile(pattern.code || 'return [0,0,0];');
  assert.equal(error, null, `${pattern.id} should compile`);
  assert.ok(fn, `${pattern.id} should return a compiled function`);
  for (const sample of [
    { index: 0, x: 0, y: 0, t: 0, time: 0, pixelCount: 1, stripProgress: 0 },
    { index: 1, x: 0.25, y: 0.5, t: 0.25, time: 0.1, pixelCount: 8, stripProgress: 0.2 },
    { index: 7, x: 1, y: 1, t: 1.5, time: 0.75, pixelCount: 8, stripProgress: 1 },
  ]) {
    const out = evalPixel(fn, sample.index, sample.x, sample.y, sample.t, sample.time, sample.pixelCount, palette, 0.25, 0.5, {}, 'audit', sample.stripProgress);
    assert.ok(Number.isFinite(out.r) && Number.isFinite(out.g) && Number.isFinite(out.b), `${pattern.id} produced invalid RGB`);
  }
}

const defaultProject = createDefaultProject();
assert.equal(defaultProject.version, PROJECT_VERSION);
const migratedV1 = migrateProject({
  version: 1,
  name: 'Legacy',
  strips: [{ id: 's1', name: 'Strip 1', pixelCount: 2, pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
  showClips: [{ id: 'c', track: 0, patternId: 'aurora', start: 0, end: 1 }],
});
assert.equal(migratedV1.version, PROJECT_VERSION);
assert.equal(migratedV1.layout.strips.length, 1);
assert.equal(migratedV1.show.clips.length, 1);

const frame = renderPixelFrame({
  t: 0.2,
  strips: [{
    id: 's1',
    pts: [{ x: 0, y: 0, p: 0 }, { x: 1, y: 0, p: 1 }],
  }],
  patternId: 'aurora',
  paletteNorm: palette,
});
assert.equal(frame.pixels.length, 2);
assert.equal(frame.stripFrames.length, 1);
frame.pixels.forEach(px => {
  assert.ok(Number.isFinite(px.r) && Number.isFinite(px.g) && Number.isFinite(px.b));
});

assert.deepEqual(makeBlackoutFrame(2), [{ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }]);
assert.deepEqual(makeWledFrameMessage([{ r: 1.2, g: 2.8, b: 300 }]).seg[0].i, [1, 3, 255]);
assert.deepEqual(makeWledSegments([{ id: 'a', pixels: [1, 2] }, { id: 'b', pixelCount: 3 }], { b: 4 }), [
  { id: 0, start: 0, stop: 2, on: true },
  { id: 4, start: 2, stop: 5, on: true },
]);

console.log('project-frame-audit passed');
