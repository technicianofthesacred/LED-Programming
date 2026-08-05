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
//
// Chunking contract: the card drops any WS payload over 4096 bytes in silence,
// which capped a frame at ~450 pixels (see frameChunking.js). A frame is now
// split into FRAME_CHUNK_MAX_PIXELS-sized chunks carrying the per-segment
// 'start' write offset the firmware already parses. Frames at or under one
// chunk serialize exactly as before, so nothing changes for small strips.
//
// Latest-frame-wins is defined at FRAME granularity, not chunk granularity.
// The pump holds one latest frame; once a frame's chunk sequence starts it
// runs to completion or failure, and a newer frame produced mid-send waits for
// the next tick. A failed chunk makes the WHOLE frame undelivered, so the next
// tick (≤1/18s) resends the NEWEST frame from chunk 0, and the keepalive
// always resends the last frame IN FULL — a half-written frame therefore
// persists at most ~FRAME_KEEPALIVE_MS, with the card's 2s watchdog as the
// last resort behind that.

import { sendCardBridgeRequest, getCardBridgeVersion } from './cardBridge.js';
import { chunkFramePixels, frameChunkPayload } from './frameChunking.js';
import { guardDirectCardMutation } from './cardIdentity.js';
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
// 2s frame-source watchdog never fires mid-show. Must sit UNDER 1000ms:
// background tabs clamp setInterval to 1000ms, and a keepalive threshold above
// that would skip every other clamped tick — a 2000ms wire cadence that ties
// the watchdog exactly and flickers. At ≤900ms every clamped 1000ms tick
// re-sends, keeping the cadence at 1000ms, safely under the 2s watchdog.
export const FRAME_KEEPALIVE_MS = 850;
// Direct-WS congestion guard: past this many unsent bytes we skip the tick and
// let the next one carry the (newer) frame instead of queueing stale ones.
const WS_CONGESTION_BYTES = 8192;
export const FRAME_OWNERSHIP_CHANNEL = 'lightweaver-card-frame-owner-v1';
// Bridge protocol version whose relay forwards the per-segment 'start' offset.
// v≤2 relays build {i, id} only and keep ONE pending frame slot, so a second
// chunk would both land at pixel 0 and clobber the first — those cards get the
// first chunk plus an honest truncation signal instead.
const FRAME_CHUNK_BRIDGE_VERSION = 3;
// A truncated frame is a persistent condition (every frame stays truncated
// until the card is reflashed), and health fires once per pump. Re-arm the
// one-shot notice flag at most this often so a UI can toast/log on it without
// firing 18 times a second; the boolean itself stays true in every report.
export const FRAME_TRUNCATION_NOTICE_MS = 5000;
// Re-exported so consumers can name the cap in copy ("more than 416 pixels
// live") without reaching into the chunking module themselves.
export { FRAME_CHUNK_MAX_PIXELS } from './frameChunking.js';

export function clampFrameFps(fps) {
  const value = Number(fps);
  if (!Number.isFinite(value)) return DEFAULT_FRAME_FPS;
  return Math.min(MAX_FRAME_FPS, Math.max(MIN_FRAME_FPS, value));
}

// A relay reply that means the frame did NOT reach the LEDs. Mirrors the
// pump's own classification so a chunk failure ends the frame at the transport
// instead of letting later chunks write over a card that never got chunk 0.
function bridgeReplyFailed(reply) {
  if (!reply) return false;
  return reply.ok === false
    || reply.relayed === false
    || reply.delivered === false
    || reply.wsOpen === false;
}

// Bridge transport — every send is a postMessage to the card page, which owns
// the persistent socket. Requires bridge protocol v1 on the card (the relay
// rejects unknown types on v0 firmware, which surfaces as a normal error).
export function createBridgeFrameTransport(host = '') {
  return {
    kind: 'bridge',
    async sendFrame(pixels, seg) {
      const chunks = chunkFramePixels(pixels);
      if (!chunks.length) return { ok: true };
      const segField = Number.isInteger(seg) ? { seg } : {};

      if (chunks.length > 1 && getCardBridgeVersion() < FRAME_CHUNK_BRIDGE_VERSION) {
        // Shipped firmware (relay v≤2) drops 'start', so only the head of the
        // strip can be driven. Send that head — the owner still sees living
        // light — and report the truncation. Never silently drop the tail,
        // never claim a delivery that did not happen.
        const reply = await sendCardBridgeRequest('frame', {
          pixels: chunks[0].pixels,
          ...segField,
        }, { host, timeoutMs: 1500, retryOnTimeout: false });
        if (bridgeReplyFailed(reply)) return reply;
        return {
          ...(reply || {}),
          ok: true,
          truncated: true,
          reason: 'bridge-frame-cap',
          sentPixels: chunks[0].pixels.length,
          framePixels: pixels.length,
        };
      }

      let lastReply = null;
      for (const chunk of chunks) {
        // Sequential and AWAITED. The relay holds a single pending-frame slot
        // and only replies relayed:true after WebSocket.send returns, so
        // waiting for each ack is what guarantees the slot is empty before the
        // next chunk is posted — no relay queue change needed.
        // Accepted residual: if the bridge disconnects mid-frame, a chunk left
        // pending in the relay may flush late and transiently overwrite part
        // of a newer frame for ≤1 frame period. That is the same kind of
        // staleness the whole-frame path has always had; the keepalive's full
        // resend corrects it within ~850ms. Do not engineer around it.
        const reply = await sendCardBridgeRequest('frame', {
          pixels: chunk.pixels,
          ...(chunk.start > 0 ? { start: chunk.start } : {}),
          ...segField,
        }, { host, timeoutMs: 1500, retryOnTimeout: false });
        if (bridgeReplyFailed(reply)) {
          // Frame-atomic: stop here and report the WHOLE frame undelivered.
          return {
            ...reply,
            ok: false,
            reason: reply.reason || (reply.wsOpen === false ? 'relay-socket-closed' : 'relay-send-failed'),
          };
        }
        lastReply = reply;
      }
      return lastReply || { ok: true };
    },
    sendCancel() {
      return sendCardBridgeRequest('control', { cancelStream: true }, { host, timeoutMs: 2500 });
    },
    close() { /* the card page owns the socket */ },
  };
}

// How long an unreachable card backs off between direct-WS open attempts:
// 250ms doubling to a 4s cap, so a dead card costs a few opens per minute
// instead of a fresh socket every ~55ms tick.
export const DIRECT_BACKOFF_MIN_MS = 250;
export const DIRECT_BACKOFF_MAX_MS = 4000;

// Direct transport — local dev (http/file pages) talks to the card itself.
export function createDirectFrameTransport(host = '', { WebSocketImpl, fetchImpl, nowImpl } = {}) {
  const resolvedHost = normalizeCardHost(host || readStoredCardHost());
  const WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const nowFn = nowImpl || (() => Date.now());
  let ws = null;
  let opening = null;
  let backoffMs = 0;
  let retryAt = 0;

  function noteOpenFailure() {
    backoffMs = backoffMs ? Math.min(DIRECT_BACKOFF_MAX_MS, backoffMs * 2) : DIRECT_BACKOFF_MIN_MS;
    retryAt = nowFn() + backoffMs;
  }

  async function openSocket() {
    if (ws && ws.readyState === 1) return Promise.resolve(ws);
    if (opening) return opening;
    if (!WS) return Promise.reject(new Error('WebSocket is not available here.'));
    if (nowFn() < retryAt) {
      const error = new Error(`Waiting to retry ws://${resolvedHost}:81/ws`);
      error.reason = 'ws-backoff';
      return Promise.reject(error);
    }
    await guardDirectCardMutation(resolvedHost, { fetchImpl: doFetch });
    // Another caller may have completed an open while identity was checked.
    if (ws && ws.readyState === 1) return ws;
    if (opening) return opening;
    if (nowFn() < retryAt) {
      // Still inside the backoff window: fail fast without opening a socket.
      // The pump counts this as an undelivered tick, which feeds the same
      // health path as a bridge failure.
      const error = new Error(`Waiting to retry ws://${resolvedHost}:81/ws`);
      error.reason = 'ws-backoff';
      return Promise.reject(error);
    }
    opening = new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WS(`ws://${resolvedHost}:81/ws`);
      } catch (error) {
        opening = null;
        noteOpenFailure();
        reject(error);
        return;
      }
      socket.onopen = () => { ws = socket; opening = null; backoffMs = 0; retryAt = 0; resolve(socket); };
      socket.onerror = () => {
        // Never keep using a socket after an error. Its replacement must pass
        // the exact-host identity check again before construction.
        if (ws === socket) ws = null;
      };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        if (opening) {
          opening = null;
          noteOpenFailure();
          const error = new Error(`Could not open ws://${resolvedHost}:81/ws`);
          error.reason = 'ws-open-failed';
          reject(error);
        }
      };
    });
    return opening;
  }

  return {
    kind: 'direct',
    async sendFrame(pixels, seg) {
      const socket = await openSocket();
      // Congestion is judged ONCE per frame, before chunk 0 — never between
      // chunks. A frame that has begun must finish, or the card would render
      // the head of one frame spliced onto the tail of another.
      if (socket.bufferedAmount > WS_CONGESTION_BYTES) {
        // Congested: drop this frame; the throttle sends a newer one next tick.
        return { ok: true, dropped: true };
      }
      // Every card in the field already parses the per-segment 'start' write
      // offset (LightweaverWledWebSocket.cpp:76), so direct chunking needs no
      // firmware update.
      for (const chunk of chunkFramePixels(pixels)) {
        socket.send(JSON.stringify(frameChunkPayload(chunk, seg)));
      }
      return { ok: true };
    },
    async sendCancel() {
      await guardDirectCardMutation(resolvedHost, { fetchImpl: doFetch });
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
      backoffMs = 0;
      retryAt = 0;
    },
  };
}

export function defaultFrameTransport(host = '') {
  return canPushDirectlyToCard()
    ? createDirectFrameTransport(host)
    : createBridgeFrameTransport(host);
}

function defaultOwnershipInstanceId() {
  try { return globalThis.crypto?.randomUUID?.() || `frame-${Date.now()}-${Math.random()}`; }
  catch { return `frame-${Date.now()}-${Math.random()}`; }
}

function newerOwnershipClaim(candidate, current) {
  if (!current) return true;
  const candidateTime = Number(candidate?.startedAt) || 0;
  const currentTime = Number(current?.startedAt) || 0;
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return String(candidate?.ownerId || '') > String(current?.ownerId || '');
}

// Coordinates streams within this JS realm through the local registry and
// across same-origin tabs through BroadcastChannel. The coordinator is
// injectable so ownership and tab handoff stay deterministic in tests.
export function createFrameOwnershipCoordinator({
  BroadcastChannelImpl = typeof window !== 'undefined' ? globalThis.BroadcastChannel : null,
  channelName = FRAME_OWNERSHIP_CHANNEL,
  instanceId = defaultOwnershipInstanceId(),
} = {}) {
  const owners = new Map();
  let sequence = 0;
  let lastStartedAt = 0;

  function supersede(entry, nextClaim) {
    if (!entry || entry.released) return;
    entry.released = true;
    if (owners.get(entry.host) === entry) owners.delete(entry.host);
    try { entry.channel?.close?.(); } catch { /* noop */ }
    try { entry.onSuperseded?.(nextClaim); } catch { /* ownership must still transfer */ }
  }

  return {
    claim({ host = '', startedAt = Date.now(), onSuperseded } = {}) {
      const normalizedHost = normalizeCardHost(host);
      const existing = owners.get(normalizedHost);
      const claimStartedAt = Math.max(Number(startedAt) || 0, lastStartedAt + 1);
      lastStartedAt = claimStartedAt;
      const claim = {
        type: 'claim',
        host: normalizedHost,
        ownerId: `${instanceId}:${++sequence}`,
        startedAt: claimStartedAt,
      };
      if (existing) supersede(existing, claim);

      let channel = null;
      if (typeof BroadcastChannelImpl === 'function') {
        try { channel = new BroadcastChannelImpl(channelName); } catch { channel = null; }
      }
      const entry = { ...claim, channel, onSuperseded, released: false };
      owners.set(normalizedHost, entry);
      if (channel) {
        channel.onmessage = event => {
          const candidate = event?.data;
          if (!['claim', 'reclaim'].includes(candidate?.type) || normalizeCardHost(candidate.host) !== normalizedHost) return;
          if (candidate.type === 'reclaim') { supersede(entry, candidate); return; }
          if (candidate.ownerId === entry.ownerId || !newerOwnershipClaim(candidate, entry)) return;
          supersede(entry, candidate);
        };
        try { channel.postMessage(claim); } catch { /* local ownership still applies */ }
      }

      return {
        ownerId: entry.ownerId,
        host: normalizedHost,
        isOwner: () => !entry.released && owners.get(normalizedHost) === entry,
        release() {
          if (entry.released) return;
          entry.released = true;
          if (owners.get(normalizedHost) === entry) owners.delete(normalizedHost);
          try { channel?.close?.(); } catch { /* noop */ }
        },
      };
    },
    reclaim({ host = '' } = {}) {
      const normalizedHost = normalizeCardHost(host);
      const message = {
        type: 'reclaim',
        host: normalizedHost,
        ownerId: `${instanceId}:reclaim:${++sequence}`,
        startedAt: Date.now(),
      };
      const existing = owners.get(normalizedHost);
      if (existing) supersede(existing, message);
      if (typeof BroadcastChannelImpl === 'function') {
        let channel = null;
        try {
          channel = new BroadcastChannelImpl(channelName);
          channel.postMessage(message);
        } catch { /* local reclaim still applies */ }
        Promise.resolve().then(() => {
          try { channel?.close?.(); } catch { /* noop */ }
        });
      }
      return { host: normalizedHost, reclaimed: Boolean(existing) };
    },
  };
}

const defaultFrameOwnershipCoordinator = createFrameOwnershipCoordinator();

export async function reclaimCardFrameStreams(host = '', {
  ownershipCoordinator = defaultFrameOwnershipCoordinator,
  handoffMs = 50,
  setTimeoutImpl = (...args) => setTimeout(...args),
} = {}) {
  const result = ownershipCoordinator?.reclaim?.({ host }) || { host: normalizeCardHost(host), reclaimed: false };
  const delay = Math.max(0, Number(handoffMs) || 0);
  if (delay) await new Promise(resolve => setTimeoutImpl(resolve, delay));
  return result;
}

// The streamer. push() as fast as you like (every RAF); frames go out on the
// throttle clock, one in flight at a time, newest frame always winning.
//
// Delivery health: every pump outcome is classified. A send rejection OR a
// bridge reply carrying wsOpen:false (F1 contract: the card page's socket to
// the card was not open, the frame was NOT delivered) counts as a failure;
// a reply without a wsOpen field (older firmware) is unknown → assumed
// delivered. Failures feed getStats() and the optional onHealth callback so
// the UI can warn and auto-stop instead of streaming into the void. A frame
// the transport could only partially deliver (a pre-v3 relay that cannot carry
// chunk offsets) is reported separately as truncated: delivered stays true for
// the part that IS lit, and the truncation reason rides the same health path
// so the UI can ask for a firmware update.
export function createCardFrameStream({
  host = '',
  fps = DEFAULT_FRAME_FPS,
  seg = undefined,
  transport = null,
  keepaliveMs = FRAME_KEEPALIVE_MS,
  onHealth = null,
  ownershipCoordinator = defaultFrameOwnershipCoordinator,
  setIntervalImpl = (...args) => setInterval(...args),
  clearIntervalImpl = (...args) => clearInterval(...args),
  now = () => Date.now(),
} = {}) {
  const wire = transport === 'bridge'
    ? createBridgeFrameTransport(host)
    : transport === 'direct'
      ? createDirectFrameTransport(host)
      : transport || defaultFrameTransport(host);
  const ownershipHost = normalizeCardHost(host || readStoredCardHost());
  let frameFps = clampFrameFps(fps);
  let timer = null;
  let active = false;
  let yielded = false;
  let ownership = null;
  let transportClosed = false;
  let latest = null;
  let latestDirty = false;
  let inflight = false;
  let lastSentAt = 0;
  let lastDeliveredAt = 0;
  let sentFrames = 0;
  let droppedFrames = 0;
  let undeliveredFrames = 0;
  let consecutiveFailures = 0;
  let failingSince = 0;
  let lastError = null;
  let truncatedFrames = 0;
  let truncatedReason = null;
  let truncatedSince = 0;
  let truncationNotice = false;
  let truncationNoticeAt = 0;

  function closeTransport() {
    if (transportClosed) return;
    transportClosed = true;
    wire.close?.();
  }

  function noteFailure(error) {
    lastError = error;
    consecutiveFailures += 1;
    undeliveredFrames += 1;
    if (!failingSince) failingSince = now();
    // The frame never reached the card — keep it dirty so the very next tick
    // retries instead of waiting out the keepalive window.
    latestDirty = true;
  }

  // A partially delivered frame is NOT a failure — what was sent is genuinely
  // lit — but it must never read as full delivery either. The condition is
  // sticky while it lasts and clears the moment a whole frame lands.
  function noteTruncation(result) {
    if (result?.truncated !== true) {
      truncatedReason = null;
      truncatedSince = 0;
      truncationNotice = false;
      truncationNoticeAt = 0;
      return;
    }
    truncatedFrames += 1;
    truncatedReason = result.reason || 'frame-truncated';
    if (!truncatedSince) truncatedSince = now();
    truncationNotice = truncationNoticeAt === 0 || (now() - truncationNoticeAt) >= FRAME_TRUNCATION_NOTICE_MS;
    if (truncationNotice) truncationNoticeAt = now();
  }

  function emitHealth() {
    if (typeof onHealth !== 'function') return;
    try {
      onHealth({
        active,
        delivered: consecutiveFailures === 0,
        consecutiveFailures,
        failingForMs: failingSince ? now() - failingSince : 0,
        lastDeliveredAt,
        lastError,
        // Existing consumers all gate on delivered/consecutiveFailures before
        // reading reason, so surfacing the truncation cause here reaches the
        // UI without changing any failure path.
        reason: lastError?.reason || truncatedReason || null,
        truncated: Boolean(truncatedReason),
        truncatedReason,
        truncationNotice,
        truncatedForMs: truncatedSince ? now() - truncatedSince : 0,
      });
    } catch { /* a health listener must never break the pump */ }
  }

  function yieldOwnership(nextClaim) {
    if (yielded) return;
    yielded = true;
    active = false;
    if (timer !== null) { clearIntervalImpl(timer); timer = null; }
    latest = null;
    latestDirty = false;
    const reclaimed = nextClaim?.type === 'reclaim';
    const error = new Error(reclaimed
      ? 'Recover lights reclaimed this card from active browser frame streams.'
      : 'Another tab or Lightweaver screen took control of this card stream.');
    error.reason = reclaimed ? 'stream-reclaimed' : 'stream-superseded';
    lastError = error;
    consecutiveFailures = Math.max(1, consecutiveFailures);
    undeliveredFrames += 1;
    if (!failingSince) failingSince = now();
    closeTransport();
    emitHealth();
  }

  async function pump() {
    if (!active || inflight) return;
    const idleTooLong = latest && (now() - lastSentAt) >= keepaliveMs;
    if (!latestDirty && !idleTooLong) return;
    const frame = latest;
    latestDirty = false;
    inflight = true;
    try {
      const result = await wire.sendFrame(frame, seg);
      // A newer same-host stream may claim ownership while this send is in
      // flight. Its acknowledgement must not revive or mark this stream
      // healthy after it has yielded.
      if (!active || yielded || (ownership && !ownership.isOwner())) return;
      if (result?.dropped === true) {
        droppedFrames += 1;
        const error = new Error('The newest frame was dropped because the card connection is congested.');
        error.reason = result.reason || 'transport-congested';
        noteFailure(error);
      } else if (result && (result.ok === false || result.relayed === false || result.delivered === false)) {
        const error = new Error(result.error || 'The card page did not relay the frame to the LEDs.');
        error.reason = result.reason || (result.wsOpen === false ? 'relay-socket-closed' : 'relay-send-failed');
        noteFailure(error);
      } else if (result && result.wsOpen === false) {
        // F1 contract: the relay accepted the postMessage but its socket to
        // the card was closed — the frame did NOT reach the LEDs.
        const error = new Error('The card page could not reach the card (its socket to the card is closed).');
        error.reason = 'relay-socket-closed';
        noteFailure(error);
      } else {
        lastSentAt = now();
        lastDeliveredAt = lastSentAt;
        sentFrames += 1;
        lastError = null;
        consecutiveFailures = 0;
        failingSince = 0;
        noteTruncation(result);
      }
    } catch (error) {
      noteFailure(error);
    } finally {
      inflight = false;
    }
    emitHealth();
  }

  function start() {
    if (active || yielded) return false;
    ownership = ownershipCoordinator?.claim?.({
      host: ownershipHost,
      startedAt: now(),
      onSuperseded: yieldOwnership,
    }) || null;
    active = true;
    lastSentAt = now();
    timer = setIntervalImpl(pump, Math.round(1000 / frameFps));
    return true;
  }

  function push(pixels) {
    if (yielded || !Array.isArray(pixels) || !pixels.length) return false;
    // Frame producers intentionally reuse their pixel buffers. Keep our own
    // immutable snapshot so a later render cannot alter a queued/in-flight
    // frame.
    if (latestDirty) droppedFrames += 1; // previous frame never made the wire
    latest = pixels.slice();
    latestDirty = true;
    return true;
  }

  async function stop() {
    if (!active) {
      ownership?.release?.();
      ownership = null;
      closeTransport();
      return;
    }
    const ownsCard = ownership?.isOwner?.() ?? true;
    active = false;
    if (timer !== null) { clearIntervalImpl(timer); timer = null; }
    latest = null;
    latestDirty = false;
    ownership?.release?.();
    ownership = null;
    // Release the card's frame-source claim so its own pattern resumes —
    // the existing control path, never a bespoke stop message.
    try {
      if (ownsCard) await wire.sendCancel();
    } catch (error) {
      lastError = error;
    } finally {
      closeTransport();
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
        undeliveredFrames,
        truncatedFrames,
        truncated: Boolean(truncatedReason),
        truncatedReason,
        consecutiveFailures,
        failingForMs: failingSince ? now() - failingSince : 0,
        lastSentAt,
        lastDeliveredAt,
        lastError,
      };
    },
  };
}
