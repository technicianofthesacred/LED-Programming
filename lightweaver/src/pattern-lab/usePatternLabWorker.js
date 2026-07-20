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

const WATCHDOG_MS = 350;
const MIN_RENDER_INTERVAL_MS = 1000 / PATTERN_LAB_WORKER_BUDGETS.previewFps;

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

export default function usePatternLabWorker({
  recipe,
  geometry,
  time,
  mode = 'preview',
  renderOptions = {},
  enabled = true,
}) {
  const geometryState = useMemo(() => {
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
  }, [geometry]);
  const compactGeometry = geometryState.compact;
  const compactGeometryRef = useRef(null);
  const enabledRef = useRef(enabled);
  const geometryGenerationRef = useRef(0);
  const sequencerRef = useRef(createPatternLabWorkerRequestSequencer());
  const workerRef = useRef(null);
  const watchdogRef = useRef(0);
  const dispatchTimerRef = useRef(0);
  const queuedRenderRef = useRef(null);
  const lastDispatchAtRef = useRef(Number.NEGATIVE_INFINITY);
  const latestRenderRef = useRef(0);
  const pendingRenderRef = useRef(null);
  const mountedRef = useRef(false);
  const [result, setResult] = useState(() => ({
    available: enabled && workerSupported(),
    status: enabled && workerSupported() ? 'initializing' : 'fallback',
    frame: null,
    frameRequestId: null,
    requestId: null,
    warning: null,
    error: null,
    stats: null,
    geometryGeneration: 0,
  }));

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = 0;
  }, []);

  const clearDispatchTimer = useCallback(() => {
    if (dispatchTimerRef.current) clearTimeout(dispatchTimerRef.current);
    dispatchTimerRef.current = 0;
  }, []);

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
    pendingRenderRef.current = null;
    latestRenderRef.current = 0;
    return cancelPatternLabWorker(worker);
  }, []);

  const spawnWorker = useCallback(() => {
    const currentGeometry = compactGeometryRef.current;
    const currentGeneration = geometryGenerationRef.current;
    if (!enabledRef.current || !workerSupported() || !currentGeometry) return null;
    if (workerRef.current) return workerRef.current;

    const worker = new Worker(new URL('./patternLab.worker.js', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    if (mountedRef.current) setResult(current => ({
      ...current,
      available: true,
      status: 'initializing',
      error: null,
    }));

    worker.onmessage = event => {
      if (!mountedRef.current || workerRef.current !== worker) return;
      const reply = event.data;
      if (!reply) return;
      if (reply?.type === 'ready') {
        if (reply.payload?.generation !== currentGeneration) return;
        setResult(current => ({ ...current, status: latestRenderRef.current ? current.status : 'ready' }));
        return;
      }
      if (reply.type === 'frame') {
        const pending = pendingRenderRef.current;
        if (!pending || !shouldAcceptPatternLabWorkerReply(reply, pending.id)) return;
        clearWatchdog();
        pendingRenderRef.current = null;
        let frame;
        try {
          frame = validatePatternLabWorkerFrameReply(reply, pending);
        } catch (error) {
          setResult(current => ({
            ...current,
            status: current.frame ? 'frame' : 'error',
            error: {
              name: 'MalformedWorkerFrame',
              message: `Malformed worker frame: ${error instanceof Error ? error.message : String(error)}`,
            },
          }));
          return;
        }
        setResult(current => ({
          ...current,
          status: 'frame',
          frame,
          frameRequestId: reply.requestId,
          requestId: reply.requestId,
          error: null,
        }));
      } else if (!shouldAcceptPatternLabWorkerReply(reply, latestRenderRef.current)) {
        return;
      } else if (reply.type === 'warning') {
        setResult(current => ({ ...current, warning: reply.payload }));
      } else if (reply.type === 'error') {
        clearWatchdog();
        pendingRenderRef.current = null;
        setResult(current => ({
          ...current,
          status: 'error',
          requestId: reply.requestId,
          error: reply.payload,
        }));
      } else if (reply.type === 'stats') {
        setResult(current => ({ ...current, stats: reply.payload }));
      }
    };
    worker.onerror = event => {
      if (!mountedRef.current || workerRef.current !== worker) return;
      clearWatchdog();
      setResult(current => ({
        ...current,
        status: 'error',
        error: { name: 'WorkerError', message: event.message || 'Pattern Lab worker failed' },
      }));
    };

    const snapshot = clonePatternLabWorkerGeometryForTransfer(currentGeometry);
    worker.postMessage(sequencerRef.current.next('initialize', {
      budgets: PATTERN_LAB_WORKER_BUDGETS,
      geometry: snapshot.geometry,
      generation: currentGeneration,
    }), snapshot.transfer);
    return worker;
  }, [clearWatchdog]);

  const dispatchQueuedRender = useCallback(() => {
    dispatchTimerRef.current = 0;
    const payload = queuedRenderRef.current;
    queuedRenderRef.current = null;
    const currentGeometry = compactGeometryRef.current;
    if (!payload || !mountedRef.current || !enabledRef.current || !currentGeometry
      || payload.generation !== geometryGenerationRef.current) return;

    if (pendingRenderRef.current) terminateCurrentWorker(true);
    const worker = spawnWorker();
    if (!worker) return;
    const request = sequencerRef.current.next('render', payload);
    latestRenderRef.current = request.requestId;
    pendingRenderRef.current = {
      id: request.requestId,
      mode: payload.mode,
      expectedSampleCount: clampPatternLabWorkerSampleCount(
        currentGeometry.visiblePixelCount,
        payload.mode,
      ),
      visiblePixelCount: currentGeometry.visiblePixelCount,
      time: payload.time,
      generation: payload.generation,
    };
    lastDispatchAtRef.current = performance.now();
    setResult(current => ({
      ...current,
      available: true,
      status: current.frame ? 'rendering' : 'loading',
      requestId: request.requestId,
      warning: null,
      error: null,
    }));
    worker.postMessage(request);
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      if (!mountedRef.current || latestRenderRef.current !== request.requestId) return;
      if (workerRef.current === worker) terminateCurrentWorker();
      setResult(current => ({
        ...current,
        status: 'timeout',
        requestId: request.requestId,
        warning: {
          code: 'render-timeout',
          message: `Pattern Lab worker exceeded ${WATCHDOG_MS} ms and was stopped`,
        },
      }));
    }, WATCHDOG_MS);
  }, [clearWatchdog, spawnWorker, terminateCurrentWorker]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearDispatchTimer();
      clearWatchdog();
      queuedRenderRef.current = null;
      pendingRenderRef.current = null;
      latestRenderRef.current = 0;
      const worker = workerRef.current;
      workerRef.current = null;
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
    terminateCurrentWorker(true);
    latestRenderRef.current = 0;
    pendingRenderRef.current = null;
    lastDispatchAtRef.current = Number.NEGATIVE_INFINITY;

    geometryGenerationRef.current += 1;
    compactGeometryRef.current = compactGeometry;
    enabledRef.current = enabled;
    const geometryGeneration = geometryGenerationRef.current;
    const available = enabled && workerSupported() && Boolean(compactGeometry);
    setResult({
      available,
      status: available ? 'initializing' : 'fallback',
      frame: null,
      frameRequestId: null,
      requestId: null,
      warning: null,
      error: geometryState.error,
      stats: null,
      geometryGeneration,
    });
    if (available) spawnWorker();
  }, [
    clearDispatchTimer,
    clearWatchdog,
    compactGeometry,
    enabled,
    geometryState.error,
    spawnWorker,
    terminateCurrentWorker,
  ]);

  useEffect(() => {
    if (!enabled || !recipe || !compactGeometry) return undefined;
    queuedRenderRef.current = {
      recipe: {
        base: {
          patternId: recipe.base?.patternId,
          params: recipe.base?.params || {},
        },
        palette: Array.isArray(recipe.palette) ? recipe.palette : [],
        layers: Array.isArray(recipe.layers) ? recipe.layers.map(() => null) : [],
      },
      time: Number(time) || 0,
      mode,
      generation: geometryGenerationRef.current,
      layerCount: Array.isArray(recipe.layers) ? recipe.layers.length : 0,
      renderOptions,
      testGenerator: testGenerator(),
    };
    if (pendingRenderRef.current) latestRenderRef.current = 0;
    const elapsed = performance.now() - lastDispatchAtRef.current;
    const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed);
    if (delay === 0) dispatchQueuedRender();
    else if (!dispatchTimerRef.current) {
      dispatchTimerRef.current = setTimeout(dispatchQueuedRender, delay);
    }
    return undefined;
  }, [compactGeometry, dispatchQueuedRender, enabled, mode, recipe, renderOptions, time]);

  const cancel = useCallback(() => {
    const targetRequestId = pendingRenderRef.current?.id;
    const queued = Boolean(queuedRenderRef.current);
    if (!targetRequestId && !queued) return false;
    clearDispatchTimer();
    queuedRenderRef.current = null;
    clearWatchdog();
    if (targetRequestId) terminateCurrentWorker(true);
    else latestRenderRef.current = 0;
    spawnWorker();
    setResult(current => ({
      ...current,
      status: current.frame ? 'frame' : 'ready',
      requestId: null,
    }));
    return true;
  }, [clearDispatchTimer, clearWatchdog, spawnWorker, terminateCurrentWorker]);

  return { ...result, cancel };
}
