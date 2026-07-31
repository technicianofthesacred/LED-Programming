import test from 'node:test';
import assert from 'node:assert/strict';

import { createPhysicalFrame } from '../src/mapper.js';

test('hidden strips retain their physical address range as black pixels', () => {
  const visiblePixels = [
    { index: 0, stripId: 'first' },
    { index: 1, stripId: 'first' },
    { index: 4, stripId: 'third' },
  ];

  const frame = createPhysicalFrame(5, visiblePixels, pixel => (
    pixel.stripId === 'first'
      ? { r: 10, g: 20, b: 30 }
      : { r: 40, g: 50, b: 60 }
  ));

  assert.deepEqual([...frame], [
    10, 20, 30,
    10, 20, 30,
    0, 0, 0,
    0, 0, 0,
    40, 50, 60,
  ]);
});
