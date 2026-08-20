import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PATTERN_LAB_WORKER_BUDGETS,
  clampPatternLabWorkerSampleCount,
  clonePatternLabWorkerGeometryForTransfer,
  compactPatternLabWorkerGeometry,
  createPatternLabWorkerRequestSequencer,
  shouldAcceptPatternLabWorkerReply,
  validatePatternLabWorkerFrameReply,
} from '../lib/patternLabWorkerProtocol.js';

// One frame may take this long before the preview degrades to sampled frames.
// A missed deadline is a slow frame, not a dead worker: it never terminates anything.
const SLOW_FRAME_MS = 400;
// The watchdog measures each deadline from the moment its request was POSTED, so it
// has to sample more often than the deadline itself. It is a single interval that
// lives as long as a render is in flight and is never re-armed by a later dispatch —
// otherwise a busy preview would keep resetting it and a hung worker would never
// be noticed (which is exactly when the watchdog matters).
const WATCHDOG_TICK_MS = 100;
// Only a worker that misses this many consecutive deadlines without saying anything
// at all is treated as genuinely unresponsive.
const UNRESPONSIVE_DEADLINES = 3;
const UNRESPONSIVE_RETRY_MS = 400;
// Replacing a wedged worker is worth doing once: a worker can be born into a bad
// state, and the retry costs ~1.6 s. Replacing it a second time and finding the very
// same request wedged again is proof the PATTERN does not terminate, not the worker —
// spawning a third one only pegs a core forever and re-transfers the geometry. Two
// consecutive replacements is the cap; after it the preview stops on its own and says
// so in plain language.
const MAX_AUTOMATIC_WORKER_REPLACEMENTS = 2;
const MIN_RENDER_INTERVAL_MS = 1000 / PATTERN_LAB_WORKER_BUDGETS.previewFps;

const NO_LIGHTS_PATTERN = /visible source pixel/i;

export function cancelPatternLabWorker(worker) {
  if (!worker || typeof worker.terminate !== 'function') return false;
  worker.terminate();
  return true;
}

function workerSupported() {
  return typeof globalThis.Worker === 'function';
}

function testGenerator() {
  if (!import.meta.env.DEV) return undefined;
  return globalThis.__LW_PATTERN_LAB_WORKER_TEST_MODE__;
}

function geometryFailure(error) {
  if (!error) return null;
  return NO_LIGHTS_PATTERN.test(String(error.message || '')) ? 'no-lights' : 'geometry';
}

// Which pattern code a recipe will actually run. Everything else about a recipe —
// macros, palette, seed, time — changes constantly while dragging a slider, so only
// this identity is allowed to release a pattern that proved it cannot be drawn.
function patternSignature(recipe) {
  if (!recipe) return '';
  const layers = Array.isArray(recipe.layers)
    ? recipe.layers.map(layer => String(
      layer?.generator?.patternId ?? layer?.generator?.kind ?? '',
    )).join(',')
    : '';
  return `${String(recipe.base?.kind ?? '')}:${String(recipe.base?.patternId ?? '')}|${layers}`;
}

export default function usePatternLabWorker({
  recipe,
  geometry,
  time,
  mode = 'preview',
  renderOptions = {},
  enabled = true,
}) {
  const [retryToken, setRetryToken] = useState(0);
  const geometryState = useMemo(() => {
    void retryToken;
    if (!geometry) return { compact: null, error: null };
    try {
      return { compact: compactPatternLabWorkerGeometry(geometry), error: null };
    } catch (error) {
      return {
        compact: null,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }, [geometry, retryToken]);
  const compactGeometry = geometryState.compact;
  const compactGeometryRef = useRef(null);
  const enabledRef = useRef(enabled);
  const geometryGenerationRef = useRef(0);
  const initializedGenerationRef = useRef(0);
  const sequencerRef = useRef(createPatternLabWorkerRequestSequencer());
  const workerRef = useRef(null);
  const watchdogRef = useRef(0);
  const watchdogTickRef = useRef(null);
  const dispatchTimerRef = useRef(0);
  const dispatchRef = useRef(null);
  const drainRef = useRef(null);
  const queuedRenderRef = useRef(null);
  const lastRenderPayloadRef = useRef(null);
  const lastDispatchAtRef = useRef(Number.NEGATIVE_INFINITY);
  const latestRenderRef = useRef(0);
  const pendingRenderRef = useRef(null);
  const missedDeadlinesRef = useRef(0);
  const degradedRef = useRef(false);
  const replacementsRef = useRef(0);
  const manualResetUsedRef = useRef(false);
  const terminalRef = useRef(false);
  const terminalSignatureRef = useRef(null);
  const lastRetryTokenRef = useRef(0);
  const mountedRef = useRef(false);
  const [result, setResult] = useState(() => ({
    available: enabled && workerSupported(),
    status: enabled && workerSupported() ? 'initializing' : 'fallback',
    frame: null,
    frameRequestId: null,
    requestId: null,
    warning: null,
    error: null,
    failure: enabled && workerSupported() ? null : 'unsupported',
    stats: null,
    degraded: false,
    geometryGeneration: 0,
  }));

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) clearInterval(watchdogRef.current);
    watchdogRef.current = 0;
  }, []);

  const clearDispatchTimer = useCallback(() => {
    if (dispatchTimerRef.current) clearTimeout(dispatchTimerRef.current);
    dispatchTimerRef.current = 0;
  }, []);

  // Terminating is now reserved for teardown, replaced geometry that no longer renders,
  // and a worker proven unresponsive. Superseded frames never reach here.
  const terminateCurrentWorker = useCallback((sendCancel = false) => {
    const worker = workerRef.current;
    if (!worker) return false;
    const targetRequestId = pendingRenderRef.current?.id;
    if (sendCancel && targetRequestId) {
      try {
        worker.postMessage(sequencerRef.current.next('cancel', { targetRequestId }));
      } catch {}
    }
    workerRef.current = null;
    initializedGenerationRef.current = 0;
    pendingRenderRef.current = null;
    latestRenderRef.current = 0;
    return cancelPatternLabWorker(worker);
  }, []);

  // The pattern itself cannot be drawn. Stop spending a core on it, keep whatever frame
  // is already on screen, and let the owner pick something else.
  const enterTerminalState = useCallback(() => {
    terminalRef.current = true;
    terminalSignatureRef.current = patternSignature(lastRenderPayloadRef.current?.recipe);
    queuedRenderRef.current = null;
    clearDispatchTimer();
    clearWatchdog();
    setResult(current => ({
      ...current,
      status: 'timeout',
      degraded: true,
      warning: null,
      failure: manualResetUsedRef.current ? 'pattern-unrenderable' : 'pattern-too-heavy',
    }));
  }, [clearDispatchTimer, clearWatchdog]);

  const watchdogTick = useCallback(() => {
    if (!mountedRef.current) {
      clearWatchdog();
      return;
    }
    const pending = pendingRenderRef.current;
    if (!pending) {
      clearWatchdog();
      return;
    }
    // Measured from when THIS request was posted, so later dispatches cannot postpone it.
    const missed = Math.floor((performance.now() - pending.postedAt) / SLOW_FRAME_MS);
    if (missed <= pending.reportedMisses) return;
    pending.reportedMisses = missed;
    missedDeadlinesRef.current = missed;
    degradedRef.current = true;
    if (missed < UNRESPONSIVE_DEADLINES) {
      setResult(current => ({
        ...current,
        status: 'timeout',
        requestId: pending.id,
        failure: 'timeout',
        degraded: true,
        warning: {
          code: 'render-slow',
          message: `Pattern Lab worker exceeded ${SLOW_FRAME_MS} ms; preview degraded to sampled frames`,
        },
      }));
      return;
    }
    clearWatchdog();
    const payload = lastRenderPayloadRef.current;
    terminateCurrentWorker();
    missedDeadlinesRef.current = 0;
    replacementsRef.current += 1;
    if (replacementsRef.current >= MAX_AUTOMATIC_WORKER_REPLACEMENTS) {
      enterTerminalState();
      return;
    }
    setResult(current => ({
      ...current,
      status: 'timeout',
      requestId: pending.id,
      failure: 'timeout',
      degraded: true,
      warning: {
        code: 'render-unresponsive',
        message: `Pattern Lab worker missed ${missed} consecutive ${SLOW_FRAME_MS} ms deadlines and was replaced`,
      },
    }));
    if (!payload) return;
    queuedRenderRef.current = { ...payload, generation: geometryGenerationRef.current };
    clearDispatchTimer();
    dispatchTimerRef.current = setTimeout(() => {
      dispatchTimerRef.current = 0;
      dispatchRef.current?.();
    }, UNRESPONSIVE_RETRY_MS);
  }, [clearDispatchTimer, clearWatchdog, enterTerminalState, terminateCurrentWorker]);

  watchdogTickRef.current = watchdogTick;

  const ensureWatchdog = useCallback(() => {
    if (watchdogRef.current) return;
    watchdogRef.current = setInterval(() => watchdogTickRef.current?.(), WATCHDOG_TICK_MS);
  }, []);

  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;
    if (!enabledRef.current || !workerSupported() || !compactGeometryRef.current) return null;

    const worker = new Worker(new URL('./patternLab.worker.js', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    initializedGenerationRef.current = 0;
    if (mountedRef.current) setResult(current => ({
      ...current,
      available: true,
      status: current.frame ? current.status : 'initializing',
      error: null,
      failure: null,
    }));

    worker.onmessage = event => {
      if (!mountedRef.current || workerRef.current !== worker) return;
      const reply = event.data;
      if (!reply) return;
      missedDeadlinesRef.current = 0;
      if (reply?.type === 'ready') {
        if (reply.payload?.generation !== geometryGenerationRef.current) return;
        setResult(current => ({ ...current, status: latestRenderRef.current ? current.status : 'ready' }));
        return;
      }
      const pending = pendingRenderRef.current;
      if (reply.type === 'frame') {
        // Matched against the IN-FLIGHT request, not the latest one: a superseded frame
        // still has to release the backpressure slot, or nothing would ever dispatch again.
        if (!pending || !shouldAcceptPatternLabWorkerReply(reply, pending.id)) return;
        clearWatchdog();
        pendingRenderRef.current = null;
        degradedRef.current = false;
        // The worker answered, so it is neither wedged nor running a pattern that
        // cannot terminate. Both give-up counters start over.
        replacementsRef.current = 0;
        manualResetUsedRef.current = false;
        if (latestRenderRef.current === pending.id) {
          let frame;
          try {
            frame = validatePatternLabWorkerFrameReply(reply, pending);
          } catch (error) {
            setResult(current => ({
              ...current,
              status: current.frame ? 'frame' : 'error',
              degraded: false,
              failure: current.frame ? current.failure : 'worker-error',
              error: {
                name: 'MalformedWorkerFrame',
                message: `Malformed worker frame: ${error instanceof Error ? error.message : String(error)}`,
              },
            }));
            drainRef.current?.();
            return;
          }
          setResult(current => ({
            ...current,
            status: 'frame',
            frame,
            frameRequestId: reply.requestId,
            requestId: reply.requestId,
            degraded: false,
            error: null,
            failure: null,
          }));
        }
        drainRef.current?.();
        return;
      }
      if (reply.type === 'error') {
        if (!pending || !shouldAcceptPatternLabWorkerReply(reply, pending.id)) return;
        clearWatchdog();
        pendingRenderRef.current = null;
        degradedRef.current = false;
        replacementsRef.current = 0;
        setResult(current => ({
          ...current,
          status: 'error',
          requestId: reply.requestId,
          failure: 'worker-error',
          degraded: false,
          error: reply.payload,
        }));
        drainRef.current?.();
        return;
      }
      if (!shouldAcceptPatternLabWorkerReply(reply, latestRenderRef.current)) return;
      if (reply.type === 'warning') {
        setResult(current => ({ ...current, warning: reply.payload }));
      } else if (reply.type === 'stats') {
        setResult(current => ({ ...current, stats: reply.payload }));
      }
    };
    worker.onerror = event => {
      if (!mountedRef.current || workerRef.current !== worker) return;
      clearWatchdog();
      pendingRenderRef.current = null;
      setResult(current => ({
        ...current,
        status: 'error',
        failure: 'worker-error',
        degraded: false,
        error: { name: 'WorkerError', message: event.message || 'Pattern Lab worker failed' },
      }));
    };
    return worker;
  }, [clearWatchdog]);

  // Geometry is transferred once per worker per geometry generation. A render never
  // re-sends it, and a changed geometry re-initializes the SAME worker.
  const syncGeometry = useCallback(worker => {
    const currentGeometry = compactGeometryRef.current;
    const generation = geometryGenerationRef.current;
    if (!worker || !currentGeometry) return false;
    if (initializedGenerationRef.current === generation) return false;
    const snapshot = clonePatternLabWorkerGeometryForTransfer(currentGeometry);
    worker.postMessage(sequencerRef.current.next('initialize', {
      budgets: PATTERN_LAB_WORKER_BUDGETS,
      geometry: snapshot.geometry,
      generation,
    }), snapshot.transfer);
    initializedGenerationRef.current = generation;
    return true;
  }, []);

  const dispatchQueuedRender = useCallback(() => {
    dispatchTimerRef.current = 0;
    if (terminalRef.current) {
      queuedRenderRef.current = null;
      return;
    }
    // BACKPRESSURE: exactly one render may be in flight. While one is, the queued slot
    // holds the newest request and nothing is posted; the slot is drained when that
    // render resolves (frame, error, cancel or replacement). The slot is only cleared
    // once this call actually posts, so a render can never be silently lost.
    if (pendingRenderRef.current) return;
    const payload = queuedRenderRef.current;
    if (!payload) return;
    const currentGeometry = compactGeometryRef.current;
    if (!mountedRef.current || !enabledRef.current || !currentGeometry
      || payload.generation !== geometryGenerationRef.current) {
      queuedRenderRef.current = null;
      return;
    }

    const worker = ensureWorker();
    if (!worker) {
      queuedRenderRef.current = null;
      return;
    }
    queuedRenderRef.current = null;
    syncGeometry(worker);

    // A slow previous frame degrades this one to the preview sample budget rather
    // than killing anything; a good frame clears the degrade on arrival.
    const renderMode = degradedRef.current ? 'preview' : payload.mode;
    const request = sequencerRef.current.next('render', { ...payload, mode: renderMode });
    latestRenderRef.current = request.requestId;
    lastRenderPayloadRef.current = payload;
    const postedAt = performance.now();
    pendingRenderRef.current = {
      id: request.requestId,
      mode: renderMode,
      expectedSampleCount: clampPatternLabWorkerSampleCount(
        currentGeometry.visiblePixelCount,
        renderMode,
      ),
      visiblePixelCount: currentGeometry.visiblePixelCount,
      time: payload.time,
      generation: payload.generation,
      postedAt,
      reportedMisses: 0,
    };
    lastDispatchAtRef.current = postedAt;
    setResult(current => ({
      ...current,
      available: true,
      status: current.frame ? 'rendering' : 'loading',
      requestId: request.requestId,
      degraded: degradedRef.current,
      warning: null,
      error: null,
      failure: null,
    }));
    worker.postMessage(request);
    ensureWatchdog();
  }, [ensureWatchdog, ensureWorker, syncGeometry]);

  dispatchRef.current = dispatchQueuedRender;

  // The single entry point for "there is queued work, run it when allowed". It respects
  // both the frame-rate floor and the one-in-flight rule, and is a no-op when either
  // says wait — the queued slot stays put and is drained later.
  const drainQueuedRender = useCallback(() => {
    if (terminalRef.current) return;
    if (dispatchTimerRef.current || pendingRenderRef.current) return;
    if (!queuedRenderRef.current) return;
    const elapsed = performance.now() - lastDispatchAtRef.current;
    const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed);
    if (delay === 0) {
      dispatchRef.current?.();
      return;
    }
    dispatchTimerRef.current = setTimeout(() => {
      dispatchTimerRef.current = 0;
      dispatchRef.current?.();
    }, delay);
  }, []);

  drainRef.current = drainQueuedRender;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearDispatchTimer();
      clearWatchdog();
      queuedRenderRef.current = null;
      lastRenderPayloadRef.current = null;
      pendingRenderRef.current = null;
      latestRenderRef.current = 0;
      const worker = workerRef.current;
      workerRef.current = null;
      initializedGenerationRef.current = 0;
      if (worker) {
        try { worker.postMessage(sequencerRef.current.next('dispose')); } catch {}
        cancelPatternLabWorker(worker);
      }
    };
  }, [clearDispatchTimer, clearWatchdog]);

  useEffect(() => {
    clearDispatchTimer();
    clearWatchdog();
    queuedRenderRef.current = null;
    lastRenderPayloadRef.current = null;
    latestRenderRef.current = 0;
    pendingRenderRef.current = null;
    lastDispatchAtRef.current = Number.NEGATIVE_INFINITY;
    missedDeadlinesRef.current = 0;
    degradedRef.current = false;
    // `retry()` regenerates the compact geometry to re-run the whole pipeline, so this
    // effect also fires for a manual retry. A retry must NOT hand back the give-up
    // budget it just spent — only genuinely new geometry does that.
    const fromRetry = lastRetryTokenRef.current !== retryToken;
    lastRetryTokenRef.current = retryToken;
    if (!fromRetry) {
      replacementsRef.current = 0;
      manualResetUsedRef.current = false;
      terminalRef.current = false;
      terminalSignatureRef.current = null;
    }

    geometryGenerationRef.current += 1;
    compactGeometryRef.current = compactGeometry;
    enabledRef.current = enabled;
    const geometryGeneration = geometryGenerationRef.current;
    const available = enabled && workerSupported() && Boolean(compactGeometry);
    if (!available) terminateCurrentWorker(true);
    setResult({
      available,
      status: available ? 'initializing' : 'fallback',
      frame: null,
      frameRequestId: null,
      requestId: null,
      warning: null,
      error: geometryState.error,
      failure: available
        ? null
        : geometryFailure(geometryState.error) || (workerSupported() ? 'geometry' : 'unsupported'),
      stats: null,
      degraded: false,
      geometryGeneration,
    });
    if (!available) return;
    const worker = ensureWorker();
    if (worker) syncGeometry(worker);
  }, [
    clearDispatchTimer,
    clearWatchdog,
    compactGeometry,
    enabled,
    ensureWorker,
    geometryState.error,
    retryToken,
    syncGeometry,
    terminateCurrentWorker,
  ]);

  useEffect(() => {
    if (!enabled || !recipe || !compactGeometry) return undefined;
    // A pattern that gave up stays given up until the owner moves to different pattern
    // code (or presses the retry once). Every other recipe edit is a slider moving.
    if (terminalRef.current && terminalSignatureRef.current !== patternSignature(recipe)) {
      terminalRef.current = false;
      terminalSignatureRef.current = null;
      replacementsRef.current = 0;
      manualResetUsedRef.current = false;
      degradedRef.current = false;
      setResult(current => ({
        ...current,
        status: current.frame ? 'frame' : 'initializing',
        degraded: false,
        warning: null,
        failure: null,
      }));
    }
    if (terminalRef.current) return undefined;
    queuedRenderRef.current = {
      recipe,
      time: Number(time) || 0,
      mode,
      generation: geometryGenerationRef.current,
      layerCount: Array.isArray(recipe.layers) ? recipe.layers.length : 0,
      renderOptions,
      testGenerator: testGenerator(),
    };
    // A superseded in-flight render is dropped on arrival — never terminated.
    if (pendingRenderRef.current) latestRenderRef.current = 0;
    drainQueuedRender();
    return undefined;
  }, [compactGeometry, drainQueuedRender, enabled, mode, recipe, renderOptions, time]);

  const cancel = useCallback(() => {
    const targetRequestId = pendingRenderRef.current?.id;
    const queued = Boolean(queuedRenderRef.current);
    if (!targetRequestId && !queued) return false;
    clearDispatchTimer();
    queuedRenderRef.current = null;
    clearWatchdog();
    if (targetRequestId) {
      const worker = workerRef.current;
      if (worker) {
        try {
          worker.postMessage(sequencerRef.current.next('cancel', { targetRequestId }));
        } catch {}
      }
      pendingRenderRef.current = null;
    }
    latestRenderRef.current = 0;
    degradedRef.current = false;
    setResult(current => ({
      ...current,
      status: current.frame ? 'frame' : 'ready',
      degraded: false,
      requestId: null,
    }));
    return true;
  }, [clearDispatchTimer, clearWatchdog]);

  const retry = useCallback(() => {
    // One manual reset per terminal pattern. A second press must not restart the
    // spawn/peg/terminate cycle the cap exists to stop.
    if (terminalRef.current && manualResetUsedRef.current) return false;
    if (terminalRef.current) manualResetUsedRef.current = true;
    terminalRef.current = false;
    terminalSignatureRef.current = null;
    replacementsRef.current = 0;
    clearDispatchTimer();
    clearWatchdog();
    missedDeadlinesRef.current = 0;
    degradedRef.current = false;
    pendingRenderRef.current = null;
    latestRenderRef.current = 0;
    terminateCurrentWorker();
    setResult(current => ({
      ...current,
      status: current.available ? 'initializing' : current.status,
      warning: null,
      error: null,
      failure: null,
      degraded: false,
    }));
    setRetryToken(token => token + 1);
    const payload = lastRenderPayloadRef.current;
    if (!payload || !compactGeometryRef.current) return true;
    queuedRenderRef.current = { ...payload, generation: geometryGenerationRef.current };
    dispatchTimerRef.current = setTimeout(() => {
      dispatchTimerRef.current = 0;
      dispatchRef.current?.();
    }, 0);
    return true;
  }, [clearDispatchTimer, clearWatchdog, terminateCurrentWorker]);

  return { ...result, cancel, retry };
}
