import assert from 'node:assert/strict';
import { makePreviewFallbackStrip } from '../src/lib/previewFallbackStrip.js';

const strip = makePreviewFallbackStrip('0 0 640 400', { pixelCount: 30 });

assert.equal(strip.id, 'preview-fallback');
assert.equal(strip.pixels.length, 30);
assert.equal(strip.pixelCount, 30);
assert.equal(strip.pixels[0].x < strip.pixels.at(-1).x, true);
assert.equal(strip.pixels.every(pixel => Number.isFinite(pixel.x) && Number.isFinite(pixel.y)), true);

const clamped = makePreviewFallbackStrip('bad viewbox', { pixelCount: 1000 });
assert.equal(clamped.pixels.length, 300);

console.log('preview-fallback-strip passed');
