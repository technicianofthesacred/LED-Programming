import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PATTERN_LAB_WORKER_BUDGETS,
  clampPatternLabWorkerSampleCount,
  createPatternLabWorkerRequestSequencer,
  shouldAcceptPatternLabWorkerReply,
} from '../lib/patternLabWorkerProtocol.js';

const WATCHDOG_MS = 350;
const MIN_RENDER_INTERVAL_MS = 1000 / PATTERN_LAB_WORKER_BUDGETS.previewFps;

export function cancelPatternLabWorker(worker) {
  if (!worker || typeof worker.terminate !== 'function') return false;
  worker.terminate();
  return true;
}

function countVisiblePixels(geometry) {
  const hidden = geometry?.hidden || {};
  return (geometry?.strips || []).reduce((total, strip) => (
    !strip || strip.hidden || hidden[strip.id]
      ? total
      : total + (Array.isArray(strip.pixels) ? strip.pixels.length : 0)
  ), 0);
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
  const sequencerRef = useRef(createPatternLabWorkerRequestSequencer());
  const workerRef = useRef(null);
  const watchdogRef = useRef(0);
  const dispatchTimerRef = useRef(0);
  const queuedRenderRef = useRef(null);
  const lastDispatchAtRef = useRef(Number.NEGATIVE_INFINITY);
  const latestRenderRef = useRef(0);
  const pendingRenderRef = useRef(0);
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
    const targetRequestId = pendingRenderRef.current;
    if (sendCancel && targetRequestId) {
      try {
        worker.postMessage(sequencerRef.current.next('cancel', { targetRequestId }));
      } catch {}
    }
    workerRef.current = null;
    pendingRenderRef.current = 0;
    latestRenderRef.current = 0;
    return cancelPatternLabWorker(worker);
  }, []);

  const spawnWorker = useCallback(() => {
    if (!enabled || !workerSupported()) {
      if (mountedRef.current) setResult(current => ({ ...current, available: false, status: 'fallback' }));
      return null;
    }
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
      if (reply?.type === 'ready') {
        setResult(current => ({ ...current, status: latestRenderRef.current ? current.status : 'ready' }));
        return;
      }
      if (!shouldAcceptPatternLabWorkerReply(reply, latestRenderRef.current)) return;
      if (reply.type === 'frame') {
        clearWatchdog();
        pendingRenderRef.current = 0;
        const frame = {
          ...reply.payload,
          colors: new Uint8ClampedArray(reply.payload.colors),
          indices: new Uint16Array(reply.payload.indices),
        };
        setResult(current => ({
          ...current,
          status: 'frame',
          frame,
          frameRequestId: reply.requestId,
          requestId: reply.requestId,
          error: null,
        }));
      } else if (reply.type === 'warning') {
        setResult(current => ({ ...current, warning: reply.payload }));
      } else if (reply.type === 'error') {
        clearWatchdog();
        pendingRenderRef.current = 0;
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

    worker.postMessage(sequencerRef.current.next('initialize', { budgets: PATTERN_LAB_WORKER_BUDGETS }));
    return worker;
  }, [clearWatchdog, enabled]);

  const dispatchQueuedRender = useCallback(() => {
    dispatchTimerRef.current = 0;
    const payload = queuedRenderRef.current;
    queuedRenderRef.current = null;
    if (!payload || !mountedRef.current || !enabled) return;

    if (pendingRenderRef.current) terminateCurrentWorker(true);
    const worker = spawnWorker();
    if (!worker) return;
    const request = sequencerRef.current.next('render', payload);
    latestRenderRef.current = request.requestId;
    pendingRenderRef.current = request.requestId;
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
  }, [clearWatchdog, enabled, spawnWorker, terminateCurrentWorker]);

  useEffect(() => {
    mountedRef.current = true;
    spawnWorker();
    return () => {
      mountedRef.current = false;
      clearDispatchTimer();
      clearWatchdog();
      queuedRenderRef.current = null;
      const worker = workerRef.current;
      workerRef.current = null;
      if (worker) {
        try { worker.postMessage(sequencerRef.current.next('dispose')); } catch {}
        cancelPatternLabWorker(worker);
      }
    };
  }, [clearDispatchTimer, clearWatchdog, spawnWorker]);

  useEffect(() => {
    if (!enabled || !recipe || !geometry) return undefined;
    const totalSamples = countVisiblePixels(geometry);
    const sampleCount = clampPatternLabWorkerSampleCount(Math.max(1, totalSamples), mode);
    queuedRenderRef.current = {
      recipe,
      geometry,
      time,
      mode,
      sampleCount,
      layerCount: Array.isArray(recipe.layers) ? recipe.layers.length : 0,
      allocationBytes: sampleCount * 5,
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
  }, [dispatchQueuedRender, enabled, geometry, mode, recipe, renderOptions, time]);

  const cancel = useCallback(() => {
    const targetRequestId = pendingRenderRef.current;
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
