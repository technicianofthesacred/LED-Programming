export const DEFAULT_WLED_PUSH_FPS = 25;

export function makeWledFrameMessage(pixels = []) {
  const flat = new Array(pixels.length * 3);
  for (let i = 0; i < pixels.length; i++) {
    flat[i * 3] = clampByte(pixels[i].r);
    flat[i * 3 + 1] = clampByte(pixels[i].g);
    flat[i * 3 + 2] = clampByte(pixels[i].b);
  }
  return { v: true, seg: [{ i: flat }] };
}

export function makeBlackoutFrame(pixelCount) {
  return Array.from({ length: Math.max(0, pixelCount || 0) }, () => ({ r: 0, g: 0, b: 0 }));
}

export function makeWledSegments(strips = [], segmentMap = {}) {
  let cursor = 0;
  return strips.map((strip, i) => {
    const count = strip.pixels?.length || strip.pixelCount || 0;
    const seg = {
      id: segmentMap[strip.id] ?? i,
      start: cursor,
      stop: cursor + count,
      on: true,
    };
    cursor += count;
    return seg;
  });
}

export async function postWledState(ip, state, timeoutMs = 3000) {
  if (!ip) throw new Error('Missing WLED IP address');
  const r = await fetch(`http://${ip}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`WLED returned HTTP ${r.status}`);
  return r;
}

function clampByte(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
