// Frame chunking — splits a full logical frame into pieces the card's
// WebSocket will actually accept.
//
// Why this exists: the firmware caps a single WS payload at
// LW_WLED_WS_MAX_PAYLOAD_BYTES (4096) and SILENTLY RETURNS on anything larger
// (firmware/lightweaver-controller/src/LightweaverWledWebSocket.cpp:33,56).
// Studio used to serialize every pixel of a frame into one
// {seg:[{i:[...]}]} message, so any strip past ~450 pixels went dark with no
// error anywhere — the worst kind of failure, an invisible one.
//
// The size budget, measured not guessed:
//   per pixel  '"RRGGBB",'                              = 9 bytes
//   envelope   {"seg":[{"id":N,"start":65535,"i":[]}]}  = 39 bytes
//   ceiling    floor((4096 - 39) / 9)                   = 450 pixels
// FRAME_CHUNK_MAX_PIXELS is 416 — the largest multiple of 32 under that
// ceiling, leaving ~300 bytes of headroom for future envelope growth. The unit
// test never trusts these numbers: it stringifies a worst-case chunk and
// asserts the real byte length.
//
// The card already understands the per-segment 'start' write offset
// (LightweaverWledWebSocket.cpp:76 `int writeIdx = s["start"] | 0;`), so
// chunking works on every card in the field today over a direct socket. Only
// the card page's postMessage relay needed a change to forward 'start' — see
// the bridge version gate in cardFrameStream.js.

// LW_WLED_WS_MAX_PAYLOAD_BYTES in LightweaverWledWebSocket.cpp — anything
// larger is dropped by the card without a reply.
export const CARD_WS_MAX_PAYLOAD_BYTES = 4096;
export const FRAME_CHUNK_MAX_PIXELS = 416;

// Split a full logical frame into card-sized chunks.
//   pixels: Array<'RRGGBB'> -> Array<{ pixels: Array<'RRGGBB'>, start: number }>
// Chunks are contiguous and ascending, cover every pixel exactly once, and a
// frame that already fits comes back as ONE chunk with start 0 — so short
// frames keep serializing byte-identically to the pre-chunking payload.
export function chunkFramePixels(pixels) {
  if (!Array.isArray(pixels) || pixels.length === 0) return [];
  const chunks = [];
  for (let start = 0; start < pixels.length; start += FRAME_CHUNK_MAX_PIXELS) {
    // Each chunk owns its slice: the frame producer may reuse its buffer, and
    // a chunk can sit in a bridge ack round-trip for a whole frame period.
    chunks.push({ pixels: pixels.slice(start, start + FRAME_CHUNK_MAX_PIXELS), start });
  }
  return chunks;
}

// Build the exact WS payload for one chunk.
// 'start' is omitted when 0 and 'id' when seg is not an integer, and the key
// order matches the original single-message payload, so a single-chunk frame
// is byte-for-byte what the card received before chunking existed.
export function frameChunkPayload(chunk, seg) {
  const segment = { i: Array.isArray(chunk?.pixels) ? chunk.pixels : [] };
  if (Number.isInteger(seg)) segment.id = seg;
  const start = Number(chunk?.start) || 0;
  if (start > 0) segment.start = start;
  return { seg: [segment] };
}
