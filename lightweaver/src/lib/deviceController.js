import { pixelsToWledHexArray } from './wledPixels.js';

export const DEFAULT_WLED_PUSH_FPS = 25;
export const DEFAULT_WLED_HTTP_TIMEOUT_MS = 3000;
export const MAX_WLED_FRAME_PIXELS = 4096;

export function makeWledFrameMessage(pixels = [], { maxPixels = MAX_WLED_FRAME_PIXELS } = {}) {
  if (pixels.length > maxPixels) {
    throw new RangeError(`WLED frame has ${pixels.length} pixels, max ${maxPixels}`);
  }
  return { v: true, seg: [{ i: pixelsToWledHexArray(pixels) }] };
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

export function makeWledHttpUrl(ip, path = '/json/info') {
  const host = normalizeWledHost(ip);
  if (!host) throw new Error('Missing WLED IP address');
  return `http://${host}${path}`;
}

export function makeWledProxyUrl(ip, route = 'info') {
  const host = normalizeWledHost(ip);
  if (!host) throw new Error('Missing WLED IP address');
  return `/api/wled/${route.replace(/^\//, '')}?ip=${encodeURIComponent(host)}`;
}

export function makeWledWsUrl(ip, { preferProxy = true, locationObj = globalThis.location } = {}) {
  const host = normalizeWledHost(ip);
  if (!host) throw new Error('Missing WLED IP address');
  if (!preferProxy) return `ws://${host}/ws`;
  const protocol = locationObj?.protocol === 'https:' ? 'wss:' : 'ws:';
  const originHost = locationObj?.host || 'localhost';
  return `${protocol}//${originHost}/api/wled/ws?ip=${encodeURIComponent(host)}`;
}

export async function requestWledJson(ip, route, {
  method = 'GET',
  body,
  timeoutMs = DEFAULT_WLED_HTTP_TIMEOUT_MS,
  preferProxy = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const fetchOpts = {
    method,
    headers: body == null ? undefined : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  };

  const proxyRoute = route.replace(/^\/?json\//, '');
  if (preferProxy) {
    try {
      return await fetchJson(fetchImpl, makeWledProxyUrl(ip, proxyRoute), fetchOpts, timeoutMs);
    } catch (error) {
      if (!shouldFallbackFromProxy(error)) throw error;
    }
  }

  return fetchJson(fetchImpl, makeWledHttpUrl(ip, `/json/${proxyRoute}`), fetchOpts, timeoutMs);
}

export async function postWledState(ip, state, timeoutMs = DEFAULT_WLED_HTTP_TIMEOUT_MS) {
  return requestWledJson(ip, 'state', { method: 'POST', body: state, timeoutMs });
}

async function fetchJson(fetchImpl, url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...opts, signal: controller.signal });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch (error) {
        error.kind = 'parse';
        error.status = response.status;
        throw error;
      }
    }
    if (!response.ok) {
      const error = new Error(`WLED returned HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function shouldFallbackFromProxy(error) {
  return error?.kind === 'parse' || error?.status === 404 || error?.name === 'TypeError' || error?.name === 'AbortError';
}

function normalizeWledHost(ip) {
  return String(ip || '').trim().replace(/^https?:\/\//, '').replace(/^ws:\/\//, '').replace(/\/.*$/, '');
}

export async function postWledStateDirect(ip, state, timeoutMs = DEFAULT_WLED_HTTP_TIMEOUT_MS) {
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
