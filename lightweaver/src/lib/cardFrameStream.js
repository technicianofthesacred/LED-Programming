// Card frame streamer — throttled latest-frame-wins pump that carries computed
// RGB frames (["RRGGBB", ...]) to the Lightweaver card.
//
// Two transports:
//  - bridge: the card page's postMessage relay ('frame' type, bridge protocol
//    v1) — the only path from the HTTPS Studio (CSP + mixed content block all
//    direct HTTP/WS). The card page forwards each frame into its own
//    same-origin WebSocket ws://<card>:81/ws as {seg:[{i: pixels}]}.
//  - direct: Studio itself opens ws://<host>:81/ws — only possible when the
//    page is http/file (local dev). Binary frames are IGNORED by the firmware
//    (see led-art-mapper/app/src/main.js C2 note), so this is JSON text too.
//
// Timing contract (production plan C1): default 18 fps, hard cap 24 (card
// renders ~30), latest-frame-wins when the producer outruns the wire, and
// never a >2s silent gap while active — the card's frame-source watchdog
// reverts the canvas after 2s, so an idle stream re-sends its last frame.
// Stopping releases the canvas through the EXISTING control path
// ({cancelStream:true}), not a new message type.

import { sendCardBridgeRequest } from './cardBridge.js';
import {
  canPushDirectlyToCard,
  cardHostToUrl,
  normalizeCardHost,
  readStoredCardHost,
} from './cardConnection.js';

export const DEFAULT_FRAME_FPS = 18;
export const MAX_FRAME_FPS = 24;
export const MIN_FRAME_FPS = 1;
// Re-send the latest frame if the wire has been quiet this long, so the card's
// 2s frame-source watchdog never fires mid-show.
export const FRAME_KEEPALIVE_MS = 1200;
// Direct-WS congestion guard: past this many unsent bytes we skip the tick and
// let the next one carry the (newer) frame instead of queueing stale ones.
const WS_CONGESTION_BYTES = 8192;

export function clampFrameFps(fps) {
  const value = Number(fps);
  if (!Number.isFinite(value)) return DEFAULT_FRAME_FPS;
  return Math.min(MAX_FRAME_FPS, Math.max(MIN_FRAME_FPS, value));
}

function segPayload(pixels, seg) {
  const segment = { i: pixels };
  if (Number.isInteger(seg)) segment.id = seg;
  return { seg: [segment] };
}

// Bridge transport — every send is a postMessage to the card page, which owns
// the persistent socket. Requires bridge protocol v1 on the card (the relay
// rejects unknown types on v0 firmware, which surfaces as a normal error).
export function createBridgeFrameTransport(host = '') {
  return {
    kind: 'bridge',
    sendFrame(pixels, seg) {
      return sendCardBridgeRequest('frame', {
        pixels,
        ...(Number.isInteger(seg) ? { seg } : {}),
      }, { host, timeoutMs: 1500, retryOnTimeout: false });
    },
    sendCancel() {
      return sendCardBridgeRequest('control', { cancelStream: true }, { host, timeoutMs: 2500 });
    },
    close() { /* the card page owns the socket */ },
  };
}

// Direct transport — local dev (http/file pages) talks to the card itself.
export function createDirectFrameTransport(host = '', { WebSocketImpl, fetchImpl } = {}) {
  const resolvedHost = normalizeCardHost(host || readStoredCardHost());
  const WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let ws = null;
  let opening = null;

  function openSocket() {
    if (ws && ws.readyState === 1) return Promise.resolve(ws);
    if (opening) return opening;
    if (!WS) return Promise.reject(new Error('WebSocket is not available here.'));
    opening = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WS(`ws://${resolvedHost}:81/ws`);
      } catch (error) {
        opening = null;
        reject(error);
        return;
      }
      socket.onopen = () => { ws = socket; opening = null; resolve(socket); };
      socket.onerror = () => { /* onclose follows and settles state */ };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        if (opening) { opening = null; reject(new Error(`Could not open ws://${resolvedHost}:81/ws`)); }
      };
    });
    return opening;
  }

  return {
    kind: 'direct',
    async sendFrame(pixels, seg) {
      const socket = await openSocket();
      if (socket.bufferedAmount > WS_CONGESTION_BYTES) {
        // Congested: drop this frame; the throttle sends a newer one next tick.
        return { ok: true, dropped: true };
      }
      socket.send(JSON.stringify(segPayload(pixels, seg)));
      return { ok: true };
    },
    async sendCancel() {
      const response = await doFetch(`${cardHostToUrl(resolvedHost)}/api/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelStream: true }),
      });
      return response?.json ? response.json().catch(() => ({ ok: true })) : { ok: true };
    },
    close() {
      try { ws?.close(); } catch { /* noop */ }
      ws = null;
      opening = null;
    },
  };
}

export function defaultFrameTransport(host = '') {
  return canPushDirectlyToCard()
    ? createDirectFrameTransport(host)
    : createBridgeFrameTransport(host);
}

// The streamer. push() as fast as you like (every RAF); frames go out on the
// throttle clock, one in flight at a time, newest frame always winning.
export function createCardFrameStream({
  host = '',
  fps = DEFAULT_FRAME_FPS,
  seg = undefined,
  transport = null,
  keepaliveMs = FRAME_KEEPALIVE_MS,
  setIntervalImpl = (...args) => setInterval(...args),
  clearIntervalImpl = (...args) => clearInterval(...args),
  now = () => Date.now(),
} = {}) {
  const wire = transport || defaultFrameTransport(host);
  let frameFps = clampFrameFps(fps);
  let timer = null;
  let active = false;
  let latest = null;
  let latestDirty = false;
  let inflight = false;
  let lastSentAt = 0;
  let sentFrames = 0;
  let droppedFrames = 0;
  let lastError = null;

  async function pump() {
    if (!active || inflight) return;
    const idleTooLong = latest && (now() - lastSentAt) >= keepaliveMs;
    if (!latestDirty && !idleTooLong) return;
    const frame = latest;
    latestDirty = false;
    inflight = true;
    try {
      await wire.sendFrame(frame, seg);
      lastSentAt = now();
      sentFrames += 1;
      lastError = null;
    } catch (error) {
      lastError = error;
    } finally {
      inflight = false;
    }
  }

  function start() {
    if (active) return;
    active = true;
    lastSentAt = now();
    timer = setIntervalImpl(pump, Math.round(1000 / frameFps));
  }

  function push(pixels) {
    if (!Array.isArray(pixels) || !pixels.length) return;
    if (latestDirty) droppedFrames += 1; // previous frame never made the wire
    latest = pixels;
    latestDirty = true;
  }

  async function stop() {
    if (!active) {
      wire.close?.();
      return;
    }
    active = false;
    if (timer !== null) { clearIntervalImpl(timer); timer = null; }
    latest = null;
    latestDirty = false;
    // Release the card's frame-source claim so its own pattern resumes —
    // the existing control path, never a bespoke stop message.
    try {
      await wire.sendCancel();
    } catch (error) {
      lastError = error;
    } finally {
      wire.close?.();
    }
  }

  return {
    start,
    push,
    stop,
    setFps(next) {
      frameFps = clampFrameFps(next);
      if (active && timer !== null) {
        clearIntervalImpl(timer);
        timer = setIntervalImpl(pump, Math.round(1000 / frameFps));
      }
    },
    isActive() { return active; },
    getStats() {
      return {
        active,
        fps: frameFps,
        transport: wire.kind || 'custom',
        sentFrames,
        droppedFrames,
        lastSentAt,
        lastError,
      };
    },
  };
}
