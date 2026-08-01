import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPixelFrame } from './frameEngine.js';

const FPS = 30;
const FRAME_COUNT = FPS * 3 + 1;
const strips = [{
  id: 'ambient-strip',
  pts: Array.from({ length: 24 }, (_, index) => ({
    x: index / 23,
    y: ((index * 7) % 23) / 23,
    p: index / 23,
  })),
}];

function frame(patternId, index, extra = {}) {
  return renderPixelFrame({
    t: index / FPS,
    strips,
    patternId,
    ...extra,
  }).pixels;
}

function signature(pixels) {
  return pixels.map(({ r, g, b }) => `${r},${g},${b}`).join('|');
}

function averageLight(pixels) {
  return pixels.reduce((total, { r, g, b }) => total + r + g + b, 0) / (pixels.length * 3);
}

test('ambient patterns render 91 finite, visibly alive frames over three seconds at normal cadence', () => {
  const timestamps = Array.from({ length: FRAME_COUNT }, (_, index) => index / FPS);
  assert.equal(timestamps.length, 91);
  assert.equal(timestamps.at(-1), 3);
  timestamps.slice(1).forEach((time, index) => assert.ok(Math.abs(time - timestamps[index] - 1 / FPS) < 1e-12));

  for (const patternId of ['breathe', 'calm', 'aurora', 'lava', 'twinkle']) {
    const frames = timestamps.map((_, index) => frame(patternId, index));
    assert.ok(frames.every(pixels => pixels.length === 24), `${patternId} must render every LED`);
    assert.ok(frames.flat().every(pixel => [pixel.r, pixel.g, pixel.b].every(Number.isFinite)), `${patternId} must stay finite`);
    assert.ok(Math.max(...frames.map(averageLight)) > 0, `${patternId} must remain visible`);
    assert.ok(new Set(frames.map(signature)).size > 1, `${patternId} must move at normal cadence`);
  }
});

test('Breathe remains a shallow ambient envelope instead of fading toward blackout', () => {
  const light = Array.from({ length: FRAME_COUNT }, (_, index) => averageLight(frame('breathe', index)));
  assert.ok(Math.min(...light) / Math.max(...light) >= 0.84);
});

test('a three-second crossfade has 91 frames and exact source/target endpoints', () => {
  const frames = Array.from({ length: FRAME_COUNT }, (_, index) => frame('aurora', index, {
    blendPatternId: 'lava',
    blendAmount: index / (FRAME_COUNT - 1),
  }));
  assert.equal(frames.length, 91);
  assert.deepEqual(frames[0], frame('aurora', 0));
  assert.deepEqual(frames.at(-1), frame('lava', FRAME_COUNT - 1));
  assert.notDeepEqual(frames[45], frames[0]);
  assert.notDeepEqual(frames[45], frames.at(-1));
});
