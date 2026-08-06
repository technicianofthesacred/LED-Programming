import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_WS_MAX_PAYLOAD_BYTES,
  FRAME_CHUNK_MAX_PIXELS,
  chunkFramePixels,
  frameChunkPayload,
} from './frameChunking.js';

const pixels = (count, seedHex = 'AABBCC') => Array.from({ length: count }, () => seedHex);

test('a worst-case chunk actually fits the card payload cap', () => {
  // The constant is never trusted: this measures the real serialized bytes of
  // the largest payload the chunker can emit — a full chunk, the widest
  // 'start' a uint16 pixel index can carry, and a segment id.
  const worstCase = frameChunkPayload(
    { pixels: pixels(FRAME_CHUNK_MAX_PIXELS), start: 65535 - FRAME_CHUNK_MAX_PIXELS },
    255,
  );
  const bytes = JSON.stringify(worstCase).length;
  assert.ok(
    bytes <= CARD_WS_MAX_PAYLOAD_BYTES,
    `worst-case chunk is ${bytes} bytes, over the card's ${CARD_WS_MAX_PAYLOAD_BYTES}-byte cap`,
  );
  assert.equal(CARD_WS_MAX_PAYLOAD_BYTES, 4096, 'mirrors LW_WLED_WS_MAX_PAYLOAD_BYTES');
});

test('one more pixel than the chunk size would still fit — the margin is real, not luck', () => {
  const bytes = JSON.stringify(frameChunkPayload(
    { pixels: pixels(FRAME_CHUNK_MAX_PIXELS + 1), start: 65535 - FRAME_CHUNK_MAX_PIXELS },
    255,
  )).length;
  assert.ok(bytes <= CARD_WS_MAX_PAYLOAD_BYTES,
    `no headroom above the chunk size (${bytes} bytes) — the margin has been eaten`);
});

test('an empty frame produces no chunks', () => {
  assert.deepEqual(chunkFramePixels([]), []);
  assert.deepEqual(chunkFramePixels(null), []);
  assert.deepEqual(chunkFramePixels(undefined), []);
  assert.deepEqual(chunkFramePixels('FF0000'), []);
});

test('a frame that already fits stays a single chunk at start 0', () => {
  for (const count of [1, 8, 415, FRAME_CHUNK_MAX_PIXELS]) {
    const chunks = chunkFramePixels(pixels(count));
    assert.equal(chunks.length, 1, `${count} pixels should be one chunk`);
    assert.equal(chunks[0].start, 0);
    assert.equal(chunks[0].pixels.length, count);
  }
});

test('chunks are contiguous, ascending, and cover every pixel exactly once', () => {
  for (const count of [FRAME_CHUNK_MAX_PIXELS + 1, 1000, 1024, 4096, 65535]) {
    const frame = Array.from({ length: count }, (_, i) => i.toString(16).padStart(6, '0'));
    const chunks = chunkFramePixels(frame);
    assert.ok(chunks.length > 1, `${count} pixels must split`);
    let expectedStart = 0;
    const rebuilt = [];
    for (const chunk of chunks) {
      assert.equal(chunk.start, expectedStart, 'starts are contiguous and ascending');
      assert.ok(chunk.pixels.length > 0 && chunk.pixels.length <= FRAME_CHUNK_MAX_PIXELS,
        `chunk of ${chunk.pixels.length} pixels stays within the cap`);
      expectedStart += chunk.pixels.length;
      rebuilt.push(...chunk.pixels);
    }
    assert.equal(expectedStart, count, 'the chunks account for every pixel');
    assert.deepEqual(rebuilt, frame, 'reassembling the chunks reproduces the frame in order');
  }
});

test('every chunk of a maximal frame serializes under the card cap', () => {
  const frame = pixels(4096, 'FFEEDD');
  for (const chunk of chunkFramePixels(frame)) {
    const bytes = JSON.stringify(frameChunkPayload(chunk, 3)).length;
    assert.ok(bytes <= CARD_WS_MAX_PAYLOAD_BYTES, `chunk at ${chunk.start} is ${bytes} bytes`);
  }
});

test('a chunk owns its pixels — mutating the source frame cannot alter it', () => {
  const frame = pixels(4, '112233');
  const [chunk] = chunkFramePixels(frame);
  frame[0] = 'FFFFFF';
  assert.equal(chunk.pixels[0], '112233');
});

test('the single-chunk payload is byte-identical to the pre-chunking message', () => {
  const frame = ['FF8800', '331100'];
  const [chunk] = chunkFramePixels(frame);
  // This is exactly what segPayload() used to build.
  assert.equal(
    JSON.stringify(frameChunkPayload(chunk, 1)),
    JSON.stringify({ seg: [{ i: frame, id: 1 }] }),
  );
  assert.equal(
    JSON.stringify(frameChunkPayload(chunk, undefined)),
    JSON.stringify({ seg: [{ i: frame }] }),
  );
});

test('start is omitted at 0 and id is omitted when seg is not an integer', () => {
  assert.deepEqual(frameChunkPayload({ pixels: ['FF0000'], start: 0 }), { seg: [{ i: ['FF0000'] }] });
  for (const seg of [undefined, null, '2', 2.5, NaN, {}]) {
    assert.deepEqual(
      frameChunkPayload({ pixels: ['FF0000'], start: 0 }, seg),
      { seg: [{ i: ['FF0000'] }] },
      `seg ${String(seg)} is not an integer id`,
    );
  }
  assert.deepEqual(frameChunkPayload({ pixels: ['FF0000'], start: 0 }, 0), { seg: [{ i: ['FF0000'], id: 0 }] });
  assert.deepEqual(
    frameChunkPayload({ pixels: ['00FF00'], start: 416 }, 2),
    { seg: [{ i: ['00FF00'], id: 2, start: 416 }] },
  );
});

test('a malformed chunk degrades to an empty segment rather than throwing', () => {
  assert.deepEqual(frameChunkPayload(null), { seg: [{ i: [] }] });
  assert.deepEqual(frameChunkPayload({ start: 5 }), { seg: [{ i: [], start: 5 }] });
});
